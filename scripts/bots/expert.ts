/**
 * 高手：完整蛇形迷宫 + 补格、组合技相邻摆放、计算器罩主力、存钱罐贴计算器（复利）、
 * 书本墙升级、按收益升级到传奇并选强分支、安全时提前开波、挑时机放技能。
 */
import type { BotParams } from './strategy';
import type { MapId, ModeId } from '../../src/core';
import { campaignSkills } from './loadout';

export function expert(ctx: { mode: ModeId; map: MapId }): BotParams {
  const skills = ctx.mode === 'campaign'
    ? (ctx.map === 'ch1' ? campaignSkills('ch1') : ctx.map === 'ch2' ? ['bell', 'caffeine', 'eraser_strike'] : ['bell', 'caffeine', 'scholarship'])
    : ['eraser_strike', 'bell', 'caffeine'];
  return {
    name: 'expert',
    skills: skills as BotParams['skills'],
    extraSkill: 'scholarship',
    mazeSegments: () => 99,
    wallShare: 0.5,
    rotation: [
      'pencil', 'pencil', 'eraser', 'pencil', 'pencil', 'lamp', 'pencil', 'pencil', 'glue', 'pencil', 'lamp', 'pencil', 'eraser',
      'pencil', 'calculator', 'pencil', 'compass', 'pencil', 'piggy', 'lamp', 'pencil', 'stapler', 'pencil', 'calculator', 'piggy',
    ],
    maxTowers: (w) => Math.min(8 + w * 1.5, 48),
    upgrade: 'value',
    upgradeBias: 1.5,
    reserve: () => 0,
    skillUse: 'smart',
    perkPriority: [
      'legend', 'promotion', 'sale', 'compound', 'timemgmt', 'notes', 'sharpener', 'quickreview', 'scholaraura', 'safe',
      'drafting', 'bulb', 'pocket', 'pocketmoney', 'staples', 'quickglue', 'inkplenty', 'earlybird', 'thickcover', 'tradein',
    ],
    branches: { pencil: 'A', stapler: 'B', glue: 'B', lamp: 'A', compass: 'B', eraser: 'A', ruler: 'B', pen: 'B', calculator: 'A', piggy: 'A' },
    combos: true,
    wallUpgrades: true,
    earlyStart: true,
    offPlan: false,
    placeNoise: 0,
    opening: ['pencil', 'pencil', 'pencil', 'pencil'],
    decisionTicks: 20,
    xpProbe: false,
  };
}
