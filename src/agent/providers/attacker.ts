/**
 * 离线（确定性）进攻方：不调用任何模型，用 scriptedAttackPlan 出题，经 ctx.callTool('attack_plan') 下达——
 * 与真模型走同一条工具 / 记录 / 指令日志路径（文档 10 §2.3）。
 */
import { planLine, scriptedAttackPlan } from '../attack';
import { emptyUsage } from '../types';
import type { DecisionContext, DecisionOutcome, LLMProvider } from './types';

export class ScriptedAttackerProvider implements LLMProvider {
  readonly id = 'scripted';
  readonly model = 'scripted-attacker';

  async decide(ctx: DecisionContext): Promise<DecisionOutcome> {
    const out: DecisionOutcome = { usage: emptyUsage(), costUsd: 0, toolCalls: 0, ended: false };
    const w = ctx.world;
    if (!w) return { ...out, error: 'scripted attacker needs in-process world access' };
    const tr = ctx.trace;
    const t0 = Date.now();
    tr?.({
      k: 'request',
      n: 1,
      provider: this.id,
      api: 'local',
      model: this.model,
      host: '本机（离线，无网络请求）',
      params: { 说明: '内置出题策略：不调用任何模型' },
      messages: 1,
      raw: { provider: 'scripted', model: this.model, note: '离线出题：没有发出任何网络请求' },
    });
    const plan = scriptedAttackPlan(w);
    let text: string;
    if (plan) {
      tr?.({ k: 'thinking', n: 1, text: `按防守方的弱点出题：${planLine(plan)}\n` });
      out.toolCalls++;
      const r = await ctx.callTool('attack_plan', { groups: plan, note: `上一波出题：${planLine(plan)}` }, { id: 'scripted_attack_1' });
      out.ended = !!r.endTurn;
      text = r.ok ? `出题：${planLine(plan)}` : `出题被拒：${r.text}`;
      if (!r.ok) {
        out.toolCalls++;
        await ctx.callTool('end_turn', { note: '保留默认波' }, { id: 'scripted_attack_2' });
        out.ended = true;
      }
    } else {
      out.toolCalls++;
      await ctx.callTool('end_turn', { note: '保留默认波' }, { id: 'scripted_attack_1' });
      out.ended = true;
      text = '保留默认波';
    }
    tr?.({ k: 'text', n: 1, text });
    tr?.({
      k: 'response',
      n: 1,
      stop: 'end_turn',
      usage: emptyUsage(),
      ms: Date.now() - t0,
      costUsd: 0,
      raw: { stop_reason: 'end_turn', note: text, tool_calls: out.toolCalls },
    });
    out.text = text;
    return out;
  }
}
