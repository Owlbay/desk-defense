/**
 * API 处理函数（与 Pages Functions 的路由文件解耦，便于在 vitest 里用假 D1 直接调用）。
 * 免费计划每次请求约 10 ms CPU：这里只做轻量校验，不做回放（第二阶段再做，见 docs/12）。
 */
import { decodeLogPayload, gzipJsonBase64 } from '../../src/shared/codec';
import {
  agentBadge,
  checkLog,
  checkSubmission,
  type DailyInfo,
  dailyInfo,
  dayOf,
  GAME_VERSION,
  isAiBoardKey,
  isDeviceId,
  LEADERBOARD_MAX_LIMIT,
  type LeaderboardResponse,
  MAX_BODY_BYTES,
  parseAiBoard,
  parseBoard,
  RATE_LIMIT,
  type RunDetail,
  type StatusResponse,
  type SubmitResponse,
} from '../../src/shared/leaderboard';
import { type D1Like, type RunRow, RunStore, toLeaderRow } from './db';
import { apiError, json } from './http';
import { checkRateLimit, D1RateLimitStore, type RateLimitStore } from './ratelimit';

/** caches.default 的最小子集 */
export interface CacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, res: Response): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface Deps {
  db: D1Like | null | undefined;
  /** 缺省用 D1 的 rate_limits 表 */
  rate?: RateLimitStore;
  now: () => number;
  /** 哈希 IP / 设备 id 用的盐（env.HASH_SALT） */
  salt: string;
  turnstileSecret?: string;
  turnstileSiteKey?: string;
  /** 服务端接受的客户端版本，缺省 [GAME_VERSION] */
  acceptVersions?: string[];
  fetch?: typeof fetch;
  cache?: CacheLike | null;
  newId?: () => string;
}

export const LEADERBOARD_TTL = 30;
const LIMIT_PRESETS = [10, 20, 50, 100];

// ───────────────────────── 工具 ─────────────────────────

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

export const hashDevice = async (salt: string, deviceId: string): Promise<string> =>
  (await sha256Hex(`${salt}|dev|${deviceId.toLowerCase()}`)).slice(0, 32);
/**
 * AI 榜的去重键：同一台设备的每个「服务商 + 模型」各保留一条最佳成绩
 * （复用 runs 表的 UNIQUE(board, device_hash)，不同模型不会互相覆盖）。
 */
export const hashAgentDevice = async (salt: string, deviceId: string, provider: string, model: string): Promise<string> =>
  (await sha256Hex(`${salt}|dev|${deviceId.toLowerCase()}|ai|${provider}|${model}`)).slice(0, 32);
export const hashIp = async (salt: string, ip: string): Promise<string> => (await sha256Hex(`${salt}|ip|${ip}`)).slice(0, 32);

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
export function randomId(len = 14): string {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => ID_ALPHABET[b % 36]).join('');
}

const RUN_ID_RE = /^[0-9a-z]{8,32}$/;

const clientIp = (req: Request): string =>
  req.headers.get('CF-Connecting-IP') ?? req.headers.get('X-Forwarded-For')?.split(',')[0].trim() ?? 'unknown';

function notConfigured(): Response {
  return apiError('not_configured', '在线功能暂未开放（服务器未配置数据库）');
}

export function leaderboardCacheKey(origin: string, board: string, limit: number): string {
  return `${origin}/api/leaderboard?board=${encodeURIComponent(board)}&limit=${limit}`;
}

