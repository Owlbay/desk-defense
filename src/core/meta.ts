import type { AffixId, DifficultyId, DifficultyParams, EnemyId, MapId, SkillId, SkillState, TalentId, TowerId } from './types';
import { TOWERS } from '../config/towers';
import { ENEMIES, AFFIXES } from '../config/enemies';
import { SKILLS } from '../config/skills';
import { TALENTS } from '../config/talents';
import { MAPS } from '../config/maps';
import { PRESETS } from '../config/difficulty';
import { PERKS } from '../config/perks';
import type { Rarity } from './types';

export const DIFFICULTY_PRESETS: Record<Exclude<DifficultyId, 'abyss'>, DifficultyParams> = PRESETS;

export const TOWER_META: Record<TowerId, { name: string; cost: number; role: string; desc: string; hitsAir: boolean; hitsGround: boolean; unlock: string }> =
  Object.fromEntries(
    Object.values(TOWERS).map((t) => [t.id, { name: t.name, cost: t.cost, role: t.role, desc: t.desc, hitsAir: t.hitsAir, hitsGround: t.hitsGround, unlock: t.unlock }]),
  ) as Record<TowerId, { name: string; cost: number; role: string; desc: string; hitsAir: boolean; hitsGround: boolean; unlock: string }>;

export const ENEMY_META: Record<EnemyId, { name: string; desc: string; flying: boolean; boss: boolean }> = Object.fromEntries(
  Object.values(ENEMIES).map((e) => [e.id, { name: e.name, desc: e.desc, flying: e.flying, boss: e.boss }]),
) as Record<EnemyId, { name: string; desc: string; flying: boolean; boss: boolean }>;

export const AFFIX_META: Record<AffixId, { name: string; desc: string }> = Object.fromEntries(
  Object.values(AFFIXES).map((a) => [a.id, { name: a.name, desc: a.desc }]),
) as Record<AffixId, { name: string; desc: string }>;

export const SKILL_META: Record<SkillId, { name: string; desc: string; cd: number; unlock: string; target: SkillState['target']; radius?: number }> =
  Object.fromEntries(
    Object.values(SKILLS).map((s) => [s.id, { name: s.name, desc: s.desc, cd: s.cd, unlock: s.unlock, target: s.target, radius: s.radius }]),
  ) as Record<SkillId, { name: string; desc: string; cd: number; unlock: string; target: SkillState['target']; radius?: number }>;

export const TALENT_META: Record<TalentId, { name: string; desc: string; max: number; star: number; ink: number }> = Object.fromEntries(
  Object.values(TALENTS).map((t) => [t.id, { name: t.name, desc: t.desc, max: t.max, star: t.star, ink: t.ink }]),
) as Record<TalentId, { name: string; desc: string; max: number; star: number; ink: number }>;

export const MAP_META: Record<MapId, { name: string; chapter: number; desc: string }> = Object.fromEntries(
  Object.values(MAPS).map((m) => [m.id, { name: m.name, chapter: m.chapter, desc: m.desc }]),
) as Record<MapId, { name: string; chapter: number; desc: string }>;

export const PERK_META: { id: string; name: string; desc: string; rarity: Rarity; needsTower: boolean }[] = PERKS.map((p) => ({
  id: p.id, name: p.name, desc: p.desc, rarity: p.rarity, needsTower: !!p.needsTower,
}));
