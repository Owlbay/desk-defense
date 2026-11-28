/**
 * API 处理函数（与 Pages Functions 的路由文件解耦，便于在 vitest 里用假 D1 直接调用）。
 * 免费计划每次请求约 10 ms CPU：这里只做轻量校验，不做回放。
 * 第二阶段的服务端回放校验在 ./admin.ts（REPLAY_VERIFY=1 + ADMIN_TOKEN，需要付费计划，见 docs/12 §5.2）。
 */
import { decodeLogPayload, gzipJsonBase64 } from '../../src/shared/codec';
import {
  checkDuelSubmission,
  checkLog,
  checkSubmission,
  type DailyInfo,
  dailyInfo,
  dayOf,
  DUEL_BOARD,
  type DuelBoardResponse,
  type DuelDetail,
  type DuelMeta,
  effectiveAutoWave,
  GAME_VERSION,
  isAiEffort,
  isDeviceId,
  LEADERBOARD_MAX_LIMIT,
  type LeaderboardResponse,
  MAX_BODY_BYTES,
  normalizeBoardKey,
  RATE_LIMIT,
  type RunDetail,
  type StatusResponse,
  type SubmitResponse,
} from '../../src/shared/leaderboard';
import {
  agentOfRow,
  type BestRow,
  type D1Like,
  duelSideOfRow,
  DuelStore,
  publicAiModel,
  ranksBefore,
  type RunRow,
  RunStore,
  toDuelRow,
  toLeaderRow,
} from './db';
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
  /** 第二阶段：env.REPLAY_VERIFY === '1' 时启用 POST /api/admin/verify（缺省关闭，见 functions/_lib/admin.ts） */
  replayVerify?: boolean;
  /** env.ADMIN_TOKEN（secret）：管理接口的口令；未设置时管理接口不可用 */
  adminToken?: string;
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
 * AI 辅助成绩的去重键：同一台设备在每个榜上「真人最佳」和「AI 辅助最佳」各保留一条
 * （复用 runs 表的 UNIQUE(board, device_hash)，两者不会互相覆盖）。
 */
export const hashAiDevice = async (salt: string, deviceId: string): Promise<string> =>
  (await sha256Hex(`${salt}|dev|${deviceId.toLowerCase()}|ai`)).slice(0, 32);
/** AI 对战：设备 + 对阵组合（进攻模型 / 档位 × 防守模型 / 档位）——每个组合各保留最好的一条 */
export const hashDuelDevice = async (salt: string, deviceId: string, d: DuelMeta): Promise<string> =>
  (
    await sha256Hex(
      `${salt}|dev|${deviceId.toLowerCase()}|duel|${d.attacker.model}|${d.attacker.effort ?? ''}|${d.defender.model}|${d.defender.effort ?? ''}`,
    )
  ).slice(0, 32);
/** AI 对战：只按设备（查「我的最佳」） */
export const hashDuelOwner = async (salt: string, deviceId: string): Promise<string> =>
  (await sha256Hex(`${salt}|dev|${deviceId.toLowerCase()}|duel`)).slice(0, 32);
export const hashIp = async (salt: string, ip: string): Promise<string> => (await sha256Hex(`${salt}|ip|${ip}`)).slice(0, 32);

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
export function randomId(len = 14): string {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => ID_ALPHABET[b % 36]).join('');
}

const RUN_ID_RE = /^[0-9a-z]{8,32}$/;

export const clientIp = (req: Request): string =>
  req.headers.get('CF-Connecting-IP') ?? req.headers.get('X-Forwarded-For')?.split(',')[0].trim() ?? 'unknown';

export function notConfigured(): Response {
  return apiError('not_configured', '在线功能暂未开放（服务器未配置数据库）');
}

/** 清掉某榜所有档位的边缘缓存（有人刷新纪录 / 有成绩被判作弊时） */
export async function purgeBoardCache(deps: Deps, origin: string, board: string): Promise<void> {
  if (!deps.cache) return;
  await Promise.all(
    LIMIT_PRESETS.flatMap((l) => [false, true].map((h) => deps.cache!.delete(leaderboardCacheKey(origin, board, l, h)).catch(() => false))),
  );
}

