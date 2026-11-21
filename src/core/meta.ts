import type {
  AffixId,
  DifficultyId,
  DifficultyParams,
  EnemyId,
  MapId,
  RandomEventId,
  SkillId,
  SkillState,
  TalentId,
  TowerId,
} from './types';
import { RANDOM_EVENTS } from '../config/events';
import { ABILITIES } from '../config/evolution';
import { TOWERS } from '../config/towers';
import { ENEMIES, AFFIXES } from '../config/enemies';
import { SKILLS } from '../config/skills';
import { TALENTS } from '../config/talents';
import { MAPS } from '../config/maps';
import { PRESETS } from '../config/difficulty';
import { PERKS } from '../config/perks';
import type { Rarity } from './types';

export const DIFFICULTY_PRESETS: Record<Exclude<DifficultyId, 'abyss'>, DifficultyParams> = PRESETS;

/**
 * 元数据视图：字段直接代理到配置表（getter），所以名称 / 说明会随当前语言变化（见 src/config/text.ts）。
 * 形状保持不变：TOWER_META[id].name 等读法照旧。
 */
function view<S extends object, K extends keyof S>(src: S, keys: readonly K[]): Pick<S, K> {
  const out = {} as Pick<S, K>;
  for (const k of keys) Object.defineProperty(out, k, { get: () => src[k], enumerable: true });
  return out;
}
function viewAll<S extends { id: string }, K extends keyof S>(list: readonly S[], keys: readonly K[]): Record<string, Pick<S, K>> {
  return Object.fromEntries(list.map((x) => [x.id, view(x, keys)]));
}

export const TOWER_META: Record<
  TowerId,
  { name: string; cost: number; role: string; desc: string; hitsAir: boolean; hitsGround: boolean; unlock: string }
> = viewAll(Object.values(TOWERS), ['name', 'cost', 'role', 'desc', 'hitsAir', 'hitsGround', 'unlock'] as const);

export const ENEMY_META: Record<EnemyId, { name: string; desc: string; flying: boolean; boss: boolean }> = viewAll(Object.values(ENEMIES), [
  'name',
  'desc',
  'flying',
  'boss',
] as const);

export const AFFIX_META: Record<AffixId, { name: string; desc: string }> = viewAll(Object.values(AFFIXES), ['name', 'desc'] as const);

export const SKILL_META: Record<
  SkillId,
  { name: string; desc: string; cd: number; unlock: string; target: SkillState['target']; radius?: number }
> = viewAll(Object.values(SKILLS), ['name', 'desc', 'cd', 'unlock', 'target', 'radius'] as const);

export const TALENT_META: Record<TalentId, { name: string; desc: string; max: number; star: number; ink: number }> = viewAll(
  Object.values(TALENTS),
  ['name', 'desc', 'max', 'star', 'ink'] as const,
);

export const MAP_META: Record<MapId, { name: string; chapter: number; desc: string }> = viewAll(Object.values(MAPS), [
  'name',
  'chapter',
  'desc',
] as const);

export const PERK_META: { id: string; name: string; desc: string; rarity: Rarity; needsTower: boolean }[] = PERKS.map(
  (p) =>
    Object.defineProperty(view(p, ['id', 'name', 'desc', 'rarity'] as const), 'needsTower', {
      value: !!p.needsTower,
      enumerable: true,
    }) as {
      id: string;
      name: string;
      desc: string;
      rarity: Rarity;
      needsTower: boolean;
    },
);

/** 随机事件元数据（文档 09 §3.2） */
export const RANDOM_EVENT_META: Record<
  RandomEventId,
  { name: string; desc: string; tone: 'bad' | 'good' | 'neutral'; warn: number | 'drop'; duration: number; minWave: number }
> = viewAll(Object.values(RANDOM_EVENTS), ['name', 'desc', 'tone', 'warn', 'duration', 'minWave'] as const);

/** 神话塔主动能力元数据（文档 11），键为 `${塔id}_a` / `${塔id}_b`；图标 art/abilities/{键}.svg */
export const ABILITY_META: Record<
  string,
  { name: string; desc: string; cd: number; target: string; form: string; radius?: number; chargeWaves?: number; duration: number }
> = viewAll(Object.values(ABILITIES), ['name', 'desc', 'cd', 'target', 'form', 'radius', 'chargeWaves', 'duration'] as const);
