/**
 * 塔的"用途"（文档 10 §19.8）：模型说要什么（破甲 / 群伤 / 防空 …），规划器挑塔；
 * 克制表把敌人 / 精英词缀映射到用途。无状态、只依赖配置，速查表 / 规划器 / 战报共用。
 */
import type { AffixId, TowerId } from '../core/types';
import type { EnemyDef } from '../config/enemies';

export const PURPOSES = ['dps', 'aoe', 'slow', 'armor', 'air', 'stealth', 'boss', 'antiheal', 'shield'] as const;
export type Purpose = (typeof PURPOSES)[number];

/** 用途 → 候选塔与适配系数（规划器：覆盖 × 威力 × 适配 ÷ 价格） */
export const PURPOSE_TOWERS: Record<Purpose, Partial<Record<TowerId, number>>> = {
  dps: { pencil: 1, lamp: 1.3, compass: 1.05, ruler: 1.2, stapler: 0.9, pen: 0.9 },
  aoe: { stapler: 1.4, compass: 1.2, ruler: 1 },
  slow: { glue: 3 },
  armor: { eraser: 3, lamp: 1.4, stapler: 0.8 },
  air: { swatter: 1.4, pencil: 1, lamp: 1, ruler: 0.9 },
  stealth: { lamp: 2 },
  boss: { lamp: 1.4, ruler: 1.1, pen: 1.3 },
  antiheal: { pen: 2.5 },
  shield: { eraser: 3, lamp: 0.8 },
};

/** 用途的"主力"塔：有这些塔才算已经有了这个用途（CTR 行判断缺什么） */
export const PURPOSE_CORE: Record<Purpose, TowerId[]> = {
  dps: [], aoe: ['stapler', 'compass'], slow: ['glue'], armor: ['eraser', 'lamp'], air: ['swatter', 'lamp', 'pencil', 'ruler'],
  stealth: ['lamp'], boss: ['lamp', 'ruler', 'pen'], antiheal: ['pen'], shield: ['eraser'],
};

/** 用途的缺省目标位置（build_near） */
export const PURPOSE_TARGET: Partial<Record<Purpose, string>> = { slow: 'early', armor: 'early', shield: 'early', air: 'air' };

/** 敌人 → 需要的用途（按属性推出；any = 什么都行） */
export function enemyPurposes(e: EnemyDef): Purpose[] {
  if (e.boss) return ['boss'];
  if (e.flying) return ['air'];
  if (e.stealthy) return ['stealth'];
  if (e.shieldRatio) return ['shield'];
  if (e.unstoppable) return ['dps'];
  if (e.armor >= 2) return ['armor'];
  if (e.id === 'whiteout') return ['antiheal'];
  if (e.id === 'paperball' || e.id === 'ant') return ['aoe'];
  if (e.fast) return ['slow', 'aoe'];
  return [];
}

/** 精英词缀 → 用途 */
export const AFFIX_PURPOSE: Partial<Record<AffixId, Purpose>> = {
  hard: 'armor', shield: 'shield', regen: 'antiheal', stealth: 'stealth', swift: 'slow', split: 'aoe', unstoppable: 'dps', rally: 'aoe', reflect: 'dps',
};

/** 用途 → 速查表里的简写："armor(eraser/lamp)" */
export function purposeText(p: Purpose): string {
  const ts = Object.entries(PURPOSE_TOWERS[p]).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id);
  return `${p}(${ts.join('/')})`;
}
