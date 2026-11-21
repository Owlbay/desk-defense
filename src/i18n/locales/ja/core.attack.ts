import type { Dict } from '../../index';

// 名前空間 core · AI 出題者によるウェーブ書き換えの拒否理由（ドキュメント 10 §2.3；ja）
export default {
  'core.reason.attackPhase': '次のウェーブを書き換えられるのは建設フェーズ中、開始前だけです',
  'core.reason.attackWave': '書き換えられるのは次のウェーブ（第 {wave} ウェーブ）だけです',
  'core.reason.attackBadPlan': '出題の形式が正しくありません：敵のグループが 1 つ以上必要です',
  'core.reason.attackGroups': '敵のグループは最大 {max} 個です',
  'core.reason.attackEnemy': '{name} はこのウェーブの出現プールにいません',
  'core.reason.attackCount': '各グループの数は 1～{max} です',
  'core.reason.attackAffixCount': '各グループの属性は最大 {max} 個です',
  'core.reason.attackAffix': '{name} に属性「{affix}」は付けられません',
  'core.reason.attackSpawner': '出現地点 {id} は今は使えません',
  'core.reason.attackDelay': '出発時間は 0～{max} 秒にしてください',
  'core.reason.attackBudget': 'インクポイントが足りません：必要 {cost}、予算 {budget}',
  'core.reason.attackHp': '強すぎます：HP 換算 {hp} が上限 {cap} を超えています',
} satisfies Dict;
