import type {
  Command,
  DifficultyId,
  DifficultyParams,
  MapId,
  RunOptions,
  SkillId,
  TalentId,
} from '../core/types';
import { safeStorage, type KV } from './storage';

/** 存档格式（文档 07 §3.3 的扩展） */
export const PROFILE_KEY = 'desk-defense.profile.v1';
export const PROFILE_VERSION = 1;

export type Quality = 'high' | 'low';

export interface Settings {
  quality: Quality;
  sfx: number; // 0..1
  music: number; // 0..1
  lang: 'zh';
}

export interface LeaderEntry {
  wave: number;
  score: number;
  seed: string;
  date: string; // YYYY-MM-DD
  map: MapId;
  perks: string[];
  kills: number;
}

export interface MidRun {
  v: 1;
  opts: RunOptions;
  /** 存档时的逻辑帧号 */
  tick: number;
  log: { tick: number; cmd: Command }[];
  /** 存档时已结束的波号（展示用） */
  wave: number;
  savedAt: number;
}

export interface LastEndless {
  map: MapId;
  difficulty: DifficultyId;
  abyssLevel: number;
  pure: boolean;
}

export interface LastCustom {
  map: MapId;
  base: DifficultyId;
  params: DifficultyParams | null;
}

export interface Profile {
  v: number;
  /** `${map}:${difficulty}` → 最佳星数（战役） */
  campaign: Record<string, number>;
  /** map → 战役中到达过的最高波（任意难度，用于技能解锁） */
  campaignWave: Record<string, number>;
  currency: { star: number; ink: number };
  talents: Partial<Record<TalentId, number>>;
  skills: { loadout: SkillId[]; levels: Partial<Record<SkillId, number>> };
  /** 无尽：难度键（easy / normal / … / abyss1..abyss10）→ 撑过的最高波数 */
  bestWave: Record<string, number>;
  /** 难度键（纯净模式加 ':pure'）→ 前 10 名 */
  leaderboard: Record<string, LeaderEntry[]>;
  customBest: { wave: number; score: number; date: string } | null;
  /** 新手引导：已看过的提示 id */
  tutorial: Record<string, boolean>;
  settings: Settings;
  lastEndless: LastEndless | null;
  lastCustom: LastCustom | null;
  midRun: MidRun | null;
}

export const DEFAULT_LOADOUT: SkillId[] = ['eraser_strike', 'bell', 'whiteout_zone'];

export function defaultSettings(): Settings {
  return { quality: 'high', sfx: 0.8, music: 0.5, lang: 'zh' };
}

export function defaultProfile(): Profile {
  return {
    v: PROFILE_VERSION,
    campaign: {},
    campaignWave: {},
    currency: { star: 0, ink: 0 },
    talents: {},
    skills: { loadout: [...DEFAULT_LOADOUT], levels: {} },
    bestWave: {},
    leaderboard: {},
    customBest: null,
    tutorial: {},
    settings: defaultSettings(),
    lastEndless: null,
    lastCustom: null,
    midRun: null,
  };
}

// ───────────── 校验（坏数据不让游戏崩溃） ─────────────

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const num = (x: unknown, d: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

function numRecord(x: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObj(x)) return out;
  for (const [k, v] of Object.entries(x)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  return out;
}

function boolRecord(x: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!isObj(x)) return out;
  for (const [k, v] of Object.entries(x)) if (typeof v === 'boolean') out[k] = v;
  return out;
}

function leaderEntries(x: unknown): LeaderEntry[] {
  if (!Array.isArray(x)) return [];
  const out: LeaderEntry[] = [];
  for (const e of x) {
    if (!isObj(e)) continue;
    out.push({
      wave: num(e.wave, 0),
      score: num(e.score, 0),
      seed: typeof e.seed === 'string' ? e.seed : '',
      date: typeof e.date === 'string' ? e.date : '',
      map: (typeof e.map === 'string' ? e.map : 'ch1') as MapId,
      perks: Array.isArray(e.perks) ? e.perks.filter((p): p is string => typeof p === 'string') : [],
      kills: num(e.kills, 0),
    });
  }
  return out.slice(0, 10);
}

