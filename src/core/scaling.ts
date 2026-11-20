import type { DifficultyParams, RunOptions, SpawnMode } from './types';

const SPAWN_MODES: SpawnMode[] = ['fixed', 'roundRobin', 'random', 'split', 'focus'];
import { PRESETS, abyssParams } from '../config/difficulty';

/** 文档 04 §3 成长公式 */
export function hpScale(D: DifficultyParams, w: number): number {
  const n = Math.max(0, w - 1);
  return D.hpMul * (1 + D.hpLinear * n) * Math.pow(D.hpExp, n);
}
export function countScale(D: DifficultyParams, w: number): number {
  return D.countMul * (1 + D.countGrowth * Math.max(0, w - 1));
}
export function speedScale(D: DifficultyParams, w: number): number {
  return D.speedMul * Math.min(1 + 0.005 * Math.max(0, w - 1), 1.5);
}
export function armorAt(D: DifficultyParams, base: number, w: number): number {
  if (base <= 0) return 0;
  return base + Math.floor(Math.max(0, w - 1) / Math.max(1, D.armorStep));
}
export function goldScale(D: DifficultyParams, w: number): number {
  return D.rewardMul * (1 + 0.04 * Math.max(0, w - 1));
}
export function xpScale(D: DifficultyParams, w: number): number {
  return D.xpMul * (1 + 0.06 * Math.max(0, w - 1));
}
export function eliteChance(D: DifficultyParams, w: number): number {
  if (D.eliteStart <= 0 || D.eliteStart > 999 || w < D.eliteStart) return 0;
  return Math.min(D.eliteCap, D.eliteRate * (w - D.eliteStart + 1));
}

/** 含魔境等级与自定义覆盖的实际参数 */
export function resolveParams(opts: RunOptions): DifficultyParams {
  let base: DifficultyParams;
  if (opts.difficulty === 'abyss') base = abyssParams(opts.abyssLevel ?? 1);
  else base = { ...(PRESETS[opts.difficulty] ?? PRESETS.normal) };
  if (opts.mode === 'campaign') {
    // 战役只有普通 / 困难两档
    base = opts.difficulty === 'hard' ? { ...PRESETS.hard } : { ...PRESETS.normal };
  }
  if (opts.mode === 'custom' && opts.custom) {
    const out = base as unknown as Record<string, unknown>;
    for (const k of Object.keys(opts.custom) as (keyof DifficultyParams)[]) {
      const v = opts.custom[k];
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
      else if (k === 'spawnMode' && typeof v === 'string' && SPAWN_MODES.includes(v as SpawnMode)) out[k] = v;
    }
  }
  return base;
}

/** 升级所需经验 30 × L^1.7（取整方式与文档表一致：30 / 462 / 1029） */
export function xpForLevel(level: number): number {
  return Math.round(30 * Math.pow(level, 1.7) - 0.3);
}

/** 金币升级费用（无经验折扣、无增益折扣）：基础造价 × 0.6 × L^1.25（9→10 再 ×1.5） */
export function rawUpgradeCost(baseCost: number, level: number): number {
  let c = baseCost * 0.6 * Math.pow(level, 1.25);
  if (level === 9) c *= 1.5;
  return c;
}

/** 出售返还率 */
export function refundRate(level: number): number {
  return Math.max(0.25, 0.7 - 0.05 * (level - 1));
}
