/**
 * 决策引擎：把"一个决策点"变成一次模型调用（或兜底机器人），统一处理
 * 观测、工具执行与记录、超时、token / 费用预算、连续失败熔断、决策后的推进保证。
 * 无头 runner（CLI / 测试）与浏览器控制器（index.ts）共用。
 */
import type { IWorld, RunOptions } from '../core/types';
import { renderObservation, estimateTokens } from './observation';
import { decisionMessage, runHeader, systemBlocks } from './prompts';
import { executeTool, toolsForRole } from './tools';
import type { AgentModelConfig } from './config';
import type { LLMProvider } from './providers/types';
import { cellOfArgs, type AgentTrace, type TraceSink } from './trace';
import { redactError } from './redact';
import {
  addUsage, emptyUsage, usageTotal,
  type AgentRole, type CommandSink, type DecisionPoint, type DecisionRecord, type FallbackPolicy, type Suggestion, type TokenUsage, type ToolCallRecord, type ToolResult,
} from './types';

export interface EngineOptions {
  world: IWorld;
  opts: RunOptions;
  config: AgentModelConfig;
  provider: LLMProvider | null;
  fallback: FallbackPolicy;
  /** realtime：世界前进若干秒；返回 false = 已结束。pause 模式 / 浏览器 realtime（世界自己在跑）传 undefined */
  elapse?: (seconds: number) => boolean;
  /** 指令出口（浏览器：session.command） */
  sink?: CommandSink;
  signal?: AbortSignal;
  onSuggest?: (s: Suggestion) => void;
  onUsage?: (total: TokenUsage, costUsd: number) => void;
  /** 军师 / 进攻方（桩）模式下由兜底机器人代替真人执行操作（无头评测用；浏览器里真人自己玩，保持 false） */
  fallbackPlaysForHuman?: boolean;
  /** 连续多少次模型失败后停用模型、余下全部兜底（默认 3） */
  maxConsecutiveErrors?: number;
  /** 思路与请求（文档 10 §12.1）：决策追踪写到这里（可选） */
  trace?: AgentTrace;
}

interface Snap {
  gold: number;
  lives: number;
  towers: number;
  levels: number;
  phase: string;
  wave: number;
}

const snap = (w: IWorld): Snap => {
  const s = w.state;
  let towers = 0;
  let levels = 0;
  for (const t of s.towers.values()) {
    towers++;
    levels += t.level;
  }
  return { gold: Math.floor(s.gold), lives: s.lives, towers, levels, phase: s.phase, wave: s.wave };
};

/** 两个快照之间游戏里实际发生的变化（给面板看的摘要） */
export function effectSummary(a: Snap, b: Snap): string {
  const out: string[] = [];
  if (a.gold !== b.gold) out.push(`金币 ${a.gold}→${b.gold}`);
  if (a.towers !== b.towers) out.push(`塔 ${a.towers}→${b.towers}`);
  else if (a.levels !== b.levels) out.push(`等级 ${b.levels > a.levels ? '+' : ''}${b.levels - a.levels}`);
  if (a.lives !== b.lives) out.push(`生命 ${a.lives}→${b.lives}`);
  if (a.phase !== b.phase) out.push(`阶段 ${a.phase}→${b.phase}`);
  if (a.wave !== b.wave) out.push(`波次 ${a.wave}→${b.wave}`);
  return out.join(' · ');
}

export class DecisionEngine {
  usage: TokenUsage = emptyUsage();
  costUsd = 0;
  readonly decisions: DecisionRecord[] = [];
  readonly errors: string[] = [];
  readonly suggestions: Suggestion[] = [];
  /** 模型已停用（预算耗尽 / 连续失败） */
  disabledReason: string | null = null;
  private note: string | undefined;
  private consecutiveErrors = 0;
  private readonly system: [string, string];
  private readonly role: AgentRole;
  private header: string;

  constructor(readonly o: EngineOptions) {
    this.role = o.config.role ?? 'player';
    this.system = systemBlocks(this.role);
    this.header = runHeader(o.opts, o.world);
    if (!o.provider) this.disabledReason = 'no provider (baseline bot)';
  }

  private budgetLeft(): number {
    const b = this.o.config.budget?.tokens;
    return b ? b - usageTotal(this.usage) : Number.POSITIVE_INFINITY;
  }

