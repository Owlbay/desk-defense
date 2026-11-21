import { localize } from '../config/text';
import type { DifficultyId, MapId, ModeId, RunOptions, SkillId, TalentId } from '../core/types';
import { t } from '../i18n';
import { starsFor as sharedStarsFor } from '../shared/leaderboard';
import type { LeaderEntry, Profile } from './profile';

/**
 * 局外进度的纯函数（不依赖 DOM / core 运行时，便于测试）。
 */

export const MAPS: MapId[] = ['ch1', 'ch2', 'ch3'];
export const DIFFS: DifficultyId[] = ['easy', 'normal', 'hard', 'nightmare', 'abyss'];
export const CAMPAIGN_DIFFS: DifficultyId[] = ['normal', 'hard'];
export const ABYSS_MAX = 10;

/** 难度名（读取时按当前语言：data.difficulty.<id>） */
export const DIFF_NAME: Record<DifficultyId, string> = localize({}, 'data.difficulty', DIFFS);

/** 墨水系数（文档 05 §3.1） */
export const INK_FACTOR: Record<DifficultyId, number> = {
  easy: 0.5,
  normal: 1,
  hard: 1.5,
  nightmare: 2,
  abyss: 3,
};

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
export const roman = (n: number): string => ROMAN[Math.max(0, Math.min(10, Math.round(n)))] ?? String(n);

/** 难度键：easy / normal / hard / nightmare / abyss1..abyss10 */
export function diffKey(d: DifficultyId, abyssLevel = 1): string {
  return d === 'abyss' ? `abyss${Math.max(1, Math.min(ABYSS_MAX, abyssLevel))}` : d;
}

export function diffLabel(d: DifficultyId, abyssLevel = 1): string {
  return d === 'abyss' ? t('data.difficulty.abyssLevel', { lv: roman(abyssLevel) }) : DIFF_NAME[d];
}

export function keyLabel(key: string): string {
  const m = /^abyss(\d+)$/.exec(key);
  if (m) return t('data.difficulty.abyssLevel', { lv: roman(Number(m[1])) });
  return DIFF_NAME[key as DifficultyId] ?? key;
}

/** 所有排行榜难度键 */
export function allDiffKeys(): string[] {
  const out = ['easy', 'normal', 'hard', 'nightmare'];
  for (let i = 1; i <= ABYSS_MAX; i++) out.push(`abyss${i}`);
  return out;
}

/**
 * 排行榜键：难度键 + ':pure'（纯净）+ ':auto'（自动开波）。
 * 旧版本没有自动开波，所以不带后缀的旧记录都是手动开波成绩。
 */
export const leaderKey = (dk: string, pure: boolean, auto = false): string => `${dk}${pure ? ':pure' : ''}${auto ? ':auto' : ''}`;

/** 自动开波的默认值（文档 09 §4）：简单难度和新手引导（未通关的第一章）为手动，其余为自动 */
export function defaultAutoWave(p: Profile, mode: ModeId, map: MapId, d: DifficultyId): boolean {
  if (d === 'easy') return false;
  if (mode === 'campaign' && map === 'ch1' && !chapterCleared(p, 'ch1')) return false;
  return true;
}

/** 玩家偏好优先，否则按难度默认 */
export function effectiveAutoWave(p: Profile, mode: ModeId, map: MapId, d: DifficultyId): boolean {
  const pref = p.settings.autoWave;
  return typeof pref === 'boolean' ? pref : defaultAutoWave(p, mode, map, d);
}

/** 这一局是否为自动开波（opts 未明确时视为手动，兼容旧存档） */
export const runAutoWave = (opts: RunOptions): boolean => opts.autoWave === true;

// ───────────── 战役 ─────────────

export const campaignKey = (map: MapId, d: DifficultyId): string => `${map}:${d}`;

/** 评星：剩余生命 ≥90% 3 星，≥50% 2 星，通关 1 星（与服务端校验同一份：src/shared/leaderboard starsFor） */
export const starsFor = sharedStarsFor;

