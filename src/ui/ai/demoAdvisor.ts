/**
 * 离线演示版「AI 军师」：不联网，用内置脚本策略"预演"一遍（不真的下指令），
 * 把它想做的头几步写成建议，走与真模型完全相同的 suggest 工具。
 */
import { t } from '../../i18n';
import { emptyUsage, type DecisionContext, type DecisionOutcome, type LLMProvider, type ToolResult } from '../../agent';
import { scriptedTurn } from '../../agent/providers/scripted';
import type { IWorld } from '../../core/types';
import { describeCall } from './actions';

const MAX_ACTIONS = 3;
const SKIP = new Set(['end_turn', 'start_wave', 'collect_pickup']);

export function demoAdvisor(world: IWorld): LLMProvider {
  return {
    id: 'scripted',
    model: 'scripted-v1',
    async decide(ctx: DecisionContext): Promise<DecisionOutcome> {
      const out: DecisionOutcome = { usage: emptyUsage(), costUsd: 0, toolCalls: 0, ended: false };
      const tr = ctx.trace;
      const t0 = Date.now();
      tr?.({
        k: 'request', n: 1, provider: 'scripted', api: 'local', model: 'scripted-v1', host: t('agent.setup.demo.host'),
        params: { note: t('agent.setup.demo.note') },
        messages: 1,
        raw: { provider: 'scripted', mode: 'advisor-dry-run', note: t('agent.setup.demo.noNetwork') },
      });
      const wanted: { name: string; input: Record<string, unknown> }[] = [];
      const seen = new Set<string>();
      let accepted = false;
      // 预演：记录脚本想做的动作；只"接受"第一步，后面的全部拒绝，让脚本把各个备选都报出来后停下
      const dry = (name: string, input: Record<string, unknown>): ToolResult => {
        if (SKIP.has(name)) return { ok: name === 'end_turn', text: 'dry-run', endTurn: name === 'end_turn' };
        const key = `${name}:${JSON.stringify(input)}`;
        if (!seen.has(key) && wanted.length < MAX_ACTIONS) {
          seen.add(key);
          wanted.push({ name, input });
        }
        const ok = !accepted;
        accepted = true;
        return { ok, text: 'dry-run' };
      };
      await scriptedTurn(world, dry, ctx.point.reasons, tr ? (line) => tr({ k: 'thinking', n: 1, text: line }) : undefined);
      tr?.({ k: 'thinking', n: 1, text: `${t('agent.setup.demo.done', { n: wanted.length })}\n` });
      if (wanted.length) {
        const actions = wanted.map((a) => `${a.name} ${Object.entries(a.input).map(([k, v]) => `${k}=${String(v)}`).join(' ')}`.trim());
        const text = t('agent.setup.demo.suggest', { list: wanted.map((a) => describeCall(world, a.name, a.input) ?? a.name).join(t('agent.setup.demo.sep')) });
        out.toolCalls++;
        tr?.({ k: 'text', n: 1, text });
        await ctx.callTool('suggest', { text: text.slice(0, 120), actions }, { id: 'demo_suggest' });
      }
      out.toolCalls++;
      const r = await ctx.callTool('end_turn', {}, { id: 'demo_end' });
      out.ended = !!r.endTurn;
      tr?.({ k: 'response', n: 1, stop: 'end_turn', usage: emptyUsage(), ms: Date.now() - t0, costUsd: 0, raw: { stop_reason: 'end_turn', suggestions: wanted } });
      return out;
    },
  };
}