export function leaderboardCacheKey(origin: string, board: string, limit: number, hideAi = false): string {
  return `${origin}/api/leaderboard?board=${encodeURIComponent(board)}&limit=${limit}&hideAi=${hideAi ? 1 : 0}`;
}

export async function verifyTurnstile(deps: Deps, token: string | undefined, ip: string): Promise<boolean> {
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
    device_hash: sub.ai ? await hashAiDevice(deps.salt, sub.deviceId) : (deviceHash as string),
    score: sub.result.score,
    wave: sub.result.wave,
    kills: sub.result.kills,
    lives: sub.result.lives,
    seed: sub.seed,
    map: sub.opts.map,
    difficulty: sub.opts.difficulty,
    abyss: sub.opts.difficulty === 'abyss' ? (sub.opts.abyssLevel ?? 1) : 0,
    pure: sub.opts.pure ? 1 : 0,
    auto_wave: effectiveAutoWave(sub.opts) ? 1 : 0,
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
    // AI 参战取 agent.botShare；中途接管的 AI 辅助局取 aiAssist.botShare（docs/10 §18-6）；其他为 NULL
    agent_bot_share: sub.botShare,
    agent_json: sub.agent ? JSON.stringify(sub.agent) : null,
    ai: sub.ai ? 1 : 0,
    ai_model: sub.aiModel,
    stars: sub.stars,
    won: sub.result.won ? 1 : 0,
    ai_effort: sub.aiEffort,
  };
  const { improved } = await store.upsertBest(row);
  const best = await store.bestOf(sub.board, row.device_hash);
  if (!best) return apiError('internal', '保存成绩失败，请稍后再试');
  // 名次按「包含 AI 辅助」的完整榜算（隐藏 AI 时界面会重新查询）
  const { rank, total } = await store.rankOf(sub.board, best, true);

  if (improved) await purgeBoardCache(deps, new URL(req.url).origin, sub.board);
  const res: SubmitResponse = { id: best.id, rank, total, improved, status: best.status };
  return json(res, { status: improved ? 201 : 200 });
}

// ───────────────────────── GET /api/leaderboard ─────────────────────────

export async function handleLeaderboard(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'GET') return apiError('method', '请求方式不支持');
  if (!deps.db) return notConfigured();
  const url = new URL(req.url);
  // 旧榜键（'normal:auto' / 'ai:hard' …）归一到新榜（endless）
  const board = normalizeBoardKey(url.searchParams.get('board') ?? '');
  if (!board) return apiError('bad_request', '排行榜不存在');
  const limitRaw = Number(url.searchParams.get('limit') ?? '20');
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(LEADERBOARD_MAX_LIMIT, Math.floor(limitRaw))) : 20;
  const around = url.searchParams.get('around');
  if (around !== null && !isDeviceId(around)) return apiError('bad_request', '设备标识无效');
  const hideAi = url.searchParams.get('hideAi') === '1';
  const includeAi = !hideAi;

  const store = new RunStore(deps.db);
  // 缓存按档位（10/20/50/100）× 是否隐藏 AI 存，任意 limit 都落到某一档再截断，提交新纪录时能全部清掉
  const bucket = LIMIT_PRESETS.find((l) => l >= limit) ?? LEADERBOARD_MAX_LIMIT;
  const key = leaderboardCacheKey(url.origin, board, bucket, hideAi);
  let base: LeaderboardResponse | null = null;
  if (deps.cache) {
    const hit = await deps.cache.match(key).catch(() => undefined);
    if (hit) base = (await hit.json()) as LeaderboardResponse;
  }
  if (!base) {
    const [rows, total] = await Promise.all([store.top(board, bucket, includeAi), store.total(board, includeAi)]);
    base = { board, rows, total, hideAi, generatedAt: deps.now() };
    if (deps.cache) {
      await deps.cache.put(key, json(base, { cacheControl: `public, max-age=${LEADERBOARD_TTL}` })).catch(() => undefined);
    }
  }
  if (base.rows.length > limit) base = { ...base, rows: base.rows.slice(0, limit) };
  if (around === null) return json(base, { cacheControl: `public, max-age=${LEADERBOARD_TTL}` });

  // 我的最佳：真人最佳；包含 AI 时再和 AI 辅助最佳比，取排名更靠前的那条
  const [human, aiBest] = await Promise.all([
    store.bestOf(board, await hashDevice(deps.salt, around)),
    includeAi ? store.bestOf(board, await hashAiDevice(deps.salt, around)) : Promise.resolve(null),
  ]);
  const pick = (a: BestRow | null, b: BestRow | null): BestRow | null => {
    if (!a || !b) return a ?? b;
    const key = (r: BestRow) => ({
      id: r.id,
      stars: Number(r.stars),
      score: Number(r.score),
      wave: Number(r.wave),
      created_at: Number(r.created_at),
    });
    return ranksBefore(key(b), key(a)) ? b : a;
  };
  const best = pick(human, aiBest);
  let me = null;
  if (best) {
    const { rank } = await store.rankOf(board, best, includeAi);
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
    ai: Number(r.ai) === 1 || !!r.agent_provider,
    ...(publicAiModel(r.ai_model || r.agent_model) ? { aiModel: publicAiModel(r.ai_model || r.agent_model) } : {}),
    ...(isAiEffort(r.ai_effort) ? { aiEffort: r.ai_effort } : {}),
    ...(agentOfRow(r) ? { agent: agentOfRow(r) } : {}),
  };
  return json(detail, { cacheControl: 'public, max-age=300' });
}

