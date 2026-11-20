/**
 * ui 使用的 core 元数据（文档 08「入口函数」）。集中在这里引用，便于对接。
 */
export {
  TOWER_META,
  SKILL_META,
  TALENT_META,
  DIFFICULTY_PRESETS,
  resolveParams,
  MAP_META,
  ENEMY_META,
  AFFIX_META,
} from '../core';

export { TOWER_IDS } from '../core/types';

import type { SkillId, TalentId } from '../core/types';

export const SKILL_ORDER: SkillId[] = [
  'eraser_strike',
  'bell',
  'whiteout_zone',
  'caffeine',
  'ruler_sweep',
  'scholarship',
  'relocate',
  'inspiration',
  'magnifier',
];

export const TALENT_ORDER: TalentId[] = ['wallet', 'bandaid', 'alarm', 'study', 'secondhand', 'bigbag', 'luckydraw', 'collector'];
