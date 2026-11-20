import type { AffixId, EnemyId } from '../core/types';

export interface EnemyDef {
  id: EnemyId;
  name: string;
  desc: string;
  hp: number;
  speed: number;
  armor: number;
  bounty: number;
  xp: number;
  lives: number;
  radius: number;
  flying: boolean;
  boss: boolean;
  /** 无尽模式首次出现波次（0 = 不按出场表出现） */
  first: number;
  baseCount: number;
  interval: number;
  weight: number;
  /** 护盾 = 生命 × shieldRatio */
  shieldRatio?: number;
  stealthy?: boolean;
  unstoppable?: boolean;
  /** 弹道闪避概率 */
  dodge?: number;
  /** 快速敌人（冲锋波 ×2） */
  fast?: boolean;
}

export const ENEMIES: Record<EnemyId, EnemyDef> = {
  crumb: { id: 'crumb', name: '橡皮屑', desc: '最普通的小麻烦', hp: 20, speed: 1.6, armor: 0, bounty: 3, xp: 6, lives: 1, radius: 0.24, flying: false, boss: false, first: 1, baseCount: 9, interval: 0.8, weight: 10 },
  inkdot: { id: 'inkdot', name: '墨点', desc: '速度很快', hp: 12, speed: 2.8, armor: 0, bounty: 3, xp: 6, lives: 1, radius: 0.2, flying: false, boss: false, first: 3, baseCount: 5, interval: 0.5, weight: 7, fast: true },
  paperclip: { id: 'paperclip', name: '回形针', desc: '带护甲', hp: 45, speed: 1.2, armor: 3, bounty: 6, xp: 12, lives: 1, radius: 0.27, flying: false, boss: false, first: 5, baseCount: 3, interval: 1.2, weight: 5 },
  plane: { id: 'plane', name: '纸飞机', desc: '飞行，直线飞向出口', hp: 18, speed: 1.8, armor: 0, bounty: 4, xp: 9, lives: 1, radius: 0.28, flying: true, boss: false, first: 6, baseCount: 4, interval: 0.9, weight: 4 },
  paperball: { id: 'paperball', name: '纸团', desc: '死亡后分裂成 3 个小纸屑', hp: 40, speed: 1.3, armor: 0, bounty: 4, xp: 9, lives: 1, radius: 0.3, flying: false, boss: false, first: 8, baseCount: 3, interval: 1.2, weight: 4 },
  sticky: { id: 'sticky', name: '便利贴', desc: '带护盾，4 秒未受击时恢复', hp: 30, speed: 1.4, armor: 0, bounty: 6, xp: 12, lives: 1, radius: 0.3, flying: false, boss: false, first: 12, baseCount: 3, interval: 1.2, weight: 4, shieldRatio: 1.0 },
  rubberband: { id: 'rubberband', name: '橡皮筋', desc: '每 4 秒向前弹跳 2 格', hp: 28, speed: 1.5, armor: 0, bounty: 5, xp: 12, lives: 1, radius: 0.27, flying: false, boss: false, first: 14, baseCount: 3, interval: 1.0, weight: 3 },
  whiteout: { id: 'whiteout', name: '修正液', desc: '治疗周围队友', hp: 35, speed: 1.3, armor: 1, bounty: 7, xp: 15, lives: 1, radius: 0.27, flying: false, boss: false, first: 16, baseCount: 2, interval: 1.5, weight: 2 },
  ant: { id: 'ant', name: '蚂蚁', desc: '成群出现，偷金币不扣命', hp: 15, speed: 2.4, armor: 0, bounty: 2, xp: 3, lives: 0, radius: 0.17, flying: false, boss: false, first: 18, baseCount: 6, interval: 0.2, weight: 3, fast: true },
  invisink: { id: 'invisink', name: '隐形墨水', desc: '隐形，需要侦测', hp: 25, speed: 1.8, armor: 0, bounty: 6, xp: 12, lives: 1, radius: 0.25, flying: false, boss: false, first: 22, baseCount: 3, interval: 1.0, weight: 3, stealthy: true },
  tape: { id: 'tape', name: '胶带卷', desc: '免控坦克', hp: 120, speed: 0.8, armor: 2, bounty: 10, xp: 24, lives: 2, radius: 0.36, flying: false, boss: false, first: 25, baseCount: 1, interval: 2.5, weight: 2, unstoppable: true },
  moth: { id: 'moth', name: '飞蛾', desc: '飞行，25% 闪避弹道，怕台灯', hp: 22, speed: 2.0, armor: 0, bounty: 5, xp: 12, lives: 1, radius: 0.28, flying: true, boss: false, first: 28, baseCount: 4, interval: 0.8, weight: 3, dodge: 0.25, fast: true },
  crumbmini: { id: 'crumbmini', name: '小纸屑', desc: '纸团分裂出的碎屑', hp: 6, speed: 1.8, armor: 0, bounty: 1, xp: 1.5, lives: 1, radius: 0.16, flying: false, boss: false, first: 0, baseCount: 0, interval: 0.5, weight: 0 },
  boss_coffee: { id: 'boss_coffee', name: '咖啡渍', desc: '泼洒瘫痪塔；半血时一分为二', hp: 300, speed: 0.9, armor: 2, bounty: 50, xp: 120, lives: 5, radius: 0.48, flying: false, boss: true, first: 10, baseCount: 1, interval: 3, weight: 0 },
  boss_coffee_small: { id: 'boss_coffee_small', name: '小咖啡渍', desc: '咖啡渍分裂而成', hp: 150, speed: 1.0, armor: 2, bounty: 25, xp: 60, lives: 3, radius: 0.36, flying: false, boss: true, first: 0, baseCount: 0, interval: 1, weight: 0 },
  boss_shredder: { id: 'boss_shredder', name: '碎纸机', desc: '高护甲，不断吐出橡皮屑', hp: 500, speed: 0.7, armor: 6, bounty: 80, xp: 180, lives: 5, radius: 0.5, flying: false, boss: true, first: 20, baseCount: 1, interval: 3, weight: 0 },
  boss_inkbottle: { id: 'boss_inkbottle', name: '墨水瓶', desc: '给队友加护盾；残血时隐入墨云', hp: 700, speed: 0.8, armor: 3, bounty: 100, xp: 240, lives: 5, radius: 0.48, flying: false, boss: true, first: 30, baseCount: 1, interval: 3, weight: 0 },
  boss_alarm: { id: 'boss_alarm', name: '闹钟', desc: '响铃让全场加速；免疫眩晕', hp: 900, speed: 1.0, armor: 4, bounty: 120, xp: 300, lives: 8, radius: 0.5, flying: false, boss: true, first: 40, baseCount: 1, interval: 3, weight: 0 },
};

