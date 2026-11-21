import type { Dict } from '../../index';

// 命名空间 agent · AI 出题（AI 进攻方、真人防守；文档 10 §2.3；zh-CN）
export default {
  'agent.attack.label': 'AI 出题 · {model}',
  'agent.attack.menu': 'AI 出题',
  'agent.attack.menuSub': '新开一局：AI 每波改写敌人，你来防守（不上传全服榜）',
  'agent.attack.menuConfirm': '再点一次：放弃当前对局，新开「AI 出题」局',
  'agent.attack.badge': 'AI 出题',
  'agent.attack.badgeTip': 'AI 进攻方在每波开始前改写下一波；本局不上传全服榜，只记本地记录',
  'agent.attack.unranked': 'AI 出题局不参与排行，只记本地记录',
  'agent.attack.waveTag': 'AI 出题 {cost}/{budget}',
  'agent.attack.waveTip': '这一波由 AI 进攻方改写：花了 {cost} / {budget} 墨水点',
  'agent.attack.pending': 'AI 出题中…',
  'agent.attack.pendingTip': 'AI 进攻方会在这一波开始前改写它（不改写就是默认波）',
  'agent.attack.panel': 'AI 进攻方',
} satisfies Dict;
