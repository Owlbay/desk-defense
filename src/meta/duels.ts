/**
 * AI 对战（进攻方模型 vs 防守方模型）的本地记录：纯数据 / 纯函数，无 DOM。
 *
 * 每局对战结束时记一条完整数据：双方模型 + 思考档位、各自的决策数 / 兜底数 / 用量 / 费用 / 错误、
 * 每波的出题内容、结果、回放（开局参数 + 含出题的指令日志）。存在独立的 localStorage 键里（不进存档）。
 * 只记模型名 + 档位，不记渠道 / 服务商 / 地址 / Key。
 * 「我的记录」（./history.ts）里的对战条目带 duel.id，排行榜页据此打开详情 / 回放。
 *
 * 容量：最多 DUELS_MAX 条；回放日志 JSON 超过 DUEL_REPLAY_MAX_CHARS 的不存回放（其余数据照存）；
 * 写不进去（存储满）时依次丢掉最旧记录的回放再试。
 */
import type { TokenUsage } from '../agent/types';
import type { AttackGroup, Command, RunOptions } from '../core/types';
import { isAiEffort, publicModelName } from '../shared/leaderboard';
import { type KV, safeStorage } from './storage';

export const DUELS_KEY = 'desk-defense.duels.v1';
export const DUELS_MAX = 10;
export const DUEL_REPLAY_MAX_CHARS = 400_000;
export const DUEL_ERRORS_MAX = 20;

export interface DuelSideRecord {
  /** 模型名（不含渠道） */
  model: string;
  effort?: string;
  /** 内置机器人 */
  scripted?: boolean;
  decisions: number;
  /** 由内置机器人兜底的决策数 */
  fallback: number;
  usage: TokenUsage;
  costUsd: number;
  /** 错误信息（最多 DUEL_ERRORS_MAX 条） */
  errors: string[];
  /** 错误总数（errors 可能被截断） */
  errorCount: number;
}

/** 进攻方给某一波出的题 */
export interface DuelPlanRecord {
  wave: number;
  tick: number;
  groups: AttackGroup[];
}

export interface DuelRecord {
  id: string;
  /** 结束时刻（毫秒） */
  at: number;
  opts: RunOptions;
  seed: string;
  result: {
    /** 结束时的波次 */
    wave: number;
    /** 防守方撑过的波数 */
    wavesSurvived: number;
    score: number;
    kills: number;
    lives: number;
    maxLives: number;
    /** 战役通关（防守方赢） */
    won: boolean;
    stars: number;
    ticks: number;
  };
  /** 对局实际耗时（秒） */
  seconds: number;
  attacker: DuelSideRecord;
  defender: DuelSideRecord;
  /** 中途被你接管过 */
  takenOver?: boolean;
  /** 防守方中途整个交给了内置机器人 */
  switchedToBot?: boolean;
  plans: DuelPlanRecord[];
  /** 回放（太大时不存） */
  replay?: { tick: number; log: { tick: number; cmd: Command }[] };
  /** 上传到对战榜后的名次（上传成功才有） */
  upload?: { rank: number; total: number };
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const num = (x: unknown, d = 0): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);

/** 指令日志里的出题记录（overrideWave） */
export function duelPlansOf(log: readonly { tick: number; cmd: Command }[]): DuelPlanRecord[] {
  const out: DuelPlanRecord[] = [];
  for (const e of log) {
    if (e.cmd.type !== 'overrideWave') continue;
    out.push({ wave: e.cmd.wave, tick: e.tick, groups: (e.cmd.plan?.groups ?? []).map((g) => ({ ...g })) });
  }
  return out;
}

export interface DuelSideInput {
  provider: string;
  model: string;
  effort?: string;
  decisions: number;
  fallback: number;
  usage: TokenUsage;
  costUsd: number;
  errors: readonly string[];
}

function sideRecord(x: DuelSideInput): DuelSideRecord {
  const scripted = x.provider === 'scripted';
  return {
    model: publicModelName(x.model) || 'unknown',
    ...(!scripted && isAiEffort(x.effort) ? { effort: x.effort } : {}),
    ...(scripted ? { scripted: true } : {}),
    decisions: x.decisions,
    fallback: x.fallback,
    usage: { ...x.usage },
    costUsd: x.costUsd,
    errors: x.errors.slice(0, DUEL_ERRORS_MAX).map((e) => e.slice(0, 300)),
    errorCount: x.errors.length,
  };
}

/** 从结算数据构造一条记录（纯函数） */
export function duelRecordOf(
  i: {
    opts: RunOptions;
    seed: string;
    result: DuelRecord['result'];
    seconds: number;
    attack: DuelSideInput;
    defend: DuelSideInput;
    log: readonly { tick: number; cmd: Command }[];
    takenOver?: boolean;
    switchedToBot?: boolean;
  },
  at: number,
  id = `d${at.toString(36)}${Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0')}`,
): DuelRecord {
  const log = i.log.map((e) => ({ tick: e.tick, cmd: e.cmd }));
  const replayOk = JSON.stringify(log).length <= DUEL_REPLAY_MAX_CHARS;
  return {
    id,
    at,
    opts: JSON.parse(JSON.stringify({ ...i.opts, seed: i.opts.seed ?? i.seed })) as RunOptions,
    seed: i.seed,
    result: { ...i.result },
    seconds: Math.max(0, Math.round(i.seconds)),
    attacker: sideRecord(i.attack),
    defender: sideRecord(i.defend),
    ...(i.takenOver ? { takenOver: true } : {}),
    ...(i.switchedToBot ? { switchedToBot: true } : {}),
    plans: duelPlansOf(log),
    ...(replayOk ? { replay: { tick: i.result.ticks, log } } : {}),
  };
}

