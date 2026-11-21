import type { TowerId } from '../core/types';
import { localize, localizedList, nameDesc, part, type TextParams } from './text';

/** 0.25 → "25%" */
export function pct(v: number): string {
  return `${Math.round(v * 1000) / 10}%`;
}
function pct0(v: number): string {
  return String(Math.round(v * 100) / 100);
}

export interface TraitText {
  name: string;
  desc: string;
}

export interface TowerDef {
  id: TowerId;
  name: string;
  cost: number;
  role: string;
  desc: string;
  hitsAir: boolean;
  hitsGround: boolean;
  /** 战役解锁 'c-w' */
  unlock: string;
  /** 是否主动攻击 */
  attacks: boolean;
  /** Lv1 数值 */
  damage: number;
  interval: number;
  range: number;
  inner?: number;
  aura?: number;
  /** 弹道速度（格/秒），0 = 瞬发/范围 */
  projSpeed: number;
  maxLevel: number;
  t2: TraitText;
  t3: TraitText;
  A: TraitText;
  B: TraitText;
}

/**
 * 传奇分支与进化星级特性里会被平衡调整的数值（文档 02 §2、文档 11 §2）。
 * 塔和进化的说明文字直接引用这里的数，改数值不用改文字。
 */
export const BRANCH = {
  pencil: {
    /** A 自动铅笔：攻击间隔 ×ivl，单发伤害 ×dmg；★1 连射每次攻速 +ramp，最多 rampMax 层；★2 无视 pierce 点护甲 */
    A: { ivl: 0.5, dmg: 0.7, ramp: 0.05, rampMax: 8, pierce: 2 },
    /** B 彩色铅笔：红色灼烧每秒 burn（3 秒）、蓝色减速 slow（1 秒）、黄色 +1 金币；★1 颜色效果 ×s1；★2 绿色中毒每秒 poison（4 秒）、紫色易伤 purple（3 秒） */
    B: { burn: 4, slow: 0.2, s1: 1.5, poison: 6, purple: 0.1, dmg: 1.12 },
  },
  glue: {
    /** A 502：root 概率定身 rootDur 秒；★1 +s1 秒；★2 定身易伤 vuln */
    A: { root: 0.4, rootDur: 1, s1: 0.5, vuln: 0.2 },
    /** B 热熔胶：胶滩每秒 dps；★1 ×s1；★2 半径 +r、持续 +dur 秒 */
    B: { dps: 5.8, s1: 1.5, r: 0.3, dur: 2 },
  },
  lamp: {
    /** A 激光笔：基础秒伤 ×dmg，每秒递增 ramp（基础秒伤的倍数），倍率上限 cap；作为主灯时汇聚效率 ×relay，且联动组不限座数；★1 上限 ×s1；★2 折射 refract */
    A: { dmg: 0.6, ramp: 1, cap: 5, relay: 1.1, s1: 1.5, refract: 0.5 },
    /** B 护眼灯：基础秒伤 ×dmg，照射易伤 vuln；★1 提高到 s1；★2 光照内友方射程 +range；联动时主灯光束在目标处分裂（辅灯数道，splitR 格内，伤害 ×split） */
    B: { dmg: 0.7, vuln: 0.15, s1: 0.25, range: 0.3, split: 0.35, splitR: 1.5 },
  },
  calculator: {
    /** A 科学计算器：光环内暴击率 +crit、暴击伤害 +critDmg；★1 再 +s1；★2 光环 +aura */
    A: { crit: 0.1, critDmg: 0.5, s1: 0.25, aura: 0.5 },
    /** B 算盘：光环内经验 +xp、伤害再 +dmg；★1 经验再 +s1；★2 升级费用 −discount */
    B: { xp: 0.5, s1: 0.25, discount: 0.1, dmg: 0.3 },
  },
};

/**
 * 台灯（文档 02 §2.5）：持续光束 + 递增 + 联动（棱镜）。台灯的 damage 是 Lv1 秒伤，interval 固定 1（等级 / 进化的间隔成长与攻速加成都换算成秒伤）。
 */
export const LAMP = {
  /** 伤害结算间隔（秒），每跳发一次 beam 事件 */
  tick: 0.1,
  /** 递增：同一目标每秒 +ramp（基础秒伤的倍数），最多 ×cap；换目标 / 目标死亡清零 */
  ramp: 0.6,
  cap: 3,
  /** 精良·余温：换目标时保留 keep 的递增 */
  keep: 0.5,
  /** 镀金·双灯头：第二道光束的秒伤系数（单独递增） */
  second: 0.5,
  /** 侦测隐形半径（护眼灯为整个射程） */
  detect: 1.5,
  /** 联动：中心距 link 格以内的台灯连成一组（可链式），普通组最多 maxGroup 座（有传奇 A 激光笔的组不限） */
  link: 2.5,
  maxGroup: 4,
  /** 第 k 座辅灯（按秒伤从高到低）并入主灯的效率 relay × k^-decay：主灯秒伤 × (1 + Σ 效率 × 辅灯秒伤 / 主灯秒伤) */
  relay: 1.1,
  decay: 0.25,
  /** 每座辅灯让主灯递增上限 +capPer，最多 +capMax */
  capPer: 0.75,
  capMax: 2.25,
};

