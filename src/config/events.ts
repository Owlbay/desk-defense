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
  tea_break: rev({ id: 'tea_break', tone: 'bad', weight: 6, minWave: 6, cooldown: 4, warn: 2, duration: 10, tags: ['buff'] }),
  medic_squad: rev({ id: 'medic_squad', tone: 'bad', weight: 6, minWave: 8, cooldown: 4, warn: 0, duration: 0, tags: ['enemy'] }),
  shield_supply: rev({ id: 'shield_supply', tone: 'bad', weight: 6, minWave: 7, cooldown: 4, warn: 2, duration: 0, tags: ['buff'] }),
  coins: rev({ id: 'coins', tone: 'good', weight: 10, minWave: 2, cooldown: 2, warn: 0, duration: 12, tags: ['pickup'] }),
  inspiration: rev({ id: 'inspiration', tone: 'good', weight: 8, minWave: 3, cooldown: 3, warn: 0, duration: 0, tags: [] }),
  nap: rev({ id: 'nap', tone: 'good', weight: 6, minWave: 3, cooldown: 4, warn: 0, duration: 4, tags: ['enemy'] }),
  praise: rev({ id: 'praise', tone: 'good', weight: 6, minWave: 2, cooldown: 3, warn: 0, duration: 0, tags: [] }),
  supply_crate: rev({ id: 'supply_crate', tone: 'good', weight: 7, minWave: 4, cooldown: 4, warn: 0, duration: 15, tags: ['pickup'] }),
  goldbag: rev({ id: 'goldbag', tone: 'good', weight: 6, minWave: 4, cooldown: 4, warn: 0, duration: 0, tags: ['loot'] }),
  bounty: rev({ id: 'bounty', tone: 'good', weight: 6, minWave: 3, cooldown: 3, warn: 0, duration: 15, tags: ['gold'] }),
  golden_elite: rev({ id: 'golden_elite', tone: 'good', weight: 5, minWave: 6, cooldown: 4, warn: 0, duration: 0, tags: ['loot'] }),
  training: rev({ id: 'training', tone: 'good', weight: 6, minWave: 4, cooldown: 4, warn: 0, duration: 20, tags: ['xp'] }),
  tidy: rev({ id: 'tidy', tone: 'neutral', weight: 6, minWave: 3, cooldown: 4, warn: 2, duration: 0, tags: ['terrain'] }),
  wind: rev({ id: 'wind', tone: 'neutral', weight: 6, minWave: 5, cooldown: 4, warn: 3, duration: 15, tags: ['air'] }),
  secret_door: rev({ id: 'secret_door', tone: 'neutral', weight: 4, minWave: 12, cooldown: 8, warn: 3, duration: 0, tags: ['terrain', 'spawner'] }),
  frenzy: rev({ id: 'frenzy', tone: 'neutral', weight: 5, minWave: 5, cooldown: 4, warn: 2, duration: 12, tags: ['gold', 'speed'] }),
};

/**
 * 怪物类随机事件的数值（文档 09 §3.2）。
 * 负面事件的强度再乘 eventSeverity(D)：简单 0.9 / 普通 1.0 / 困难 1.15 / 噩梦 1.2 / 魔境 ≤ 1.32。
 */
export const MONSTER_EVENTS = {
  /** 茶歇时间：场上敌人每秒回复最大生命的比例（Boss 减半；被钢笔墨水沾上再减半） */
  teaRegen: 0.012,
  teaBossMul: 0.5,
  /** 急救小队：修正液数量 = base + floor(波数 / perWaves)，上限 max；出怪间隔 */
  medicBase: 2,
  medicPerWaves: 12,
  medicMax: 5,
  medicInterval: 1.1,
  /** 护盾补给：护盾 = 最大生命 × ratio（叠加在现有护盾上） */
  shieldRatio: 0.25,
  /** 狂暴：敌人速度倍率 / 击杀金币倍率 */
  frenzySpeed: 1.3,
  frenzyGold: 1.5,
  /** 赏金时刻：击杀金币倍率 */
  bountyGold: 2,
  /** 加练：塔获得经验倍率 */
  trainingXp: 2,
  /** 金币袋怪 */
  goldbag: {
    /** 多少秒没挨打开始回血；每秒回复最大生命比例 */
    regenDelay: 2,
    regen: 0.08,
    /** 击杀爆出的硬币总额 = burst × goldScale(D, 波)，分成 coins 枚（随机 min..max） */
    burst: 32,
    coinsMin: 6,
    coinsMax: 8,
    coinLife: 10,
    /** 漏走：偷走 max(stealMin, 当前金币 × stealPct)，不扣生命 */
    stealPct: 0.08,
    stealMin: 15,
    /** 第 count2Wave 波起一次召唤 2 只 */
    count2Wave: 25,
  },
  /** 金色精英：死亡掉落硬币总额 = burst × goldScale(D, 波)，分成 coins 枚 */
  golden: {
    burst: 20,
    coins: 5,
    coinLife: 10,
  },
};

/** 负面事件强度倍率（按难度的 eventHostile） */
export function eventSeverity(eventHostile: number): number {
  return Math.max(0.8, Math.min(1.35, 0.6 + eventHostile));
}

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