  private overBudget(): string | null {
    const b = this.o.config.budget;
    if (b?.tokens && usageTotal(this.usage) >= b.tokens) return `token budget ${b.tokens} exhausted`;
    if (b?.usd && this.costUsd >= b.usd) return `cost budget $${b.usd} exhausted`;
    return null;
  }

  /** 执行一个决策点（含兜底与推进保证）。recent = 自上次决策以来的事件 */
  async decide(point: DecisionPoint, recent: import('../core/types').GameEvent[]): Promise<DecisionRecord> {
    const w = this.o.world;
    const t0 = Date.now();
    const calls: ToolCallRecord[] = [];
    const observation = renderObservation(w, { recent, note: this.note });
    const rec: DecisionRecord = { point, by: 'agent', toolCalls: calls, usage: emptyUsage(), ms: 0, observationTokens: estimateTokens(observation) };
    const budget = this.overBudget();
    if (budget && !this.disabledReason) this.disabledReason = budget;
    const message = decisionMessage(this.header, point, observation);
    const tools = toolsForRole(this.role);
    const sink = this.o.trace?.begin({
      k: 'decision_start',
      trigger: point.reasons.slice(),
      wave: point.wave,
      time: point.time,
      tick: point.tick,
      phase: point.phase,
      provider: this.o.provider?.id ?? 'none',
      model: this.o.provider?.model ?? this.o.fallback.name,
      role: this.role,
      observation: message,
      system: this.system.join('\n\n'),
      toolDefs: tools,
      toolNames: tools.map((t) => t.name),
    });
    let costThis = 0;

    let failed: string | null = this.disabledReason;
    if (!failed && this.o.provider) {
      const ac = new AbortController();
      const outer = this.o.signal;
      const onAbort = () => ac.abort();
      outer?.addEventListener('abort', onAbort);
      const timeoutMs = this.o.config.decisionTimeoutMs ?? 90_000;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
      let gameOver = false;
      try {
        const out = await this.o.provider.decide({
          role: this.role,
          point,
          system: this.system,
          message,
          tools,
          maxToolCalls: this.o.config.maxToolCallsPerDecision ?? 12,
          remainingTokens: this.budgetLeft(),
          signal: ac.signal,
          world: this.o.provider.id === 'scripted' ? w : undefined,
          callTool: async (name, input, meta) => this.callTool(name, input, calls, sink, meta?.id),
          trace: sink,
          afterRequest: async (ms) => {
            if (ac.signal.aborted) return false;
            const mode = this.o.config.decision?.mode ?? 'pause';
            if (mode === 'realtime' && this.o.elapse) {
              const lat = this.o.config.decision?.realtimeLatencySec ?? 3;
              const sec = lat === 'measured' ? ms / 1000 : lat;
              if (!this.o.elapse(sec)) { gameOver = true; return false; }
            }
            const ph = w.state.phase;
            return ph !== 'won' && ph !== 'lost';
          },
        });
        rec.usage = out.usage;
        this.usage = addUsage(this.usage, out.usage);
        this.costUsd += out.costUsd;
        costThis = out.costUsd;
        this.o.onUsage?.(this.usage, this.costUsd);
        if (out.note) this.note = out.note;
        if (out.text) rec.note = out.text.slice(0, 500);
        if (timedOut) failed = `timeout after ${timeoutMs} ms`;
        else if (out.error && !(gameOver && out.error === 'aborted')) failed = out.error;
        if (out.note) rec.note = out.note;
      } catch (e) {
        failed = `provider threw: ${redactError(e, this.o.config.apiKey ? [this.o.config.apiKey] : [])}`;
      } finally {
        clearTimeout(timer);
        outer?.removeEventListener('abort', onAbort);
      }
      if (failed) {
        sink?.({ k: 'error', message: failed });
        this.consecutiveErrors++;
        this.errors.push(`decision ${point.seq} @wave ${point.wave}: ${failed}`);
        if (this.consecutiveErrors >= (this.o.maxConsecutiveErrors ?? 3)) this.disabledReason = `disabled after ${this.consecutiveErrors} consecutive errors (last: ${failed})`;
      } else this.consecutiveErrors = 0;
      const b2 = this.overBudget();
      if (b2) this.disabledReason = b2;
    }
    const end = (): DecisionRecord => {
      rec.ms = Date.now() - t0;
      this.decisions.push(rec);
      sink?.({
        k: 'decision_end', by: rec.by, ms: rec.ms, usage: rec.usage, costUsd: costThis, toolCalls: calls.length,
        note: rec.note, fallbackReason: rec.fallbackReason,
      });
      return rec;
    };
    if (this.o.signal?.aborted) return end();

    // 兜底：模型失败 / 停用；军师与进攻方（桩）模式下，实际操作也由兜底机器人（模拟玩家 / 防守方）完成
    const isPlayer = this.role === 'player';
    if ((failed && isPlayer) || (!isPlayer && this.o.fallbackPlaysForHuman)) {
      if (failed) { rec.by = 'fallback'; rec.fallbackReason = failed; }
      const before = snap(w);
      await this.o.fallback.decide(point.reasons);
      if (failed) sink?.({ k: 'fallback', reason: failed, acted: true, effect: effectSummary(before, snap(w)) || undefined });
    } else if (failed) {
      rec.by = 'fallback';
      rec.fallbackReason = `${failed} (advisor: no advice this time)`;
      sink?.({ k: 'fallback', reason: rec.fallbackReason, acted: false });
    }
    if (isPlayer || this.o.fallbackPlaysForHuman) {
      const before = snap(w);
      const had = rec.fallbackReason;
      this.ensureProgress(rec);
      if (rec.fallbackReason !== had) sink?.({ k: 'fallback', reason: (rec.fallbackReason ?? '').slice(had ? had.length + 2 : 0), acted: true, effect: effectSummary(before, snap(w)) || undefined });
    }
    return end();
  }

