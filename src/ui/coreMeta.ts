/**
 * ui 使用的 core 元数据（文档 08「入口函数」）。集中在这里引用，便于对接。
 */
import * as core from '../core';
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

/** core 未提供 RANDOM_EVENT_META 时的兜底（文档 09 §3.2） */
const EVENT_FALLBACK: Record<RandomEventId, EventMeta> = {
  drop_box: { name: '空降纸箱', desc: '落下一个空降出生点', tone: 'bad' },
  lamp_outage: { name: '台灯跳闸', desc: '所有台灯停用 8 秒', tone: 'bad' },
  fan: { name: '风扇转起来', desc: '飞行敌人加速并摆动', tone: 'bad' },
  books_fall: { name: '书本倒下', desc: '一摞书倒下，新增一段障碍', tone: 'bad' },
  homework_check: { name: '作业检查', desc: '20 秒内所有敌人护甲 +3', tone: 'bad' },
  coffee_spill: { name: '咖啡打翻', desc: '一块区域里的塔瘫痪 6 秒', tone: 'bad' },
  reinforce: { name: '敌军增援', desc: '本波额外加一组敌人', tone: 'bad' },
  coins: { name: '掉落零花钱', desc: '棋盘上出现硬币，点击收集', tone: 'good' },
  inspiration: { name: '灵感闪现', desc: '随机一座塔获得半级经验', tone: 'good' },
  nap: { name: '午休铃', desc: '地面敌人睡着 4 秒', tone: 'good' },
  praise: { name: '老师表扬', desc: '本波得分 ×2', tone: 'good' },
  supply_crate: { name: '补给箱', desc: '点开箱子，三选一小奖励', tone: 'good' },
  tidy: { name: '桌面整理', desc: '一个杂物换了位置', tone: 'neutral' },
  wind: { name: '窗外起风', desc: '弹道类子弹向一侧偏移', tone: 'neutral' },
  secret_door: { name: '暗门', desc: '开启一个隐藏出生点，持续 3 波', tone: 'neutral' },
};

export function eventMeta(id: RandomEventId): EventMeta {
  return C.RANDOM_EVENT_META?.[id] ?? EVENT_FALLBACK[id] ?? { name: id, desc: '', tone: 'neutral' };
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

const EDGE_NAME: Record<string, string> = {
  north: '北入口',
  south: '南入口',
  west: '西入口',
  east: '东入口',
  top: '北入口',
  bottom: '南入口',
  left: '西入口',
  right: '东入口',
  n: '北入口',
  s: '南入口',
  w: '西入口',
  e: '东入口',
};

/** 把出生点 id 映射为玩家可读的名字：北/南/西/东入口、空降点 n、暗门 n */
export function spawnerName(id: string, spawners?: readonly SpawnerState[]): string {
  if (id === '*') return '各入口';
  const m = /^([a-z]+)(?:[-_]?(\d+))?$/i.exec(id);
  const base = m?.[1]?.toLowerCase() ?? id;
  const num = m?.[2];
  const sp = spawners?.find((s) => s.id === id);
  if (EDGE_NAME[base]) return num ? `${EDGE_NAME[base]} ${num}` : EDGE_NAME[base];
  if (base === 'drop' || sp?.kind === 'drop') {
    const drops = spawners?.filter((s) => s.kind === 'drop') ?? [];
    const i = drops.findIndex((s) => s.id === id);
    return `空降点 ${i >= 0 ? i + 1 : num ?? ''}`.trim();
  }
  if (base === 'hidden' || base === 'secret' || sp?.kind === 'hidden') {
    const hid = spawners?.filter((s) => s.kind === 'hidden') ?? [];
    if (hid.length <= 1 && !num) return '暗门';
    const i = hid.findIndex((s) => s.id === id);
    return `暗门 ${i >= 0 ? i + 1 : num ?? ''}`.trim();
  }
  if (base === 'spawn' || base === 'edge' || base === 'entry') return num ? `入口 ${num}` : '入口';
  return id;
}
