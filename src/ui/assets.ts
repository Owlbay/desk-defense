import type { AffixId, Branch, EnemyId, SkillId, Tier, TowerId } from '../core/types';
import { G } from './icons';

const files = import.meta.glob('../../art/**/*.svg', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

export function art(path: string): string {
  return files[`../../art/${path}.svg`] ?? '';
}

export function towerIcon(id: TowerId, tier: Tier = 1, branch: Branch | null = null, level = 1): string {
  if (id === 'wall') return art(`towers/wall_l${Math.max(1, Math.min(3, level))}`);
  const b = (branch ?? 'A').toLowerCase();
  if (tier >= 5) return art(`towers/${id}_t5${b}`) || art(`towers/${id}_t4${b}`) || art(`towers/${id}_t1`);
  const suffix = tier === 4 ? `t4${b}` : `t${tier}`;
  return art(`towers/${id}_${suffix}`) || art(`towers/${id}_t1`);
}

/** 神话塔主动能力图标 art/abilities/{塔id}_{a|b}.svg；缺失时退回神话/传奇外观 */
export function abilityIcon(id: TowerId, branch: Branch | null): string {
  const b = (branch ?? 'A').toLowerCase();
  return art(`abilities/${id}_${b}`) || towerIcon(id, 5, branch) || svgUrl(G.sparkle);
}

export function enemyIcon(id: EnemyId): string {
  const base = id === 'crumbmini' ? 'crumb' : id === 'boss_coffee_small' ? 'boss_coffee' : id;
  return art(`enemies/${base}`);
}

/** 内联 SVG → data URI（缺少美术素材时的兜底） */
export const svgUrl = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

const SKILL_FALLBACK: Partial<Record<SkillId, string>> = { seal_tape: G.tape };
export const skillIcon = (id: SkillId): string => art(`skills/${id}`) || svgUrl(SKILL_FALLBACK[id] ?? G.sparkle);
export const affixIcon = (id: AffixId): string => art(`affixes/${id}`);
