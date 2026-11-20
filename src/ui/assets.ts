import type { AffixId, Branch, EnemyId, SkillId, Tier, TowerId } from '../core/types';

const files = import.meta.glob('../../art/**/*.svg', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

export function art(path: string): string {
  return files[`../../art/${path}.svg`] ?? '';
}

export function towerIcon(id: TowerId, tier: Tier = 1, branch: Branch | null = null, level = 1): string {
  if (id === 'wall') return art(`towers/wall_l${Math.max(1, Math.min(3, level))}`);
  const suffix = tier === 4 ? `t4${(branch ?? 'A').toLowerCase()}` : `t${tier}`;
  return art(`towers/${id}_${suffix}`) || art(`towers/${id}_t1`);
}

export function enemyIcon(id: EnemyId): string {
  const base = id === 'crumbmini' ? 'crumb' : id === 'boss_coffee_small' ? 'boss_coffee' : id;
  return art(`enemies/${base}`);
}

export const skillIcon = (id: SkillId): string => art(`skills/${id}`);
export const affixIcon = (id: AffixId): string => art(`affixes/${id}`);
