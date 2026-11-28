/**
 * POST /api/feedback —— 游戏内反馈（bug / 建议 / 其他）。
 * 存进 D1 的 feedback 表（migrations/0005_feedback.sql），负责人用 wrangler d1 execute 读取（docs/12 §9）。
 *
 * - 所有字段在服务端重新清洗、截断；正文必填。
 * - 限流两层：rate_limits 表固定窗口（10 分钟 3 次，垃圾请求也计数）+ feedback 表里最近一小时已存条数（6 条）。
 *   限流 key 加 fb: 前缀，与提交成绩的计数互不影响。
 * - 不存 IP、不存原始设备 id，只存加盐哈希。
 * - 开了 Turnstile（TURNSTILE_SECRET）时同样要求 token。
 */
import {
  cleanFeedbackText,
  cleanLine,
  FEEDBACK_CONTACT_MAX,
  FEEDBACK_CONTEXT_MAX,
  FEEDBACK_HOURLY_MAX,
  FEEDBACK_MAX_BODY_BYTES,
  FEEDBACK_RATE_LIMIT,
  type FeedbackKind,
  type FeedbackResponse,
  isFeedbackKind,
} from '../../src/shared/feedback';
import { isDeviceId } from '../../src/shared/leaderboard';
import { clientIp, type Deps, hashDevice, hashIp, notConfigured, randomId, verifyTurnstile } from './handlers';
import { apiError, json } from './http';
import { checkRateLimit, D1RateLimitStore } from './ratelimit';

export const HOUR_MS = 3_600_000;

/** feedback 表的一行 */
export interface FeedbackRow {
  id: string;
  created_at: number;
  kind: FeedbackKind;
  text: string;
  contact: string | null;
  app_version: string;
  locale: string;
  screen: string;
  route: string;
  user_agent: string;
  device_hash: string | null;
  ip_hash: string;
}

export type FeedbackChecked =
  | {
      ok: true;
      value: Omit<FeedbackRow, 'id' | 'created_at' | 'device_hash' | 'ip_hash'> & { deviceId: string | null; turnstileToken?: string };
    }
  | { ok: false; message: string };

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** 校验并清洗请求体；uaHeader 是请求头里的 User-Agent（请求体没带时用它） */
export function checkFeedback(body: unknown, uaHeader = ''): FeedbackChecked {
  if (!isObj(body)) return { ok: false, message: '请求格式错误' };
  if (!isFeedbackKind(body.kind)) return { ok: false, message: '反馈类型无效' };
  const text = cleanFeedbackText(body.text);
  if (!text) return { ok: false, message: '请填写反馈内容' };
  const contact = cleanLine(body.contact, FEEDBACK_CONTACT_MAX);
  const ctx = isObj(body.context) ? body.context : {};
  const M = FEEDBACK_CONTEXT_MAX;
  const token = typeof body.turnstileToken === 'string' ? body.turnstileToken.slice(0, 2048) : undefined;
  return {
    ok: true,
    value: {
      kind: body.kind,
      text,
      contact: contact || null,
      app_version: cleanLine(ctx.version, M.version),
      locale: cleanLine(ctx.locale, M.locale),
      screen: cleanLine(ctx.screen, M.screen),
      route: cleanLine(ctx.route, M.route),
      user_agent: cleanLine(typeof ctx.ua === 'string' && ctx.ua ? ctx.ua : uaHeader, M.ua),
      deviceId: isDeviceId(body.deviceId) ? body.deviceId : null,
      ...(token ? { turnstileToken: token } : {}),
    },
  };
}

/** 最近一小时内，同一 IP 或同一设备已经存下的反馈条数 */
async function recentCount(deps: Deps, ipHash: string, deviceHash: string | null, now: number): Promise<number> {
  const since = now - HOUR_MS;
  const r = await deps
    .db!.prepare(
      deviceHash
        ? 'SELECT COUNT(*) AS n FROM feedback WHERE created_at > ?1 AND (ip_hash = ?2 OR device_hash = ?3)'
        : 'SELECT COUNT(*) AS n FROM feedback WHERE created_at > ?1 AND ip_hash = ?2',
    )
    .bind(...(deviceHash ? [since, ipHash, deviceHash] : [since, ipHash]))
    .first<{ n: number }>();
  return Number(r?.n ?? 0);
}

export async function handleFeedback(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return apiError('method', '请求方式不支持');
  if (!deps.db) return notConfigured();
  const now = deps.now();

  const len = Number(req.headers.get('Content-Length') ?? '0');
  if (len > FEEDBACK_MAX_BODY_BYTES) return apiError('too_large', '反馈内容太长了');
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > FEEDBACK_MAX_BODY_BYTES) return apiError('too_large', '反馈内容太长了');
  let body: unknown;
  let parsed = true;
  try {
    body = JSON.parse(raw);
  } catch {
    parsed = false;
  }

  // 限流放在校验之前：垃圾请求（包括不是 JSON 的）也计数
  const ip = clientIp(req);
  const ipHash = await hashIp(deps.salt, ip);
  const rawDevice = isObj(body) ? body.deviceId : undefined;
  const deviceHash = isDeviceId(rawDevice) ? await hashDevice(deps.salt, rawDevice) : null;
  const rate = deps.rate ?? new D1RateLimitStore(deps.db);
  const keys = [`fb:ip:${ipHash}`, ...(deviceHash ? [`fb:dev:${deviceHash}`] : [])];
  const rl = await checkRateLimit(rate, keys, now, FEEDBACK_RATE_LIMIT);
  if (!rl.ok) {
    return apiError('rate_limited', `反馈太频繁了，请 ${Math.ceil(rl.retryAfter / 60)} 分钟后再试`, { retryAfter: rl.retryAfter });
  }
  if (!parsed) return apiError('bad_request', '请求格式错误');

  const checked = checkFeedback(body, req.headers.get('User-Agent') ?? '');
  if (!checked.ok) return apiError('bad_request', checked.message);
  const v = checked.value;

  if (!(await verifyTurnstile(deps, v.turnstileToken, ip))) return apiError('turnstile', '人机验证未通过，请重试');

  if ((await recentCount(deps, ipHash, deviceHash, now)) >= FEEDBACK_HOURLY_MAX) {
    return apiError('rate_limited', '一小时内的反馈已经够多了，请稍后再试', { retryAfter: 3600 });
  }

  const row: FeedbackRow = {
    id: (deps.newId ?? randomId)(),
    created_at: now,
    kind: v.kind,
    text: v.text,
    contact: v.contact,
    app_version: v.app_version,
    locale: v.locale,
    screen: v.screen,
    route: v.route,
    user_agent: v.user_agent,
    device_hash: deviceHash,
    ip_hash: ipHash,
  };
  const cols = Object.keys(row) as (keyof FeedbackRow)[];
  await deps.db
    .prepare(`INSERT INTO feedback (${cols.join(', ')}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(', ')})`)
    .bind(...cols.map((c) => row[c]))
    .run();

  const res: FeedbackResponse = { ok: true, id: row.id };
  return json(res, { status: 201 });
}
