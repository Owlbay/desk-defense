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

/** 这局能不能进 AI 榜；不能时返回原因 */
export function aiBoardBlocker(s: { agent: { role: string }; opts: RunOptions; takenOver: boolean; decisions: number }): string | null {
  if (s.agent.role !== 'player') return t('agent.setup.block.advisor');
  if (s.takenOver) return t('agent.setup.block.takenOver');
  if (s.opts.mode !== 'endless') return t('agent.setup.block.endlessOnly');
  if (!isEligibleRun(s.opts)) return t('agent.setup.block.params');
  if (s.decisions <= 0) return t('agent.setup.block.noDecisions');
  return null;
}
