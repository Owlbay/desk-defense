import type { Dict } from '../../index';

// 命名空間 agent · AI 對戰（進攻方模型 vs 防守方模型）與設定頁的 AI 出題入口（文件 10 §2.3；zh-TW）
export default {
  'agent.duel.label': '攻 {attacker} vs 守 {defender}',
  'agent.duel.badge': 'AI 對戰',
  'agent.duel.badgeTip': '兩個 AI 同局對抗：進攻方每波開始前改寫下一波，防守方建塔應對；本局不參與排行，只記本機紀錄',
  'agent.duel.unranked': 'AI 對戰局不參與排行，只記本機紀錄',
  'agent.duel.role': 'AI 對戰',
  'agent.duel.panel': 'AI 對戰',
  'agent.duel.side.attack': '攻',
  'agent.duel.side.defend': '守',
  'agent.duel.lineThinking': '{model} 思考中：{reasons}',
  'agent.duel.lineWaitAttack': '{model}：等下一波開始後給再下一波出題',
  'agent.duel.lineWaitDefend': '{model}：等下一個決策點',
  'agent.duel.lineStopped': '{model}：已停止',
  'agent.duel.planAct': '出題：{plan}',
  'agent.duel.attackerModel': '進攻方模型',
  'agent.duel.defenderModel': '防守方模型',
  'agent.duel.roleAttack': 'AI 出題',
  'agent.duel.roleAttackDesc': 'AI 當進攻方，每波開始前改寫敵人，你來防守（不上傳全服榜）',
  'agent.duel.roleDuel': 'AI 對戰',
  'agent.duel.roleDuelDesc': '兩個模型同局對抗：一個出題進攻，一個建塔防守（只記本機紀錄）',
  'agent.duel.setupNote': '每個建造階段先由進攻方改寫下一波，再由防守方決策；兩邊都用暫停模式，不參與排行。',
  'agent.duel.attackNote':
    '每波一開始，AI 就在背景給下一波出題（不暫停遊戲，題沒出完時開波會稍等），你來防守；這種局不上傳全服榜，只記本機紀錄。',
} satisfies Dict;
