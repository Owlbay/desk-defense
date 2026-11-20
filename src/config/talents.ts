import type { TalentId } from '../core/types';

export interface TalentDef {
  id: TalentId;
  name: string;
  desc: string;
  max: number;
  star: number;
  ink: number;
}

export const TALENTS: Record<TalentId, TalentDef> = {
  wallet: { id: 'wallet', name: '零钱包', desc: '初始金币 +5%', max: 5, star: 2, ink: 40 },
  bandaid: { id: 'bandaid', name: '创可贴', desc: '初始生命 +1', max: 3, star: 3, ink: 60 },
  alarm: { id: 'alarm', name: '闹钟提醒', desc: '技能冷却 −3%', max: 5, star: 2, ink: 50 },
  study: { id: 'study', name: '勤学', desc: '塔获得经验 +5%', max: 5, star: 2, ink: 50 },
  secondhand: { id: 'secondhand', name: '二手市场', desc: '卖塔返还率 +2%', max: 3, star: 3, ink: 60 },
  bigbag: { id: 'bigbag', name: '大书包', desc: '解锁第 4 个技能槽', max: 1, star: 6, ink: 200 },
  luckydraw: { id: 'luckydraw', name: '幸运签', desc: '增益刷新免费 1 次', max: 1, star: 4, ink: 120 },
  collector: { id: 'collector', name: '文具收藏家', desc: '局内增益变成四选一', max: 1, star: 8, ink: 300 },
};

export const TALENT_IDS: TalentId[] = ['wallet', 'bandaid', 'alarm', 'study', 'secondhand', 'bigbag', 'luckydraw', 'collector'];