/** 无尽出场表（按首次出现排序） */
export const ENDLESS_POOL: EnemyId[] = [
  'crumb', 'inkdot', 'paperclip', 'plane', 'paperball', 'sticky',
  'rubberband', 'whiteout', 'ant', 'invisink', 'tape', 'moth',
];

export const BOSS_ROTATION: EnemyId[] = ['boss_coffee', 'boss_shredder', 'boss_inkbottle', 'boss_alarm'];

export interface AffixDef {
  id: AffixId;
  name: string;
  desc: string;
  /** 互斥词缀 */
  excludes?: AffixId[];
  /** 不会出现在这些敌人身上 */
  notOn?: EnemyId[];
}

export const AFFIXES: Record<AffixId, AffixDef> = {
  hard: { id: 'hard', name: '坚硬', desc: '护甲 +3' },
  swift: { id: 'swift', name: '迅捷', desc: '速度 ×1.35', excludes: ['unstoppable'] },
  regen: { id: 'regen', name: '再生', desc: '每秒回复 2% 最大生命' },
  shield: { id: 'shield', name: '护盾', desc: '获得最大生命 30% 的护盾' },
  split: { id: 'split', name: '分裂', desc: '死后分裂成 2 个同类敌人（生命 30%）', notOn: ['crumbmini'] },
  stealth: { id: 'stealth', name: '隐身', desc: '获得隐形', notOn: ['invisink'] },
  reflect: { id: 'reflect', name: '反光', desc: '受到光束伤害 −50%' },
  unstoppable: { id: 'unstoppable', name: '免控', desc: '免疫减速、眩晕、击退', excludes: ['swift'], notOn: ['tape'] },
  rally: { id: 'rally', name: '激励', desc: '1.5 格内队友速度 +20%' },
};

export const AFFIX_IDS: AffixId[] = ['hard', 'swift', 'regen', 'shield', 'split', 'stealth', 'reflect', 'unstoppable', 'rally'];

export const ELITE = { hp: 2.5, scale: 1.2, bounty: 2, xp: 2 };