  private async callTool(name: string, input: unknown, calls: ToolCallRecord[], sink?: TraceSink, id?: string): Promise<ToolResult> {
    const w = this.o.world;
    const callId = id ?? `call_${calls.length + 1}`;
    sink?.({ k: 'tool_call', id: callId, name, args: input });
    const before = sink ? snap(w) : null;
    const r = executeTool({
      world: this.o.world,
      role: this.role,
      sink: this.o.sink,
      onSuggest: (text, actions) => {
        const s: Suggestion = { tick: this.o.world.state.tick, wave: this.o.world.state.wave, text, actions };
        this.suggestions.push(s);
        this.o.onSuggest?.(s);
      },
    }, name, input);
    calls.push({ name, input, ok: r.ok, result: r.text.length > 400 ? `${r.text.slice(0, 400)}…` : r.text, cmd: r.cmd, queuedFor: r.queuedFor });
    if (sink && before) {
      const fx = r.queuedFor !== undefined ? `已排队，第 ${r.queuedFor} 帧落地` : effectSummary(before, snap(w));
      const cell = cellOfArgs(input, (uid) => {
        const t = w.state.towers.get(uid);
        return t ? { x: t.cx, y: t.cy } : undefined;
      });
      sink({ k: 'tool_result', id: callId, name, ok: r.ok, text: r.text, effect: fx || undefined, cell });
    }
    return r;
  }

  /** 决策后保证游戏能继续：增益必须选、补给必须选、手动模式必须开波 */
  private ensureProgress(rec: DecisionRecord): void {
    const w = this.o.world;
    const s = w.state;
    const send = (c: Parameters<IWorld['command']>[0]) => (this.o.sink ? this.o.sink(c) : w.command(c));
    if (s.phase === 'perk' && s.perkChoices) {
      const c = s.perkChoices.find((x) => !x.needsTower) ?? s.perkChoices[0];
      send({ type: 'choosePerk', id: c.id });
      rec.fallbackReason = (rec.fallbackReason ? `${rec.fallbackReason}; ` : '') + `auto perk ${c.id}`;
    }
    if (s.crateChoice) send({ type: 'chooseCrate', option: s.crateChoice.options[0].id });
    const manualWait = s.phase === 'build' && !(s.autoWave.enabled && s.autoWave.started);
    if (manualWait) {
      send({ type: 'startWave' });
      rec.fallbackReason = (rec.fallbackReason ? `${rec.fallbackReason}; ` : '') + 'auto start_wave';
    }
  }
}
