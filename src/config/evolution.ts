import type { TowerId } from '../core/types';
import { BRANCH, SWATTER, pct, type TraitText } from './towers';

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
  id: string;            // `${towerId}_a|b`
  name: string;          // 能力名
  form: string;          // 神话形态名
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
  /** 过载：光束分裂为 beams 道，每道伤害 ×dmg */
  lamp_a: { beams: 6, dmg: 8 },
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

const ab = (id: string, form: string, name: string, desc: string, cd: number, target: AbilityTarget, duration = 0, extra: Partial<AbilityDef> = {}): AbilityDef =>
  ({ id, form, name, desc, cd, target, duration, fx: ABILITY_FX[id] ?? {}, ...extra });
const F = ABILITY_FX;
const P = BRANCH;

export const EVOLUTION: Partial<Record<TowerId, { A: EvoBranch; B: EvoBranch }>> = {
  pencil: {
    A: {
      s1: { name: '连射', desc: `连续命中同一目标，每次攻速 +${pct(P.pencil.A.ramp)}，最多 +${pct(P.pencil.A.ramp * P.pencil.A.rampMax)}` },
      s2: { name: '钢芯', desc: `无视 ${P.pencil.A.pierce} 点护甲` },
      ability: ab('pencil_a', '加特林笔筒', '弹幕', `8 秒内攻速 ×${F.pencil_a.atk}，子弹穿透 ${F.pencil_a.pierce} 个目标`, 45, 'none', 8),
    },
    B: {
      s1: { name: '浓彩', desc: `每种颜色效果 +${pct(P.pencil.B.s1 - 1)}` },
      s2: { name: '十二色', desc: `新增绿色（中毒，每秒 ${P.pencil.B.poison} 点，持续 4 秒）和紫色（易伤 +${pct(P.pencil.B.purple)}）` },
      ability: ab('pencil_b', '彩虹笔盒', '调色盘', `8 秒内每发子弹同时附带全部颜色效果${F.pencil_b.mul !== 1 ? `，颜色效果 ×${F.pencil_b.mul}` : ''}${F.pencil_b.dmg !== 1 ? `，伤害 ×${F.pencil_b.dmg}` : ''}`, 60, 'none', 8),
    },
  },
  stapler: {
    A: {
      s1: { name: '连钉', desc: '钉住概率 +10%' },
      s2: { name: '强力钉击', desc: '每第 5 次攻击为强力钉击，伤害 ×3' },
      ability: ab('stapler_a', '工业钉枪', '连环钉', `沿指定方向射出 ${F.stapler_a.count} 枚钉子（每枚 ${F.stapler_a.dmg} 倍伤害），穿透`, 40, 'direction'),
    },
    B: {
      s1: { name: '深撬', desc: '护甲削减上限从 −5 提高到 −8' },
      s2: { name: '拆盾', desc: '对护盾伤害 ×2' },
      ability: ab('stapler_b', '拆解钳', '拆解', `清除 ${F.stapler_b.r} 格内所有敌人的护甲和护盾${F.stapler_b.dmg > 0 ? `并造成 ${F.stapler_b.dmg} 倍伤害` : ''}${F.stapler_b.vuln > 0 ? `，${F.stapler_b.vulnDur} 秒内受到伤害 +${pct(F.stapler_b.vuln)}` : ''}`, 60, 'none', 0, { radius: F.stapler_b.r }),
    },
  },
  glue: {
    A: {
      s1: { name: '速凝', desc: `定身时间 +${P.glue.A.s1} 秒` },
      s2: { name: '粘牢', desc: `被定身的敌人受到伤害 +${pct(P.glue.A.vuln)}` },
      ability: ab('glue_a', '速干胶枪', '封冻', `全场地面敌人定身 ${F.glue_a.root} 秒（Boss ${F.glue_a.bossRoot} 秒）${F.glue_a.vuln > 0 ? `，定身期间受到伤害 +${pct(F.glue_a.vuln)}` : ''}`, 75, 'none'),
    },
    B: {
      s1: { name: '高温', desc: `灼烧伤害 +${pct(P.glue.B.s1 - 1)}` },
      s2: { name: '大胶滩', desc: `胶滩半径 +${P.glue.B.r}，持续时间 +${P.glue.B.dur} 秒` },
      ability: ab('glue_b', '熔胶火山', '熔胶海', `3×3 区域 8 秒高额灼烧并减速 ${pct(F.glue_b.slow)}`, 50, 'rect3', 8),
    },
  },
  lamp: {
    A: {
      s1: { name: '蓄能', desc: `伤害递增上限 +${pct(P.lamp.A.s1 - 1)}` },
      s2: { name: '折射', desc: `光束折射到第二个目标，造成 ${pct(P.lamp.A.refract)} 伤害` },
      ability: ab('lamp_a', '激光阵列', '过载', `8 秒内光束分裂为 ${F.lamp_a.beams} 道${F.lamp_a.dmg !== 1 ? `，伤害 ×${F.lamp_a.dmg}` : ''}`, 60, 'none', 8),
    },
    B: {
      s1: { name: '强光', desc: `照射易伤从 +${pct(P.lamp.B.vuln)} 提高到 +${pct(P.lamp.B.s1)}` },
      s2: { name: '照明', desc: `光照范围内的友方塔射程 +${P.lamp.B.range}` },
      ability: ab('lamp_b', '日光灯管', '白昼', `8 秒内全图暴露隐形，所有敌人受到伤害 +${pct(F.lamp_b.vuln)}`, 70, 'none', 8),
    },
  },
  compass: {
    A: {
      s1: { name: '广角', desc: '扇形角度 +30°' },
      s2: { name: '刮擦', desc: '扫过的敌人减速 15%' },
      ability: ab('compass_a', '旋转仪', '满圆', `10 秒内变为 360° 持续切割${F.compass_a.dmg !== 1 ? `，伤害 ×${F.compass_a.dmg}` : ''}`, 50, 'none', 10),
    },
    B: {
      s1: { name: '深孔', desc: '流血上限从 10 层提高到 15 层' },
      s2: { name: '崩裂', desc: '带流血的敌人死亡时爆开，把一半层数传给 1 格内的敌人' },
      ability: ab('compass_b', '电钻', '深钻', `对一个敌人造成其已损失生命 ${pct(F.compass_b.pct)} 的伤害（Boss ${pct(F.compass_b.bossPct)}）${F.compass_b.r > 0 ? `，并钻穿周围 ${F.compass_b.r} 格内的地面敌人（按各自已损失生命）` : ''}`, 45, 'enemy'),
    },
  },
  eraser: {
    A: {
      s1: { name: '长卷', desc: '修正带长度 +2 格' },
      s2: { name: '黏带', desc: '修正带上的敌人减速 20%' },
      ability: ab('eraser_a', '修正带机', '全面修改', `沿当前路线铺满修正带 6 秒（受到伤害 +${pct(F.eraser_a.vuln)}，减速 ${pct(F.eraser_a.slow)}）`, 70, 'none', 6),
    },
    B: {
      s1: { name: '高速', desc: '清空护盾概率从 10% 提高到 20%' },
      s2: { name: '连擦', desc: '弹跳目标 +2' },
      ability: ab('eraser_b', '橡皮旋风', '擦除', `抹掉一个非 Boss 精英身上的全部词缀${F.eraser_b.pct > 0 ? `，并造成其最大生命 ${pct(F.eraser_b.pct)} 的伤害${F.eraser_b.r > 0 ? `（${F.eraser_b.r} 格内的其他非 Boss 敌人同样受伤）` : ''}` : ''}`, 60, 'enemy'),
    },
  },
  ruler: {
    A: {
      s1: { name: '重尺', desc: '击退距离 +0.3 格' },
      s2: { name: '撞墙', desc: '被击退撞到墙或塔时，额外受到 50% 伤害' },
      ability: ab('ruler_a', '工字钢', '横扫千军', `一整行或一整列的地面敌人击退 ${F.ruler_a.dist} 格${F.ruler_a.dmg > 0 ? `，并受到 ${F.ruler_a.dmg} 倍伤害` : ''}`, 55, 'axis'),
    },
    B: {
      s1: { name: '精测', desc: '处决线从 10% 提高到 15%' },
      s2: { name: '计件', desc: '每次处决额外 +2 金币' },
      ability: ab('ruler_b', '测量仪', '精准测量', `标记一个敌人${F.ruler_b.r > 0 ? `及其 ${F.ruler_b.r} 格内的敌人` : ''}，10 秒内受到的伤害 +${pct(F.ruler_b.vuln)}`, 60, 'enemy', 10),
    },
  },
  pen: {
    A: {
      s1: { name: '长锋', desc: '笔画长度 +1 格' },
      s2: { name: '饱墨', desc: '每笔墨迹层数 +1' },
      ability: ab('pen_a', '书法大家', '挥毫', `在指定位置画出十字形墨迹区（臂长 ${F.pen_a.arm} 格），6 秒内持续叠墨迹（每 0.5 秒 ${F.pen_a.ink} 层）${F.pen_a.dps > 0 ? `并造成每秒 ${F.pen_a.dps}×伤害系数的伤害` : ''}`, 60, 'circle', 6, { radius: F.pen_a.arm + 0.5 }),
    },
    B: {
      s1: { name: '严批', desc: '标记易伤从 +20% 提高到 +30%' },
      s2: { name: '扣分', desc: '被标记的敌人死亡时额外 +1 金币' },
      ability: ab('pen_b', '阅卷笔', '不及格', `场上所有被标记的敌人立即受到其最大生命 ${pct(F.pen_b.pct)} 的伤害`, 70, 'none'),
    },
  },
  calculator: {
    A: {
      s1: { name: '双精度', desc: `暴击伤害再 +${pct(P.calculator.A.s1)}` },
      s2: { name: '大屏幕', desc: `光环范围 +${P.calculator.A.aura}` },
      ability: ab('calculator_a', '超级计算机', '精算', `12 秒内光环里的塔必定暴击${F.calculator_a.critDmg > 0 ? `，暴击伤害再 +${pct(F.calculator_a.critDmg)}` : ''}`, 80, 'none', 12),
    },
    B: {
      s1: { name: '口诀', desc: `光环内的塔获得经验再 +${pct(P.calculator.B.s1)}` },
      s2: { name: '心算', desc: `光环内的塔升级费用 −${pct(P.calculator.B.discount)}` },
      ability: ab('calculator_b', '珠算大师', '速算', `光环里选一座塔，立即升 ${F.calculator_b.levels} 级（不超过 Lv9；Lv10 改为获得 ${F.calculator_b.evo} 星进化经验）`, 120, 'tower'),
    },
  },
  piggy: {
    A: {
      s1: { name: '大肚', desc: '利息上限 +10' },
      s2: { name: '肥猪', desc: '每波产出 +50%' },
      ability: ab('piggy_a', '聚宝盆', '砸罐', `立即获得 ${F.piggy_a.mul} 倍的每波产出，之后 ${F.piggy_a.mute} 波不产出（充能制，每 5 波 1 次）`, 0, 'none', 0, { chargeWaves: 5 }),
    },
    B: {
      s1: { name: '理赔', desc: '每漏 1 只怪的返还 +5' },
      s2: { name: '保额', desc: '生命 +3（一次性）' },
      ability: ab('piggy_b', '金库', '紧急锁门', '10 秒内漏怪不扣生命', 120, 'none', 10),
    },
  },
  swatter: {
    A: {
      s1: { name: '高压', desc: `连锁弹跳 +${SWATTER.chainS1} 次` },
      s2: { name: '接地', desc: `连锁闪电也能打到地面敌人（伤害 ×${SWATTER.chainGround}）` },
      ability: ab('swatter_a', '高压电网拍', '电网', `6 秒内在全场飞行敌人之间持续放电，每秒造成其最大生命 ${pct(F.swatter_a.pct)} 的伤害（Boss ${pct(F.swatter_a.bossPct)}）`, 60, 'none', 6),
    },
    B: {
      s1: { name: '大网', desc: `网住时间 +${SWATTER.netS1} 秒` },
      s2: { name: '快网', desc: `每第 ${SWATTER.netEveryS2} 次攻击就甩网` },
      ability: ab('swatter_b', '天罗地网', '天网', `全场飞行敌人被网到地面 ${F.swatter_b.net} 秒（Boss ${F.swatter_b.bossNet} 秒）`, 75, 'none'),
    },
  },
};

export function evoBranch(id: TowerId, branch: 'A' | 'B' | null): EvoBranch | null {
  if (!branch) return null;
  return EVOLUTION[id]?.[branch] ?? null;
}

export const ABILITIES: Record<string, AbilityDef> = Object.fromEntries(
  Object.values(EVOLUTION).flatMap((e) => [e!.A.ability, e!.B.ability]).map((a) => [a.id, a]),
);