function sanitizeSide(x: unknown): DuelSideRecord | null {
  if (!isObj(x) || typeof x.model !== 'string' || !isObj(x.usage)) return null;
  const u = x.usage;
  return {
    model: x.model.slice(0, 120),
    ...(isAiEffort(x.effort) ? { effort: x.effort } : {}),
    ...(x.scripted === true ? { scripted: true } : {}),
    decisions: num(x.decisions),
    fallback: num(x.fallback),
    usage: {
      inputTokens: num(u.inputTokens),
      outputTokens: num(u.outputTokens),
      cacheReadTokens: num(u.cacheReadTokens),
      cacheWriteTokens: num(u.cacheWriteTokens),
      requests: num(u.requests),
    },
    costUsd: num(x.costUsd),
    errors: Array.isArray(x.errors) ? x.errors.filter((e): e is string => typeof e === 'string').slice(0, DUEL_ERRORS_MAX) : [],
    errorCount: num(x.errorCount),
  };
}

function sanitize(x: unknown): DuelRecord | null {
  if (!isObj(x) || typeof x.id !== 'string' || !isObj(x.opts) || !isObj(x.result) || typeof x.seed !== 'string') return null;
  const attacker = sanitizeSide(x.attacker);
  const defender = sanitizeSide(x.defender);
  if (!attacker || !defender) return null;
  const r = x.result;
  const rec: DuelRecord = {
    id: x.id.slice(0, 40),
    at: num(x.at),
    opts: x.opts as unknown as RunOptions,
    seed: x.seed.slice(0, 64),
    result: {
      wave: num(r.wave),
      wavesSurvived: num(r.wavesSurvived),
      score: num(r.score),
      kills: num(r.kills),
      lives: num(r.lives),
      maxLives: num(r.maxLives),
      won: r.won === true,
      stars: num(r.stars),
      ticks: num(r.ticks),
    },
    seconds: num(x.seconds),
    attacker,
    defender,
    plans: Array.isArray(x.plans) ? (x.plans.filter((p) => isObj(p) && Array.isArray(p.groups)) as unknown as DuelPlanRecord[]) : [],
  };
  if (x.takenOver === true) rec.takenOver = true;
  if (x.switchedToBot === true) rec.switchedToBot = true;
  if (isObj(x.replay) && Array.isArray(x.replay.log)) rec.replay = x.replay as unknown as DuelRecord['replay'];
  if (isObj(x.upload)) rec.upload = { rank: num(x.upload.rank), total: num(x.upload.total) };
  return rec;
}

/** 读全部对战记录（新到旧） */
export function readDuels(kv: KV = safeStorage()): DuelRecord[] {
  let raw: string | null;
  try {
    raw = kv.get(DUELS_KEY);
  } catch {
    raw = null;
  }
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .map(sanitize)
      .filter((e): e is DuelRecord => !!e)
      .slice(0, DUELS_MAX);
  } catch {
    return [];
  }
}

export function getDuel(id: string, kv: KV = safeStorage()): DuelRecord | null {
  return readDuels(kv).find((d) => d.id === id) ?? null;
}

function write(list: DuelRecord[], kv: KV): DuelRecord[] {
  const cur = list.map((d) => ({ ...d }));
  const tryWrite = (): boolean => {
    try {
      return kv.set(DUELS_KEY, JSON.stringify(cur));
    } catch {
      return false;
    }
  };
  if (tryWrite()) return cur;
  // 写不进去（存储满）：从最旧的开始丢回放，再不行就丢整条
  for (let i = cur.length - 1; i >= 0; i--) {
    if (!cur[i].replay) continue;
    delete cur[i].replay;
    if (tryWrite()) return cur;
  }
  while (cur.length > 1) {
    cur.pop();
    if (tryWrite()) return cur;
  }
  return cur;
}

/** 记一局（放在最前面，超出 DUELS_MAX 的旧记录丢掉） */
export function recordDuel(rec: DuelRecord, kv: KV = safeStorage()): DuelRecord[] {
  return write([rec, ...readDuels(kv).filter((d) => d.id !== rec.id)].slice(0, DUELS_MAX), kv);
}

/** 上传成功后补上名次 */
export function noteDuelUpload(id: string, upload: { rank: number; total: number }, kv: KV = safeStorage()): void {
  const list = readDuels(kv);
  const d = list.find((x) => x.id === id);
  if (!d) return;
  d.upload = upload;
  write(list, kv);
}
