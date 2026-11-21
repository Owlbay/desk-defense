/**
 * AI 对局结算用的纯函数（无 DOM、不引用渲染层，便于单测）：兜底占比、上传标记、能否进 AI 榜。
 */
import { type TokenUsage, usageTotal } from '../../agent/types';
import type { RunOptions } from '../../core/types';
import { t } from '../../i18n';
import type { AgentMeta } from '../../shared/leaderboard';
import { isEligibleRun } from '../online/util';

/** 兜底机器人做的决策占比 */
export function botShareOf(decisions: readonly { by: 'agent' | 'fallback' | 'local' }[]): number {
  if (!decisions.length) return 0;
  return decisions.filter((d) => d.by === 'fallback').length / decisions.length;
}

export interface AgentMetaInput {
  agent: { provider: string; model: string; role: string };
  mode: 'pause' | 'realtime';
  botShare: number;
  decisions: number;
  usage: TokenUsage;
  costUsd: number;
}

/** 上传用的 AI 标记（服务端要求：服务商小写 ASCII、模型名可打印 ASCII ≤ 80） */
export function agentMetaOf(s: AgentMetaInput): AgentMeta {
  const provider =
    s.agent.provider
      .toLowerCase()
      .replace(/[^a-z0-9:_.-]/g, '-')
      .replace(/^[^a-z0-9]+/, '')
      .slice(0, 40) || 'unknown';
  const model = s.agent.model.replace(/[^\x21-\x7e]/g, '_').slice(0, 80) || 'unknown';
  return {
    provider,
    model,
    mode: s.mode,
    botShare: Math.max(0, Math.min(1, Math.round(s.botShare * 1000) / 1000)),
    decisions: s.decisions,
    tokens: Math.round(usageTotal(s.usage)),
    costUsd: Math.round(s.costUsd * 1e4) / 1e4,
  };
}

/**
 * 「AI 参战」结算时这局怎么上传（与普通结算同一套榜：无尽 / 每日 / 战役）：
 *  - agent：AI 玩家全程操作 → 带「AI 辅助」+ 模型标记；
 *  - assist：中途由你接管过 → 只带「AI 辅助」标记；
 *  - human：军师模式（你自己在玩）→ 普通成绩；
 *  - skip：开局参数不参与排行 / AI 还没做过决策 / AI 出题局（reason 给玩家看）。
 */
export type AiUploadPlan = { kind: 'agent' | 'assist' | 'human' } | { kind: 'skip'; reason: string };

export function aiUploadPlan(s: { agent: { role: string }; opts: RunOptions; takenOver: boolean; decisions: number }): AiUploadPlan {
  // 「AI 出题」（AI 进攻、真人防守，文档 10 §2.3）：波次被改写过，不参与排行，只记本地记录
  if (s.agent.role === 'attacker') return { kind: 'skip', reason: t('agent.attack.unranked') };
  // 「AI 对战」（进攻方模型 vs 防守方模型）：同上，不参与任何排行
  if (s.agent.role === 'duel') return { kind: 'skip', reason: t('agent.duel.unranked') };
  if (!isEligibleRun(s.opts)) return { kind: 'skip', reason: t('agent.setup.block.params') };
  if (s.agent.role !== 'player') return { kind: 'human' };
  if (s.decisions <= 0) return { kind: 'skip', reason: t('agent.setup.block.noDecisions') };
  return { kind: s.takenOver ? 'assist' : 'agent' };
}