export function campaignStars(p: Profile, map: MapId, d: DifficultyId): number {
  return p.campaign[campaignKey(map, d)] ?? 0;
}

export function chapterCleared(p: Profile, map: MapId): boolean {
  return CAMPAIGN_DIFFS.some((d) => campaignStars(p, map, d) > 0);
}

export function chapterUnlocked(p: Profile, map: MapId): boolean {
  const i = MAPS.indexOf(map);
  if (i <= 0) return true;
  return chapterCleared(p, MAPS[i - 1]);
}

/** 战役困难：需先通关该章普通 */
export function campaignDiffUnlocked(p: Profile, map: MapId, d: DifficultyId): boolean {
  if (!chapterUnlocked(p, map)) return false;
  if (d === 'hard') return campaignStars(p, map, 'normal') > 0;
  return d === 'normal';
}

/** 记录战役通关，返回新获得的星星（只计提升的部分） */
export function recordCampaignClear(p: Profile, map: MapId, d: DifficultyId, stars: number): number {
  const k = campaignKey(map, d);
  const prev = p.campaign[k] ?? 0;
  if (stars <= prev) return 0;
  p.campaign[k] = stars;
  const gained = stars - prev;
  p.currency.star += gained;
  return gained;
}

export function totalStarsEarned(p: Profile): number {
  return Object.values(p.campaign).reduce((a, b) => a + b, 0);
}

// ───────────── 无尽难度解锁（文档 04 §2.2） ─────────────

/** 无尽模式默认开放：新玩家打开游戏就能直接玩（地图至少有第一章，其他章节通关战役后加入） */
export const ENDLESS_OPEN_BY_DEFAULT = true;
export const endlessUnlocked = (p: Profile): boolean => ENDLESS_OPEN_BY_DEFAULT || chapterCleared(p, 'ch1');
/** 自定义模式仍需通关战役第一章 */
export const customUnlocked = (p: Profile): boolean => chapterCleared(p, 'ch1');
/** 无尽模式可选的地图：第一章始终可选，其余章节通关后加入 */
export const endlessMaps = (p: Profile, all: readonly MapId[]): MapId[] => all.filter((m) => m === 'ch1' || chapterCleared(p, m));

export const bestWave = (p: Profile, key: string): number => p.bestWave[key] ?? 0;

/** 已解锁的最高魔境等级（0 = 未解锁） */
export function maxAbyssLevel(p: Profile): number {
  if (bestWave(p, 'nightmare') < 35) return 0;
  let lvl = 1;
  while (lvl < ABYSS_MAX && bestWave(p, `abyss${lvl}`) >= 30) lvl++;
  return lvl;
}

export function difficultyUnlocked(p: Profile, d: DifficultyId, abyssLevel = 1): boolean {
  if (!endlessUnlocked(p)) return false;
  switch (d) {
    case 'easy':
    case 'normal':
      return true;
    case 'hard':
      return bestWave(p, 'normal') >= 30;
    case 'nightmare':
      return bestWave(p, 'hard') >= 40;
    case 'abyss':
      return abyssLevel <= maxAbyssLevel(p);
  }
}

export function unlockHint(d: DifficultyId, abyssLevel = 1): string {
  switch (d) {
    case 'easy':
    case 'normal':
      return t('core.unlock.clearChapter1');
    case 'hard':
      return t('core.unlock.reachWave', { diff: DIFF_NAME.normal, n: 30 });
    case 'nightmare':
      return t('core.unlock.reachWave', { diff: DIFF_NAME.hard, n: 40 });
    case 'abyss':
      return abyssLevel <= 1
        ? t('core.unlock.reachWave', { diff: DIFF_NAME.nightmare, n: 35 })
        : t('core.unlock.reachWaveAbyss', { diff: diffLabel('abyss', abyssLevel - 1), n: 30 });
  }
}

