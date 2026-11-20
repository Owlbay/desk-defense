/**
 * 机器人注册表。每个机器人是 StrategyBot 的一组参数；新增策略只需在这里加一项。
 */
import type { MapId, ModeId } from '../../src/core';
import type { BotParams } from './strategy';
import { newbie } from './newbie';
import { medium } from './medium';
import { expert } from './expert';

export type BotFactory = (ctx: { mode: ModeId; map: MapId }) => BotParams;

export const BOTS: Record<string, BotFactory> = { newbie, medium, expert };

export { campaignSkills } from './loadout';
export { StrategyBot, type BotParams } from './strategy';
