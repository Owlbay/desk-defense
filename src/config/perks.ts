import type { Rarity } from '../core/types';

export type PerkId =
  | 'sharpener' | 'quickglue' | 'thickcover' | 'pocketmoney' | 'notes' | 'earlybird'
  | 'bulb' | 'staples' | 'compound' | 'sale' | 'quickreview' | 'safe' | 'drafting' | 'inkplenty'
  | 'promotion' | 'scholaraura' | 'pocket' | 'timemgmt' | 'tradein' | 'legend';

export interface PerkDef {
  id: PerkId;
  name: string;
  desc: string;
  rarity: Rarity;
  needsTower?: boolean;
  /** 可重复选择 */
  repeatable?: boolean;
}

export const PERKS: PerkDef[] = [
  { id: 'sharpener', name: '削笔刀', desc: '铅笔塔伤害 +20%', rarity: 'common' },
  { id: 'quickglue', name: '快干胶', desc: '胶水减速 +10%，持续时间 +0.5 秒', rarity: 'common' },
  { id: 'thickcover', name: '加厚书皮', desc: '书本墙造价降为 3，升级费用 −30%', rarity: 'common' },
  { id: 'pocketmoney', name: '零花钱', desc: '立即获得 50 + 5×波数 金币', rarity: 'common', repeatable: true },
  { id: 'notes', name: '复习笔记', desc: '所有塔获得经验 +15%', rarity: 'common' },
  { id: 'earlybird', name: '早起的鸟', desc: '提前开波奖励 ×2', rarity: 'common' },
  { id: 'bulb', name: '节能灯泡', desc: '台灯攻击间隔 −20%', rarity: 'rare' },
  { id: 'staples', name: '订书钉补充装', desc: '订书机眩晕概率 +10%', rarity: 'rare' },
  { id: 'compound', name: '利滚利', desc: '利息比例提高到 8%，上限 +10', rarity: 'rare' },
  { id: 'sale', name: '打折季', desc: '所有塔造价和升级费用 −10%', rarity: 'rare' },
  { id: 'quickreview', name: '快速复习', desc: '所有技能冷却 −15%', rarity: 'rare' },
  { id: 'safe', name: '保险箱', desc: '生命 +5', rarity: 'rare' },
  { id: 'drafting', name: '精确制图', desc: '尺子、圆规射程 +0.5', rarity: 'rare' },
  { id: 'inkplenty', name: '墨水管够', desc: '钢笔墨迹最大层数 +2', rarity: 'rare' },
  { id: 'promotion', name: '全员晋升', desc: '场上所有塔立即升 1 级（不超过 Lv9）', rarity: 'epic' },
  { id: 'scholaraura', name: '学霸光环', desc: '计算器光环范围 +1，并且可以叠加', rarity: 'epic' },
  { id: 'pocket', name: '二次元口袋', desc: '额外获得 1 个技能槽，随机给 1 个未带入的技能', rarity: 'epic' },
  { id: 'timemgmt', name: '时间管理', desc: '每波开始时，所有地面敌人眩晕 1 秒', rarity: 'epic' },
  { id: 'tradein', name: '以旧换新', desc: '卖塔返还率固定为 70%', rarity: 'epic' },
  { id: 'legend', name: '传奇在望', desc: '选一座 Lv7 以上的塔并选择分支，直接升到 Lv10，只付一半传奇费用', rarity: 'epic', needsTower: true },
];

export const PERK_MAP: Record<string, PerkDef> = Object.fromEntries(PERKS.map((p) => [p.id, p]));

export const RARITY_WEIGHT: Record<Rarity, number> = { common: 60, rare: 30, epic: 10 };
export const EPIC_WEIGHT_LATE = 15;
export const EPIC_LATE_WAVE = 30;
export const PERK_REROLL_COST = 50;
