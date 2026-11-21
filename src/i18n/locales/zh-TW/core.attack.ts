import type { Dict } from '../../index';

// 命名空間 core · AI 進攻方改寫波次的拒絕原因（文件 10 §2.3；zh-TW）
export default {
  'core.reason.attackPhase': '只能在對局進行中、下一波開始之前改寫它',
  'core.reason.attackWave': '只能改寫下一波（第 {wave} 波）',
  'core.reason.attackBadPlan': '出題格式不對：需要 1 組以上的敵人',
  'core.reason.attackGroups': '最多 {max} 組敵人',
  'core.reason.attackEnemy': '{name} 不在本波的出怪池裡',
  'core.reason.attackCount': '每組數量須為 1～{max}',
  'core.reason.attackAffixCount': '每組最多 {max} 個詞綴',
  'core.reason.attackAffix': '{name} 不能帶詞綴「{affix}」',
  'core.reason.attackSpawner': '出生點 {id} 現在不可用',
  'core.reason.attackDelay': '出發時間須在 0～{max} 秒',
  'core.reason.attackBudget': '墨水點不夠：需要 {cost}，預算 {budget}',
  'core.reason.attackHp': '太強了：生命當量 {hp} 超過上限 {cap}',
  'core.reason.attackPending': 'AI 還在給下一波出題，稍等一下再開波',
} satisfies Dict;
