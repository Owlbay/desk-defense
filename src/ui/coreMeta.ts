/**
 * ui 使用的 core 元数据（文档 08「入口函数」）。集中在这里引用，便于对接。
 */
import * as core from '../core';
import { t } from '../i18n';
import type { MapId, Obstacle, RandomEventId, SkillId, SpawnerState, TalentId } from '../core/types';

export {
  TOWER_META,
  SKILL_META,
  TALENT_META,
  DIFFICULTY_PRESETS,
  resolveParams,
  MAP_META,
  ENEMY_META,
  AFFIX_META,
} from '../core';

export { TOWER_IDS, RANDOM_EVENT_IDS } from '../core/types';

export const SKILL_ORDER: SkillId[] = [
  'eraser_strike',
  'bell',
  'whiteout_zone',
  'caffeine',
  'ruler_sweep',
  'scholarship',
  'relocate',
  'inspiration',
  'magnifier',
  'seal_tape',
];

export const TALENT_ORDER: TalentId[] = ['wallet', 'bandaid', 'alarm', 'study', 'secondhand', 'bigbag', 'luckydraw', 'collector'];

// ───────────── 文档 09 / 11 的新导出（core 尚未落地时优雅降级） ─────────────

export type EventTone = 'bad' | 'good' | 'neutral';
export interface EventMeta {
  name: string;
  desc: string;
  tone: EventTone;
}
export interface AbilityMeta {
  name: string;
  desc: string;
  cd: number;
  target: string;
}
export interface LayoutResult {
  obstacles: Obstacle[];
  spawners: SpawnerState[];
  exits: { x: number; y: number }[];
}

const C = core as unknown as {
  generateLayout?: (map: MapId, seed: string, fixedLayout?: boolean) => LayoutResult;
  RANDOM_EVENT_META?: Record<RandomEventId, EventMeta>;
  ABILITY_META?: Record<string, AbilityMeta>;
};

export function eventMeta(id: RandomEventId): EventMeta {
  return C.RANDOM_EVENT_META?.[id] ?? { name: id, desc: '', tone: 'neutral' };
}

export function abilityMeta(key: string): AbilityMeta | null {
  return C.ABILITY_META?.[key] ?? null;
}

/** 地图选择界面的布局缩略图；core 尚未实现时返回 null */
export function generateLayout(map: MapId, seed: string, fixedLayout?: boolean): LayoutResult | null {
  const fn = C.generateLayout;
  if (typeof fn !== 'function') return null;
  try {
    return fn(map, seed, fixedLayout);
  } catch (e) {
    console.warn('generateLayout failed', e);
    return null;
  }
}

// ───────────── 出生点名称 ─────────────

type Edge = 'north' | 'south' | 'west' | 'east';
const EDGE_OF: Record<string, Edge> = {
  north: 'north', south: 'south', west: 'west', east: 'east',
  top: 'north', bottom: 'south', left: 'west', right: 'east',
  n: 'north', s: 'south', w: 'west', e: 'east',
};

/** 把出生点 id 映射为玩家可读的名字：北/南/西/东入口、空降点 n、暗门 n */
export function spawnerName(id: string, spawners?: readonly SpawnerState[]): string {
  if (id === '*') return t('ui.coremeta.allEntries');
  const m = /^([a-z]+)(?:[-_]?(\d+))?$/i.exec(id);
  const base = m?.[1]?.toLowerCase() ?? id;
  const num = m?.[2];
  const sp = spawners?.find((s) => s.id === id);
  const edge = EDGE_OF[base];
  if (edge) return num ? t('ui.coremeta.edgeN', { name: t(`ui.coremeta.edge.${edge}`), n: num }) : t(`ui.coremeta.edge.${edge}`);
  if (base === 'drop' || sp?.kind === 'drop') {
    const drops = spawners?.filter((s) => s.kind === 'drop') ?? [];
    const i = drops.findIndex((s) => s.id === id);
    const n = i >= 0 ? i + 1 : num;
    return n !== undefined && n !== '' ? t('ui.coremeta.dropN', { n }) : t('ui.coremeta.drop');
  }
  if (base === 'hidden' || base === 'secret' || sp?.kind === 'hidden') {
    const hid = spawners?.filter((s) => s.kind === 'hidden') ?? [];
    if (hid.length <= 1 && !num) return t('ui.coremeta.hidden');
    const i = hid.findIndex((s) => s.id === id);
    const n = i >= 0 ? i + 1 : num;
    return n !== undefined && n !== '' ? t('ui.coremeta.hiddenN', { n }) : t('ui.coremeta.hidden');
  }
  if (base === 'spawn' || base === 'edge' || base === 'entry') return num ? t('ui.coremeta.entryN', { n: num }) : t('ui.coremeta.entry');
  return id;
}
