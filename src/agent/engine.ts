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
          message: decisionMessage(this.header, point, observation),
          tools: toolsForRole(this.role),
          maxToolCalls: this.o.config.maxToolCallsPerDecision ?? 12,
          remainingTokens: this.budgetLeft(),
          signal: ac.signal,
          world: this.o.provider.id === 'scripted' ? w : undefined,
          callTool: async (name, input) => this.callTool(name, input, calls),
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
        this.o.onUsage?.(this.usage, this.costUsd);
        if (out.note) this.note = out.note;
        if (out.text) rec.note = out.text.slice(0, 500);
        if (timedOut) failed = `timeout after ${timeoutMs} ms`;
        else if (out.error && !(gameOver && out.error === 'aborted')) failed = out.error;
        if (out.note) rec.note = out.note;
      } catch (e) {
        failed = `provider threw: ${e instanceof Error ? e.message : String(e)}`;
      } finally {
        clearTimeout(timer);
        outer?.removeEventListener('abort', onAbort);
      }
      if (failed) {
        this.consecutiveErrors++;
        this.errors.push(`decision ${point.seq} @wave ${point.wave}: ${failed}`);
        if (this.consecutiveErrors >= (this.o.maxConsecutiveErrors ?? 3)) this.disabledReason = `disabled after ${this.consecutiveErrors} consecutive errors (last: ${failed})`;
      } else this.consecutiveErrors = 0;
      const b2 = this.overBudget();
      if (b2) this.disabledReason = b2;
    }
    if (this.o.signal?.aborted) {
      rec.ms = Date.now() - t0;
      this.decisions.push(rec);
      return rec;
    }

    // 兜底：模型失败 / 停用；军师与进攻方（桩）模式下，实际操作也由兜底机器人（模拟玩家 / 防守方）完成
    const isPlayer = this.role === 'player';
    if ((failed && isPlayer) || (!isPlayer && this.o.fallbackPlaysForHuman)) {
      if (failed) { rec.by = 'fallback'; rec.fallbackReason = failed; }
      await this.o.fallback.decide(point.reasons);
    } else if (failed) {
      rec.by = 'fallback';
      rec.fallbackReason = `${failed} (advisor: no advice this time)`;
    }
    if (isPlayer || this.o.fallbackPlaysForHuman) this.ensureProgress(rec);
    rec.ms = Date.now() - t0;
    this.decisions.push(rec);
    return rec;
  }

  private async callTool(name: string, input: unknown, calls: ToolCallRecord[]): Promise<ToolResult> {
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
