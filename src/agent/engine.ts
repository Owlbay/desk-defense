/**
 * 决策引擎：把"一个决策点"变成一次模型调用（或兜底机器人），统一处理
 * 观测、工具执行与记录、超时、token / 费用预算、连续失败熔断、决策后的推进保证。
 * 无头 runner（CLI / 测试）与浏览器控制器（index.ts）共用。
 */
import { ENEMIES } from '../config/enemies';
import type { IWorld, RunOptions } from '../core/types';
import { SOURCE_LOCALE, t, withLocale } from '../i18n';
import { BattleLog, eventLine, idleLine, threatLine } from './battle';
import { comboLine, mazeLine, reclaimLine } from './board';
import { type AgentModelConfig, CONTEXT_MODES, type ContextModeSpec, contextSpec, type ThinkingLevel } from './config';
import { ContextBuilder } from './context';
import { gateDecision } from './gating';
import { type AckCode, type InstructionQueue, type InstructionRef, instructionSection } from './instructions';
import { BattleIntel, gapLine, killLine, leakLine, type LeakRecord } from './intel';
import type { PlannerState } from './planner';
import { runHeader, systemBlocks } from './prompts';
import type { LLMProvider } from './providers/types';
import { AFFIX_PURPOSE, enemyPurposes, type Purpose } from './purpose';
import { redactError } from './redact';
import { executeTool, toolsForRole } from './tools';
import { type AgentTrace, cellOfArgs, type TraceSink } from './trace';
import {
  addUsage,
  type AgentRole,
  budgetTokens,
  type CommandSink,
  type DecisionPoint,
  type DecisionRecord,
  emptyUsage,
  type FallbackPolicy,
  type Suggestion,
  type TokenUsage,
  type ToolCallRecord,
  type ToolResult,
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
  /** 预算分级变化（UI：预算条刻度 + 模式标签） */
  onBudget?: (b: BudgetState) => void;
  /**
   * budget.mode = 'ask' 且用完预算时调用（浏览器：暂停并弹出 继续 / 追加 / 交给机器人）。
   * 不提供时按 'continue'（压缩后以最省模式继续）。
   */
  onBudgetExceeded?: (b: BudgetState) => Promise<BudgetChoice>;
  /**
   * 玩家指令队列（「给 AI 下指令」）：有等待中的一次性指令时本次决策带上（原因加 player、绕过门控），
   * 长期方针每次决策都带上；结束后按模型回应标记完成。
   */
  instructions?: InstructionQueue;
}

/** 预算分级：0 正常 · 1 ≥70% 省流 · 2 ≥90% 省流 + 无思考 + 只在建造 / 事件时决策 · 3 ≥100%（soft：最省模式继续） */
export type BudgetStage = 0 | 1 | 2 | 3;
export const BUDGET_STAGE_AT = [0.7, 0.9, 1.0] as const;
export type BudgetChoice = 'continue' | 'extend' | 'bot';
/** 追加预算（暂停并询问 → 追加） */
export const BUDGET_EXTEND = 500_000;

export interface BudgetState {
  stage: BudgetStage;
  /** 折算预算用量 / 上限（按 token 与美元两者取大；无上限为 0） */
  ratio: number;
  weighted: number;
  limit: number | null;
  /** 当前上下文模式标签：均衡 / 省流 / 最省 …… */
  modeLabel: string;
  /** 给玩家看的一句话（例如 "已超出预算，已切换到最省模式继续"） */
  message?: string;
  /** 上下文已压缩的次数 */
  compactions: number;
  policy: 'soft' | 'hard' | 'ask';
}

