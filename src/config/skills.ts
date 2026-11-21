import type { SkillId, SkillState } from '../core/types';
import { localize } from './text';

export interface SkillDef {
  id: SkillId;
  name: string;
  desc: string;
  cd: number;
  /** 'default' 或战役 'c-w' */
  unlock: string;
  target: SkillState['target'];
  radius?: number;
}

/** 技能：名称 / 说明走 i18n（data.skill.<id>.*） */
const skill = (d: Omit<SkillDef, 'name' | 'desc'>): SkillDef => localize(d, `data.skill.${d.id}`, ['name', 'desc'] as const);

export const SKILLS: Record<SkillId, SkillDef> = {
  eraser_strike: skill({ id: 'eraser_strike', cd: 50, unlock: 'default', target: 'circle', radius: 1.5 }),
  bell: skill({ id: 'bell', cd: 90, unlock: 'default', target: 'none' }),
  whiteout_zone: skill({ id: 'whiteout_zone', cd: 40, unlock: 'default', target: 'rect2' }),
  caffeine: skill({ id: 'caffeine', cd: 80, unlock: '1-10', target: 'none' }),
  ruler_sweep: skill({ id: 'ruler_sweep', cd: 60, unlock: '2-5', target: 'line' }),
  scholarship: skill({ id: 'scholarship', cd: 150, unlock: '2-10', target: 'none' }),
  relocate: skill({ id: 'relocate', cd: 0, unlock: '1-15', target: 'tower+cell' }),
  inspiration: skill({ id: 'inspiration', cd: 120, unlock: '3-5', target: 'tower' }),
  magnifier: skill({ id: 'magnifier', cd: 70, unlock: '3-10', target: 'circle', radius: 2 }),
  seal_tape: skill({ id: 'seal_tape', cd: 60, unlock: '2-1', target: 'spawner' }),
};

export const SKILL_IDS: SkillId[] = [
  'eraser_strike', 'bell', 'whiteout_zone', 'caffeine', 'ruler_sweep',
  'scholarship', 'relocate', 'inspiration', 'magnifier', 'seal_tape',
];

export const SKILL_LEVEL = { cdPerLevel: 0.08, effectPerLevel: 0.15, maxLevel: 3 };
export const RELOCATE_CHARGES = [2, 3, 4];
export const RELOCATE_RECOVER_WAVES = 3;
