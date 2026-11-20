import type { TowerId } from '../core/types';

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

/** 每级成长（文档 02 §1.2） */
export const GROWTH = { damage: 1.15, interval: 0.97, range: 0.06 };

export const TOWERS: Record<TowerId, TowerDef> = {
  wall: {
    id: 'wall', name: '书本墙', cost: 5, role: '造迷宫', desc: '堵路、改路线；升级后给相邻塔加成',
    hitsAir: false, hitsGround: false, unlock: '1-1', attacks: false,
    damage: 0, interval: 0, range: 0, projSpeed: 0, maxLevel: 3,
    t2: { name: '精装书', desc: '相邻攻击塔射程 +5%' },
    t3: { name: '百科全书', desc: '相邻攻击塔射程 +5%，伤害 +5%' },
    A: { name: '—', desc: '' }, B: { name: '—', desc: '' },
  },
  pencil: {
    id: 'pencil', name: '铅笔塔', cost: 20, role: '单体', desc: '发射追踪笔芯弹，地空皆可',
    hitsAir: true, hitsGround: true, unlock: '1-1', attacks: true,
    damage: 8, interval: 0.5, range: 2.5, projSpeed: 10, maxLevel: 10,
    t2: { name: '削尖', desc: '15% 概率暴击，造成 2 倍伤害' },
    t3: { name: '双笔齐发', desc: '一次射出 2 发' },
    A: { name: '自动铅笔', desc: '攻速 ×2，单发伤害 ×0.7' },
    B: { name: '彩色铅笔', desc: '命中随机附带：红色灼烧、蓝色减速、黄色 +1 金币（每波最多 15 次）' },
  },
  stapler: {
    id: 'stapler', name: '订书机', cost: 45, role: '近身群伤', desc: '咔嚓一下，打到范围内所有地面敌人',
    hitsAir: false, hitsGround: true, unlock: '1-3', attacks: true,
    damage: 12, interval: 1.0, range: 1.6, projSpeed: 0, maxLevel: 10,
    t2: { name: '钉住', desc: '10% 概率眩晕 0.5 秒（同一目标 3 秒内一次）' },
    t3: { name: '重型订书机', desc: '范围 +0.3 格，对有护甲的敌人 +4 伤害' },
    A: { name: '电动订书机', desc: '攻击间隔 0.4 秒，单次伤害 ×0.6' },
    B: { name: '起钉器', desc: '每次命中 −1 护甲（最多 −5），对 0 护甲敌人伤害 +30%' },
  },
  glue: {
    id: 'glue', name: '胶水瓶', cost: 35, role: '减速', desc: '胶团落点 0.8 格内敌人减速 40%',
    hitsAir: false, hitsGround: true, unlock: '1-2', attacks: true,
    damage: 2, interval: 0.8, range: 2.2, projSpeed: 7, maxLevel: 10,
    t2: { name: '残胶', desc: '落点留下一滩胶水，持续 3 秒' },
    t3: { name: '强力胶', desc: '基础减速提高到 55%' },
    A: { name: '502 胶', desc: '25% 概率定身 1 秒（Boss 0.3 秒）' },
    B: { name: '热熔胶', desc: '胶滩改为每秒造成 10 点灼烧伤害' },
  },
  lamp: {
    id: 'lamp', name: '台灯', cost: 80, role: '穿甲光束', desc: '瞬发光束，无视护甲，侦测 1.5 格内隐形',
    hitsAir: true, hitsGround: true, unlock: '1-6', attacks: true,
    damage: 30, interval: 1.5, range: 3.5, projSpeed: 0, maxLevel: 10,
    t2: { name: '聚光', desc: '连续打同一目标每次 +20%，最多 3 层' },
    t3: { name: '双灯头', desc: '同时打 2 个目标' },
    A: { name: '激光笔', desc: '持续光束每秒 20 点，每秒递增 25%' },
    B: { name: '护眼灯', desc: '整个射程侦测隐形；被照到的敌人受到伤害 +15%' },
  },
  compass: {
    id: 'compass', name: '圆规', cost: 60, role: '环形切割', desc: '对 0.8–1.8 格环形区域持续伤害',
    hitsAir: false, hitsGround: true, unlock: '2-1', attacks: true,
    damage: 6, interval: 0.25, range: 1.8, inner: 0.8, projSpeed: 0, maxLevel: 10,
    t2: { name: '加速旋转', desc: '攻击间隔变为 0.2 秒' },
    t3: { name: '双脚', desc: '内圈也能打到（0–1.8 格）' },
    A: { name: '量角器', desc: '范围 2.5 格扇形来回扫射，伤害 ×1.5' },
    B: { name: '钻头', desc: '命中叠加流血，每层每秒 2 点，最多 10 层' },
  },
  eraser: {
    id: 'eraser', name: '橡皮擦', cost: 40, role: '破甲破盾', desc: '每次命中 −1 护甲，对护盾 3 倍伤害',
    hitsAir: false, hitsGround: true, unlock: '2-3', attacks: true,
    damage: 4, interval: 1.0, range: 2.0, projSpeed: 9, maxLevel: 10,
    t2: { name: '弹跳', desc: '攻击弹到附近第 2 个目标' },
    t3: { name: '深度擦除', desc: '每次命中 −2 护甲' },
    A: { name: '修正带', desc: '在目标脚下拉出 3 格修正带，路过敌人受伤 +25%' },
    B: { name: '电动橡皮', desc: '攻击间隔 0.35 秒，10% 概率清空护盾' },
  },
  ruler: {
    id: 'ruler', name: '尺子', cost: 70, role: '远程穿透', desc: '直线刻度波，穿透路线上所有敌人',
    hitsAir: true, hitsGround: true, unlock: '2-6', attacks: true,
    damage: 20, interval: 2.0, range: 4.5, projSpeed: 12, maxLevel: 10,
    t2: { name: '刻度', desc: '每飞过 1 格伤害 +3%' },
    t3: { name: '三角尺', desc: '一次射出 3 道，呈 30° 扇形' },
    A: { name: '钢尺', desc: '被命中的地面敌人后退 0.5 格' },
    B: { name: '游标卡尺', desc: '处决生命低于 10% 的非 Boss 敌人' },
  },
  pen: {
    id: 'pen', name: '钢笔', cost: 55, role: '持续伤害', desc: '挂墨迹每秒 6 点，减半治疗',
    hitsAir: true, hitsGround: true, unlock: '3-1', attacks: true,
    damage: 3, interval: 1.0, range: 2.8, projSpeed: 9, maxLevel: 10,
    t2: { name: '溅墨', desc: '0.6 格内其他敌人也挂 1 层墨迹' },
    t3: { name: '浓墨', desc: '墨迹最多叠 5 层' },
    A: { name: '毛笔', desc: '大笔画打中 2 格长线上所有敌人，各叠 2 层' },
    B: { name: '红笔批改', desc: '被标记的敌人受到所有伤害 +20%' },
  },
  calculator: {
    id: 'calculator', name: '计算器', cost: 90, role: '增益', desc: '光环内攻击塔伤害 +10%，分享经验',
    hitsAir: false, hitsGround: false, unlock: '3-3', attacks: false,
    damage: 0, interval: 0, range: 0, aura: 2.0, projSpeed: 0, maxLevel: 10,
    t2: { name: '超频', desc: '光环内额外 +8% 攻速' },
    t3: { name: '高精度', desc: '额外 +15% 伤害，射程 +0.3' },
    A: { name: '科学计算器', desc: '光环内暴击率 +10%，暴击伤害 +50%' },
    B: { name: '算盘', desc: '光环内的塔获得经验 +50%' },
  },
  piggy: {
    id: 'piggy', name: '存钱罐', cost: 100, role: '经济', desc: '每波结束产出 8 金币（最多 3 个）',
    hitsAir: false, hitsGround: false, unlock: '3-6', attacks: false,
    damage: 0, interval: 0, range: 0, projSpeed: 0, maxLevel: 10,
    t2: { name: '定期存款', desc: '利息上限 +5' },
    t3: { name: '招财', desc: '周围 2.5 格内死亡的敌人额外 +1 金币' },
    A: { name: '金猪', desc: '每波产出翻倍' },
    B: { name: '保险箱', desc: '蚂蚁偷不走金币；每漏 1 只怪返还 10 金币' },
  },
};

export const WALL_UPGRADE_COST = [0, 15, 30]; // 索引为当前等级：Lv1→2 = 15，Lv2→3 = 30
export const PIGGY_MAX = 3;
export const UNDO_SECONDS = 5;

export const COMBOS: { a: TowerId; b: TowerId; name: string; desc: string }[] = [
  { a: 'pencil', b: 'eraser', name: '带橡皮的铅笔', desc: '铅笔每次命中 −0.5 护甲' },
  { a: 'glue', b: 'stapler', name: '粘住再钉', desc: '订书机对被减速的敌人伤害 +25%' },
  { a: 'lamp', b: 'pen', name: '墨迹烤干', desc: '钢笔墨迹持续伤害 +30%' },
  { a: 'ruler', b: 'compass', name: '尺规作图', desc: '两座塔射程各 +0.3' },
  { a: 'calculator', b: 'piggy', name: '复利', desc: '存钱罐每波产出 +25%' },
];

export const TIER_NAMES = ['草稿', '精良', '镀金', '传奇', '神话'];
