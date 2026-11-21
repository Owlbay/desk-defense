/**
 * 「中转服务」（API relay / 代理商，OpenAI / Anthropic 兼容）——纯前端（文档 10 §10.8）。
 *
 * 玩家只填一个地址和一个 Key：
 *  - normalizeRelayBase：任意形式的地址（带 / 不带结尾斜杠、带 / 不带 /v1、甚至完整端点 …/v1/chat/completions）
 *    → 各 API 需要的 baseUrl（openai-* 以 /v1 结尾；anthropic-messages 不带 /v1，因为 Anthropic SDK 会自己拼 /v1/messages）；
 *  - listRelayModels：GET {根}/v1/models，先 Bearer，再试 x-api-key + anthropic-version（Anthropic 风格的中转）；
 *  - detectRelayApi：按顺序用极小的工具调用请求探测（Claude 模型先试 anthropic-messages；然后 responses → completions → messages），
 *    第一个真正调用了工具的就是答案；全部失败时给出分类诊断（CORS / Key / 路径 / 模型）。
 * 我们不做服务器转发：请求由浏览器直接发往玩家填写的地址，中转站必须允许跨域（CORS）。
 */
import type { AgentModelConfig, PiApi } from './config';
import type { ConnectionDiagnostics } from './models';
import { t } from '../i18n';

export type RelayApi = Exclude<PiApi, 'google-generative-ai'>;
export const RELAY_APIS: readonly RelayApi[] = ['openai-completions', 'openai-responses', 'anthropic-messages'];

/** 地址末尾可能被玩家一起粘贴进来的端点路径（从长到短匹配） */
const ENDPOINT_SUFFIXES = ['/chat/completions', '/completions', '/responses', '/messages', '/models'];

export interface RelayUrlParts {
  /** https://host[:port] */
  origin: string;
  /** 去掉端点与 /v1 之后的前缀路径（'' 或 '/openai' 之类，不以 / 结尾） */
  root: string;
  /** 原地址是否带了版本段（/v1、/v2beta、/api/v3 等），带了非 v1 版本时 openai-* 原样使用 */
  version: string;
  host: string;
}

