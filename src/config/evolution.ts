import type { TowerId } from '../core/types';
import type { TraitText } from './towers';

/** 传奇进化（文档 11） */
export const EVO = {
  /** ★1 / ★2 / ★3 所需进化经验 */
  xp: [2000, 4000, 7000],
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
}

type EvoBranch = { s1: TraitText; s2: TraitText; ability: AbilityDef };

const ab = (id: string, form: string, name: string, desc: string, cd: number, target: AbilityTarget, duration = 0, extra: Partial<AbilityDef> = {}): AbilityDef =>
  ({ id, form, name, desc, cd, target, duration, ...extra });

export const EVOLUTION: Partial<Record<TowerId, { A: EvoBranch; B: EvoBranch }>> = {
  pencil: {
    A: {
      s1: { name: '连射', desc: '连续命中同一目标，每次攻速 +5%，最多 +40%' },
      s2: { name: '钢芯', desc: '无视 2 点护甲' },
      ability: ab('pencil_a', '加特林笔筒', '弹幕', '8 秒内攻速 ×3，子弹穿透 1 个目标', 45, 'none', 8),
    },
    B: {
      s1: { name: '浓彩', desc: '每种颜色效果 +50%' },
      s2: { name: '十二色', desc: '新增绿色（中毒，每秒 6 点，持续 4 秒）和紫色（易伤 +10%）' },
      ability: ab('pencil_b', '彩虹笔盒', '调色盘', '8 秒内每发子弹同时附带全部颜色效果', 60, 'none', 8),
    },
  },
  stapler: {
    A: {
      s1: { name: '连钉', desc: '钉住概率 +10%' },
      s2: { name: '强力钉击', desc: '每第 5 次攻击为强力钉击，伤害 ×3' },
      ability: ab('stapler_a', '工业钉枪', '连环钉', '沿指定方向射出 12 枚钉子，穿透', 40, 'direction'),
    },
    B: {
      s1: { name: '深撬', desc: '护甲削减上限从 −5 提高到 −8' },
      s2: { name: '拆盾', desc: '对护盾伤害 ×2' },
      ability: ab('stapler_b', '拆解钳', '拆解', '清除 2 格内所有敌人的护甲和护盾', 60, 'none', 0, { radius: 2 }),
    },
  },
  glue: {
    A: {
      s1: { name: '速凝', desc: '定身时间 +0.5 秒' },
      s2: { name: '粘牢', desc: '被定身的敌人受到伤害 +20%' },
      ability: ab('glue_a', '速干胶枪', '封冻', '全场地面敌人定身 2 秒（Boss 0.5 秒）', 75, 'none'),
    },
    B: {
      s1: { name: '高温', desc: '灼烧伤害 +50%' },
      s2: { name: '大胶滩', desc: '胶滩半径 +0.3，持续时间 +2 秒' },
      ability: ab('glue_b', '熔胶火山', '熔胶海', '3×3 区域 8 秒高额灼烧并减速 50%', 50, 'rect3', 8),
    },
  },
  lamp: {
    A: {
      s1: { name: '蓄能', desc: '伤害递增上限 +50%' },
      s2: { name: '折射', desc: '光束折射到第二个目标，造成 50% 伤害' },
      ability: ab('lamp_a', '激光阵列', '过载', '8 秒内光束分裂为 4 道', 60, 'none', 8),
    },
    B: {
      s1: { name: '强光', desc: '照射易伤从 +15% 提高到 +25%' },
      s2: { name: '照明', desc: '光照范围内的友方塔射程 +0.3' },
      ability: ab('lamp_b', '日光灯管', '白昼', '8 秒内全图暴露隐形，所有敌人受到伤害 +20%', 70, 'none', 8),
    },
  },
  compass: {
    A: {
      s1: { name: '广角', desc: '扇形角度 +30°' },
      s2: { name: '刮擦', desc: '扫过的敌人减速 15%' },
      ability: ab('compass_a', '旋转仪', '满圆', '10 秒内变为 360° 持续切割', 50, 'none', 10),
    },
    B: {
      s1: { name: '深孔', desc: '流血上限从 10 层提高到 15 层' },
      s2: { name: '崩裂', desc: '带流血的敌人死亡时爆开，把一半层数传给 1 格内的敌人' },
      ability: ab('compass_b', '电钻', '深钻', '对一个敌人造成其已损失生命 20% 的伤害（Boss 5%）', 45, 'enemy'),
    },
  },
  eraser: {
    A: {
      s1: { name: '长卷', desc: '修正带长度 +2 格' },
      s2: { name: '黏带', desc: '修正带上的敌人减速 20%' },
      ability: ab('eraser_a', '修正带机', '全面修改', '沿当前路线铺满修正带 6 秒', 70, 'none', 6),
    },
    B: {
      s1: { name: '高速', desc: '清空护盾概率从 10% 提高到 20%' },
      s2: { name: '连擦', desc: '弹跳目标 +2' },
      ability: ab('eraser_b', '橡皮旋风', '擦除', '抹掉一个非 Boss 精英身上的全部词缀', 60, 'enemy'),
    },
  },
  ruler: {
    A: {
      s1: { name: '重尺', desc: '击退距离 +0.3 格' },
      s2: { name: '撞墙', desc: '被击退撞到墙或塔时，额外受到 50% 伤害' },
      ability: ab('ruler_a', '工字钢', '横扫千军', '一整行或一整列的地面敌人击退 2 格', 55, 'axis'),
    },
    B: {
      s1: { name: '精测', desc: '处决线从 10% 提高到 15%' },
      s2: { name: '计件', desc: '每次处决额外 +2 金币' },
      ability: ab('ruler_b', '测量仪', '精准测量', '标记一个敌人，10 秒内它受到的伤害 +40%', 60, 'enemy', 10),
    },
  },
  pen: {
    A: {
      s1: { name: '长锋', desc: '笔画长度 +1 格' },
      s2: { name: '饱墨', desc: '每笔墨迹层数 +1' },
      ability: ab('pen_a', '书法大家', '挥毫', '在指定位置画出十字形墨迹区，6 秒内持续叠墨迹', 60, 'circle', 6, { radius: 1.5 }),
    },
    B: {
      s1: { name: '严批', desc: '标记易伤从 +20% 提高到 +30%' },
      s2: { name: '扣分', desc: '被标记的敌人死亡时额外 +1 金币' },
      ability: ab('pen_b', '阅卷笔', '不及格', '场上所有被标记的敌人立即受到其最大生命 10% 的伤害', 70, 'none'),
    },
  },
  calculator: {
    A: {
      s1: { name: '双精度', desc: '暴击伤害再 +25%' },
      s2: { name: '大屏幕', desc: '光环范围 +0.5' },
      ability: ab('calculator_a', '超级计算机', '精算', '12 秒内光环里的塔必定暴击', 80, 'none', 12),
    },
    B: {
      s1: { name: '口诀', desc: '光环内的塔获得经验再 +25%' },
      s2: { name: '心算', desc: '光环内的塔升级费用 −10%' },
      ability: ab('calculator_b', '珠算大师', '速算', '光环里选一座塔，立即升 1 级（不超过 Lv9；Lv10 改为获得半星进化经验）', 120, 'tower'),
    },
  },
  piggy: {
    A: {
      s1: { name: '大肚', desc: '利息上限 +10' },
      s2: { name: '肥猪', desc: '每波产出 +50%' },
      ability: ab('piggy_a', '聚宝盆', '砸罐', '立即获得 3 倍的每波产出，之后 2 波不产出（充能制，每 5 波 1 次）', 0, 'none', 0, { chargeWaves: 5 }),
    },
    B: {
      s1: { name: '理赔', desc: '每漏 1 只怪的返还 +5' },
      s2: { name: '保额', desc: '生命 +3（一次性）' },
      ability: ab('piggy_b', '金库', '紧急锁门', '10 秒内漏怪不扣生命', 120, 'none', 10),
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
