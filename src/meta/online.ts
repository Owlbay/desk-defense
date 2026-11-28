/**
 * 全服排行榜客户端（文档 12）。
 *
 * - 设备 id：随机 UUID，存在 localStorage（服务端只存其加盐哈希）
 * - 昵称：独立于存档的 localStorage 键；没设过时用默认昵称（「玩家」+ 设备 id 前 4 位），不再弹框
 * - 自动上传：缺省开启（AUTO_UPLOAD_KEY），结算时直接上传；关掉后结算面板给一个「上传成绩」按钮
 * - 提交成绩：指令日志用 CompressionStream('gzip') 压缩（不支持时直接发 JSON）；
 *   断网 / 服务不可用 / 被限流时进入离线队列，下次启动或 online 事件时重试
 * - API 不存在（例如本地 `vite dev`）时状态为 'unavailable'，所有函数都不会抛异常
 *
 * UI 用法：启动时 initOnline()；subscribeOnline(fn) 订阅状态；结算时 submitWorldRun(world, {...})。
 */
import { localize } from '../config/text';
import type { RunOptions, WorldState } from '../core/types';
import { getLocale, t } from '../i18n';
import { decodeLogPayload, encodeLog } from '../shared/codec';
import type { FeedbackBody, FeedbackResponse } from '../shared/feedback';
import {
  type AgentMeta,
  type AiAssistMeta,
  type ApiError,
  boardForOpts,
  type Checked,
  type ClaimedResult,
  type DailyInfo,
  dailyInfo,
  dayOf,
  type DuelBoardResponse,
  type DuelDetail,
  type DuelMeta,
  type DuelSubmitBody,
  GAME_VERSION,
  isAiEffort,
  isDeviceId,
  type LeaderboardResponse,
  type LogEntry,
  publicModelName,
  type RunDetail,
  sanitizeNickname,
  starsFor,
  type StatusResponse,
  type SubmitBody,
  type SubmitResponse,
} from '../shared/leaderboard';
import { type AiAssist, isAiAssisted } from './aiAssist';
import type { MidRun } from './profile';
import { type KV, safeStorage } from './storage';

export const DEVICE_KEY = 'desk-defense.online.device.v1';
export const NICK_KEY = 'desk-defense.online.nickname.v1';
export const QUEUE_KEY = 'desk-defense.online.queue.v1';
/** 「自动上传成绩」开关（缺省开启；'0' = 关闭） */
export const AUTO_UPLOAD_KEY = 'desk-defense.online.autoUpload.v1';
export const QUEUE_MAX = 20;
/** 队列里的成绩最多保留 7 天 */
export const QUEUE_TTL_MS = 7 * 86_400_000;

// ───────────────────────── 状态 ─────────────────────────

/**
 * unknown：还没探测；online：API 可用；offline：网络不通（会自动重试）；
 * unavailable：API 未部署 / 未配置（如本地 vite dev），界面应显示「在线功能不可用」。
 */
export type OnlineStatus = 'unknown' | 'online' | 'offline' | 'unavailable';

export interface OnlineState {
  status: OnlineStatus;
  /** 给玩家看的中文说明 */
  message: string;
  /** 离线队列里待上传的成绩数 */
  pending: number;
  serverVersion: string | null;
  turnstileSiteKey: string | null;
  /** 今日挑战（离线时由本地推算，与服务端一致） */
  daily: DailyInfo | null;
}

/** 联网状态文本（读取时按当前语言：core.online.status.<status>） */
const STATUS_TEXT: Record<OnlineStatus, string> = localize({}, 'core.online.status', [
  'unknown',
  'online',
  'offline',
  'unavailable',
] as const);

interface Config {
  fetch: typeof fetch;
  storage: KV;
  baseUrl: string;
  now: () => number;
}

let cfg: Config | null = null;
const conf = (): Config => {
  if (!cfg) {
    cfg = {
      fetch: (input, init) => fetch(input, init),
      storage: safeStorage(),
      baseUrl: '',
      now: () => Date.now(),
    };
  }
  return cfg;
};