// ───────────────────────── AI 对战榜：POST/GET /api/duels、GET /api/duels/:id ─────────────────────────

export function duelCacheKey(origin: string, limit: number): string {
  return `${origin}/api/duels?limit=${limit}`;
}

async function purgeDuelCache(deps: Deps, origin: string): Promise<void> {
  if (!deps.cache) return;
  await Promise.all(LIMIT_PRESETS.map((l) => deps.cache!.delete(duelCacheKey(origin, l)).catch(() => false)));
}

/** POST /api/duels：AI 对战成绩（与 /api/runs 同一套限流 / 人机验证 / 轻量校验，日志允许 overrideWave） */
export async function handleDuelSubmit(req: Request, deps: Deps): Promise<Response> {
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

  const ip = clientIp(req);
  const ipHash = await hashIp(deps.salt, ip);
  const rawDevice = (body as { deviceId?: unknown } | null)?.deviceId;
  const deviceHash = isDeviceId(rawDevice) ? await hashDevice(deps.salt, rawDevice) : null;
  const rate = deps.rate ?? new D1RateLimitStore(deps.db);
  const rl = await checkRateLimit(rate, [`ip:${ipHash}`, ...(deviceHash ? [`dev:${deviceHash}`] : [])], now, RATE_LIMIT);
  if (!rl.ok) {
    return apiError('rate_limited', `提交太频繁了，请 ${Math.ceil(rl.retryAfter / 60)} 分钟后再试`, { retryAfter: rl.retryAfter });
  }

  const checked = checkDuelSubmission(body, { now, acceptVersions: deps.acceptVersions ?? [GAME_VERSION] });
  if (!checked.ok) return apiError(checked.message.startsWith('游戏版本') ? 'version' : 'bad_request', checked.message);
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
  const logChecked = checkLog(decoded.log, sub.result, sub.opts, { allowOverride: true });
  if (!logChecked.ok) return apiError('bad_request', logChecked.message);
  const plans = logChecked.value.filter((e) => e.cmd.type === 'overrideWave').length;
  const logGz = Array.isArray(sub.log) ? await gzipJsonBase64(logChecked.value) : sub.log.gz;
  const d = sub.duel;
  const store = new DuelStore(deps.db);
  const row = {
    id: (deps.newId ?? randomId)(),
    nickname: sub.nickname,
    device_hash: await hashDuelDevice(deps.salt, sub.deviceId, d),
    owner_hash: await hashDuelOwner(deps.salt, sub.deviceId),
    mode: sub.opts.mode,
    map: sub.opts.map,
    difficulty: sub.opts.difficulty,
    abyss: sub.opts.difficulty === 'abyss' ? (sub.opts.abyssLevel ?? 1) : 0,
    wave: sub.result.wave,
    score: sub.result.score,
    kills: sub.result.kills,
    lives: sub.result.lives,
    won: sub.result.won ? 1 : 0,
    stars: sub.stars,
    plans,
    seed: sub.seed,
    game_version: sub.gameVersion,
    opts_json: JSON.stringify(sub.opts),
    result_json: JSON.stringify(sub.result),
    log_gz: logGz,
    log_bytes: decoded.rawBytes,
    atk_model: d.attacker.model,
    atk_effort: d.attacker.effort ?? null,
    atk_scripted: d.attacker.scripted ? 1 : 0,
    atk_bot_share: d.attacker.botShare,
    def_model: d.defender.model,
    def_effort: d.defender.effort ?? null,
    def_scripted: d.defender.scripted ? 1 : 0,
    def_bot_share: d.defender.botShare,
    // 出题次数以日志为准
    duel_json: JSON.stringify({ ...d, plans }),
    created_at: now,
    ip_hash: ipHash,
  };
  const { improved } = await store.upsertBest(row);
  const best = await store.bestOf(row.device_hash);
  if (!best) return apiError('internal', '保存成绩失败，请稍后再试');
  const { rank, total } = await store.rankOf(best);
  if (improved) await purgeDuelCache(deps, new URL(req.url).origin);
  const res: SubmitResponse = { id: best.id, rank, total, improved, status: 'pending' };
  return json(res, { status: improved ? 201 : 200 });
}

