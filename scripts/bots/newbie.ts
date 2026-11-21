/** 新手：塔不多、几乎不造迷宫、沿路随手放、很少升级、技能想起来才按、增益选第一张 */
import type { MapId, ModeId } from '../../src/core';
import type { BotParams } from './strategy';

export function newbie(_ctx: { mode: ModeId; map: MapId }): BotParams {
  return {
    name: 'newbie',
    skills: ['eraser_strike', 'bell', 'whiteout_zone'],
    mazeSegments: () => 0,
    looseWalls: (w) => Math.min(Math.floor(w / 2), 8),
    wallShare: 0.2,
    rotation: ['pencil', 'pencil', 'stapler', 'pencil', 'glue', 'pencil', 'lamp', 'stapler', 'swatter'],
    maxTowers: (w) => Math.min(4 + Math.floor(w / 2), 16),
    upgrade: 'rare',
    upgradeBias: 1,
    reserve: () => 0,
    skillUse: 'rare',
    perkPriority: [],
    branches: {},
    combos: false,
    wallUpgrades: false,
    earlyStart: false,
    offPlan: true,
    placeNoise: 0.5,
    opening: ['pencil', 'pencil'],
    demolishAt: 0,
    abilities: 'none',
    decisionTicks: 60,
    xpProbe: false,
  };
}
