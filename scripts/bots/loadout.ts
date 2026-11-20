import type { MapId, SkillId } from '../../src/core';

/** 战役里按章节已经解锁的技能（假设打过前面的章节） */
export function campaignSkills(map: MapId): SkillId[] {
  const base: SkillId[] = ['eraser_strike', 'bell', 'whiteout_zone'];
  if (map === 'ch1') return base;
  if (map === 'ch2') return [...base, 'caffeine', 'relocate'];
  return [...base, 'caffeine', 'relocate', 'ruler_sweep', 'scholarship'];
}
