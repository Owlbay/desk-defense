/**
 * 脱敏：思路与请求面板（文档 10 §12.1）里展示 / 存档 / 导出的一切内容都先经过这里。
 *
 *  - 对象：键名像密钥的字段（Authorization、x-api-key、apiKey、access_token、cookie……）整体替换为 "•••"；
 *  - 字符串：常见密钥格式（sk-ant-…、sk-…、sk-proj-…、AIza…、Bearer …、JWT、URL 里的 ?key=…、"x-api-key: …"）替换为 "•••"；
 *  - 已知密钥：调用方登记的真实 Key（玩家填的）在任何位置出现都替换掉（最可靠的一道）。
 * 纯函数、无依赖，Node / 浏览器通用。
 */

export const REDACTED = '•••';

/** 键名（不区分大小写、忽略 - 和 _）完全匹配时整值替换 */
const SECRET_KEYS = new Set([
  'authorization',
  'proxyauthorization',
  'xapikey',
  'xgoogapikey',
  'apikey',
  'key',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'clientsecret',
  'secret',
  'password',
  'cookie',
  'setcookie',
  'sessiontoken',
  'bearer',
  'token',
  'authtoken',
  'xauthtoken',
  'openaiapikey',
  'anthropicapikey',
  'anthropicauthtoken',
  'googleapikey',
  'geminiapikey',
]);

export function isSecretKey(k: string): boolean {
  return SECRET_KEYS.has(k.toLowerCase().replace(/[-_\s]/g, ''));
}

const PATTERNS: [RegExp, string][] = [
  // Authorization: Bearer xxx / Basic xxx
  [/\b(Bearer|Basic)\s+(?!•••)[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${REDACTED}`],
  // Anthropic / OpenAI / OpenRouter / DeepSeek 风格：sk-ant-api03-…、sk-proj-…、sk-or-v1-…、sk-…
  [/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{7,}/g, REDACTED],
  // Google API key
  [/\bAIza[0-9A-Za-z_-]{20,}/g, REDACTED],
  // 其它常见前缀
  [/\b(?:gsk|hf|ghp|gho|ghs|github_pat|glpat|xoxb|xoxp)_[A-Za-z0-9_-]{12,}/g, REDACTED],
  [/\bxai-[A-Za-z0-9]{16,}/g, REDACTED],
  // JWT
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, REDACTED],
  // URL 查询参数：?key=… &api_key=… &access_token=…
  [/([?&](?:key|api[_-]?key|apikey|access[_-]?token|token|auth|secret)=)(?!•••)[^&#\s"'<>]+/gi, `$1${REDACTED}`],
  // 错误文本 / 头部转储里的 "x-api-key: …"、"apiKey=…"、"\"authorization\":\"…\""
  [
    /((?:^|[\s{,;"'])(?:x-api-key|x-goog-api-key|api[_-]?key|apikey|authorization|access[_-]?token|client[_-]?secret|password)["']?\s*[:=]\s*["']?)(?!•••|Bearer\b|Basic\b)([^"',;\s}&]+)/gi,
    `$1${REDACTED}`,
  ],
];

/** 字符串脱敏；secrets = 已知的真实密钥（长度 ≥ 6 才参与，避免误伤普通数字） */
export function redactString(s: string, secrets: readonly string[] = []): string {
  let out = s;
  for (const sec of secrets) if (sec && sec.length >= 6 && out.includes(sec)) out = out.split(sec).join(REDACTED);
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

/** 深拷贝 + 脱敏（循环引用 / 过深 / 函数安全处理） */
export function redactValue(v: unknown, secrets: readonly string[] = [], depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof v === 'string') return redactString(v, secrets);
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'function' || typeof v === 'symbol') return undefined;
    if (typeof v === 'bigint') return String(v);
    return v;
  }
  if (depth > 40) return '[太深，已省略]';
  if (seen.has(v)) return '[循环引用]';
  seen.add(v);
  if (Array.isArray(v)) return v.map((x) => redactValue(x, secrets, depth + 1, seen));
  // Headers / Map 一类
  if (typeof (v as { entries?: unknown }).entries === 'function' && !(v as object).constructor?.name?.startsWith('Object')) {
    try {
      const o: Record<string, unknown> = {};
      for (const [k, x] of (v as Map<string, unknown>).entries())
        o[String(k)] = isSecretKey(String(k)) ? REDACTED : redactValue(x, secrets, depth + 1, seen);
      return o;
    } catch {
      /* 不是可迭代的键值对：按普通对象处理 */
    }
  }
  const o: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (x === undefined) continue;
    o[k] = isSecretKey(k) && x !== null && x !== '' ? REDACTED : redactValue(x, secrets, depth + 1, seen);
  }
  return o;
}

/** 脱敏后序列化为 JSON（带缩进），超过 maxChars 截断；返回 { json, chars: 截断前长度 } */
export function redactJson(v: unknown, secrets: readonly string[] = [], maxChars = 64_000): { json: string; chars: number } {
  let json: string;
  try {
    json = JSON.stringify(redactValue(v, secrets), null, 2) ?? 'null';
  } catch (e) {
    json = JSON.stringify(`[无法序列化：${e instanceof Error ? e.message : String(e)}]`);
  }
  // 序列化后再过一遍字符串规则（例如被拼进数字 / 键名里的密钥）
  json = redactString(json, secrets);
  const chars = json.length;
  if (chars > maxChars) json = `${json.slice(0, maxChars)}\n…[已截断：共 ${chars} 字符，只保留前 ${maxChars}]`;
  return { json, chars };
}

/** 错误 → 脱敏后的文字 */
export function redactError(e: unknown, secrets: readonly string[] = []): string {
  const s =
    e instanceof Error
      ? `${e.name && e.name !== 'Error' ? `${e.name}: ` : ''}${e.message}`
      : typeof e === 'string'
        ? e
        : (() => {
            try {
              return JSON.stringify(e);
            } catch {
              return String(e);
            }
          })();
  return redactString(s, secrets);
}
