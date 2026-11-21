import type { Dict } from '../../index';

// 命名空間 agent · AI 出題（AI 進攻方、真人防守；文件 10 §2.3；zh-TW）
export default {
  'agent.attack.label': 'AI 出題 · {model}',
  'agent.attack.menu': 'AI 出題',
  'agent.attack.menuSub': '新開一局：AI 每波改寫敵人，你來防守（不上傳全服榜）',
  'agent.attack.menuConfirm': '再點一次：放棄目前對局，新開「AI 出題」局',
  'agent.attack.badge': 'AI 出題',
  'agent.attack.badgeTip': 'AI 進攻方在每波開始前改寫下一波；本局不上傳全服榜，只記錄在本機',
  'agent.attack.unranked': 'AI 出題局不參與排行，只記錄在本機',
  'agent.attack.waveTag': 'AI 出題 {cost}/{budget}',
  'agent.attack.waveTip': '這一波由 AI 進攻方改寫：花了 {cost} / {budget} 墨水點',
  'agent.attack.pending': 'AI 出題中…',
  'agent.attack.pendingTip': 'AI 進攻方會在這一波開始前改寫它（不改寫就是預設波）',
  'agent.attack.panel': 'AI 進攻方',
} satisfies Dict;