/** 苍蝇拍（文档 02 §2.12）的特性数值 */
export const SWATTER = {
  /** 拍击半径（格）；镀金双拍 +splashT3 */
  splash: 0.6,
  splashT3: 0.2,
  /** 精良·气流：减速 / 持续 */
  airSlow: 0.25,
  airSlowDur: 1.5,
  /** 传奇 A 电蚊拍：弹跳次数、每跳伤害系数、弹跳距离、麻痹秒数；★1 弹跳 +s1；★2 可打地面，伤害 ×ground */
  chain: 3,
  chainMul: 0.7,
  chainRange: 2,
  chainStun: 0.3,
  chainS1: 2,
  chainGround: 0.5,
  /** 传奇 B 捕虫网：每第 netEvery 次攻击甩网，网住 netDur 秒；★1 +netS1 秒；★2 每第 netEveryS2 次；网住时受伤 +netVuln */
  netEvery: 3,
  netDur: 4,
  netS1: 2,
  netEveryS2: 2,
  netVuln: 0.15,
  /** 网的飞行速度（格/秒） */
  netSpeed: 9,
};

/** 每级成长（文档 02 §1.2） */
export const GROWTH = { damage: 1.15, interval: 0.97, range: 0.06 };

type TowerNumbers = Omit<TowerDef, 'name' | 'role' | 'desc' | 't2' | 't3' | 'A' | 'B'>;

/** 塔定义：数值写在这里，名称 / 定位 / 说明 / 特性文本走 i18n（data.tower.<id>.*） */
function tower(n: TowerNumbers, p: { desc?: TextParams; A?: TextParams; B?: TextParams; t2?: TextParams; t3?: TextParams } = {}): TowerDef {
  const k = `data.tower.${n.id}`;
  const def = localize(n, k, ['name', 'role', 'desc'] as const, { desc: p.desc });
  return Object.assign(def, {
    t2: nameDesc(`${k}.t2`, p.t2),
    t3: nameDesc(`${k}.t3`, p.t3),
    A: nameDesc(`${k}.A`, p.A),
    B: nameDesc(`${k}.B`, p.B),
  });
}

