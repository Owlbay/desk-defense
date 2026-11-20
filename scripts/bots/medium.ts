/**
 * 中等：造一段像样的蛇形迷宫（3～4 道挡板），混合塔型沿迷宫摆放，
 * 按"每金币收益"比较买塔和升级，技能冷却好就放，增益按常识挑。
 */
import type { BotParams } from './strategy';
import type { MapId, ModeId } from '../../src/core';
import { campaignSkills } from './loadout';

export function medium(ctx: { mode: ModeId; map: MapId }): BotParams {
  return {
    name: 'medium',
    skills: ctx.mode === 'campaign' ? campaignSkills(ctx.map).slice(0, 3) : ['eraser_strike', 'bell', 'whiteout_zone'],
    extraSkill: 'caffeine',
    mazeSegments: (w) => (w < 3 ? 2 : w < 8 ? 3 : w < 14 ? 4 : 99),
    wallShare: 0.4,
    rotation: ['pencil', 'pencil', 'glue', 'stapler', 'pencil', 'lamp', 'compass', 'pencil', 'ruler', 'eraser', 'stapler', 'pen', 'lamp', 'glue', 'compass', 'pencil'],
    maxTowers: (w) => Math.min(6 + w, 36),
    upgrade: 'value',
    upgradeBias: 1,
    reserve: () => 0,
    skillUse: 'cooldown',
    perkPriority: [
      'promotion', 'legend', 'sale', 'notes', 'sharpener', 'safe', 'timemgmt', 'compound', 'pocketmoney',
      'quickreview', 'bulb', 'drafting', 'quickglue', 'staples', 'inkplenty', 'earlybird', 'thickcover', 'scholaraura', 'pocket', 'tradein',
    ],
    branches: { pencil: 'A', stapler: 'A', glue: 'A', lamp: 'A', compass: 'A', eraser: 'A', ruler: 'A', pen: 'B', calculator: 'A', piggy: 'A' },
    combos: false,
    wallUpgrades: false,
    earlyStart: false,
    offPlan: false,
    placeNoise: 0.1,
    opening: ['pencil', 'pencil', 'pencil'],
    demolishAt: 2.5,
    abilities: 'ready',
    airGuard: 0.6,
    airExtra: 6,
    swatters: (w) => 1 + Math.floor(w / 12),
    decisionTicks: 30,
    xpProbe: true,
  };
}