async function verifyTurnstile(deps: Deps, token: string | undefined, ip: string): Promise<boolean> {
  if (!deps.turnstileSecret) return true;
  if (!token) return false;
  const f = deps.fetch ?? fetch;
  try {
    const form = new FormData();
    form.append('secret', deps.turnstileSecret);
    form.append('response', token);
    if (ip !== 'unknown') form.append('remoteip', ip);
    const r = await f('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    const data = (await r.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

// ───────────────────────── POST /api/runs ─────────────────────────

export async function handleSubmit(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return apiError('method', '请求方式不支持');
  if (!deps.db) return notConfigured();
  const now = deps.now();

  const len = Number(req.headers.get('Content-Length') ?? '0');
  if (len > MAX_BODY_BYTES) return apiError('too_large', '提交的数据太大了');
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return apiError('too_large', '提交的数据太大了');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return apiError('bad_request', '请求格式错误');
  }

  // 限流放在详细校验之前：垃圾请求也计数
  const ip = clientIp(req);
  const ipHash = await hashIp(deps.salt, ip);
  const rawDevice = (body as { deviceId?: unknown } | null)?.deviceId;
  const deviceHash = isDeviceId(rawDevice) ? await hashDevice(deps.salt, rawDevice) : null;
  const rate = deps.rate ?? new D1RateLimitStore(deps.db);
  const keys = [`ip:${ipHash}`, ...(deviceHash ? [`dev:${deviceHash}`] : [])];
  const rl = await checkRateLimit(rate, keys, now, RATE_LIMIT);
  if (!rl.ok) {
    return apiError('rate_limited', `提交太频繁了，请 ${Math.ceil(rl.retryAfter / 60)} 分钟后再试`, { retryAfter: rl.retryAfter });
  }

  const checked = checkSubmission(body, { now, acceptVersions: deps.acceptVersions ?? [GAME_VERSION] });
  if (!checked.ok) {
    const isVersion = checked.message.startsWith('游戏版本');
    return apiError(isVersion ? 'version' : 'bad_request', checked.message);
  }
  const sub = checked.value;

  if (!(await verifyTurnstile(deps, sub.turnstileToken, ip))) return apiError('turnstile', '人机验证未通过，请重试');

  let decoded: { log: unknown; rawBytes: number };
  try {
    decoded = await decodeLogPayload(sub.log);
  } catch (e) {
    return e instanceof Error && e.message === 'too_large'
      ? apiError('too_large', '操作记录过长')
      : apiError('bad_request', '操作记录无法解析');
  }
  const logChecked = checkLog(decoded.log, sub.result, sub.opts);
  if (!logChecked.ok) return apiError('bad_request', logChecked.message);

  const logGz = Array.isArray(sub.log) ? await gzipJsonBase64(logChecked.value) : sub.log.gz;
  const store = new RunStore(deps.db);
  const row: RunRow = {
    id: (deps.newId ?? randomId)(),
    board: sub.board,
    day: sub.day,
    nickname: sub.nickname,
    device_hash: sub.agent ? await hashAgentDevice(deps.salt, sub.deviceId, sub.agent.provider, sub.agent.model) : (deviceHash as string),
    score: sub.result.score,
    wave: sub.result.wave,
    kills: sub.result.kills,
    lives: sub.result.lives,
    seed: sub.seed,
    map: sub.opts.map,
    difficulty: sub.opts.difficulty,
    abyss: sub.opts.difficulty === 'abyss' ? (sub.opts.abyssLevel ?? 1) : 0,
    pure: sub.opts.pure ? 1 : 0,
    auto_wave: sub.parsedBoard.kind === 'daily' || sub.board.endsWith(':auto') ? 1 : 0,
    game_version: sub.gameVersion,
    opts_json: JSON.stringify(sub.opts),
    result_json: JSON.stringify(sub.result),
    log_gz: logGz,
    log_bytes: decoded.rawBytes,
    status: 'pending',
    created_at: now,
    ip_hash: ipHash,
    agent_provider: sub.agent?.provider ?? null,
    agent_model: sub.agent?.model ?? null,
    agent_mode: sub.agent?.mode ?? null,
    agent_bot_share: sub.agent ? sub.agent.botShare : null,
    agent_json: sub.agent ? JSON.stringify(sub.agent) : null,
  };
  const { improved } = await store.upsertBest(row);
  const best = await store.bestOf(sub.board, row.device_hash);
  if (!best) return apiError('internal', '保存成绩失败，请稍后再试');
  const { rank, total } = await store.rankOf(sub.board, best);

  if (improved && deps.cache) {
    const origin = new URL(req.url).origin;
    await Promise.all(LIMIT_PRESETS.map((l) => deps.cache!.delete(leaderboardCacheKey(origin, sub.board, l)).catch(() => false)));
  }
  const res: SubmitResponse = { id: best.id, rank, total, improved, status: best.status };
  return json(res, { status: improved ? 201 : 200 });
}

// ───────────────────────── GET /api/leaderboard ─────────────────────────

export async function handleLeaderboard(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'GET') return apiError('method', '请求方式不支持');
  if (!deps.db) return notConfigured();
  const url = new URL(req.url);
  const board = url.searchParams.get('board') ?? '';
  const ai = isAiBoardKey(board);
  if (!(ai ? parseAiBoard(board) : parseBoard(board))) return apiError('bad_request', '排行榜不存在');
  const limitRaw = Number(url.searchParams.get('limit') ?? '20');
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(LEADERBOARD_MAX_LIMIT, Math.floor(limitRaw))) : 20;
  const around = url.searchParams.get('around');
  if (around !== null && !isDeviceId(around)) return apiError('bad_request', '设备标识无效');

  const store = new RunStore(deps.db);
  // 缓存按档位（10/20/50/100）存，任意 limit 都落到某一档再截断，提交新纪录时能全部清掉
  const bucket = LIMIT_PRESETS.find((l) => l >= limit) ?? LEADERBOARD_MAX_LIMIT;
  const key = leaderboardCacheKey(url.origin, board, bucket);
  let base: LeaderboardResponse | null = null;
  if (deps.cache) {
    const hit = await deps.cache.match(key).catch(() => undefined);
    if (hit) base = (await hit.json()) as LeaderboardResponse;
  }
  if (!base) {
    const [rows, total] = await Promise.all([store.top(board, bucket), store.total(board)]);
    base = { board, rows, total, generatedAt: deps.now() };
    if (deps.cache) {
      await deps.cache.put(key, json(base, { cacheControl: `public, max-age=${LEADERBOARD_TTL}` })).catch(() => undefined);
    }
  }
  if (base.rows.length > limit) base = { ...base, rows: base.rows.slice(0, limit) };
  if (around === null) return json(base, { cacheControl: `public, max-age=${LEADERBOARD_TTL}` });

  // AI 榜按「设备 + 模型」去重，没有单一的「我的名次」
  if (ai) return json({ ...base, me: null }, { cacheControl: 'private, max-age=10' });
  const best = await store.bestOf(board, await hashDevice(deps.salt, around));
  let me = null;
  if (best) {
    const { rank } = await store.rankOf(board, best);
    me = toLeaderRow(best, rank);
  }
  return json({ ...base, me }, { cacheControl: 'private, max-age=10' });
}

