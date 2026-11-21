import type { Dict } from '../../index';

// 命名空间 core · AI 进攻方改写波次的拒绝原因（文档 10 §2.3；zh-CN）
export default {
  'core.reason.attackPhase': '只能在建造阶段、开波之前改写下一波',
  'core.reason.attackWave': '只能改写下一波（第 {wave} 波）',
  'core.reason.attackBadPlan': '出题格式不对：需要 1 组以上的敌人',
  'core.reason.attackGroups': '最多 {max} 组敌人',
  'core.reason.attackEnemy': '{name} 不在本波的出怪池里',
  'core.reason.attackCount': '每组数量须为 1～{max}',
  'core.reason.attackAffixCount': '每组最多 {max} 个词缀',
  'core.reason.attackAffix': '{name} 不能带词缀「{affix}」',
  'core.reason.attackSpawner': '出生点 {id} 现在不可用',
  'core.reason.attackDelay': '出发时间须在 0～{max} 秒',
  'core.reason.attackBudget': '墨水点不够：需要 {cost}，预算 {budget}',
  'core.reason.attackHp': '太强了：生命当量 {hp} 超过上限 {cap}',
} satisfies Dict;