/** 解析中转地址；不合法时返回 null。没写协议时按 https 处理。 */
export function parseRelayUrl(input: string): RelayUrlParts | null {
  let s = (input ?? '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, '')}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  let path = u.pathname.replace(/\/+$/, '');
  // 可能粘贴了多层，如 …/v1/messages/ 或 …/v1/chat/completions
  for (let changed = true; changed;) {
    changed = false;
    for (const suf of ENDPOINT_SUFFIXES) {
      if (path.toLowerCase().endsWith(suf)) {
        path = path.slice(0, -suf.length).replace(/\/+$/, '');
        changed = true;
        break;
      }
    }
  }
  let version = '';
  const m = /\/(v\d+[a-z0-9]*)$/i.exec(path);
  if (m) {
    version = m[1].toLowerCase();
    path = path.slice(0, -m[0].length).replace(/\/+$/, '');
  }
  return { origin: u.origin, root: path, version, host: u.host };
}

/**
 * 中转地址 → pi 需要的 baseUrl。
 *   openai-completions / openai-responses：…/v1（OpenAI SDK 在其后拼 /chat/completions、/responses）
 *   anthropic-messages：不带 /v1（Anthropic SDK 自己拼 /v1/messages）
 * 地址本身带了非 v1 的版本段（如 /api/v3）时，openai-* 保留原样。不合法时原样返回（交给 validateConfig 报错）。
 */
export function normalizeRelayBase(url: string, api: PiApi): string {
  const p = parseRelayUrl(url);
  if (!p) return (url ?? '').trim();
  if (api === 'anthropic-messages') return `${p.origin}${p.root}`;
  return `${p.origin}${p.root}/${p.version && p.version !== 'v1' ? p.version : 'v1'}`;
}

/** 显示用：Key 只会发送到这个主机 */
export function relayHost(url: string): string {
  return parseRelayUrl(url)?.host ?? '';
}

/** 模型名看起来是 Claude 吗（探测时先试 Anthropic Messages） */
export const looksLikeClaude = (model: string): boolean => /claude|anthropic/i.test(model ?? '');

export type ModelFamily = 'claude' | 'gpt' | 'gemini' | 'other';
export const FAMILY_LABEL: Record<ModelFamily, string> = { claude: 'Claude', gpt: 'GPT / OpenAI', gemini: 'Gemini', other: '其他' };

export function modelFamily(id: string): ModelFamily {
  const s = id.toLowerCase();
  if (/claude|anthropic/.test(s)) return 'claude';
  if (/gemini|gemma/.test(s)) return 'gemini';
  if (/gpt|chatgpt|openai|(^|\/)o\d(-|$)|davinci|codex/.test(s)) return 'gpt';
  return 'other';
}

/** 按家族分组（组内保持字母序），只返回非空组 */
export function groupModels(ids: readonly string[], filter = ''): { family: ModelFamily; models: string[] }[] {
  const q = filter.trim().toLowerCase();
  const groups: Record<ModelFamily, string[]> = { claude: [], gpt: [], gemini: [], other: [] };
  for (const id of [...new Set(ids)].sort((a, b) => a.localeCompare(b))) {
    if (q && !id.toLowerCase().includes(q)) continue;
    groups[modelFamily(id)].push(id);
  }
  return (Object.keys(groups) as ModelFamily[]).filter((f) => groups[f].length).map((family) => ({ family, models: groups[family] }));
}

// ───────────────────────── 模型列表 ─────────────────────────

export interface RelayModelListing {
  ok: boolean;
  models: string[];
  error?: string;
  hint?: string;
  /** 哪种鉴权方式成功 */
  auth?: 'bearer' | 'x-api-key';
}

/** 浏览器连不上中转站时的说明（当前语言） */
export const relayCorsHint = (): string => t('agent.relay.cors');

const parseIds = (j: unknown): string[] => {
  const o = j as { data?: { id?: string; name?: string }[]; models?: { id?: string; name?: string }[] } | null;
  const arr = o?.data ?? o?.models ?? [];
  return Array.isArray(arr) ? arr.map((m) => m?.id ?? m?.name ?? '').filter((x): x is string => !!x) : [];
};

/** GET {根}/v1/models：先 Bearer，再 x-api-key + anthropic-version */
export async function listRelayModels(
  url: string,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<RelayModelListing> {
  const p = parseRelayUrl(url);
  if (!p) return { ok: false, models: [], error: t('agent.relay.badUrl') };
  const endpoint = `${normalizeRelayBase(url, 'openai-completions')}/models`;
  const attempts: { auth: 'bearer' | 'x-api-key'; headers: Record<string, string> }[] = [
    { auth: 'bearer', headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} },
  ];
  if (apiKey) {
    attempts.push({
      auth: 'x-api-key',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    });
  }
  let lastErr = '';
  let network = false;
  for (const a of attempts) {
    try {
      const r = await fetchImpl(endpoint, { headers: a.headers });
      if (!r.ok) {
        lastErr = `HTTP ${r.status}`;
        continue;
      }
      const ids = parseIds(await r.json());
      return { ok: true, models: ids, auth: a.auth };
    } catch (e) {
      network = true;
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  const status = /HTTP (\d+)/.exec(lastErr)?.[1];
  const hint =
    network && !status
      ? relayCorsHint()
      : status === '401' || status === '403'
        ? t('agent.relay.keyRejected')
        : status === '404'
          ? t('agent.relay.noModelList')
          : undefined;
  return { ok: false, models: [], error: lastErr || t('agent.relay.unknownError'), hint };
}

// ───────────────────────── 接口探测 ─────────────────────────

export type RelayFailure = 'stale' | 'cors' | 'auth' | 'not_found' | 'model' | 'rate' | 'no_tools' | 'other';

/** 页面是旧版本、去加载已被新部署替换掉的 AI 分包（不是中转站的问题） */
export const STALE_CHUNK_RE =
  /dynamically imported module|importing a module script failed|error loading dynamically imported|failed to load module script|chunkloaderror|loading chunk \S+ failed/i;

export interface RelayAttempt {
  api: RelayApi;
  baseUrl: string;
  ok: boolean;
  /** 收到了回复（不一定调用了工具） */
  reachable: boolean;
  failure?: RelayFailure;
  error?: string;
  latencyMs: number;
  tokens: number;
}

export interface RelayDetection {
  ok: boolean;
  /** 成功的接口；全部失败但某个接口能回复（只是不调用工具）时，给出那个接口 */
  api?: RelayApi;
  attempts: RelayAttempt[];
  /** 全部失败时的主要原因 */
  failure?: RelayFailure;
  /** 面向玩家的说明（当前语言） */
  message: string;
}

/** 探测顺序：Claude 模型先试 Anthropic Messages，然后 Responses → Chat Completions → Messages */
export function relayProbeOrder(model: string): RelayApi[] {
  const base: RelayApi[] = ['openai-responses', 'openai-completions', 'anthropic-messages'];
  return looksLikeClaude(model) ? ['anthropic-messages', 'openai-responses', 'openai-completions'] : base;
}

const NET_RE = /connection error|failed to fetch|networkerror|load failed|fetch failed|cors|econnrefused|enotfound|err_|network/i;
const MODEL_RE =
  /model[_ ]?not[_ ]?found|no such model|unknown model|invalid model|model .*(not found|does not exist|not exist|not supported|unavailable|不存在)|not_found_error.*model|无可用渠道|no available (channel|distributor)|模型.*(不存在|不可用|未开放)/i;

/** 按错误文本分类（pi / OpenAI SDK / Anthropic SDK 的错误信息都以 "401 …" 之类开头） */
export function classifyRelayError(error: string | undefined, reachable: boolean, tokens = 0): RelayFailure {
  const e = error ?? '';
  if (!e) return reachable ? 'no_tools' : 'other';
  if (STALE_CHUNK_RE.test(e)) return 'stale';
  if (MODEL_RE.test(e)) return 'model';
  const status = /(?:^|\D)(401|403|404|405|429)(?:\D|$)/.exec(e)?.[1];
  if (
    status === '401' ||
    status === '403' ||
    /unauthori[sz]ed|invalid.*(api[ _-]?key|token)|api[ _-]?key.*invalid|令牌|无效的?\s*key/i.test(e)
  )
    return 'auth';
  if (status === '404' || status === '405' || /not found|no route|invalid url|unknown (url|endpoint|path)/i.test(e)) return 'not_found';
  if (status === '429' || /rate limit|quota|insufficient|余额|额度/i.test(e)) return 'rate';
  if (tokens === 0 && NET_RE.test(e)) return 'cors';
  return 'other';
}

/** 失败原因的说明（当前语言） */
export const relayFailureText = (f: RelayFailure): string => (f === 'cors' ? relayCorsHint() : t(`agent.relay.fail.${f}`));

/** 多个失败里挑最能说明问题的那个 */
function mainFailure(attempts: RelayAttempt[]): RelayFailure {
  const fs = attempts.map((a) => a.failure ?? 'other');
  for (const f of ['stale', 'no_tools', 'model', 'auth', 'rate'] as RelayFailure[]) if (fs.includes(f)) return f;
  if (fs.every((f) => f === 'cors')) return 'cors';
  if (fs.includes('not_found')) return 'not_found';
  if (fs.includes('cors')) return 'cors';
  return 'other';
}

export const RELAY_API_LABEL: Record<RelayApi, string> = {
  'openai-completions': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
};

export interface DetectOptions {
  /** 一次探测（默认 testConnection，极小请求 + 一个 end_turn 工具） */
  probe?: (cfg: Partial<AgentModelConfig>) => Promise<ConnectionDiagnostics>;
  onProgress?: (api: RelayApi, index: number, total: number) => void;
  signal?: AbortSignal;
  /** 只试这些（默认按 relayProbeOrder） */
  order?: RelayApi[];
}

/** 依次探测中转站支持的接口，第一个真正调用了工具的即为答案 */
export async function detectRelayApi(cfg: Partial<AgentModelConfig>, opts: DetectOptions = {}): Promise<RelayDetection> {
  const url = cfg.baseUrl ?? '';
  const order = opts.order ?? relayProbeOrder(cfg.model ?? '');
  const probe = opts.probe ?? (async (c: Partial<AgentModelConfig>) => (await import('./models')).testConnection(c));
  const attempts: RelayAttempt[] = [];
  for (let i = 0; i < order.length; i++) {
    if (opts.signal?.aborted) break;
    const api = order[i];
    opts.onProgress?.(api, i, order.length);
    const baseUrl = normalizeRelayBase(url, api);
    let d: ConnectionDiagnostics;
    try {
      d = await probe({
        ...cfg,
        provider: 'pi',
        preset: 'relay',
        api,
        baseUrl,
        toolMode: 'native',
        contextBudget: 'compact',
        maxOutputTokens: 256,
        decisionTimeoutMs: 30_000,
        maxRetries: 0,
        budget: {},
      });
    } catch (e) {
      d = {
        ok: false,
        reachable: false,
        toolCalling: false,
        latencyMs: 0,
        model: cfg.model ?? '',
        provider: 'pi',
        tokens: 0,
        error: e instanceof Error ? e.message : String(e),
      };
    }
    // 报了错、一个 token 都没收到 ⇒ 实际上没有连通
    const reachable = d.reachable && !(d.error && d.tokens === 0 && !d.toolCalling);
    const ok = d.ok && d.toolCalling;
    attempts.push({
      api,
      baseUrl,
      ok,
      reachable,
      latencyMs: d.latencyMs,
      tokens: d.tokens,
      ...(ok ? {} : { failure: classifyRelayError(d.error, reachable, d.tokens), error: d.error }),
    });
    if (ok)
      return {
        ok: true,
        api,
        attempts,
        message: t('agent.relay.detected', { api: RELAY_API_LABEL[api], s: (d.latencyMs / 1000).toFixed(1) }),
      };
  }
  const failure = mainFailure(attempts);
  const partial = attempts.find((a) => a.failure === 'no_tools');
  return { ok: false, api: partial?.api, attempts, failure, message: relayFailureText(failure) };
}