/** GET /api/duels?limit=20[&around=deviceId] */
export async function handleDuelBoard(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'GET') return apiError('method', '请求方式不支持');
  if (!deps.db) return notConfigured();
  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get('limit') ?? '20');
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(LEADERBOARD_MAX_LIMIT, Math.floor(limitRaw))) : 20;
  const around = url.searchParams.get('around');
  if (around !== null && !isDeviceId(around)) return apiError('bad_request', '设备标识无效');
  const store = new DuelStore(deps.db);
  const bucket = LIMIT_PRESETS.find((l) => l >= limit) ?? LEADERBOARD_MAX_LIMIT;
  const key = duelCacheKey(url.origin, bucket);
  let base: DuelBoardResponse | null = null;
  if (deps.cache) {
    const hit = await deps.cache.match(key).catch(() => undefined);
    if (hit) base = (await hit.json()) as DuelBoardResponse;
  }
  if (!base) {
    const [rows, total] = await Promise.all([store.top(bucket), store.total()]);
    base = { board: DUEL_BOARD, rows, total, generatedAt: deps.now() };
    if (deps.cache) await deps.cache.put(key, json(base, { cacheControl: `public, max-age=${LEADERBOARD_TTL}` })).catch(() => undefined);
  }
  if (base.rows.length > limit) base = { ...base, rows: base.rows.slice(0, limit) };
  if (around === null) return json(base, { cacheControl: `public, max-age=${LEADERBOARD_TTL}` });
  const best = await store.bestOfOwner(await hashDuelOwner(deps.salt, around));
  const me = best ? toDuelRow(best, (await store.rankOf(best)).rank) : null;
  return json({ ...base, me }, { cacheControl: 'private, max-age=10' });
}

/** GET /api/duels/:id —— 对战详情（回放用；只有模型名 + 档位，不含渠道） */
export async function handleGetDuel(req: Request, deps: Deps, id: string): Promise<Response> {
  if (req.method !== 'GET') return apiError('method', '请求方式不支持');
  if (!deps.db) return notConfigured();
  const missing = (): Response => apiError('not_found', '找不到这条对战记录（可能已被同一组合的新纪录替换）');
  if (!RUN_ID_RE.test(id)) return missing();
  const r = await new DuelStore(deps.db).getRun(id);
  if (!r) return missing();
  const detail: DuelDetail = {
    id: r.id,
    nickname: r.nickname,
    opts: JSON.parse(r.opts_json) as DuelDetail['opts'],
    seed: r.seed,
    logGz: r.log_gz,
    result: JSON.parse(r.result_json) as DuelDetail['result'],
    gameVersion: r.game_version,
    createdAt: Number(r.created_at),
    attacker: duelSideOfRow(r.atk_model, r.atk_effort, r.atk_scripted, r.atk_bot_share),
    defender: duelSideOfRow(r.def_model, r.def_effort, r.def_scripted, r.def_bot_share),
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