export const TOWERS: Record<TowerId, TowerDef> = {
  wall: tower({
    id: 'wall',
    cost: 5,
    hitsAir: false,
    hitsGround: false,
    unlock: '1-1',
    attacks: false,
    damage: 0,
    interval: 0,
    range: 0,
    projSpeed: 0,
    maxLevel: 3,
  }),
  pencil: tower(
    {
      id: 'pencil',
      cost: 20,
      hitsAir: true,
      hitsGround: true,
      unlock: '1-1',
      attacks: true,
      damage: 8,
      interval: 0.5,
      range: 2.5,
      projSpeed: 10,
      maxLevel: 10,
    },
    {
      A: () => ({ atk: pct0(1 / BRANCH.pencil.A.ivl), dmg: BRANCH.pencil.A.dmg }),
      B: () => ({
        burn: BRANCH.pencil.B.burn,
        slow: pct(BRANCH.pencil.B.slow),
        extra: part(BRANCH.pencil.B.dmg !== 1, 'data.tower.pencil.B.descDmg', { dmg: BRANCH.pencil.B.dmg }),
      }),
    },
  ),
  stapler: tower({
    id: 'stapler',
    cost: 45,
    hitsAir: false,
    hitsGround: true,
    unlock: '1-3',
    attacks: true,
    damage: 12,
    interval: 1.0,
    range: 1.6,
    projSpeed: 0,
    maxLevel: 10,
  }),
  glue: tower(
    {
      id: 'glue',
      cost: 35,
      hitsAir: false,
      hitsGround: true,
      unlock: '1-2',
      attacks: true,
      damage: 2,
      interval: 0.8,
      range: 2.2,
      projSpeed: 7,
      maxLevel: 10,
    },
    {
      A: () => ({ chance: pct(BRANCH.glue.A.root), dur: BRANCH.glue.A.rootDur }),
      B: () => ({ dps: BRANCH.glue.B.dps }),
    },
  ),
  lamp: tower(
    {
      id: 'lamp',
      cost: 80,
      hitsAir: true,
      hitsGround: true,
      unlock: '1-6',
      attacks: true,
      damage: 13,
      interval: 1,
      range: 3.5,
      projSpeed: 0,
      maxLevel: 10,
    },
    {
      desc: () => ({ ramp: pct(LAMP.ramp), cap: LAMP.cap, detect: LAMP.detect, link: LAMP.link }),
      t2: () => ({ keep: pct(LAMP.keep) }),
      t3: () => ({ v: pct(LAMP.second) }),
      A: () => ({ dmg: BRANCH.lamp.A.dmg, ramp: pct(BRANCH.lamp.A.ramp), cap: BRANCH.lamp.A.cap, relay: BRANCH.lamp.A.relay }),
      B: () => ({ dmg: BRANCH.lamp.B.dmg, vuln: pct(BRANCH.lamp.B.vuln), split: pct(BRANCH.lamp.B.split) }),
    },
  ),
  compass: tower({
    id: 'compass',
    cost: 60,
    hitsAir: false,
    hitsGround: true,
    unlock: '2-1',
    attacks: true,
    damage: 6,
    interval: 0.25,
    range: 1.8,
    inner: 0.8,
    projSpeed: 0,
    maxLevel: 10,
  }),
  eraser: tower({
    id: 'eraser',
    cost: 40,
    hitsAir: false,
    hitsGround: true,
    unlock: '2-3',
    attacks: true,
    damage: 4,
    interval: 1.0,
    range: 2.0,
    projSpeed: 9,
    maxLevel: 10,
  }),
  ruler: tower({
    id: 'ruler',
    cost: 70,
    hitsAir: true,
    hitsGround: true,
    unlock: '2-6',
    attacks: true,
    damage: 20,
    interval: 2.0,
    range: 4.5,
    projSpeed: 12,
    maxLevel: 10,
  }),
  pen: tower({
    id: 'pen',
    cost: 55,
    hitsAir: true,
    hitsGround: true,
    unlock: '3-1',
    attacks: true,
    damage: 3,
    interval: 1.0,
    range: 2.8,
    projSpeed: 9,
    maxLevel: 10,
  }),
  calculator: tower(
    {
      id: 'calculator',
      cost: 90,
      hitsAir: false,
      hitsGround: false,
      unlock: '3-3',
      attacks: false,
      damage: 0,
      interval: 0,
      range: 0,
      aura: 2.0,
      projSpeed: 0,
      maxLevel: 10,
    },
    {
      A: () => ({ crit: pct(BRANCH.calculator.A.crit), critDmg: pct(BRANCH.calculator.A.critDmg) }),
      B: () => ({
        xp: pct(BRANCH.calculator.B.xp),
        extra: part(BRANCH.calculator.B.dmg > 0, 'data.tower.calculator.B.descDmg', { dmg: pct(BRANCH.calculator.B.dmg) }),
      }),
    },
  ),
  piggy: tower({
    id: 'piggy',
    cost: 100,
    hitsAir: false,
    hitsGround: false,
    unlock: '3-6',
    attacks: false,
    damage: 0,
    interval: 0,
    range: 0,
    projSpeed: 0,
    maxLevel: 10,
  }),
  swatter: tower(
    {
      id: 'swatter',
      cost: 50,
      hitsAir: true,
      hitsGround: false,
      unlock: '1-5',
      attacks: true,
      damage: 26,
      interval: 1.2,
      range: 3.0,
      projSpeed: 0,
      maxLevel: 10,
    },
    {
      desc: () => ({ splash: SWATTER.splash }),
      t2: () => ({ slow: pct(SWATTER.airSlow), dur: SWATTER.airSlowDur }),
      t3: () => ({ splash: SWATTER.splashT3 }),
      A: () => ({ chain: SWATTER.chain, mul: SWATTER.chainMul, stun: SWATTER.chainStun }),
      B: () => ({ every: SWATTER.netEvery, dur: SWATTER.netDur, vuln: pct(SWATTER.netVuln) }),
    },
  ),
};

export const WALL_UPGRADE_COST = [0, 15, 30]; // 索引为当前等级：Lv1→2 = 15，Lv2→3 = 30
export const PIGGY_MAX = 3;
export const UNDO_SECONDS = 5;

const combo = (a: TowerId, b: TowerId) => localize({ a, b }, `data.combo.${a}_${b}`, ['name', 'desc'] as const);

/** 组合（名称 / 说明：data.combo.<a>_<b>.*） */
export const COMBOS: { a: TowerId; b: TowerId; name: string; desc: string }[] = [
  combo('pencil', 'eraser'),
  combo('glue', 'stapler'),
  combo('lamp', 'pen'),
  combo('ruler', 'compass'),
  combo('calculator', 'piggy'),
];

/** 阶级名：草稿 / 精良 / 镀金 / 传奇 / 神话（data.tier.1..5，读取时按当前语言） */
export const TIER_NAMES: string[] = localizedList(['data.tier.1', 'data.tier.2', 'data.tier.3', 'data.tier.4', 'data.tier.5']);