/** 预算分级的提示（当前语言；0 级没有） */
const stageMsg = (st: BudgetStage): string | undefined => (st === 0 ? undefined : t(`agent.budget.stage${st}`));

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
  private consecutiveErrors = 0;
  private readonly system: [string, string];
  private readonly role: AgentRole;
  private header: string;
  /** 本局配置的上下文设置（模式缺省 + 显式配置）；实际使用见 spec（随预算分级收紧） */
  readonly baseSpec: ContextModeSpec;
  readonly ctx: ContextBuilder;
  /** 预算分级 */
  stage: BudgetStage = 0;
  compactions = 0;
  private budgetAsked = false;
  private budgetLimit: number | null;
  /** 门控跳过的决策点数 */
  skippedCount = 0;
  private goldAtLastCall = 0;
  /** 打法辅助（§19）：意图、战报、威胁估算 */
  readonly assist: boolean;
  readonly battle: BattleLog;
  readonly plannerState: PlannerState = {};
  /** 战场情报（漏怪明细 / 缺口 / 击杀分布 / 零伤害塔）：每个世界事件喂一次（onWorldEvent） */
  readonly intel: BattleIntel;
  /** 棋盘体检行上次发出的内容与时间（同样的内容隔 3 次建造决策才重发） */
  private boardSeen = new Map<string, { text: string; n: number }>();
  private buildSeq = 0;
  /** 建造阶段决策结束时剩下的金币（闲置金币指标；模型 / 机器人 / 跳过都记） */
  readonly buildGoldAfter: number[] = [];
  private lastThreatWave = -1;

  constructor(readonly o: EngineOptions) {
    this.role = o.config.role ?? 'player';
    this.assist = o.config.assist !== false;
    this.battle = new BattleLog(o.world);
    this.intel = new BattleIntel(o.world);
    this.plannerState.intel = this.intel;
    // 提示词里的目录文本始终用源语言（简体中文），与玩家界面语言无关
    this.system = withLocale(SOURCE_LOCALE, () => systemBlocks(this.role, this.assist));
    this.header = withLocale(SOURCE_LOCALE, () => runHeader(o.opts, o.world));
    this.baseSpec = contextSpec(o.config);
    this.budgetLimit = o.config.budget?.tokens ?? null;
    this.ctx = new ContextBuilder(o.world, this.baseSpec, this.header);
    if (!o.provider) this.disabledReason = 'no provider (baseline bot)';
  }

  private get policy(): 'soft' | 'hard' | 'ask' {
    return this.o.config.budget?.mode ?? 'soft';
  }

  /** 实际使用的上下文设置：预算分级越高越省 */
  get spec(): ContextModeSpec {
    const b = this.baseSpec;
    if (this.stage === 0) return b;
    const saver = CONTEXT_MODES.saver;
    const s1: ContextModeSpec = {
      ...b,
      observation: 'delta',
      mapEvery: 0,
      rleMap: true,
      gating: 'aggressive',
      compactChars: Math.min(b.compactChars, saver.compactChars),
      maxOutputTokens: Math.min(b.maxOutputTokens, saver.maxOutputTokens),
      maxToolCalls: Math.min(b.maxToolCalls, saver.maxToolCalls),
    };
    if (this.stage === 1) return s1;
    // 输出上限不能压得太低：推理模型即使在低思考档也要几千 token，压到 1.5k 会在调用工具前被截断（实测）
    if (this.stage === 2)
      return { ...s1, maxOutputTokens: Math.min(s1.maxOutputTokens, 6144), compactChars: Math.min(s1.compactChars, 4000) };
    return { ...s1, maxOutputTokens: Math.min(s1.maxOutputTokens, 4096), compactChars: 3000, maxToolCalls: Math.min(s1.maxToolCalls, 4) };
  }

  /**
   * 预算分级下的思考等级覆盖（≥90%：降到"低"）。
   * 不降到"无思考"：实测 deepseek-flash 无思考时有钱也不造塔、明显漏怪；省 token 主要靠增量观察、跳过定期检查和压缩历史。
   * 只有玩家本来就选了"无思考"才保持关闭。
   */
  private thinkingOverride(): ThinkingLevel | undefined {
    if (this.stage < 2) return undefined;
    return this.o.config.thinking === 'off' ? 'off' : 'low';
  }

  budgetState(message?: string): BudgetState {
    const weighted = budgetTokens(this.usage);
    const tok = this.budgetLimit ? weighted / this.budgetLimit : 0;
    const usd = this.o.config.budget?.usd ? this.costUsd / this.o.config.budget.usd : 0;
    const base = this.o.config.contextMode ?? 'balanced';
    const mode = this.stage === 0 ? base : this.stage === 1 ? 'saver' : this.stage === 2 ? 'saverLow' : 'min';
    const modeLabel = t(`agent.budget.mode.${mode}`);
    return {
      stage: this.stage,
      ratio: Math.max(tok, usd),
      weighted,
      limit: this.budgetLimit,
      modeLabel,
      message: message ?? stageMsg(this.stage),
      compactions: this.compactions,
      policy: this.policy,
    };
  }

  private ratio(): number {
    const tok = this.budgetLimit ? budgetTokens(this.usage) / this.budgetLimit : 0;
    const usd = this.o.config.budget?.usd ? this.costUsd / this.o.config.budget.usd : 0;
    return Math.max(tok, usd);
  }

  private stageOf(r: number): BudgetStage {
    return r >= BUDGET_STAGE_AT[2] ? 3 : r >= BUDGET_STAGE_AT[1] ? 2 : r >= BUDGET_STAGE_AT[0] ? 1 : 0;
  }

  /**
   * 决策前检查预算分级。上升时压缩上下文；到 100%：soft 继续（最省）、hard 交给机器人、ask 询问。
   * 返回本次要记进追踪的压缩事件（如有）。
   */
  private async checkBudget(): Promise<{ before: number; after: number; n: number; stage: BudgetStage } | null> {
    if (this.disabledReason || !this.o.provider) return null;
    let next = this.stageOf(this.ratio());
    if (next === 3 && this.policy === 'hard') {
      this.disabledReason = this.overBudget() ?? 'budget exhausted';
      this.stage = 3;
      this.o.onBudget?.(this.budgetState(t('agent.budget.toBot')));
      return null;
    }
    if (next === 3 && this.policy === 'ask' && !this.budgetAsked) {
      this.budgetAsked = true;
      const choice = this.o.onBudgetExceeded
        ? await this.o.onBudgetExceeded({ ...this.budgetState(t('agent.budget.ask')), stage: 3 })
        : 'continue';
      if (choice === 'bot') {
        this.disabledReason = 'budget exhausted (handed to bot)';
        this.stage = 3;
        this.o.onBudget?.(this.budgetState(t('agent.budget.toBot')));
        return null;
      }
      if (choice === 'extend') {
        this.budgetLimit = (this.budgetLimit ?? 0) + BUDGET_EXTEND;
        this.budgetAsked = false;
        next = this.stageOf(this.ratio());
      }
    }
    if (next <= this.stage) {
      if (next < this.stage) {
        // 追加预算后回落
        this.stage = next;
        this.o.onBudget?.(this.budgetState());
      }
      return null;
    }
    this.stage = next;
    const c = this.compactContext();
    this.o.onBudget?.(this.budgetState());
    return { ...c, stage: next };
  }

  /** 压缩上下文：把备忘 + 最近几次决策的结果压成 ≤300 token 的备忘，清掉增量基线（下次发完整观测） */
  private compactContext(): { before: number; after: number; n: number } {
    const before = this.ctx.memo.tokens() + this.ctx.baselineTokens();
    const outcomes: string[] = [];
    for (const d of this.decisions.slice(-6)) {
      if (d.by !== 'agent') continue;
      const acts = d.toolCalls
        .filter((c) => c.name === 'act' || c.name === 'suggest')
        .map((c) =>
          c.result
            .split('\n')
            .filter((l) => /^\d+ (OK|REJECTED)/.test(l))
            .map((l) => l.replace(/^\d+ /, '').slice(0, 40))
            .join('; '),
        );
      const txt = acts.filter(Boolean).join('; ');
      if (txt) outcomes.push(`w${d.point.wave}: ${txt}`);
    }
    const f = this.ctx.memo.fields;
    this.ctx.memo.update({
      ...(f.plan ? { plan: f.plan.slice(0, 240) } : {}),
      ...(f.maze ? { maze: f.maze.slice(0, 160) } : {}),
      ...(f.priorities ? { priorities: f.priorities.slice(0, 160) } : {}),
      note: (outcomes.length ? `recent: ${outcomes.slice(-3).join(' / ')}` : (f.note ?? 'budget tight: act only when needed')).slice(
        0,
        400,
      ),
    });
    this.ctx.reset();
    this.compactions++;
    return { before, after: this.ctx.memo.tokens(), n: this.compactions };
  }

  /** 固定前缀（系统提示两块），测试 / 基准用 */
  get systemPrompt(): readonly [string, string] {
    return this.system;
  }

  private budgetLeft(): number {
    const b = this.o.config.budget?.tokens;
    return b ? b - budgetTokens(this.usage) : Number.POSITIVE_INFINITY;
  }

  private overBudget(): string | null {
    const b = this.o.config.budget;
    if (b?.tokens && budgetTokens(this.usage) >= b.tokens) return `token budget ${b.tokens} exhausted (weighted)`;
    if (b?.usd && this.costUsd >= b.usd) return `cost budget $${b.usd} exhausted`;
    return null;
  }

  /** 执行一个决策点（含门控、兜底与推进保证）。recent = 自上次决策以来的事件 */
  async decide(point: DecisionPoint, recent: import('../core/types').GameEvent[]): Promise<DecisionRecord> {
    const w = this.o.world;
    const t0 = Date.now();
    const calls: ToolCallRecord[] = [];
    const compacted = await this.checkBudget();
    const tools = toolsForRole(this.role, this.assist);
    const spec = this.spec;
    this.ctx.setSpec(spec);
    this.battle.feed(recent);
    this.goldAtWaveStart = null;
    const buildPhase = point.reasons.includes('build') || point.reasons.includes('game_start');
    const queue = this.o.instructions;
    if (queue?.hasPending() && !point.reasons.includes('player')) point.reasons.push('player');

    // 门控：模型可用、但局面里没有值得叫模型的事 → 本地处理
    if (!this.disabledReason && this.o.provider) {
      const why = gateDecision(w, point.reasons, spec.gating, {
        goldAtLastCall: this.goldAtLastCall,
        seq: point.seq,
        quiet: this.stage >= 2,
      });
      if (why) return this.skipLocal(point, recent, why, t0, compacted);
    }

    const ins =
      queue && this.role !== 'attacker' ? queue.take(point.seq) : { once: [] as InstructionRef[], standing: [] as InstructionRef[] };
    const insText = instructionSection(ins.once, ins.standing, this.role);
    const built = withLocale(SOURCE_LOCALE, () =>
      this.ctx.build(point, recent, this.assist && this.role !== 'attacker' ? this.extras(buildPhase) : undefined, insText || undefined),
    );
    const message = built.text;
    const rec: DecisionRecord = {
      point,
      by: 'agent',
      toolCalls: calls,
      usage: emptyUsage(),
      ms: 0,
      observationTokens: built.observationTokens,
    };
    this.goldAtLastCall = Math.floor(w.state.gold);
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
      contextMode: this.o.config.contextMode,
      delta: !built.full,
      budgetStage: this.stage,
    });
    if (compacted)
      sink?.({
        k: 'compact',
        n: compacted.n,
        before: compacted.before,
        after: compacted.after,
        stage: compacted.stage,
        reason: stageMsg(compacted.stage) ?? '',
      });
    if (ins.once.length || ins.standing.length) {
      sink?.({ k: 'instruction', items: [...ins.once, ...ins.standing].map((x) => ({ id: x.id, text: x.text, kind: x.kind })) });
      rec.instructions = [...ins.once, ...ins.standing].map((x) => ({ id: x.id, text: x.text, kind: x.kind }));
    }
    let costThis = 0;
    /** 模型这次说的话（end.note / 文字 / 建议）：从里面找对每条指令的回应 */
    let reply = '';

    let failed: string | null = this.disabledReason;
    if (!failed && this.o.provider) {
      const ac = new AbortController();
      const outer = this.o.signal;
      const onAbort = () => ac.abort();
      outer?.addEventListener('abort', onAbort);
      const timeoutMs = this.o.config.decisionTimeoutMs ?? 90_000;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ac.abort();
      }, timeoutMs);
      let gameOver = false;
      try {
        const out = await this.o.provider.decide({
          role: this.role,
          point,
          system: this.system,
          message,
          tools,
          maxToolCalls: spec.maxToolCalls,
          // soft / ask-继续：超出预算后仍按模式的输出上限请求（不缩到 0）
          remainingTokens: this.policy === 'hard' ? this.budgetLeft() : Math.max(this.budgetLeft(), spec.maxOutputTokens),
          maxOutputTokens: spec.maxOutputTokens,
          historyCompactChars: spec.compactChars,
          thinking: this.thinkingOverride(),
          signal: ac.signal,
          world: this.o.provider.id === 'scripted' ? w : undefined,
          instructions: ins.once.length || ins.standing.length ? ins : undefined,
          callTool: async (name, input, meta) => this.callTool(name, input, calls, sink, meta?.id),
          trace: sink,
          afterRequest: async (ms) => {
            if (ac.signal.aborted) return false;
            const mode = this.o.config.decision?.mode ?? 'pause';
            if (mode === 'realtime' && this.o.elapse) {
              const lat = this.o.config.decision?.realtimeLatencySec ?? 3;
              const sec = lat === 'measured' ? ms / 1000 : lat;
              if (!this.o.elapse(sec)) {
                gameOver = true;
                return false;
              }
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
        // JSON 模式的 note / 旧 end_turn 的 note（act 的结构化备忘已在工具结果里更新）
        if (out.note && !calls.some((c) => c.name === 'act' || c.name === 'end_turn' || c.name === 'suggest'))
          this.ctx.memo.update(undefined, out.note);
        if (out.text) rec.note = out.text.slice(0, 500);
        reply = [out.text, out.note, ...replyParts(calls)].filter(Boolean).join('\n');
        if (timedOut) failed = `timeout after ${timeoutMs} ms`;
        else if (out.error && !(gameOver && out.error === 'aborted')) failed = out.error;
        const memo = this.ctx.memo.text();
        if (memo && (out.note || calls.some((c) => c.name === 'act'))) rec.note = memo;
      } catch (e) {
        failed = `provider threw: ${redactError(e, this.o.config.apiKey ? [this.o.config.apiKey] : [])}`;
      } finally {
        clearTimeout(timer);
        outer?.removeEventListener('abort', onAbort);
      }
      if (failed) {
        // 模型可能没看到 / 没用上这次观测：下次发完整观测
        this.ctx.reset();
        sink?.({ k: 'error', message: failed });
        this.consecutiveErrors++;
        this.errors.push(`decision ${point.seq} @wave ${point.wave}: ${failed}`);
        if (this.consecutiveErrors >= (this.o.maxConsecutiveErrors ?? 3))
          this.disabledReason = `disabled after ${this.consecutiveErrors} consecutive errors (last: ${failed})`;
      } else this.consecutiveErrors = 0;
      if (this.policy === 'hard') {
        const b2 = this.overBudget();
        if (b2) this.disabledReason = b2;
      }
    }
    const end = (): DecisionRecord => {
      if (buildPhase) this.noteBuildGold();
      if (queue && ins.once.length) {
        const ids = ins.once.map((x) => x.id);
        if (this.o.signal?.aborted) queue.requeue(ids);
        else {
          const code: AckCode = failed ? (this.role === 'player' ? 'bot' : 'failed') : 'noReply';
          const done = queue.complete(ids, reply, code);
          sink?.({ k: 'instruction_ack', items: done.map((x) => ({ id: x.id, ack: x.ack, code: x.ackCode })) });
          for (const x of rec.instructions ?? []) {
            const d = done.find((y) => y.id === x.id);
            if (d) {
              x.ack = d.ack;
              x.ackCode = d.ackCode;
            }
          }
        }
      }
      rec.ms = Date.now() - t0;
      this.decisions.push(rec);
      sink?.({
        k: 'decision_end',
        by: rec.by,
        ms: rec.ms,
        usage: rec.usage,
        costUsd: costThis,
        toolCalls: calls.length,
        note: rec.note,
        fallbackReason: rec.fallbackReason,
      });
      return rec;
    };
    if (this.o.signal?.aborted) return end();

    // 兜底：模型失败 / 停用；军师与进攻方（桩）模式下，实际操作也由兜底机器人（模拟玩家 / 防守方）完成
    const isPlayer = this.role === 'player';
    if ((failed && isPlayer) || (!isPlayer && this.o.fallbackPlaysForHuman)) {
      if (failed) {
        rec.by = 'fallback';
        rec.fallbackReason = failed;
      }
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
      if (rec.fallbackReason !== had)
        sink?.({
          k: 'fallback',
          reason: (rec.fallbackReason ?? '').slice(had ? had.length + 2 : 0),
          acted: true,
          effect: effectSummary(before, snap(w)) || undefined,
        });
    }
    return end();
  }

  /** 门控跳过：不叫模型，只做推进保证（手动开波模式下自动开波），追踪里记一条"跳过（无可行动作）" */
  private skipLocal(
    point: DecisionPoint,
    recent: import('../core/types').GameEvent[],
    why: string,
    t0: number,
    compacted: { before: number; after: number; n: number; stage: BudgetStage } | null,
  ): DecisionRecord {
    const w = this.o.world;
    this.skippedCount++;
    this.ctx.skip(recent);
    const rec: DecisionRecord = { point, by: 'local', skipped: why, toolCalls: [], usage: emptyUsage(), ms: 0, observationTokens: 0 };
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
      contextMode: this.o.config.contextMode,
      skipped: why,
      budgetStage: this.stage,
    });
    if (compacted)
      sink?.({
        k: 'compact',
        n: compacted.n,
        before: compacted.before,
        after: compacted.after,
        stage: compacted.stage,
        reason: stageMsg(compacted.stage) ?? '',
      });
    if (this.role === 'player' || this.o.fallbackPlaysForHuman) {
      if (this.role !== 'player') void this.o.fallback.decide(point.reasons);
      const before = snap(w);
      this.ensureProgress(rec);
      if (rec.fallbackReason)
        sink?.({ k: 'fallback', reason: rec.fallbackReason, acted: true, effect: effectSummary(before, snap(w)) || undefined });
    }
    if (point.reasons.includes('build') || point.reasons.includes('game_start')) this.noteBuildGold();
    rec.ms = Date.now() - t0;
    this.decisions.push(rec);
    sink?.({
      k: 'decision_end',
      by: 'local',
      ms: rec.ms,
      usage: rec.usage,
      costUsd: 0,
      toolCalls: 0,
      skipped: why,
      fallbackReason: rec.fallbackReason,
    });
    return rec;
  }

  private async callTool(name: string, input: unknown, calls: ToolCallRecord[], sink?: TraceSink, id?: string): Promise<ToolResult> {
    const w = this.o.world;
    const callId = id ?? `call_${calls.length + 1}`;
    sink?.({ k: 'tool_call', id: callId, name, args: input });
    const before = sink ? snap(w) : null;
    const r = executeTool(
      {
        world: this.o.world,
        role: this.role,
        sink: this.send,
        rleMap: this.spec.rleMap,
        assist: this.assist,
        planner: this.plannerState,
        onObserve: (obs) => this.ctx.onObserve(obs),
        onSuggest: (text, actions) => {
          const s: Suggestion = { tick: this.o.world.state.tick, wave: this.o.world.state.wave, text, actions };
          this.suggestions.push(s);
          this.o.onSuggest?.(s);
        },
      },
      name,
      input,
    );
    this.ctx.onToolResult(r);
    if (name === 'act') this.battle.noteActResult(r.text);
    calls.push({
      name,
      input,
      ok: r.ok,
      result: r.text.length > 400 ? `${r.text.slice(0, 400)}…` : r.text,
      cmd: r.cmd,
      queuedFor: r.queuedFor,
    });
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

  /** 本次决策里开波（建造阶段）前一刻的金币：闲置金币按它算（提前开波的奖励不算"闲置"） */
  private goldAtWaveStart: number | null = null;

  /** 指令出口（工具 / 推进保证共用）：记下建造阶段开波前的金币，再交给 sink / world.command */
  private readonly send: CommandSink = (c) => {
    const w = this.o.world;
    if (c.type === 'startWave' && w.state.phase === 'build' && this.goldAtWaveStart === null)
      this.goldAtWaveStart = Math.floor(w.state.gold);
    return this.o.sink ? this.o.sink(c) : w.command(c);
  };

  private noteBuildGold(): void {
    const g = this.goldAtWaveStart ?? Math.floor(this.o.world.state.gold);
    this.goldAtWaveStart = null;
    this.buildGoldAfter.push(g);
    this.battle.noteBuildGold(g);
  }

  /**
   * 打法信息（§19，一次性、不进增量基线）：上一波战报、下一波威胁估算与克制（建造阶段或下一波变了时）、闲置金币提醒（建造阶段）。
   */
  private extras(buildPhase: boolean): string | undefined {
    const w = this.o.world;
    const out: string[] = [];
    const br = this.battle.take();
    if (br) out.push(br);
    // 漏怪明细 / 缺口热点 / 击杀分布：与战报同一窗口（波末之后的第一次模型决策）；波中漏怪也即时给明细
    if (this.intel.hasPendingLeaks()) {
      const leaks = this.intel.takeLeaks();
      const lk = leakLine(w, leaks);
      if (lk) {
        out.push(lk);
        this.intel.stats.reports++;
      }
      const gap = gapLine(w, this.intel);
      if (gap) out.push(gap);
    }
    if (br) {
      const kh = killLine(w, this.intel.takeKills());
      if (kh) out.push(kh);
    }
    const nw = w.state.nextWave.wave;
    if (buildPhase || nw !== this.lastThreatWave) {
      const th = threatLine(w, this.leakPurposes());
      if (th) out.push(th);
      this.lastThreatWave = nw;
    }
    const evt = eventLine(w);
    if (evt) out.push(evt);
    if (buildPhase && this.role === 'player') {
      this.buildSeq++;
      for (const [k, f] of [
        ['RC', () => reclaimLine(w, this.intel)],
        ['CB', () => comboLine(w)],
        ['MZ', () => mazeLine(w)],
      ] as const) {
        const t = f();
        if (!t) continue;
        const seen = this.boardSeen.get(k);
        if (seen && seen.text === t && this.buildSeq - seen.n < 3) continue;
        this.boardSeen.set(k, { text: t, n: this.buildSeq });
        out.push(t);
      }
      const idle = idleLine(w, this.plannerState);
      if (idle) out.push(idle);
    }
    return out.length ? out.join('\n') : undefined;
  }

  /** 最近 3 波漏掉的敌人 / 精英词缀需要的用途（CTR 用） */
  private leakPurposes(): Purpose[] {
    const cur = this.o.world.state.wave;
    const out = new Set<Purpose>();
    for (const l of this.intel.leaks as readonly LeakRecord[]) {
      if (l.wave <= cur - 3) continue;
      for (const a of l.affixes) {
        const p = AFFIX_PURPOSE[a];
        if (p) out.add(p);
      }
      const def = ENEMIES[l.enemy];
      if (def) for (const p of enemyPurposes(def)) out.add(p);
    }
    return [...out];
  }

  /** 每个世界事件调用（浏览器控制器 / 无头 runner）：喂给战场情报 */
  onWorldEvent(ev: import('../core/types').GameEvent): void {
    this.intel.onEvent(ev);
  }

  /** 决策后保证游戏能继续：增益必须选、补给必须选、手动模式必须开波 */
  private ensureProgress(rec: DecisionRecord): void {
    const w = this.o.world;
    const s = w.state;
    const send = this.send;
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

/** 模型这次决策里说的话：act 的 end.note、end_turn 的 note、suggest 的文字（找对玩家指令的回应用） */
function replyParts(calls: readonly ToolCallRecord[]): string[] {
  const out: string[] = [];
  for (const c of calls) {
    const i = (c.input ?? {}) as Record<string, unknown>;
    if (c.name === 'act') {
      const e = i.end as Record<string, unknown> | undefined;
      if (e && typeof e.note === 'string') out.push(e.note);
      if (Array.isArray(i.actions))
        for (const a of i.actions as Record<string, unknown>[]) if (a?.do === 'end_turn' && typeof a.note === 'string') out.push(a.note);
    } else if (c.name === 'end_turn' && typeof i.note === 'string') out.push(i.note);
    else if (c.name === 'suggest' && typeof i.text === 'string') out.push(i.text);
  }
  return out;
}
