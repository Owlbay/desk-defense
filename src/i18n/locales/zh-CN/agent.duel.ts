import type { Dict } from '../../index';

// 命名空间 agent · AI 对战（进攻方模型 vs 防守方模型）与设置页的 AI 出题入口（文档 10 §2.3；zh-CN）
export default {
  'agent.duel.label': '攻 {attacker} vs 守 {defender}',
  'agent.duel.badge': 'AI 对战',
  'agent.duel.badgeTip':
    '两个 AI 同局对抗：进攻方每波开始前改写下一波，防守方建塔应对；不进无尽 / 每日 / 战役榜，成绩上传到独立的 AI 对战榜',
  'agent.duel.unranked': 'AI 对战局不进无尽 / 每日 / 战役榜，成绩上传到独立的 AI 对战榜',
  'agent.duel.role': 'AI 对战',
  'agent.duel.panel': 'AI 对战',
  'agent.duel.side.attack': '攻',
  'agent.duel.side.defend': '守',
  'agent.duel.lineThinking': '{model} 思考中：{reasons}',
  'agent.duel.lineWaitAttack': '{model}：等下一波开始后给再下一波出题',
  'agent.duel.lineWaitDefend': '{model}：等下一个决策点',
  'agent.duel.lineStopped': '{model}：已停止',
  'agent.duel.planAct': '出题：{plan}',
  'agent.duel.attackerModel': '进攻方模型',
  'agent.duel.defenderModel': '防守方模型',
  'agent.duel.roleAttack': 'AI 出题',
  'agent.duel.roleAttackDesc': 'AI 当进攻方，每波开始前改写敌人，你来防守（不上传全服榜）',
  'agent.duel.roleDuel': 'AI 对战',
  'agent.duel.roleDuelDesc': '两个模型同局对抗：一个出题进攻，一个建塔防守（上传到独立的 AI 对战榜）',
  'agent.duel.setupNote':
    '每个建造阶段先由进攻方改写下一波，再由防守方决策；两边都用暂停模式。完整数据记在本地，成绩上传到独立的 AI 对战榜（只显示模型和思考档位）。',
  'agent.duel.attackNote':
    '每波一开始，AI 就在后台给下一波出题（不暂停游戏，题没出完时开波会稍等），你来防守；这种局不上传全服榜，只记本地记录。',
} satisfies Dict;
