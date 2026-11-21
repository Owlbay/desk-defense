/**
 * 「我的记录」：本设备最近 N 局（所有模式，含不排名的自定义模式）。纯数据 / 纯函数，无 DOM。
 *
 * 排行榜页只显示三张全服榜（无尽 / 每日 / 战役）；本地不再分难度 / 纯净 / 开波方式开一堆榜，
 * 本设备的历史统一放在这里。存在独立的 localStorage 键里（不进存档，清存档不影响）。
 * 第一次读取时，用旧存档里的本地排行榜（profile.leaderboard）和自定义最佳补出初始记录。
 */
import type { DifficultyId, MapId, ModeId, RunOptions } from '../core/types';
import type { Profile } from './profile';
import { type KV, safeStorage } from './storage';

export const HISTORY_KEY = 'desk-defense.history.v1';
export const HISTORY_MAX = 20;

export interface HistoryEntry {
  /** 毫秒时间戳（从旧存档补出来的记录只有日期，取当天 0 点） */
  at: number;
  mode: ModeId;
  map: MapId;
  difficulty: DifficultyId;
  abyssLevel?: number;
  /** 每日挑战的日期 */
  daily?: string;
  wave: number;
  score: number;
  /** 战役通关 */
  won?: boolean;
  /** 战役评星 */
  stars?: number;
  /** AI 辅助 */
  ai?: boolean;
  /** 是否参与全服排名（自定义模式为 false） */
  ranked: boolean;
  seed?: string;
  /** AI 对战局：双方模型 + 思考档位（不含渠道）；id 指向 ./duels.ts 里的完整记录（详情 / 回放） */
  duel?: HistoryDuel;
}

export interface HistoryDuel {
  id: string;
  attacker: string;
  defender: string;
  atkEffort?: string;
  defEffort?: string;
}

function sanitizeDuel(x: unknown): HistoryDuel | undefined {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return undefined;
  const o = x as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.attacker !== 'string' || typeof o.defender !== 'string') return undefined;
  const s = (v: unknown) => (typeof v === 'string' && v.length <= 16 ? v : undefined);
  const atkEffort = s(o.atkEffort);
  const defEffort = s(o.defEffort);
  return {
    id: o.id.slice(0, 40),
    attacker: o.attacker.slice(0, 120),
    defender: o.defender.slice(0, 120),
    ...(atkEffort ? { atkEffort } : {}),
    ...(defEffort ? { defEffort } : {}),
  };
}

const MODES: readonly ModeId[] = ['campaign', 'endless', 'custom'];

function sanitize(x: unknown): HistoryEntry | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const at = n(o.at);
  const wave = n(o.wave);
  const score = n(o.score);
  if (at === null || wave === null || score === null) return null;
  if (!MODES.includes(o.mode as ModeId) || typeof o.map !== 'string' || typeof o.difficulty !== 'string') return null;
  const e: HistoryEntry = {
    at,
    mode: o.mode as ModeId,
    map: o.map as MapId,
    difficulty: o.difficulty as DifficultyId,
    wave,
    score,
    ranked: o.ranked === true,
  };
  if (n(o.abyssLevel)) e.abyssLevel = o.abyssLevel as number;
  if (typeof o.daily === 'string') e.daily = o.daily;
  if (o.won === true) e.won = true;
  if (n(o.stars)) e.stars = o.stars as number;
  if (o.ai === true) e.ai = true;
  if (typeof o.seed === 'string' && o.seed.length <= 64) e.seed = o.seed;
  const duel = sanitizeDuel(o.duel);
  if (duel) e.duel = duel;
  return e;
}

function dayStart(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : 0;
}

/** 旧存档 → 初始记录：本地排行榜的无尽成绩 + 自定义最佳，按日期取最近 HISTORY_MAX 条 */
export function historyFromProfile(p: Pick<Profile, 'leaderboard' | 'customBest'>): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const [key, list] of Object.entries(p.leaderboard ?? {})) {
    const m = /^(easy|normal|hard|nightmare|abyss(\d+))/.exec(key);
    if (!m) continue;
    for (const e of list ?? []) {
      out.push({
        at: dayStart(e.date),
        mode: 'endless',
        map: e.map,
        difficulty: (m[2] ? 'abyss' : m[1]) as DifficultyId,
        ...(m[2] ? { abyssLevel: Number(m[2]) } : {}),
        wave: e.wave,
        score: e.score,
        ...(e.ai ? { ai: true } : {}),
        ranked: true,
        ...(e.seed ? { seed: e.seed } : {}),
      });
    }
  }
  const c = p.customBest;
  if (c && c.score > 0)
    out.push({ at: dayStart(c.date), mode: 'custom', map: 'ch1', difficulty: 'normal', wave: c.wave, score: c.score, ranked: false });
  return out.sort((a, b) => b.at - a.at || b.score - a.score).slice(0, HISTORY_MAX);
}

/** 读「我的记录」（新到旧）；还没有记录时用旧存档补 */
export function readHistory(profile?: Pick<Profile, 'leaderboard' | 'customBest'> | null, kv: KV = safeStorage()): HistoryEntry[] {
  let raw: string | null;
  try {
    raw = kv.get(HISTORY_KEY);
  } catch {
    raw = null;
  }
  if (raw === null) return profile ? historyFromProfile(profile) : [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .map(sanitize)
      .filter((e): e is HistoryEntry => !!e)
      .slice(0, HISTORY_MAX);
  } catch {
    return [];
  }
}

/** 记一局（放在最前面，超出 HISTORY_MAX 的旧记录丢掉） */
export function recordHistory(
  e: HistoryEntry,
  profile?: Pick<Profile, 'leaderboard' | 'customBest'> | null,
  kv: KV = safeStorage(),
): HistoryEntry[] {
  const list = [e, ...readHistory(profile, kv)].slice(0, HISTORY_MAX);
  try {
    kv.set(HISTORY_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
  return list;
}

/** 从结束时的对局构造一条记录 */
export function historyEntryOf(
  opts: RunOptions,
  r: {
    wave: number;
    score: number;
    won: boolean;
    stars?: number;
    ai: boolean;
    ranked: boolean;
    daily?: string | null;
    seed?: string;
    duel?: HistoryDuel;
  },
  at: number,
): HistoryEntry {
  return {
    at,
    mode: opts.mode,
    map: opts.map,
    difficulty: opts.difficulty,
    ...(opts.difficulty === 'abyss' ? { abyssLevel: opts.abyssLevel ?? 1 } : {}),
    ...(r.daily ? { daily: r.daily } : {}),
    wave: r.wave,
    score: Math.round(r.score),
    ...(r.won ? { won: true } : {}),
    ...(r.stars ? { stars: r.stars } : {}),
    ...(r.ai ? { ai: true } : {}),
    ranked: r.ranked,
    ...(r.seed ? { seed: r.seed } : {}),
    ...(r.duel ? { duel: r.duel } : {}),
  };
}
