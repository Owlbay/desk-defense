/**
 * AI 对局结算用的纯函数（无 DOM、不引用渲染层，便于单测）：兜底占比、上传标记、能否进 AI 榜。
 * 上传只带模型名 + 思考档位，不带渠道 / 服务商 / 地址（provider 只区分是不是内置机器人）。
 */
import { type TokenUsage, usageTotal } from '../../agent/types';
import type { RunOptions } from '../../core/types';
import { t } from '../../i18n';
import { type AgentMeta, type DuelMeta, type DuelSideMeta, isAiEffort, publicModelName } from '../../shared/leaderboard';
import { isEligibleRun } from '../online/util';

/** 兜底机器人做的决策占比 */
export function botShareOf(decisions: readonly { by: 'agent' | 'fallback' | 'local' }[]): number {
  if (!decisions.length) return 0;
  return decisions.filter((d) => d.by === 'fallback').length / decisions.length;
}

export interface AgentMetaInput {
  agent: { provider: string; model: string; role: string; effort?: string };
  mode: 'pause' | 'realtime';
  botShare: number;
  decisions: number;
  usage: TokenUsage;
  costUsd: number;
}

const share = (x: number): number => Math.max(0, Math.min(1, Math.round((Number.isFinite(x) ? x : 0) * 1000) / 1000));

/** 上传用的 AI 标记：provider 只发 scripted / llm（不发渠道）；模型名去掉中转前缀 / 地址，可打印 ASCII ≤ 80 */
export function agentMetaOf(s: AgentMetaInput): AgentMeta {
  const scripted = s.agent.provider === 'scripted';
  return {
    provider: scripted ? 'scripted' : 'llm',
    model: publicModelName(s.agent.model, true) || 'unknown',
    ...(!scripted && isAiEffort(s.agent.effort) ? { effort: s.agent.effort } : {}),
    mode: s.mode,
    botShare: share(s.botShare),
    decisions: s.decisions,
    tokens: Math.round(usageTotal(s.usage)),
    costUsd: Math.round(s.costUsd * 1e4) / 1e4,
  };
}

export interface DuelSideInput {
  provider: string;
  model: string;
  effort?: string;
  decisions: number;
  fallback: number;
  usage: TokenUsage;
  costUsd: number;
  errors: readonly string[];
}

function duelSideMetaOf(x: DuelSideInput, botAll: boolean): DuelSideMeta {
  const scripted = x.provider === 'scripted';
  return {
    model: publicModelName(x.model, true) || 'unknown',
    ...(!scripted && isAiEffort(x.effort) ? { effort: x.effort } : {}),
    ...(scripted ? { scripted: true } : {}),
    decisions: x.decisions,
    botShare: scripted || botAll ? 1 : share(x.decisions ? x.fallback / x.decisions : 0),
    tokens: Math.round(usageTotal(x.usage)),
    costUsd: Math.round(x.costUsd * 1e4) / 1e4,
    errors: x.errors.length,
  };
}

/** AI 对战的上传数据（双方只有模型名 + 思考档位 + 统计；不含渠道） */
export function duelMetaOf(d: { attack: DuelSideInput; defend: DuelSideInput }, o: { plans: number; switchedToBot?: boolean }): DuelMeta {
  return {
    attacker: duelSideMetaOf(d.attack, false),
    defender: duelSideMetaOf(d.defend, !!o.switchedToBot),
    plans: o.plans,
  };
}

/**
 * 「AI 参战」结算时这局怎么上传（与普通结算同一套榜：无尽 / 每日 / 战役）：
 *  - agent：AI 玩家全程操作 → 带「AI 辅助」+ 模型标记；
 *  - assist：中途由你接管过 → 只带「AI 辅助」标记；
 *  - human：军师模式（你自己在玩）→ 普通成绩；
 *  - skip：开局参数不参与排行 / AI 还没做过决策 / AI 出题局（reason 给玩家看）。
 */
export type AiUploadPlan = { kind: 'agent' | 'assist' | 'human' | 'duel' } | { kind: 'skip'; reason: string };

export function aiUploadPlan(s: { agent: { role: string }; opts: RunOptions; takenOver: boolean; decisions: number }): AiUploadPlan {
  // 「AI 出题」（AI 进攻、真人防守，文档 10 §2.3）：波次被改写过，不参与排行，只记本地记录
  if (s.agent.role === 'attacker') return { kind: 'skip', reason: t('agent.attack.unranked') };
  if (!isEligibleRun(s.opts)) return { kind: 'skip', reason: t('agent.setup.block.params') };
  // 「AI 对战」（进攻方模型 vs 防守方模型）：不进三类榜，上传到独立的 AI 对战榜
  //（中途被你接管的对战不再是 AI 对 AI，只记本地记录）
  if (s.agent.role === 'duel') {
    if (s.takenOver) return { kind: 'skip', reason: t('ui.duel.takenOverSkip') };
    return s.decisions > 0 ? { kind: 'duel' } : { kind: 'skip', reason: t('agent.setup.block.noDecisions') };
  }
  if (s.agent.role !== 'player') return { kind: 'human' };
  if (s.decisions <= 0) return { kind: 'skip', reason: t('agent.setup.block.noDecisions') };
  return { kind: s.takenOver ? 'assist' : 'agent' };
}