/** 记录撑过的波数（每波结束调用），返回是否刷新了记录 */
export function recordWave(p: Profile, opts: RunOptions, wavesSurvived: number): boolean {
  if (opts.mode === 'campaign') {
    const prev = p.campaignWave[opts.map] ?? 0;
    if (wavesSurvived > prev) {
      p.campaignWave[opts.map] = wavesSurvived;
      return true;
    }
    return false;
  }
  if (opts.mode === 'endless') {
    const k = diffKey(opts.difficulty, opts.abyssLevel ?? 1);
    if (wavesSurvived > bestWave(p, k)) {
      p.bestWave[k] = wavesSurvived;
      return true;
    }
  }
  return false;
}

// ───────────── 墨水 ─────────────

export function inkFor(mode: ModeId, d: DifficultyId, wavesSurvived: number): number {
  if (mode === 'campaign') return 0;
  return Math.floor(Math.max(0, wavesSurvived) * INK_FACTOR[d]);
}

// ───────────── 技能 ─────────────

/** 解析解锁条件字符串（如 '1-10'、'c1-10'、'战役 1-10'）；无法解析视为默认解锁 */
export function parseUnlock(unlock: string | undefined): { chapter: number; wave: number } | null {
  if (!unlock) return null;
  const m = /(\d+)\s*-\s*(\d+)/.exec(unlock);
  if (!m) return null;
  return { chapter: Number(m[1]), wave: Number(m[2]) };
}

export function unlockReached(p: Profile, unlock: string | undefined): boolean {
  const u = parseUnlock(unlock);
  if (!u) return true;
  const map = `ch${u.chapter}`;
  const reached = p.campaignWave[map] ?? 0;
  // 到达第 w 波视为解锁（撑过 w-1 波即开始第 w 波；以撑过 w 波为准更稳妥）
  return reached >= u.wave || chapterCleared(p, map as MapId);
}

export function unlockText(unlock: string | undefined): string {
  const u = parseUnlock(unlock);
  return u ? t('core.unlock.campaign', { c: u.chapter, w: u.wave }) : t('core.unlock.default');
}

export const SKILL_MAX_LEVEL = 3;
/** 技能升级价格（墨水）：Lv1→2 100，Lv2→3 250 */
export function skillUpgradeCost(level: number): number | null {
  if (level >= SKILL_MAX_LEVEL) return null;
  return level <= 1 ? 100 : 250;
}

export const skillLevel = (p: Profile, id: SkillId): number => Math.max(1, Math.min(SKILL_MAX_LEVEL, p.skills.levels[id] ?? 1));

export function upgradeSkill(p: Profile, id: SkillId): boolean {
  const lv = skillLevel(p, id);
  const cost = skillUpgradeCost(lv);
  if (cost === null || p.currency.ink < cost) return false;
  p.currency.ink -= cost;
  p.skills.levels[id] = lv + 1;
  return true;
}

export const skillSlots = (p: Profile): number => ((p.talents.bigbag ?? 0) > 0 ? 4 : 3);

/** 整理带入的技能：去掉未解锁/重复，超出槽位截断，不足时用已解锁技能补齐 */
export function resolveLoadout(p: Profile, unlocked: SkillId[], pure = false): SkillId[] {
  // 纯净模式关闭天赋，大书包的第 4 槽也不生效
  const slots = pure ? 3 : skillSlots(p);
  const out: SkillId[] = [];
  for (const s of p.skills.loadout) if (unlocked.includes(s) && !out.includes(s) && out.length < slots) out.push(s);
  // 只有一个都没选时才自动补默认技能；否则尊重玩家的选择（允许少带，取消后不会被自动补回）
  if (out.length === 0) for (const s of unlocked) if (out.length < slots) out.push(s);
  return out;
}

// ───────────── 天赋 ─────────────

export interface TalentPrice {
  max: number;
  star: number;
  ink: number;
}

export const talentLevel = (p: Profile, id: TalentId): number => p.talents[id] ?? 0;

