import type { AffixId, EnemyId } from '../core/types';
import { localize } from './text';

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

/** 敌人定义：名称 / 说明走 i18n（data.enemy.<id>.*） */
const enemy = (d: Omit<EnemyDef, 'name' | 'desc'>): EnemyDef => localize(d, `data.enemy.${d.id}`, ['name', 'desc'] as const);

export const ENEMIES: Record<EnemyId, EnemyDef> = {
  crumb: enemy({ id: 'crumb', hp: 20, speed: 1.6, armor: 0, bounty: 3, xp: 6, lives: 1, radius: 0.24, flying: false, boss: false, first: 1, baseCount: 9, interval: 0.8, weight: 10 }),
  inkdot: enemy({ id: 'inkdot', hp: 12, speed: 2.8, armor: 0, bounty: 3, xp: 6, lives: 1, radius: 0.2, flying: false, boss: false, first: 3, baseCount: 5, interval: 0.5, weight: 7, fast: true }),
  paperclip: enemy({ id: 'paperclip', hp: 45, speed: 1.2, armor: 3, bounty: 6, xp: 12, lives: 1, radius: 0.27, flying: false, boss: false, first: 5, baseCount: 3, interval: 1.2, weight: 5 }),
  plane: enemy({ id: 'plane', hp: 18, speed: 1.8, armor: 0, bounty: 4, xp: 9, lives: 1, radius: 0.28, flying: true, boss: false, first: 6, baseCount: 4, interval: 0.9, weight: 4 }),
  paperball: enemy({ id: 'paperball', hp: 40, speed: 1.3, armor: 0, bounty: 4, xp: 9, lives: 1, radius: 0.3, flying: false, boss: false, first: 8, baseCount: 3, interval: 1.2, weight: 4 }),
  sticky: enemy({ id: 'sticky', hp: 30, speed: 1.4, armor: 0, bounty: 6, xp: 12, lives: 1, radius: 0.3, flying: false, boss: false, first: 12, baseCount: 3, interval: 1.2, weight: 4, shieldRatio: 1.0 }),
  rubberband: enemy({ id: 'rubberband', hp: 28, speed: 1.5, armor: 0, bounty: 5, xp: 12, lives: 1, radius: 0.27, flying: false, boss: false, first: 14, baseCount: 3, interval: 1.0, weight: 3 }),
  whiteout: enemy({ id: 'whiteout', hp: 35, speed: 1.3, armor: 1, bounty: 7, xp: 15, lives: 1, radius: 0.27, flying: false, boss: false, first: 16, baseCount: 2, interval: 1.5, weight: 2 }),
  ant: enemy({ id: 'ant', hp: 15, speed: 2.4, armor: 0, bounty: 2, xp: 3, lives: 0, radius: 0.17, flying: false, boss: false, first: 18, baseCount: 6, interval: 0.2, weight: 3, fast: true }),
  invisink: enemy({ id: 'invisink', hp: 25, speed: 1.8, armor: 0, bounty: 6, xp: 12, lives: 1, radius: 0.25, flying: false, boss: false, first: 22, baseCount: 3, interval: 1.0, weight: 3, stealthy: true }),
  tape: enemy({ id: 'tape', hp: 120, speed: 0.8, armor: 2, bounty: 10, xp: 24, lives: 2, radius: 0.36, flying: false, boss: false, first: 25, baseCount: 1, interval: 2.5, weight: 2, unstoppable: true }),
  moth: enemy({ id: 'moth', hp: 22, speed: 2.0, armor: 0, bounty: 5, xp: 12, lives: 1, radius: 0.28, flying: true, boss: false, first: 28, baseCount: 4, interval: 0.8, weight: 3, dodge: 0.25, fast: true }),
  goldbag: enemy({ id: 'goldbag', hp: 70, speed: 2.5, armor: 1, bounty: 0, xp: 30, lives: 0, radius: 0.27, flying: false, boss: false, first: 0, baseCount: 0, interval: 1, weight: 0, fast: true }),
  crumbmini: enemy({ id: 'crumbmini', hp: 6, speed: 1.8, armor: 0, bounty: 1, xp: 1.5, lives: 1, radius: 0.16, flying: false, boss: false, first: 0, baseCount: 0, interval: 0.5, weight: 0 }),
  boss_coffee: enemy({ id: 'boss_coffee', hp: 300, speed: 0.9, armor: 2, bounty: 50, xp: 120, lives: 5, radius: 0.48, flying: false, boss: true, first: 10, baseCount: 1, interval: 3, weight: 0 }),
  boss_coffee_small: enemy({ id: 'boss_coffee_small', hp: 150, speed: 1.0, armor: 2, bounty: 25, xp: 60, lives: 3, radius: 0.36, flying: false, boss: true, first: 0, baseCount: 0, interval: 1, weight: 0 }),
  boss_shredder: enemy({ id: 'boss_shredder', hp: 500, speed: 0.7, armor: 6, bounty: 80, xp: 180, lives: 5, radius: 0.5, flying: false, boss: true, first: 20, baseCount: 1, interval: 3, weight: 0 }),
  boss_inkbottle: enemy({ id: 'boss_inkbottle', hp: 700, speed: 0.8, armor: 3, bounty: 100, xp: 240, lives: 5, radius: 0.48, flying: false, boss: true, first: 30, baseCount: 1, interval: 3, weight: 0 }),
  boss_alarm: enemy({ id: 'boss_alarm', hp: 900, speed: 1.0, armor: 4, bounty: 120, xp: 300, lives: 8, radius: 0.5, flying: false, boss: true, first: 40, baseCount: 1, interval: 3, weight: 0 }),
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

/** 词缀：名称 / 说明走 i18n（data.affix.<id>.*） */
const affix = (d: Omit<AffixDef, 'name' | 'desc'>): AffixDef => localize(d, `data.affix.${d.id}`, ['name', 'desc'] as const);

export const AFFIXES: Record<AffixId, AffixDef> = {
  hard: affix({ id: 'hard' }),
  swift: affix({ id: 'swift', excludes: ['unstoppable'] }),
  regen: affix({ id: 'regen' }),
  shield: affix({ id: 'shield' }),
  split: affix({ id: 'split', notOn: ['crumbmini'] }),
  stealth: affix({ id: 'stealth', notOn: ['invisink'] }),
  reflect: affix({ id: 'reflect' }),
  unstoppable: affix({ id: 'unstoppable', excludes: ['swift'], notOn: ['tape'] }),
  rally: affix({ id: 'rally' }),
  /** 金色精英：只由「金色精英」事件赋予（不参与随机抽取）；死亡掉落一堆可收集硬币 */
  golden: affix({ id: 'golden', excludes: ['split'], notOn: ['crumbmini', 'goldbag', 'boss_coffee', 'boss_coffee_small', 'boss_shredder', 'boss_inkbottle', 'boss_alarm'] }),
};

/** 全部词缀（图鉴 / 文档用） */
export const AFFIX_IDS: AffixId[] = ['hard', 'swift', 'regen', 'shield', 'split', 'stealth', 'reflect', 'unstoppable', 'rally', 'golden'];
/** 波次生成时随机抽取的词缀（不含事件专属的 golden） */
export const AFFIX_ROLL_IDS: AffixId[] = AFFIX_IDS.filter((a) => a !== 'golden');

export const ELITE = { hp: 2.5, scale: 1.2, bounty: 2, xp: 2 };

/** 金色精英（事件词缀 golden）：额外生命倍率 / 护甲 */
export const GOLDEN = { hp: 1.5, armor: 1 };