// ───────────────────────── GET /api/runs/:id ─────────────────────────

export async function handleGetRun(req: Request, deps: Deps, id: string): Promise<Response> {
  if (req.method !== 'GET') return apiError('method', '请求方式不支持');
  if (!deps.db) return notConfigured();
  if (!RUN_ID_RE.test(id)) return apiError('not_found', '找不到这条成绩（可能已被同一玩家的新纪录替换）');
  const r = await new RunStore(deps.db).getRun(id);
  if (!r || r.status === 'rejected') return apiError('not_found', '找不到这条成绩（可能已被同一玩家的新纪录替换）');
  const detail: RunDetail = {
    id: r.id,
    board: r.board,
    nickname: r.nickname,
    opts: JSON.parse(r.opts_json) as RunDetail['opts'],
    seed: r.seed,
    logGz: r.log_gz,
    result: JSON.parse(r.result_json) as RunDetail['result'],
    gameVersion: r.game_version,
    status: r.status,
    createdAt: Number(r.created_at),
    ...(r.agent_provider && r.agent_model
      ? {
          agent: agentBadge({
            provider: r.agent_provider,
            model: r.agent_model,
            mode: r.agent_mode === 'realtime' ? 'realtime' : 'pause',
            botShare: Number(r.agent_bot_share ?? 0),
          }),
        }
      : {}),
  };
  return json(detail, { cacheControl: 'public, max-age=300' });
}

// ───────────────────────── GET /api/daily /api/status ─────────────────────────

export function todayDaily(now: number): DailyInfo {
  return dailyInfo(dayOf(now));
}

/** 到下一个北京时间零点的秒数（缓存不跨天） */
function secondsToNextDay(now: number): number {
  const DAY = 86_400_000;
  const shifted = now + 8 * 3_600_000;
  return Math.max(1, Math.floor((DAY - (shifted % DAY)) / 1000));
}

export function handleDaily(req: Request, deps: Deps): Response {
  if (req.method !== 'GET') return apiError('method', '请求方式不支持');
  const now = deps.now();
  return json(todayDaily(now), { cacheControl: `public, max-age=${Math.min(300, secondsToNextDay(now))}` });
}

export function handleStatus(req: Request, deps: Deps): Response {
  if (req.method !== 'GET') return apiError('method', '请求方式不支持');
  if (!deps.db) return notConfigured();
  const body: StatusResponse = {
    ok: true,
    gameVersion: (deps.acceptVersions ?? [GAME_VERSION])[0],
    turnstileSiteKey: deps.turnstileSiteKey ?? null,
    daily: todayDaily(deps.now()),
  };
  return json(body, { cacheControl: 'public, max-age=60' });
}
