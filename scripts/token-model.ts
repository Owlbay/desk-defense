/**
 * 离线 token 模型（文档 10 §13「上下文与成本优化」）：不联网，用真实的提示词构造器回放一局脚本对局，
 * 估算每种上下文模式（以及优化前的旧做法）每波大约花多少 token。
 *
 *   npm run agent:tokens -- [--waves 15] [--seed tok-1] [--map ch1] [--json]（scripts/agent-tokens.ts）
 *
 * 模型（以实测的中转 deepseek-flash 为锚点：每次请求输出 ≈3k token，多为推理；服务端自动前缀缓存，不收缓存写）：
 *  - 前缀 = 系统提示 + 工具定义（JSON），第一次请求写缓存，之后读缓存；
 *  - 决策内第 k 次请求：前缀 + 之前的对话（缓存读）+ 新内容（未缓存：本次 user 消息 / 上次的工具结果）；
 *  - 旧做法：系统提示含完整资料表 + 19 个细粒度工具 + 完整观测 + 地图，固定 4 次请求 / 决策（实测 ≈4），
 *    第 2 次带一次 get_state；无门控，波次中每 10 秒决策一次；
 *  - 新做法：一次 act（全部动作 + end）；有动作被拒时再加一次纠正请求；门控跳过的决策点不花 token。
 * 估算用 estimateTokens（ASCII ≈3.5 字符 / token，CJK ≈1.1 token / 字），只用于比较，不代表账单。
 */
import { createWorld, type RunOptions } from '../src/core';
import type { MapId } from '../src/core/types';
import { estimateTokens, renderObservation } from '../src/agent/observation';
import { catalogText, decisionMessage, runHeader, systemBlocks } from '../src/agent/prompts';
import { LEGACY_TOOLS, SLIM_TOOLS } from '../src/agent/tools';
import { runAgentGame } from '../src/agent/runner';
import { scriptedTurn } from '../src/agent/providers/scripted';
import { type ContextMode, type ThinkingLevel } from '../src/agent/config';
import { budgetTokens, emptyUsage, usageTotal, type TokenUsage } from '../src/agent/types';
import type { DecisionContext, DecisionOutcome, LLMProvider } from '../src/agent/providers/types';

/** 每次请求的输出 token（按思考等级；"低"取实测中转 deepseek-flash 的 60k / 20 次） */
export const OUTPUT_PER_REQUEST: Record<'off' | 'low', { first: number; fix: number }> = {
  low: { first: 3000, fix: 800 },
  off: { first: 350, fix: 200 },
};
/** 旧做法的规则文本 ≈1.1k token（实测） */
export const LEGACY_RULES_TOKENS = 1100;
const LEGACY_REQUESTS = 4;

export interface TokenRun {
  label: string;
  waves: number;
  decisionPoints: number;
  called: number;
  skipped: number;
  requests: number;
  usage: TokenUsage;
  raw: number;
  weighted: number;
  perWaveRaw: number;
  perWaveWeighted: number;
  reqPerDecision: number;
  prefixTokens: number;
  avgMessageTokens: number;
}

class TokenModel implements LLMProvider {
  readonly id = 'scripted'; // 让引擎把 world 交给我们（离线策略需要读状态）
  readonly model = 'token-model';
  private warm = false;
  msgTokens: number[] = [];
  constructor(private readonly legacy: boolean, private readonly out: { first: number; fix: number }, private readonly opts: RunOptions) {}

