import type { TowerId } from '../core/types';
import { BRANCH, SWATTER, pct, type TraitText } from './towers';
import { localize, nameDesc, part, type TextParams } from './text';

/** 传奇进化（文档 11） */
export const EVO = {
  /** ★1 / ★2 / ★3 所需进化经验 */
  xp: [500, 1000, 1750],
  /** 金币进化费用 = 传奇升级费用 × 系数（★1 / ★2 / ★3） */
  costMul: [0.8, 1.0, 1.3],
  /** 每颗星：伤害 ×1.12、射程 +0.1、攻击间隔 ×0.97；辅助 / 经济塔光环或产出 +10% */
  dmg: 1.12,
  range: 0.1,
  interval: 0.97,
  support: 0.1,
};

export type AbilityTarget = 'none' | 'circle' | 'rect3' | 'direction' | 'axis' | 'enemy' | 'tower';

export interface AbilityDef {
  id: string; // `${towerId}_a|b`
  name: string; // 能力名
  form: string; // 神话形态名
  desc: string;
  cd: number;
  target: AbilityTarget;
  radius?: number;
  /** 充能制：每 N 波 1 次 */
  chargeWaves?: number;
  /** 效果持续秒数（0 = 瞬时） */
  duration: number;
  /** 效果强度（各能力自己的数值，见 ABILITY_FX；说明文字引用这些数） */
  fx: Record<string, number>;
}

type EvoBranch = { s1: TraitText; s2: TraitText; ability: AbilityDef };

/**
 * ★3 主动能力的强度（文档 11 §5：单次释放价值约等于玩家技能"大橡皮"的 1～1.5 倍）。
 * 平衡调整改这里；说明文字引用这里的数。
 */
export const ABILITY_FX: Record<string, Record<string, number>> = {
  /** 弹幕：攻速 ×atk，子弹穿透 pierce 个目标，穿透伤害 ×pierceDmg */
  pencil_a: { atk: 6, pierce: 3, pierceDmg: 1 },
  /** 调色盘：全部颜色效果，颜色效果 ×mul，单发伤害 ×dmg */
  pencil_b: { mul: 6, dmg: 11 },
  /** 连环钉：count 枚，每枚伤害 = 塔伤害 × dmg */
  stapler_a: { count: 24, dmg: 40 },
  /** 拆解：半径 r 内清除护甲护盾并造成 dmg 倍塔伤害，之后 vulnDur 秒受到伤害 +vuln */
  stapler_b: { r: 3, dmg: 60, vuln: 1, vulnDur: 8 },
  /** 封冻：定身 root 秒（Boss bossRoot 秒），定身期间受到伤害 +vuln */
  glue_a: { root: 8, bossRoot: 1.5, vuln: 4 },
  /** 熔胶海：每秒伤害 = 塔伤害系数 × dps，减速 slow */
  glue_b: { dps: 280, slow: 0.5 },
  /** 过载：整个联动组超载 dur 秒（递增立即拉满），每座灯的光束分裂为 beams 道，伤害 ×dmg */
  lamp_a: { beams: 4, dmg: 2 },
  /** 白昼：所有敌人受到伤害 +vuln */
  lamp_b: { vuln: 3 },
  /** 满圆：360° 切割，伤害 ×dmg */
  compass_a: { dmg: 9 },
  /** 深钻：已损失生命 pct（Boss bossPct）；r > 0 时钻穿，目标 r 格内的地面敌人同样受伤 */
  compass_b: { pct: 6, bossPct: 0.5, r: 2 },
  /** 全面修改：修正带易伤 vuln、减速 slow */
  eraser_a: { vuln: 3, slow: 0.7 },
  /** 擦除：抹掉词缀，再造成其最大生命 pct 的伤害；r > 0 时 r 格内的其他非 Boss 敌人也受到同样比例的伤害 */
  eraser_b: { pct: 1, r: 2.2 },
  /** 横扫千军：击退 dist 格，伤害 = 塔伤害 × dmg */
  ruler_a: { dist: 2, dmg: 50 },
  /** 精准测量：受到伤害 +vuln；r > 0 时目标 r 格内的敌人一起标记 */
  ruler_b: { vuln: 5, r: 2.5 },
  /** 挥毫：十字臂长 arm 格，每 0.5 秒叠 ink 层墨迹，另有每秒 dps × 塔伤害系数的伤害 */
  pen_a: { arm: 3, ink: 6, dps: 120 },
  /** 不及格：被标记的敌人受到最大生命 pct 的伤害 */
  pen_b: { pct: 1.1 },
  /** 精算：光环内必定暴击，暴击伤害再 +critDmg */
  calculator_a: { critDmg: 1.5 },
  /** 速算：升 levels 级；Lv10 改为获得 evo 星进化经验 */
  calculator_b: { levels: 1, evo: 0.5 },
  /** 砸罐：mul 倍每波产出，之后 mute 波不产出 */
  piggy_a: { mul: 3, mute: 2 },
  /** 紧急锁门 */
  piggy_b: {},
  /** 电网：每秒造成最大生命 pct（Boss bossPct）的伤害 */
  swatter_a: { pct: 0.22, bossPct: 0.02 },
  /** 天网：网到地面 net 秒（Boss bossNet 秒） */
  swatter_b: { net: 12, bossNet: 2 },
};

