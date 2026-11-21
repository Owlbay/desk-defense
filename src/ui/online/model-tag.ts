/**
 * 榜单 / 结算 / 对战榜上的模型标记文本（纯函数，无 DOM，便于单测）：
 * 只显示「模型名 · 思考档位」（例如 deepseek-flash · high），不显示渠道 / 服务商；内置机器人显示「离线演示」；
 * 旧数据没有档位时只显示模型名。
 */
import { t } from '../../i18n';
import { type LeaderRow, modelTagText } from '../../shared/leaderboard';

const SCRIPTED_RE = /^scripted(-v\d+)?$/;

/** 「AI 辅助」/「AI 参战」成绩的模型文本 */
export function aiModelText(r: Pick<LeaderRow, 'aiModel' | 'aiEffort' | 'agent'>): string {
  if (r.agent?.scripted || (!r.agent && SCRIPTED_RE.test(r.aiModel ?? ''))) return t('agent.setup.label.demo');
  return r.agent ? modelTagText(r.agent.model, r.agent.effort) : modelTagText(r.aiModel, r.aiEffort);
}

export type DuelSideLike = { model: string; effort?: string; scripted?: boolean };

/** AI 对战里一方的文本：模型 · 档位（内置机器人显示「离线演示」） */
export function duelSideText(s: DuelSideLike): string {
  return s.scripted ? t('agent.setup.label.demo') : modelTagText(s.model, s.effort);
}

/** 「攻 A · high vs 守 B · low」 */
export function duelVsText(a: DuelSideLike, d: DuelSideLike): string {
  return t('ui.duel.vs', { attacker: duelSideText(a), defender: duelSideText(d) });
}
