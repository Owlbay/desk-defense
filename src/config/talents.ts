import type { TalentId } from '../core/types';
import { localize } from './text';

export interface TalentDef {
  id: TalentId;
  name: string;
  desc: string;
  max: number;
  star: number;
  ink: number;
}

/** 天赋：名称 / 说明走 i18n（data.talent.<id>.*） */
const talent = (d: Omit<TalentDef, 'name' | 'desc'>): TalentDef => localize(d, `data.talent.${d.id}`, ['name', 'desc'] as const);

export const TALENTS: Record<TalentId, TalentDef> = {
  wallet: talent({ id: 'wallet', max: 5, star: 2, ink: 40 }),
  bandaid: talent({ id: 'bandaid', max: 3, star: 3, ink: 60 }),
  alarm: talent({ id: 'alarm', max: 5, star: 2, ink: 50 }),
  study: talent({ id: 'study', max: 5, star: 2, ink: 50 }),
  secondhand: talent({ id: 'secondhand', max: 3, star: 3, ink: 60 }),
  bigbag: talent({ id: 'bigbag', max: 1, star: 6, ink: 200 }),
  luckydraw: talent({ id: 'luckydraw', max: 1, star: 4, ink: 120 }),
  collector: talent({ id: 'collector', max: 1, star: 8, ink: 300 }),
};

export const TALENT_IDS: TalentId[] = ['wallet', 'bandaid', 'alarm', 'study', 'secondhand', 'bigbag', 'luckydraw', 'collector'];