let state: OnlineState = {
  status: 'unknown',
  message: STATUS_TEXT.unknown,
  pending: 0,
  serverVersion: null,
  turnstileSiteKey: null,
  daily: null,
};
const listeners = new Set<(s: OnlineState) => void>();

function setState(patch: Partial<OnlineState>): void {
  state = { ...state, ...patch };
  if (patch.status && !patch.message) state.message = STATUS_TEXT[patch.status];
  for (const fn of listeners) {
    try {
      fn(state);
    } catch {
      /* ignore */
    }
  }
}

export const getOnlineState = (): OnlineState => state;

/** 订阅在线状态（立即回调一次），返回取消订阅函数 */
export function subscribeOnline(fn: (s: OnlineState) => void): () => void {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

/** 测试 / 特殊部署用：替换 fetch、存储、API 前缀、时钟 */
export function configureOnline(c: Partial<Config>): void {
  cfg = { ...conf(), ...c };
  state = { ...state, pending: readQueue().length };
}

// ───────────────────────── 设备 id / 昵称 ─────────────────────────

function randomUuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 本设备的随机 id（首次调用时生成并保存） */
export function getDeviceId(): string {
  const kv = conf().storage;
  let id: string | null;
  try {
    id = kv.get(DEVICE_KEY);
  } catch {
    id = null;
  }
  if (!isDeviceId(id)) {
    id = randomUuid();
    try {
      kv.set(DEVICE_KEY, id);
    } catch {
      /* ignore */
    }
  }
  return id.toLowerCase();
}

/**
 * 默认昵称：本地化前缀（玩家 / Player / プレイヤー）+ 设备 id 的前 4 位（大写）。
 * 不用弹框问昵称，第一局就能直接上榜；之后可以在排行榜页或结算面板改名。
 */
export function defaultNickname(deviceId: string, prefix: string): string {
  const tag =
    deviceId
      .replace(/[^0-9a-z]/gi, '')
      .slice(0, 4)
      .toUpperCase() || '0000';
  const r = sanitizeNickname(`${prefix}${tag}`);
  return r.ok ? r.value : `P${tag}`;
}

/** 玩家自己设过的昵称（没有则返回空串） */
export function getCustomNickname(): string {
  try {
    return conf().storage.get(NICK_KEY) ?? '';
  } catch {
    return '';
  }
}

/** 上传用的昵称：自己设过的，否则是默认昵称（永远非空） */
export function getNickname(): string {
  const n = getCustomNickname();
  if (n && sanitizeNickname(n).ok) return n;
  return defaultNickname(getDeviceId(), t('core.online.nickPrefix'));
}

/** 是否还在用默认昵称 */
export const isDefaultNickname = (): boolean => !getCustomNickname();

/** 校验并保存昵称；失败返回中文原因 */
export function setNickname(raw: string): Checked<string> {
  const r = sanitizeNickname(raw);
  if (r.ok) {
    try {
      conf().storage.set(NICK_KEY, r.value);
    } catch {
      /* ignore */
    }
  }
  return r;
}

/** 「自动上传成绩」（缺省开启） */
export function getAutoUpload(): boolean {
  try {
    return conf().storage.get(AUTO_UPLOAD_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setAutoUpload(on: boolean): void {
  try {
    if (on) conf().storage.remove(AUTO_UPLOAD_KEY);
    else conf().storage.set(AUTO_UPLOAD_KEY, '0');
  } catch {
    /* ignore */
  }
}

// ───────────────────────── 请求 ─────────────────────────

type CallResult<T> =
  | { kind: 'ok'; status: number; data: T }
  | { kind: 'api'; status: number; error: ApiError }
  | { kind: 'offline'; message: string }
  | { kind: 'unavailable'; message: string };

/**
 * 服务端（Pages Functions）没有 i18n，错误信息固定是简体中文。
 * 简体中文界面直接用服务端的原文（更具体）；其他语言按错误码换成本地化的通用说明（core.api.<code>）。
 */
const API_CODES = [
  'bad_request',
  'version',
  'too_large',
  'rate_limited',
  'turnstile',
  'forbidden',
  'not_found',
  'method',
  'not_configured',
  'internal',
];
function apiMessage(code: string, serverMessage: string | undefined, retryAfter?: number): string | undefined {
  if (getLocale() === 'zh-CN' && serverMessage) return serverMessage;
  if (API_CODES.includes(code)) return t(`core.api.${code}`, { min: Math.max(1, Math.ceil((retryAfter ?? 60) / 60)) });
  return serverMessage;
}

async function call<T>(path: string, init?: RequestInit): Promise<CallResult<T>> {
  const c = conf();
  let res: Response;
  try {
    res = await c.fetch(`${c.baseUrl}${path}`, {
      ...init,
      headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers ?? {}) },
    });
  } catch {
    return { kind: 'offline', message: STATUS_TEXT.offline };
  }
  const ct = res.headers.get('Content-Type') ?? '';
  // vite dev / 静态托管没有 API：返回 index.html 或纯 404
  if (!ct.includes('application/json')) return { kind: 'unavailable', message: STATUS_TEXT.unavailable };
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { kind: 'unavailable', message: STATUS_TEXT.unavailable };
  }
  if (res.ok) return { kind: 'ok', status: res.status, data: data as T };
  const err = data as Partial<ApiError>;
  if (typeof err?.error !== 'string') return { kind: 'unavailable', message: STATUS_TEXT.unavailable };
  if (err.error === 'not_configured')
    return { kind: 'unavailable', message: apiMessage(err.error, err.message, err.retryAfter) ?? STATUS_TEXT.unavailable };
  const message = apiMessage(err.error, err.message, err.retryAfter) ?? t('core.online.requestFailed');
  return {
    kind: 'api',
    status: res.status,
    error: { error: err.error, message, ...(err.retryAfter ? { retryAfter: err.retryAfter } : {}) },
  };
}

function noteTransport<T>(r: CallResult<T>): void {
  if (r.kind === 'offline') setState({ status: 'offline' });
  else if (r.kind === 'unavailable') setState({ status: 'unavailable', message: r.message });
  else if (state.status !== 'online') setState({ status: 'online' });
}

export type Fetched<T> = { ok: true; data: T } | { ok: false; status: OnlineStatus; message: string };

function toFetched<T>(r: CallResult<T>): Fetched<T> {
  noteTransport(r);
  if (r.kind === 'ok') return { ok: true, data: r.data };
  if (r.kind === 'api') return { ok: false, status: 'online', message: r.error.message };
  return { ok: false, status: r.kind, message: r.message };
}

// ───────────────────────── 探测 / 初始化 ─────────────────────────

let initialized = false;

/** 探测 API 并上传离线队列；可重复调用（例如进入排行榜页面时） */
export async function probeOnline(): Promise<OnlineState> {
  const r = await call<StatusResponse>('/api/status');
  noteTransport(r);
  if (r.kind === 'ok') {
    setState({ serverVersion: r.data.gameVersion, turnstileSiteKey: r.data.turnstileSiteKey, daily: r.data.daily });
    if (r.data.gameVersion !== GAME_VERSION) setState({ message: t('core.online.newVersion') });
    await flushQueue();
  } else if (!state.daily) {
    setState({ daily: dailyInfo(dayOf(conf().now())) });
  }
  return state;
}

/** 游戏启动时调用一次：探测 + 重试队列 + 监听 online 事件 */
export function initOnline(): Promise<OnlineState> {
  if (!initialized) {
    initialized = true;
    setState({ pending: readQueue().length });
    try {
      if (typeof window !== 'undefined') window.addEventListener('online', () => void probeOnline());
    } catch {
      /* ignore */
    }
  }
  return probeOnline().catch(() => state);
}

// ───────────────────────── Turnstile ─────────────────────────

let turnstileProvider: (() => Promise<string | null>) | null = null;

/**
 * 服务端开启 Turnstile 时（state.turnstileSiteKey 非空），UI 提供一个取 token 的函数
 * （例如渲染隐形挑战并等待回调）。每次发送前都会调用一次，因为 token 只能用一次。
 */
export function setTurnstileProvider(fn: (() => Promise<string | null>) | null): void {
  turnstileProvider = fn;
}

// ───────────────────────── 离线队列 ─────────────────────────

interface QueueItem {
  body: Omit<SubmitBody, 'turnstileToken'> | Omit<DuelSubmitBody, 'turnstileToken'>;
  queuedAt: number;
  attempts: number;
  /** 'duel' = AI 对战成绩（POST /api/duels）；缺省 = 普通成绩（POST /api/runs） */
  kind?: 'duel';
}

const RUNS_PATH = '/api/runs';
const DUELS_PATH = '/api/duels';

function readQueue(): QueueItem[] {
  try {
    const raw = conf().storage.get(QUEUE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    const now = conf().now();
    return arr.filter(
      (x): x is QueueItem =>
        !!x && typeof x === 'object' && typeof (x as QueueItem).queuedAt === 'number' && now - (x as QueueItem).queuedAt < QUEUE_TTL_MS,
    );
  } catch {
    return [];
  }
}

function writeQueue(q: QueueItem[]): void {
  const trimmed = q.slice(-QUEUE_MAX);
  try {
    if (trimmed.length) conf().storage.set(QUEUE_KEY, JSON.stringify(trimmed));
    else conf().storage.remove(QUEUE_KEY);
  } catch {
    /* ignore */
  }
  setState({ pending: trimmed.length });
}

export const pendingCount = (): number => readQueue().length;

// ───────────────────────── 提交 ─────────────────────────

export type SubmitOutcome =
  /** 已上传（res 含名次） */
  | { kind: 'ok'; res: SubmitResponse }
  /** 暂时传不上，已放进离线队列 */
  | { kind: 'queued'; message: string }
  /** 服务端拒收（数据不合法 / 版本过旧等），不会重试 */
  | { kind: 'rejected'; message: string };

export interface SubmitInput {
  opts: RunOptions;
  log: LogEntry[];
  result: ClaimedResult;
  /** 每日挑战的日期（DailyInfo.day）；无尽榜不填 */
  dailyDay?: string | null;
  /** 缺省用 getNickname() */
  nickname?: string;
  /** 「AI 参战」对局：成绩进同一个榜，带「AI 辅助」+ 模型标记 */
  agent?: AgentMeta;
  /** 用过「让 AI 替我玩」：成绩进同一个榜，带「AI 辅助」标记 */
  aiAssist?: AiAssistMeta;
}

const RETRYABLE_CODES = new Set(['rate_limited', 'turnstile', 'internal', 'not_configured']);

async function send(
  body: Omit<SubmitBody, 'turnstileToken'> | Omit<DuelSubmitBody, 'turnstileToken'>,
  path: string = RUNS_PATH,
): Promise<{ outcome: SubmitOutcome; retry: boolean }> {
  let token: string | null = null;
  if (state.turnstileSiteKey && turnstileProvider) {
    try {
      token = await turnstileProvider();
    } catch {
      token = null;
    }
  }
  const full = { ...body, ...(token ? { turnstileToken: token } : {}) };
  const r = await call<SubmitResponse>(path, { method: 'POST', body: JSON.stringify(full) });
  noteTransport(r);
  if (r.kind === 'ok') return { outcome: { kind: 'ok', res: r.data }, retry: false };
  if (r.kind === 'api') {
    const retry = RETRYABLE_CODES.has(r.error.error) || r.status >= 500;
    return { outcome: retry ? { kind: 'queued', message: r.error.message } : { kind: 'rejected', message: r.error.message }, retry };
  }
  return { outcome: { kind: 'queued', message: r.message }, retry: true };
}

/** 组装请求体（压缩日志）；昵称不合法时返回错误 */
export async function buildSubmitBody(input: SubmitInput): Promise<Checked<Omit<SubmitBody, 'turnstileToken'>>> {
  const nick = sanitizeNickname(input.nickname ?? getNickname());
  if (!nick.ok) return nick;
  const seed = input.opts.seed ?? '';
  return {
    ok: true,
    value: {
      nickname: nick.value,
      deviceId: getDeviceId(),
      board: boardForOpts(input.opts, input.dailyDay ?? null),
      opts: JSON.parse(JSON.stringify(input.opts)) as RunOptions,
      seed,
      log: await encodeLog(input.log),
      result: input.result,
      gameVersion: GAME_VERSION,
      ...(input.agent ? { agent: input.agent } : input.aiAssist ? { aiAssist: input.aiAssist } : {}),
    },
  };
}

/** 上传一局成绩。网络 / 服务问题时自动进入离线队列。永不抛异常。 */
export async function submitRun(input: SubmitInput): Promise<SubmitOutcome> {
  try {
    const built = await buildSubmitBody(input);
    if (!built.ok) return { kind: 'rejected', message: built.message };
    if (state.serverVersion && state.serverVersion !== GAME_VERSION) {
      return { kind: 'rejected', message: t('core.online.newVersion') };
    }
    // 先把队列里更早的成绩传掉，保证顺序
    if (readQueue().length) await flushQueue();
    const { outcome, retry } = await send(built.value);
    if (retry) {
      const q = readQueue();
      q.push({ body: built.value, queuedAt: conf().now(), attempts: 1 });
      writeQueue(q);
    }
    return outcome;
  } catch {
    return { kind: 'rejected', message: t('core.online.uploadFailed') };
  }
}

/** 从结束时的 world 取声明结果（wavesSurvived 与本地结算一致：失败时 = 当前波 - 1）；战役附带评星 */
export function resultFromWorld(
  st: Pick<WorldState, 'score' | 'lives' | 'gold' | 'tick' | 'stats'> & Partial<Pick<WorldState, 'phase' | 'maxLives' | 'opts'>>,
  wavesSurvived: number,
  extra: { cleared?: number; bonus?: number } = {},
): ClaimedResult {
  const campaign = st.opts?.mode === 'campaign';
  const won = campaign && st.phase === 'won';
  return {
    wave: wavesSurvived,
    score: Math.round(st.score),
    kills: st.stats.kills,
    lives: st.lives,
    gold: st.gold,
    won,
    ticks: st.tick,
    ...extra,
    ...(campaign
      ? won
        ? { maxLives: Math.max(st.lives, st.maxLives ?? st.lives), stars: starsFor(st.lives, Math.max(st.lives, st.maxLives ?? st.lives)) }
        : { stars: 0 }
      : {}),
  };
}

/**
 * 结算时的便捷入口：world 结束后直接调用。
 * AI 辅助的对局照常上传（带标记）：agent = 「AI 参战」，aiAssist.player = 「让 AI 替我玩」；只用过军师不算 AI 辅助。
 */
export function submitWorldRun(
  world: {
    readonly log: readonly LogEntry[];
    readonly state: Pick<WorldState, 'score' | 'lives' | 'gold' | 'tick' | 'stats' | 'opts' | 'seed'> &
      Partial<Pick<WorldState, 'phase' | 'maxLives'>>;
  },
  o: {
    wavesSurvived: number;
    dailyDay?: string | null;
    nickname?: string;
    agent?: AgentMeta;
    aiAssist?: AiAssist | null;
    /** AI 辅助局里兜底机器人的决策占比 0..1（知道时才填；> 20% 榜上标「兜底多」） */
    aiBotShare?: number;
  },
): Promise<SubmitOutcome> {
  const st = world.state;
  const opts: RunOptions = { ...st.opts, seed: st.opts.seed ?? st.seed };
  const rawShare = o.aiBotShare ?? o.aiAssist?.botShare;
  const share =
    typeof rawShare === 'number' && Number.isFinite(rawShare)
      ? { botShare: Math.round(Math.max(0, Math.min(1, rawShare)) * 1000) / 1000 }
      : {};
  // 只发模型名 + 思考档位（旧存档里的模型名可能是「服务商 · 模型」的界面标签，这里再清洗一次）
  const model = publicModelName(o.aiAssist?.model);
  const assist: AiAssistMeta | undefined =
    !o.agent && isAiAssisted(o.aiAssist)
      ? { ...(model ? { model } : {}), ...(model && isAiEffort(o.aiAssist?.effort) ? { effort: o.aiAssist.effort } : {}), ...share }
      : undefined;
  return submitRun({
    opts,
    log: world.log.map((e) => ({ tick: e.tick, cmd: e.cmd })),
    result: resultFromWorld(st, o.wavesSurvived),
    dailyDay: o.dailyDay ?? null,
    nickname: o.nickname,
    ...(o.agent ? { agent: o.agent } : {}),
    ...(assist ? { aiAssist: assist } : {}),
  });
}

// ───────────────────────── AI 对战榜 ─────────────────────────

/** 上传一局 AI 对战（独立的对战榜；只带模型名 + 思考档位）。网络 / 服务问题时进离线队列。永不抛异常。 */
export async function submitDuel(
  world: {
    readonly log: readonly LogEntry[];
    readonly state: Pick<WorldState, 'score' | 'lives' | 'gold' | 'tick' | 'stats' | 'opts' | 'seed'> &
      Partial<Pick<WorldState, 'phase' | 'maxLives'>>;
  },
  o: { wavesSurvived: number; duel: DuelMeta; nickname?: string },
): Promise<SubmitOutcome> {
  try {
    const nick = sanitizeNickname(o.nickname ?? getNickname());
    if (!nick.ok) return { kind: 'rejected', message: nick.message };
    if (state.serverVersion && state.serverVersion !== GAME_VERSION) return { kind: 'rejected', message: t('core.online.newVersion') };
    const st = world.state;
    const opts: RunOptions = { ...st.opts, seed: st.opts.seed ?? st.seed };
    const body: Omit<DuelSubmitBody, 'turnstileToken'> = {
      nickname: nick.value,
      deviceId: getDeviceId(),
      opts: JSON.parse(JSON.stringify(opts)) as RunOptions,
      seed: opts.seed ?? '',
      log: await encodeLog(world.log.map((e) => ({ tick: e.tick, cmd: e.cmd }))),
      result: resultFromWorld(st, o.wavesSurvived),
      gameVersion: GAME_VERSION,
      duel: o.duel,
    };
    if (readQueue().length) await flushQueue();
    const { outcome, retry } = await send(body, DUELS_PATH);
    if (retry) {
      const q = readQueue();
      q.push({ body, queuedAt: conf().now(), attempts: 1, kind: 'duel' });
      writeQueue(q);
    }
    return outcome;
  } catch {
    return { kind: 'rejected', message: t('core.online.uploadFailed') };
  }
}

/** AI 对战榜前 N 名；around = true 时附带本设备最好的一条（me） */
export async function fetchDuelBoard(o: { limit?: number; around?: boolean } = {}): Promise<Fetched<DuelBoardResponse>> {
  const p = new URLSearchParams({ limit: String(o.limit ?? 20) });
  if (o.around) p.set('around', getDeviceId());
  return toFetched(await call<DuelBoardResponse>(`${DUELS_PATH}?${p.toString()}`));
}

export interface DuelReplay extends DuelDetail {
  log: LogEntry[];
}

/** 拉取一条对战记录（解压日志），用于观看回放 */
export async function fetchDuel(id: string): Promise<Fetched<DuelReplay>> {
  const r = toFetched(await call<DuelDetail>(`${DUELS_PATH}/${encodeURIComponent(id)}`));
  if (!r.ok) return r;
  try {
    const { log } = await decodeLogPayload({ gz: r.data.logGz });
    return { ok: true, data: { ...r.data, log: log as LogEntry[] } };
  } catch {
    return { ok: false, status: 'online', message: t('core.online.replayCorrupt') };
  }
}

let flushing: Promise<number> | null = null;

/** 依次重试离线队列，返回本次成功上传的条数 */
export function flushQueue(): Promise<number> {
  if (flushing) return flushing;
  flushing = (async () => {
    let sent = 0;
    try {
      const q = readQueue();
      while (q.length) {
        const item = q[0];
        if (item.body.gameVersion !== GAME_VERSION) {
          q.shift();
          continue;
        }
        const { outcome, retry } = await send(item.body, item.kind === 'duel' ? DUELS_PATH : RUNS_PATH);
        if (retry) {
          item.attempts++;
          break;
        }
        q.shift();
        if (outcome.kind === 'ok') sent++;
      }
      writeQueue(q);
    } catch {
      /* ignore */
    } finally {
      flushing = null;
    }
    return sent;
  })();
  return flushing;
}

// ───────────────────────── 查询 ─────────────────────────

/** 拉取某榜前 N 名；around = true 时附带本设备的最佳名次（me）；hideAi = true 时隐藏 AI 辅助的成绩 */
export async function fetchLeaderboard(
  board: string,
  o: { limit?: number; around?: boolean; hideAi?: boolean } = {},
): Promise<Fetched<LeaderboardResponse>> {
  const p = new URLSearchParams({ board, limit: String(o.limit ?? 20) });
  if (o.around) p.set('around', getDeviceId());
  if (o.hideAi) p.set('hideAi', '1');
  return toFetched(await call<LeaderboardResponse>(`/api/leaderboard?${p.toString()}`));
}

/** 今日挑战；服务端不可用时用本地推算（结果与服务端一致，但成绩只能进离线队列） */
export async function fetchDaily(): Promise<Fetched<DailyInfo> & { source?: 'server' | 'local' }> {
  const r = toFetched(await call<DailyInfo>('/api/daily'));
  if (r.ok) {
    setState({ daily: r.data });
    return { ...r, source: 'server' };
  }
  if (r.status === 'online') return r;
  return { ok: true, data: dailyInfo(dayOf(conf().now())), source: 'local' };
}

export interface RunReplay extends RunDetail {
  log: LogEntry[];
}

/** 拉取一条成绩的种子 + 参数 + 指令日志（解压后），用于观看回放 */
export async function fetchRun(id: string): Promise<Fetched<RunReplay>> {
  const r = toFetched(await call<RunDetail>(`/api/runs/${encodeURIComponent(id)}`));
  if (!r.ok) return r;
  try {
    const { log } = await decodeLogPayload({ gz: r.data.logGz });
    return { ok: true, data: { ...r.data, log: log as LogEntry[] } };
  } catch {
    return { ok: false, status: 'online', message: t('core.online.replayCorrupt') };
  }
}

/** 把线上成绩转成 midrun 回放结构：createWorld(m.opts) 后用 replayAsync(world, m) 快进到结束 */
export function runToMidRun(r: RunReplay): MidRun {
  return {
    v: 1,
    opts: { ...r.opts, seed: r.seed },
    tick: r.result.ticks,
    log: r.log.map((e) => ({ tick: e.tick, cmd: e.cmd })),
    wave: r.result.wave,
    savedAt: r.createdAt,
  };
}

// ───────────────────────── 反馈 ─────────────────────────

/**
 * 发送一条游戏内反馈（POST /api/feedback）。不进离线队列：失败时界面给「复制反馈内容」+ GitHub Issues 兜底。永不抛异常。
 * 设备 id 只用于服务端限流（只存哈希）。
 */
export async function sendFeedback(body: Omit<FeedbackBody, 'deviceId' | 'turnstileToken'>): Promise<Fetched<FeedbackResponse>> {
  try {
    let token: string | null = null;
    if (state.turnstileSiteKey && turnstileProvider) token = await turnstileProvider().catch(() => null);
    const full: FeedbackBody = { ...body, deviceId: getDeviceId(), ...(token ? { turnstileToken: token } : {}) };
    return toFetched(await call<FeedbackResponse>('/api/feedback', { method: 'POST', body: JSON.stringify(full) }));
  } catch {
    return { ok: false, status: state.status, message: t('core.online.requestFailed') };
  }
}

/** 仅测试用：重置模块状态 */
export function _resetOnlineForTests(): void {
  cfg = null;
  initialized = false;
  turnstileProvider = null;
  flushing = null;
  listeners.clear();
  state = { status: 'unknown', message: STATUS_TEXT.unknown, pending: 0, serverVersion: null, turnstileSiteKey: null, daily: null };
}
