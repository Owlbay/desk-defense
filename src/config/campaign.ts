import type { EnemyId, MapId } from '../core/types';

export interface CampaignGroup {
  enemy: EnemyId;
  count: number;
  /** 生成间隔（缺省用敌人表的间隔） */
  interval?: number;
  /** 额外生命倍率（小 Boss 0.6） */
  hpMul?: number;
}

export interface CampaignWave {
  groups: CampaignGroup[];
  tags?: ('boss' | 'air' | 'rush')[];
}

export interface CampaignChapter {
  map: MapId;
  chapter: number;
  /** 成长公式使用的波数偏移：有效波数 = w + offset */
  waveOffset: number;
  boss: EnemyId;
  waves: CampaignWave[];
}

const g = (enemy: EnemyId, count: number, interval?: number, hpMul?: number): CampaignGroup => ({ enemy, count, interval, hpMul });

export const CAMPAIGN_WAVES = 20;
export const CAMPAIGN_MINI_BOSS_HP = 0.6;

export const CAMPAIGN: Record<MapId, CampaignChapter> = {
  ch1: {
    map: 'ch1', chapter: 1, waveOffset: 0, boss: 'boss_coffee',
    waves: [
      { groups: [g('crumb', 8)] },
      { groups: [g('crumb', 10)] },
      { groups: [g('crumb', 8), g('inkdot', 4)] },
      { groups: [g('crumb', 10), g('inkdot', 6)] },
      { groups: [g('paperclip', 3), g('crumb', 10)] },
      { groups: [g('plane', 4), g('crumb', 8)], tags: ['air'] },
      { groups: [g('inkdot', 10), g('paperclip', 3)], tags: ['rush'] },
      { groups: [g('paperball', 3), g('crumb', 10)] },
      { groups: [g('plane', 6), g('paperclip', 4), g('inkdot', 6)] },
      { groups: [g('boss_coffee', 1, 3, 0.6), g('crumb', 8)], tags: ['boss'] },
      { groups: [g('paperball', 5), g('inkdot', 8)] },
      { groups: [g('paperclip', 6), g('plane', 5)] },
      { groups: [g('crumb', 18, 0.5), g('inkdot', 10)], tags: ['rush'] },
      { groups: [g('paperball', 6), g('paperclip', 5)] },
      { groups: [g('plane', 10), g('inkdot', 6)], tags: ['air'] },
      { groups: [g('paperclip', 8), g('paperball', 6), g('crumb', 10)] },
      { groups: [g('inkdot', 16, 0.4), g('plane', 6)], tags: ['rush'] },
      { groups: [g('paperclip', 10), g('paperball', 8)] },
      { groups: [g('crumb', 20), g('inkdot', 12), g('plane', 8), g('paperclip', 6)] },
      { groups: [g('boss_coffee', 1), g('paperclip', 6), g('inkdot', 8)], tags: ['boss'] },
    ],
  },
  ch2: {
    map: 'ch2', chapter: 2, waveOffset: 1, boss: 'boss_shredder',
    waves: [
      { groups: [g('crumb', 8), g('inkdot', 3)] },
      { groups: [g('paperclip', 4), g('crumb', 8)] },
      { groups: [g('sticky', 4), g('crumb', 8)] },
      { groups: [g('plane', 6), g('inkdot', 6)], tags: ['air'] },
      { groups: [g('rubberband', 4), g('paperclip', 4)] },
      { groups: [g('paperball', 4), g('sticky', 4)] },
      { groups: [g('ant', 8, 0.2), g('inkdot', 8)], tags: ['rush'] },
      { groups: [g('rubberband', 6), g('crumb', 12)] },
      { groups: [g('sticky', 6), g('paperclip', 6), g('plane', 4)] },
      { groups: [g('boss_coffee', 1, 3, 0.6), g('sticky', 4), g('crumb', 8)], tags: ['boss'] },
      { groups: [g('ant', 10, 0.2), g('rubberband', 6)] },
      { groups: [g('plane', 12), g('inkdot', 6)], tags: ['air'] },
      { groups: [g('paperclip', 8), g('paperball', 6)] },
      { groups: [g('sticky', 8), g('rubberband', 6), g('ant', 8, 0.2)] },
      { groups: [g('inkdot', 18, 0.35), g('ant', 10, 0.2)], tags: ['rush'] },
      { groups: [g('paperclip', 10), g('sticky', 8)] },
      { groups: [g('rubberband', 10), g('plane', 8)] },
      { groups: [g('paperball', 10), g('ant', 12, 0.2), g('sticky', 6)] },
      { groups: [g('paperclip', 12), g('rubberband', 8), g('plane', 8), g('inkdot', 10)] },
      { groups: [g('boss_shredder', 1), g('sticky', 6), g('paperclip', 6)], tags: ['boss'] },
    ],
  },
  ch3: {
    map: 'ch3', chapter: 3, waveOffset: 2, boss: 'boss_inkbottle',
    waves: [
      { groups: [g('crumb', 10), g('inkdot', 6)] },
      { groups: [g('whiteout', 2), g('paperclip', 5)] },
      { groups: [g('plane', 6), g('crumb', 10)], tags: ['air'] },
      { groups: [g('invisink', 4), g('crumb', 8)] },
      { groups: [g('tape', 2), g('sticky', 4)] },
      { groups: [g('moth', 5), g('plane', 4)], tags: ['air'] },
      { groups: [g('whiteout', 3), g('paperclip', 6), g('rubberband', 4)] },
      { groups: [g('invisink', 6), g('ant', 8, 0.2)] },
      { groups: [g('tape', 3), g('whiteout', 3), g('inkdot', 8)] },
      { groups: [g('boss_shredder', 1, 3, 0.6), g('invisink', 4), g('crumb', 8)], tags: ['boss'] },
      { groups: [g('moth', 8), g('plane', 6)], tags: ['air'] },
      { groups: [g('tape', 4), g('sticky', 6), g('whiteout', 3)] },
      { groups: [g('inkdot', 16, 0.35), g('ant', 10, 0.2), g('invisink', 4)], tags: ['rush'] },
      { groups: [g('paperball', 8), g('whiteout', 4), g('paperclip', 6)] },
      { groups: [g('moth', 10), g('invisink', 6)] },
      { groups: [g('tape', 5), g('rubberband', 8), g('whiteout', 4)] },
      { groups: [g('plane', 10), g('moth', 10)], tags: ['air'] },
      { groups: [g('invisink', 10), g('sticky', 8), g('tape', 4)] },
      { groups: [g('paperclip', 12), g('whiteout', 5), g('moth', 8), g('ant', 12, 0.2)] },
      { groups: [g('boss_inkbottle', 1), g('tape', 3), g('invisink', 6), g('whiteout', 3)], tags: ['boss'] },
    ],
  },
};
