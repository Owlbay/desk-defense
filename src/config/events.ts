import type { RandomEventId } from '../core/types';

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

export const RANDOM_EVENTS: Record<RandomEventId, RandomEventDef> = {
  drop_box: { id: 'drop_box', name: '空降纸箱', desc: '一个纸箱从天而降，成为新的出生点', tone: 'bad', weight: 10, minWave: 6, cooldown: 5, warn: 'drop', duration: 0, tags: ['terrain', 'spawner'] },
  lamp_outage: { id: 'lamp_outage', name: '台灯跳闸', desc: '所有台灯停用 8 秒', tone: 'bad', weight: 6, minWave: 6, cooldown: 4, warn: 3, duration: 8, tags: ['towers'] },
  fan: { id: 'fan', name: '风扇转起来', desc: '飞行敌人速度 +40%，飞行路线摆动，持续 12 秒', tone: 'bad', weight: 6, minWave: 7, cooldown: 4, warn: 3, duration: 12, tags: ['air'] },
  books_fall: { id: 'books_fall', name: '书本倒下', desc: '一摞书倒下，新增 1×3 障碍（不会堵路，压到的塔会被推开）', tone: 'bad', weight: 6, minWave: 5, cooldown: 6, warn: 4, duration: 0, tags: ['terrain'] },
  homework_check: { id: 'homework_check', name: '作业检查', desc: '接下来 20 秒，所有敌人护甲 +3', tone: 'bad', weight: 7, minWave: 8, cooldown: 4, warn: 0, duration: 20, tags: ['enemy'] },
  coffee_spill: { id: 'coffee_spill', name: '咖啡打翻', desc: '一块 3×3 区域里的塔瘫痪 6 秒', tone: 'bad', weight: 7, minWave: 5, cooldown: 4, warn: 3, duration: 6, tags: ['towers'] },
  reinforce: { id: 'reinforce', name: '敌军增援', desc: '本波额外增加一组敌人，从随机出生点出来', tone: 'bad', weight: 8, minWave: 4, cooldown: 3, warn: 0, duration: 0, tags: ['enemy'] },
  coins: { id: 'coins', name: '掉落零花钱', desc: '棋盘上出现几枚硬币，12 秒内点击收集', tone: 'good', weight: 10, minWave: 2, cooldown: 2, warn: 0, duration: 12, tags: ['pickup'] },
  inspiration: { id: 'inspiration', name: '灵感闪现', desc: '随机一座塔获得半级经验', tone: 'good', weight: 8, minWave: 3, cooldown: 3, warn: 0, duration: 0, tags: [] },
  nap: { id: 'nap', name: '午休铃', desc: '所有地面敌人睡着 4 秒', tone: 'good', weight: 6, minWave: 3, cooldown: 4, warn: 0, duration: 4, tags: ['enemy'] },
  praise: { id: 'praise', name: '老师表扬', desc: '本波得分 ×2', tone: 'good', weight: 6, minWave: 2, cooldown: 3, warn: 0, duration: 0, tags: [] },
  supply_crate: { id: 'supply_crate', name: '补给箱', desc: '出现一个补给箱，点开后三选一', tone: 'good', weight: 7, minWave: 4, cooldown: 4, warn: 0, duration: 15, tags: ['pickup'] },
  tidy: { id: 'tidy', name: '桌面整理', desc: '一个杂物被挪到了新位置', tone: 'neutral', weight: 6, minWave: 3, cooldown: 4, warn: 2, duration: 0, tags: ['terrain'] },
  wind: { id: 'wind', name: '窗外起风', desc: '15 秒内弹道向一侧偏移，命中率下降；光束不受影响', tone: 'neutral', weight: 6, minWave: 5, cooldown: 4, warn: 3, duration: 15, tags: ['air'] },
  secret_door: { id: 'secret_door', name: '暗门', desc: '一个隐藏出生点开启，持续 3 波', tone: 'neutral', weight: 4, minWave: 12, cooldown: 8, warn: 3, duration: 0, tags: ['terrain', 'spawner'] },
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

/** 补给箱选项池 */
export const CRATE_OPTIONS: { id: string; name: string; desc: string }[] = [
  { id: 'gold', name: '零花钱袋', desc: '获得 40 + 4×波数 金币' },
  { id: 'lives', name: '创可贴', desc: '生命 +2' },
  { id: 'cooldown', name: '提神饮料', desc: '所有技能立即冷却完毕' },
  { id: 'xp', name: '错题本', desc: '所有塔获得下一级经验的 20%' },
  { id: 'caffeine', name: '速溶咖啡', desc: '所有塔攻速 +60%，持续 10 秒' },
  { id: 'charge', name: '搬家券', desc: '搬家技能 +1 次充能（未携带则改为 +30 金币）' },
];