function midRunOf(x: unknown): MidRun | null {
  if (!isObj(x) || x.v !== 1 || !isObj(x.opts) || !Array.isArray(x.log)) return null;
  const opts = x.opts as unknown as RunOptions;
  if (typeof opts.mode !== 'string' || typeof opts.map !== 'string' || !Array.isArray(opts.skills)) return null;
  const log = (x.log as unknown[]).filter(
    (e): e is { tick: number; cmd: Command } => isObj(e) && typeof e.tick === 'number' && isObj(e.cmd),
  );
  return { v: 1, opts, tick: num(x.tick, 0), log, wave: num(x.wave, 0), savedAt: num(x.savedAt, 0) };
}

/** 把任意 JSON 规范化为合法存档（缺失字段补默认值） */
export function normalizeProfile(raw: unknown): Profile {
  const d = defaultProfile();
  if (!isObj(raw)) return d;
  const p = d;
  p.campaign = numRecord(raw.campaign);
  p.campaignWave = numRecord(raw.campaignWave);
  if (isObj(raw.currency)) {
    p.currency.star = Math.max(0, num(raw.currency.star, 0));
    p.currency.ink = Math.max(0, num(raw.currency.ink, 0));
  }
  p.talents = numRecord(raw.talents) as Profile['talents'];
  if (isObj(raw.skills)) {
    const lo = raw.skills.loadout;
    if (Array.isArray(lo)) {
      const ids = lo.filter((s): s is SkillId => typeof s === 'string');
      p.skills.loadout = Array.from(new Set(ids)).slice(0, 4);
    }
    p.skills.levels = numRecord(raw.skills.levels) as Profile['skills']['levels'];
  }
  p.bestWave = numRecord(raw.bestWave);
  if (isObj(raw.leaderboard)) {
    for (const [k, v] of Object.entries(raw.leaderboard)) p.leaderboard[k] = leaderEntries(v);
  }
  if (isObj(raw.customBest)) {
    p.customBest = {
      wave: num(raw.customBest.wave, 0),
      score: num(raw.customBest.score, 0),
      date: typeof raw.customBest.date === 'string' ? raw.customBest.date : '',
    };
  }
  p.tutorial = boolRecord(raw.tutorial);
  if (isObj(raw.settings)) {
    const s = raw.settings;
    p.settings.quality = s.quality === 'low' ? 'low' : 'high';
    p.settings.sfx = clamp01(num(s.sfx, d.settings.sfx));
    p.settings.music = clamp01(num(s.music, d.settings.music));
  }
  if (isObj(raw.lastEndless)) {
    const l = raw.lastEndless;
    p.lastEndless = {
      map: (typeof l.map === 'string' ? l.map : 'ch1') as MapId,
      difficulty: (typeof l.difficulty === 'string' ? l.difficulty : 'normal') as DifficultyId,
      abyssLevel: Math.max(1, Math.min(10, num(l.abyssLevel, 1))),
      pure: l.pure === true,
    };
  }
  if (isObj(raw.lastCustom)) {
    const l = raw.lastCustom;
    p.lastCustom = {
      map: (typeof l.map === 'string' ? l.map : 'ch1') as MapId,
      base: (typeof l.base === 'string' ? l.base : 'normal') as DifficultyId,
      params: isObj(l.params) ? (l.params as unknown as DifficultyParams) : null,
    };
  }
  p.midRun = midRunOf(raw.midRun);
  return p;
}

export function loadProfile(kv: KV): Profile {
  const s = kv.get(PROFILE_KEY);
  if (!s) return defaultProfile();
  try {
    return normalizeProfile(JSON.parse(s));
  } catch {
    return defaultProfile();
  }
}

export function saveProfile(kv: KV, p: Profile): boolean {
  try {
    return kv.set(PROFILE_KEY, JSON.stringify(p));
  } catch {
    return false;
  }
}

// ───────────── 全局存档仓库 ─────────────

type Sub = (p: Profile) => void;

export class ProfileStore {
  private p: Profile;
  private subs = new Set<Sub>();
  constructor(readonly kv: KV = safeStorage()) {
    this.p = loadProfile(kv);
  }
  get(): Profile {
    return this.p;
  }
  /** 修改并立即保存 */
  update(fn: (p: Profile) => void): void {
    fn(this.p);
    saveProfile(this.kv, this.p);
    for (const s of this.subs) s(this.p);
  }
  /** 清除全部存档 */
  reset(): void {
    this.kv.remove(PROFILE_KEY);
    this.p = defaultProfile();
    saveProfile(this.kv, this.p);
    for (const s of this.subs) s(this.p);
  }
  subscribe(fn: Sub): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
}