/** 能力定义：名称 / 形态名 / 说明走 i18n（data.ability.<id>.*），说明里的数值来自 ABILITY_FX */
const ab = (id: string, cd: number, target: AbilityTarget, duration = 0, extra: Partial<AbilityDef> = {}, desc?: TextParams): AbilityDef =>
  localize({ id, cd, target, duration, fx: ABILITY_FX[id] ?? {}, ...extra }, `data.ability.${id}`, ['name', 'form', 'desc'] as const, {
    desc,
  });
/** ★1 / ★2 特性文本：data.evo.<塔>.<A|B>.<s1|s2>.* */
const st = (tower: TowerId, br: 'A' | 'B', s: 's1' | 's2', desc?: TextParams): TraitText => nameDesc(`data.evo.${tower}.${br}.${s}`, desc);
const F = ABILITY_FX;
const P = BRANCH;
const AK = (id: string, k: string) => `data.ability.${id}.${k}`;

export const EVOLUTION: Partial<Record<TowerId, { A: EvoBranch; B: EvoBranch }>> = {
  pencil: {
    A: {
      s1: st('pencil', 'A', 's1', () => ({ ramp: pct(P.pencil.A.ramp), max: pct(P.pencil.A.ramp * P.pencil.A.rampMax) })),
      s2: st('pencil', 'A', 's2', () => ({ n: P.pencil.A.pierce })),
      ability: ab('pencil_a', 45, 'none', 8, {}, () => ({ atk: F.pencil_a.atk, pierce: F.pencil_a.pierce })),
    },
    B: {
      s1: st('pencil', 'B', 's1', () => ({ v: pct(P.pencil.B.s1 - 1) })),
      s2: st('pencil', 'B', 's2', () => ({ poison: P.pencil.B.poison, purple: pct(P.pencil.B.purple) })),
      ability: ab('pencil_b', 60, 'none', 8, {}, () => ({
        mul: part(F.pencil_b.mul !== 1, AK('pencil_b', 'descMul'), { mul: F.pencil_b.mul }),
        dmg: part(F.pencil_b.dmg !== 1, AK('pencil_b', 'descDmg'), { dmg: F.pencil_b.dmg }),
      })),
    },
  },
  stapler: {
    A: {
      s1: st('stapler', 'A', 's1'),
      s2: st('stapler', 'A', 's2'),
      ability: ab('stapler_a', 40, 'direction', 0, {}, () => ({ count: F.stapler_a.count, dmg: F.stapler_a.dmg })),
    },
    B: {
      s1: st('stapler', 'B', 's1'),
      s2: st('stapler', 'B', 's2'),
      ability: ab('stapler_b', 60, 'none', 0, { radius: F.stapler_b.r }, () => ({
        r: F.stapler_b.r,
        dmg: part(F.stapler_b.dmg > 0, AK('stapler_b', 'descDmg'), { dmg: F.stapler_b.dmg }),
        vuln: part(F.stapler_b.vuln > 0, AK('stapler_b', 'descVuln'), { dur: F.stapler_b.vulnDur, vuln: pct(F.stapler_b.vuln) }),
      })),
    },
  },
  glue: {
    A: {
      s1: st('glue', 'A', 's1', () => ({ v: P.glue.A.s1 })),
      s2: st('glue', 'A', 's2', () => ({ v: pct(P.glue.A.vuln) })),
      ability: ab('glue_a', 75, 'none', 0, {}, () => ({
        root: F.glue_a.root,
        bossRoot: F.glue_a.bossRoot,
        vuln: part(F.glue_a.vuln > 0, AK('glue_a', 'descVuln'), { vuln: pct(F.glue_a.vuln) }),
      })),
    },
    B: {
      s1: st('glue', 'B', 's1', () => ({ v: pct(P.glue.B.s1 - 1) })),
      s2: st('glue', 'B', 's2', () => ({ r: P.glue.B.r, dur: P.glue.B.dur })),
      ability: ab('glue_b', 50, 'rect3', 8, {}, () => ({ slow: pct(F.glue_b.slow) })),
    },
  },
  lamp: {
    A: {
      s1: st('lamp', 'A', 's1', () => ({ v: pct(P.lamp.A.s1 - 1) })),
      s2: st('lamp', 'A', 's2', () => ({ v: pct(P.lamp.A.refract) })),
      ability: ab('lamp_a', 60, 'none', 8, {}, () => ({
        beams: F.lamp_a.beams,
        dmg: part(F.lamp_a.dmg !== 1, AK('lamp_a', 'descDmg'), { dmg: F.lamp_a.dmg }),
      })),
    },
    B: {
      s1: st('lamp', 'B', 's1', () => ({ from: pct(P.lamp.B.vuln), to: pct(P.lamp.B.s1) })),
      s2: st('lamp', 'B', 's2', () => ({ v: P.lamp.B.range })),
      ability: ab('lamp_b', 70, 'none', 8, {}, () => ({ vuln: pct(F.lamp_b.vuln) })),
    },
  },
  compass: {
    A: {
      s1: st('compass', 'A', 's1'),
      s2: st('compass', 'A', 's2'),
      ability: ab('compass_a', 50, 'none', 10, {}, () => ({
        dmg: part(F.compass_a.dmg !== 1, AK('compass_a', 'descDmg'), { dmg: F.compass_a.dmg }),
      })),
    },
    B: {
      s1: st('compass', 'B', 's1'),
      s2: st('compass', 'B', 's2'),
      ability: ab('compass_b', 45, 'enemy', 0, {}, () => ({
        pct: pct(F.compass_b.pct),
        bossPct: pct(F.compass_b.bossPct),
        area: part(F.compass_b.r > 0, AK('compass_b', 'descArea'), { r: F.compass_b.r }),
      })),
    },
  },
  eraser: {
    A: {
      s1: st('eraser', 'A', 's1'),
      s2: st('eraser', 'A', 's2'),
      ability: ab('eraser_a', 70, 'none', 6, {}, () => ({ vuln: pct(F.eraser_a.vuln), slow: pct(F.eraser_a.slow) })),
    },
    B: {
      s1: st('eraser', 'B', 's1'),
      s2: st('eraser', 'B', 's2'),
      ability: ab('eraser_b', 60, 'enemy', 0, {}, () => ({
        dmg: part(F.eraser_b.pct > 0, AK('eraser_b', 'descDmg'), {
          pct: pct(F.eraser_b.pct),
          area: part(F.eraser_b.r > 0, AK('eraser_b', 'descArea'), { r: F.eraser_b.r }),
        }),
      })),
    },
  },
  ruler: {
    A: {
      s1: st('ruler', 'A', 's1'),
      s2: st('ruler', 'A', 's2'),
      ability: ab('ruler_a', 55, 'axis', 0, {}, () => ({
        dist: F.ruler_a.dist,
        dmg: part(F.ruler_a.dmg > 0, AK('ruler_a', 'descDmg'), { dmg: F.ruler_a.dmg }),
      })),
    },
    B: {
      s1: st('ruler', 'B', 's1'),
      s2: st('ruler', 'B', 's2'),
      ability: ab('ruler_b', 60, 'enemy', 10, {}, () => ({
        area: part(F.ruler_b.r > 0, AK('ruler_b', 'descArea'), { r: F.ruler_b.r }),
        vuln: pct(F.ruler_b.vuln),
      })),
    },
  },
  pen: {
    A: {
      s1: st('pen', 'A', 's1'),
      s2: st('pen', 'A', 's2'),
      ability: ab('pen_a', 60, 'circle', 6, { radius: F.pen_a.arm + 0.5 }, () => ({
        arm: F.pen_a.arm,
        ink: F.pen_a.ink,
        dmg: part(F.pen_a.dps > 0, AK('pen_a', 'descDmg'), { dps: F.pen_a.dps }),
      })),
    },
    B: {
      s1: st('pen', 'B', 's1'),
      s2: st('pen', 'B', 's2'),
      ability: ab('pen_b', 70, 'none', 0, {}, () => ({ pct: pct(F.pen_b.pct) })),
    },
  },
  calculator: {
    A: {
      s1: st('calculator', 'A', 's1', () => ({ v: pct(P.calculator.A.s1) })),
      s2: st('calculator', 'A', 's2', () => ({ v: P.calculator.A.aura })),
      ability: ab('calculator_a', 80, 'none', 12, {}, () => ({
        crit: part(F.calculator_a.critDmg > 0, AK('calculator_a', 'descCrit'), { v: pct(F.calculator_a.critDmg) }),
      })),
    },
    B: {
      s1: st('calculator', 'B', 's1', () => ({ v: pct(P.calculator.B.s1) })),
      s2: st('calculator', 'B', 's2', () => ({ v: pct(P.calculator.B.discount) })),
      ability: ab('calculator_b', 120, 'tower', 0, {}, () => ({ levels: F.calculator_b.levels, evo: F.calculator_b.evo })),
    },
  },
  piggy: {
    A: {
      s1: st('piggy', 'A', 's1'),
      s2: st('piggy', 'A', 's2'),
      ability: ab('piggy_a', 0, 'none', 0, { chargeWaves: 5 }, () => ({ mul: F.piggy_a.mul, mute: F.piggy_a.mute })),
    },
    B: {
      s1: st('piggy', 'B', 's1'),
      s2: st('piggy', 'B', 's2'),
      ability: ab('piggy_b', 120, 'none', 10),
    },
  },
  swatter: {
    A: {
      s1: st('swatter', 'A', 's1', () => ({ v: SWATTER.chainS1 })),
      s2: st('swatter', 'A', 's2', () => ({ v: SWATTER.chainGround })),
      ability: ab('swatter_a', 60, 'none', 6, {}, () => ({ pct: pct(F.swatter_a.pct), bossPct: pct(F.swatter_a.bossPct) })),
    },
    B: {
      s1: st('swatter', 'B', 's1', () => ({ v: SWATTER.netS1 })),
      s2: st('swatter', 'B', 's2', () => ({ v: SWATTER.netEveryS2 })),
      ability: ab('swatter_b', 75, 'none', 0, {}, () => ({ net: F.swatter_b.net, bossNet: F.swatter_b.bossNet })),
    },
  },
};

export function evoBranch(id: TowerId, branch: 'A' | 'B' | null): EvoBranch | null {
  if (!branch) return null;
  return EVOLUTION[id]?.[branch] ?? null;
}

export const ABILITIES: Record<string, AbilityDef> = Object.fromEntries(
  Object.values(EVOLUTION)
    .flatMap((e) => [e!.A.ability, e!.B.ability])
    .map((a) => [a.id, a]),
);
