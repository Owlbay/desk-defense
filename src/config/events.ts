import type { RandomEventId } from '../core/types';
import { localize } from './text';

/** 随机事件（文档 09 §3.2） */
export interface RandomEventDef {
  id: RandomEventId;
  name: string;
  desc: string;
  tone: 'bad' | 'good' | 'neutral';
  weight: number;
  /** 最早出现的波数 */
  minWave: number;
  /** 冷却（波） */
  cooldown: number;
  /** 预警秒数；'drop' = 用难度的 dropWarn */
  warn: number | 'drop';
  /** 生效持续秒数（0 = 瞬时） */
  duration: number;
  /** 互斥标签：同标签的事件不会同时处于预警 / 进行中 */
  tags: string[];
}

/** 随机事件：名称 / 说明走 i18n（data.event.<id>.*） */
const rev = (d: Omit<RandomEventDef, 'name' | 'desc'>): RandomEventDef => localize(d, `data.event.${d.id}`, ['name', 'desc'] as const);

export const RANDOM_EVENTS: Record<RandomEventId, RandomEventDef> = {
  drop_box: rev({ id: 'drop_box', tone: 'bad', weight: 10, minWave: 6, cooldown: 5, warn: 'drop', duration: 0, tags: ['terrain', 'spawner'] }),
  lamp_outage: rev({ id: 'lamp_outage', tone: 'bad', weight: 6, minWave: 6, cooldown: 4, warn: 3, duration: 8, tags: ['towers'] }),
  fan: rev({ id: 'fan', tone: 'bad', weight: 6, minWave: 7, cooldown: 4, warn: 3, duration: 12, tags: ['air'] }),
  books_fall: rev({ id: 'books_fall', tone: 'bad', weight: 6, minWave: 5, cooldown: 6, warn: 4, duration: 0, tags: ['terrain'] }),
  homework_check: rev({ id: 'homework_check', tone: 'bad', weight: 7, minWave: 8, cooldown: 4, warn: 0, duration: 20, tags: ['enemy'] }),
  coffee_spill: rev({ id: 'coffee_spill', tone: 'bad', weight: 7, minWave: 5, cooldown: 4, warn: 3, duration: 6, tags: ['towers'] }),
  reinforce: rev({ id: 'reinforce', tone: 'bad', weight: 8, minWave: 4, cooldown: 3, warn: 0, duration: 0, tags: ['enemy'] }),
  coins: rev({ id: 'coins', tone: 'good', weight: 10, minWave: 2, cooldown: 2, warn: 0, duration: 12, tags: ['pickup'] }),
  inspiration: rev({ id: 'inspiration', tone: 'good', weight: 8, minWave: 3, cooldown: 3, warn: 0, duration: 0, tags: [] }),
  nap: rev({ id: 'nap', tone: 'good', weight: 6, minWave: 3, cooldown: 4, warn: 0, duration: 4, tags: ['enemy'] }),
  praise: rev({ id: 'praise', tone: 'good', weight: 6, minWave: 2, cooldown: 3, warn: 0, duration: 0, tags: [] }),
  supply_crate: rev({ id: 'supply_crate', tone: 'good', weight: 7, minWave: 4, cooldown: 4, warn: 0, duration: 15, tags: ['pickup'] }),
  tidy: rev({ id: 'tidy', tone: 'neutral', weight: 6, minWave: 3, cooldown: 4, warn: 2, duration: 0, tags: ['terrain'] }),
  wind: rev({ id: 'wind', tone: 'neutral', weight: 6, minWave: 5, cooldown: 4, warn: 3, duration: 15, tags: ['air'] }),
  secret_door: rev({ id: 'secret_door', tone: 'neutral', weight: 4, minWave: 12, cooldown: 8, warn: 3, duration: 0, tags: ['terrain', 'spawner'] }),
};

/** 事件导演参数 */
export const EVENT_DIRECTOR = {
  /** 两次事件之间的基础间隔（波），实际 = [min,max) / eventRate */
  gapMin: 2,
  gapMax: 3.2,
  /** 开波后多少秒触发（随机） */
  offsetMin: 3,
  offsetMax: 14,
  /** 非负面事件中正面的比例 */
  goodShare: 0.65,
  /** 已结束事件在 state.events 中保留的秒数 */
  keepDone: 30,
};

/** 空降出生点（文档 09 §2.2） */
export const DROP = {
  minExitDist: 7,
  minWaves: 2,
  maxWaves: 4,
  ratioMin: 0.25,
  ratioMax: 0.4,
  demolishBase: 40,
  demolishPerWave: 5,
};

/** 补给箱选项：名称 / 说明走 i18n（data.crate.<id>.*） */
const crate = (id: string) => localize({ id }, `data.crate.${id}`, ['name', 'desc'] as const);

/** 补给箱选项池 */
export const CRATE_OPTIONS: { id: string; name: string; desc: string }[] = [
  crate('gold'),
  crate('lives'),
  crate('cooldown'),
  crate('xp'),
  crate('caffeine'),
  crate('charge'),
];
