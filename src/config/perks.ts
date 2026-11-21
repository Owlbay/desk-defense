import type { Rarity } from '../core/types';
import { localize } from './text';

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

/** 增益：名称 / 说明走 i18n（data.perk.<id>.*） */
const perk = (d: Omit<PerkDef, 'name' | 'desc'>): PerkDef => localize(d, `data.perk.${d.id}`, ['name', 'desc'] as const);

export const PERKS: PerkDef[] = [
  perk({ id: 'sharpener', rarity: 'common' }),
  perk({ id: 'quickglue', rarity: 'common' }),
  perk({ id: 'thickcover', rarity: 'common' }),
  perk({ id: 'pocketmoney', rarity: 'common', repeatable: true }),
  perk({ id: 'notes', rarity: 'common' }),
  perk({ id: 'earlybird', rarity: 'common' }),
  perk({ id: 'bulb', rarity: 'rare' }),
  perk({ id: 'staples', rarity: 'rare' }),
  perk({ id: 'compound', rarity: 'rare' }),
  perk({ id: 'sale', rarity: 'rare' }),
  perk({ id: 'quickreview', rarity: 'rare' }),
  perk({ id: 'safe', rarity: 'rare' }),
  perk({ id: 'drafting', rarity: 'rare' }),
  perk({ id: 'inkplenty', rarity: 'rare' }),
  perk({ id: 'promotion', rarity: 'epic' }),
  perk({ id: 'scholaraura', rarity: 'epic' }),
  perk({ id: 'pocket', rarity: 'epic' }),
  perk({ id: 'timemgmt', rarity: 'epic' }),
  perk({ id: 'tradein', rarity: 'epic' }),
  perk({ id: 'legend', rarity: 'epic', needsTower: true }),
];

export const PERK_MAP: Record<string, PerkDef> = Object.fromEntries(PERKS.map((p) => [p.id, p]));

export const RARITY_WEIGHT: Record<Rarity, number> = { common: 60, rare: 30, epic: 10 };
export const EPIC_WEIGHT_LATE = 15;
export const EPIC_LATE_WAVE = 30;
export const PERK_REROLL_COST = 50;