export function buyTalent(p: Profile, id: TalentId, price: TalentPrice, with_: 'star' | 'ink'): boolean {
  const lv = talentLevel(p, id);
  if (lv >= price.max) return false;
  const cost = with_ === 'star' ? price.star : price.ink;
  if (p.currency[with_] < cost) return false;
  p.currency[with_] -= cost;
  p.talents[id] = lv + 1;
  return true;
}

// ───────────── 排行榜 ─────────────

export const LEADER_SIZE = 10;

/** 插入排行榜，返回名次（1 起），未上榜返回 0 */
export function insertLeader(p: Profile, key: string, e: LeaderEntry): number {
  const list = (p.leaderboard[key] ?? []).slice();
  list.push(e);
  list.sort((a, b) => b.score - a.score || b.wave - a.wave);
  // 真人成绩与 AI 协助（ai: true）的成绩各占 LEADER_SIZE 个名额，名次也各算各的
  const human = list.filter((x) => !x.ai).slice(0, LEADER_SIZE);
  const ai = list.filter((x) => x.ai).slice(0, LEADER_SIZE);
  p.leaderboard[key] = [...human, ...ai];
  const idx = (e.ai ? ai : human).indexOf(e);
  return idx >= 0 ? idx + 1 : 0;
}

/** 排行榜显示用：默认只显示真人成绩 */
export function leaderView(list: readonly LeaderEntry[] | undefined, showAi = false): LeaderEntry[] {
  const out = (list ?? []).filter((e) => showAi || !e.ai);
  return showAi ? out.sort((a, b) => b.score - a.score || b.wave - a.wave) : out;
}

export function today(d = new Date()): string {
  const z = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

// ───────────── 结算 ─────────────

export interface RunResult {
  won: boolean;
  /** 撑过的波数 */
  wavesSurvived: number;
  score: number;
  kills: number;
  lives: number;
  maxLives: number;
  seed: string;
  perks: string[];
  /** 实际是否为自动开波（缺省按 opts.autoWave） */
  autoWave?: boolean;
  /** 用过「让 AI 替我玩」：本地排行榜条目打上 AI 协助标记（进度 / 星星 / 墨水照常） */
  aiAssisted?: boolean;
}

export interface Rewards {
  stars: number;
  starsBest: number;
  ink: number;
  rank: number;
  newRecord: boolean;
}

/** 对局结束时更新存档，返回获得的奖励 */
export function settleRun(p: Profile, opts: RunOptions, r: RunResult, date = today()): Rewards {
  const res: Rewards = { stars: 0, starsBest: 0, ink: 0, rank: 0, newRecord: false };
  res.newRecord = recordWave(p, opts, r.wavesSurvived);
  if (opts.mode === 'campaign') {
    if (r.won) {
      const s = starsFor(r.lives, r.maxLives);
      res.starsBest = s;
      res.stars = recordCampaignClear(p, opts.map, opts.difficulty, s);
    }
  } else {
    res.ink = inkFor(opts.mode, opts.difficulty, r.wavesSurvived);
    p.currency.ink += res.ink;
    if (opts.mode === 'endless') {
      const auto = r.autoWave ?? runAutoWave(opts);
      const k = leaderKey(diffKey(opts.difficulty, opts.abyssLevel ?? 1), !!opts.pure, auto);
      res.rank = insertLeader(p, k, {
        auto,
        wave: r.wavesSurvived,
        score: Math.round(r.score),
        seed: r.seed,
        date,
        map: opts.map,
        perks: r.perks.slice(),
        kills: r.kills,
        ...(r.aiAssisted ? { ai: true } : {}),
      });
    } else {
      const b = p.customBest;
      // 自定义最佳是「记录」：AI 协助的对局不刷新
      if (!r.aiAssisted && (!b || r.score > b.score)) {
        p.customBest = { wave: r.wavesSurvived, score: Math.round(r.score), date };
        res.newRecord = true;
      }
    }
  }
  p.midRun = null;
  return res;
}
