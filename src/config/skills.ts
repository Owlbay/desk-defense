import type { SkillId, SkillState } from '../core/types';

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

export const SKILLS: Record<SkillId, SkillDef> = {
  eraser_strike: { id: 'eraser_strike', name: '大橡皮', desc: '半径 1.5 内造成 120×伤害缩放，可打飞行，暴露隐形 3 秒', cd: 50, unlock: 'default', target: 'circle', radius: 1.5 },
  bell: { id: 'bell', name: '下课铃', desc: '所有地面敌人眩晕 2.5 秒（Boss 与免控改为减速 50%）', cd: 90, unlock: 'default', target: 'none' },
  whiteout_zone: { id: 'whiteout_zone', name: '涂改液', desc: '2×2 区域持续 8 秒：减速 60%，暴露隐形', cd: 40, unlock: 'default', target: 'rect2' },
  caffeine: { id: 'caffeine', name: '咖啡因', desc: '所有塔攻速 +60%，持续 8 秒', cd: 80, unlock: '1-10', target: 'none' },
  ruler_sweep: { id: 'ruler_sweep', name: '横扫尺', desc: '一行或一列造成 80×伤害缩放，地面敌人击退 1 格', cd: 60, unlock: '2-5', target: 'line' },
  scholarship: { id: 'scholarship', name: '奖学金', desc: '立即获得 30 + 5×波数 金币', cd: 150, unlock: '2-10', target: 'none' },
  relocate: { id: 'relocate', name: '搬家', desc: '免费把塔挪到新位置，保留等级和经验（充能制，每 3 波恢复 1 次）', cd: 0, unlock: '1-15', target: 'tower+cell' },
  inspiration: { id: 'inspiration', name: '灵感闪现', desc: '一座塔立即获得下一级所需经验的 50%', cd: 120, unlock: '3-5', target: 'tower' },
  magnifier: { id: 'magnifier', name: '放大镜', desc: '半径 2 内持续 6 秒：暴露隐形，受到伤害 +25%', cd: 70, unlock: '3-10', target: 'circle', radius: 2 },
};

export const SKILL_IDS: SkillId[] = [
  'eraser_strike', 'bell', 'whiteout_zone', 'caffeine', 'ruler_sweep',
  'scholarship', 'relocate', 'inspiration', 'magnifier',
];

export const SKILL_LEVEL = { cdPerLevel: 0.08, effectPerLevel: 0.15, maxLevel: 3 };
export const RELOCATE_CHARGES = [2, 3, 4];
export const RELOCATE_RECOVER_WAVES = 3;