  async decide(ctx: DecisionContext): Promise<DecisionOutcome> {
    const w = ctx.world!;
    const u = emptyUsage();
    const results: { name: string; ok: boolean; text: string }[] = [];
    const call = async (name: string, input: Record<string, unknown>) => {
      const r = await ctx.callTool(name, input);
      results.push({ name, ok: r.ok, text: r.text });
      return r;
    };
    const legacyMsg = this.legacy
      ? decisionMessage(runHeader(this.opts, w), ctx.point, renderObservation(w, { recent: [] }))
      : '';
    await scriptedTurn(w, call, ctx.point.reasons);
    const prefix = this.legacy
      ? LEGACY_RULES_TOKENS + estimateTokens(`# Reference data (static)\n${catalogText('all')}`) + estimateTokens(JSON.stringify(LEGACY_TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }))))
      : estimateTokens(ctx.system.join('\n\n')) + estimateTokens(JSON.stringify(ctx.tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }))));
    const msg = estimateTokens(this.legacy ? legacyMsg : ctx.message);
    this.msgTokens.push(msg);
    const add = (cached: number, fresh: number, outTok: number) => {
      u.requests++;
      if (!this.warm) { u.inputTokens += cached + fresh; this.warm = true; } else { u.cacheReadTokens += cached; u.inputTokens += fresh; }
      u.outputTokens += outTok;
    };
    const resTok = estimateTokens(results.map((r) => r.text).join('\n'));
    if (this.legacy) {
      // 4 次请求：工具结果平均分摊；第 2 次额外带一次 get_state（完整观测）
      const getState = estimateTokens(renderObservation(w));
      let convo = 0;
      for (let k = 0; k < LEGACY_REQUESTS; k++) {
        const fresh = k === 0 ? msg : Math.round(resTok / (LEGACY_REQUESTS - 1)) + (k === 1 ? getState : 0);
        add(prefix + convo, fresh, this.out.first);
        convo += fresh + this.out.first;
      }
    } else {
      // 一次 act；有被拒的动作就再来一次纠正
      add(prefix, msg, this.out.first);
      if (results.some((r) => !r.ok && r.name !== 'end_turn')) add(prefix + msg + this.out.first, resTok, this.out.fix);
    }
    return { usage: u, costUsd: 0, toolCalls: results.length, ended: true };
  }
}

export async function tokenRun(mode: ContextMode | 'before', thinking: 'low' | 'off', o: { waves?: number; seed?: string; map?: MapId } = {}): Promise<TokenRun> {
  const opts: RunOptions = { mode: 'endless', map: o.map ?? 'ch1', difficulty: 'normal', seed: o.seed ?? 'tok-1', skills: ['eraser_strike', 'bell', 'whiteout_zone'], pure: true };
  const legacy = mode === 'before';
  const provider = new TokenModel(legacy, OUTPUT_PER_REQUEST[thinking], opts);
  const rep = await runAgentGame(opts, {
    config: legacy
      ? { provider: 'scripted', contextMode: 'full', decision: { waveIntervalSec: 10 }, thinking: thinking as ThinkingLevel, budget: {} }
      : { provider: 'scripted', contextMode: mode, thinking: thinking as ThinkingLevel, budget: {} },
    provider,
    maxWaves: o.waves ?? 15,
  });
  const called = rep.decisions.filter((d) => d.by === 'agent').length;
  const skipped = rep.decisions.filter((d) => d.by === 'local').length;
  const waves = Math.max(1, rep.result.cleared);
  const raw = usageTotal(rep.usage);
  const weighted = budgetTokens(rep.usage);
  const w0 = createWorld(opts);
  const prefixTokens = legacy
    ? LEGACY_RULES_TOKENS + estimateTokens(catalogText('all')) + estimateTokens(JSON.stringify(LEGACY_TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }))))
    : estimateTokens(systemBlocks('player').join('\n\n')) + estimateTokens(JSON.stringify(SLIM_TOOLS.filter((t) => t.roles.includes('player')).map(({ name, description, input_schema }) => ({ name, description, input_schema }))));
  void w0;
  return {
    label: mode === 'before' ? '优化前' : `${({ saver: '省流', balanced: '均衡', full: '完整' } as const)[mode]}`,
    waves: rep.result.cleared, decisionPoints: rep.decisions.length, called, skipped,
    requests: rep.usage.requests, usage: rep.usage, raw, weighted,
    perWaveRaw: Math.round(raw / waves), perWaveWeighted: Math.round(weighted / waves),
    reqPerDecision: called ? Math.round((rep.usage.requests / called) * 100) / 100 : 0,
    prefixTokens,
    avgMessageTokens: Math.round(provider.msgTokens.reduce((a, b) => a + b, 0) / Math.max(1, provider.msgTokens.length)),
  };
}

