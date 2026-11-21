/**
 * 无头整局运行（CLI / 测试 / 评测场）：runAgentGame(opts, agent) → { result, log, replay, usage, decisions, ... }
 *
 * 回放：返回的 replay 与 src/meta/midrun.ts 的 MidRun 同形（seed + opts + 指令日志 + 帧号），
 * 可直接交给 replaySync / replayAsync 复现整局（模型的思考不影响回放：日志里只有落地的指令和帧号）。
 */
import { createWorld } from '../core';
import type { IWorld, RunOptions } from '../core/types';
import { makeMidRun } from '../meta/midrun';
import { boardForOpts } from '../shared/leaderboard';
import { type AgentModelConfig, agentTag, resolveConfig, saveableConfig } from './config';
import { DecisionEngine } from './engine';
import { scriptedFallback } from './providers/scripted';
import type { LLMProvider } from './providers/types';
import { AgentScheduler } from './scheduler';
import {
  type AgentReplay,
  type AgentRunResult,
  type AgentWaveRow,
  budgetTokens,
  type DecisionRecord,
  type FallbackPolicy,
  type Suggestion,
  type TokenUsage,
  usageTotal,
} from './types';

export interface AgentRunConfig {
  /** 模型配置（未填的用缺省；apiKey 不会写进报告） */
  config: Partial<AgentModelConfig>;
  /** 已构造好的适配器；null = 纯内置机器人基线（评测对照）。不给则由调用方先 createProvider(config) */
  provider: LLMProvider | null;
  /** 兜底策略工厂（CLI 用 scripts/bots 的 StrategyBot；缺省 = 脚本策略） */
  fallback?: (w: IWorld) => FallbackPolicy;
  /** 无尽模式封顶波数（该波结束即停） */
  maxWaves?: number;
  /** 游戏时间上限（秒） */
  maxGameSeconds?: number;
  signal?: AbortSignal;
  onDecision?: (rec: DecisionRecord, w: IWorld) => void;
  onWave?: (row: AgentWaveRow) => void;
  onUsage?: (total: TokenUsage, costUsd: number) => void;
  onSuggest?: (s: Suggestion) => void;
  /** 思路与请求的缓冲区（可选） */
  trace?: import('./trace').AgentTrace;
  /** 预算分级变化 */
  onBudget?: (b: import('./engine').BudgetState) => void;
  /** budget.mode = 'ask' 时的回答（缺省 continue） */
  onBudgetExceeded?: (b: import('./engine').BudgetState) => Promise<import('./engine').BudgetChoice>;
  /**
   * AI 对战（文档 10 §2.3）：再给一个进攻方模型，与防守方（上面的 config / provider，按 AI 玩家处理）在同一个世界里对局。
   * 每个建造决策点先让进攻方改写下一波（overrideWave），再让防守方决策；provider = null 时用确定性出题策略。
   */
  attacker?: { config: Partial<AgentModelConfig>; provider: LLMProvider | null };
}

/** AI 对战：进攻方的汇总（防守方在报告的顶层字段里） */
export interface AttackerRunReport {
  agent: { provider: string; model: string; role: 'attacker' };
  usage: TokenUsage;
  totalTokens: number;
  costUsd: number;
  decisions: DecisionRecord[];
  errors: string[];
  disabledReason: string | null;
  /** 改写过的波数 */
  planned: number;
}

export interface AgentRunReport {
  result: AgentRunResult;
  /** 指令日志（world.log 的拷贝） */
  log: { tick: number; cmd: import('../core/types').Command }[];
  replay: AgentReplay;
  usage: TokenUsage;
  totalTokens: number;
  costUsd: number;
  decisions: DecisionRecord[];
  waves: AgentWaveRow[];
  errors: string[];
  suggestions: Suggestion[];
  /** AI 专用榜键（永远不会进入真人榜） */
  board: string;
  agent: { provider: string; model: string; role: string };
  config: AgentModelConfig;
  disabledReason: string | null;
  /** 结束时的预算分级（无预算时为 null） */
  budget: import('./engine').BudgetState | null;
  /** 打法指标（评测用，scripts/agent-eval.ts） */
  play: PlayStats;
  wallMs: number;
  /** AI 对战：进攻方（没有进攻方时不设） */
  attacker?: AttackerRunReport;
}

export interface PlayStats {
  /** 建造阶段决策结束时剩余金币的平均值（闲置金币） */
  idleGold: number;
  idleSamples: number;
  /** 被拒 / 出错的动作数（act 结果里的 REJECTED / ERROR 行 + 失败的旧工具调用） */
  rejected: number;
  /** 被拒后由规划器自动挪位成功的放置数 */
  recovered: number;
  /** 结束时的攻击塔 / 墙数量 */
  towers: number;
  walls: number;
  /** 结束时各开放出生点的路线长度平均（格）；开局时的长度 */
  pathLen: number;
  pathLen0: number;
}

function pathAvg(w: IWorld): number {
  const ps = w.currentPaths();
  return ps.length ? Math.round((ps.reduce((a, p) => a + p.length, 0) / ps.length) * 10) / 10 : 0;
}

export async function runAgentGame(opts: RunOptions, agent: AgentRunConfig): Promise<AgentRunReport> {
  const t0 = Date.now();
  const config = resolveConfig(agent.config);
  if (agent.attacker && (config.role ?? 'player') !== 'player') throw new Error('AI 对战：防守方必须是 player 角色');
  const world = createWorld(opts);
  const s = world.state;
  const pathLen0 = pathAvg(world);
  const sched = new AgentScheduler(world, {
    mode: config.decision?.mode ?? 'pause',
    waveIntervalSec: config.decision?.waveIntervalSec,
    maxWaves: agent.maxWaves,
    maxGameSeconds: agent.maxGameSeconds,
  });
  const fallback = (agent.fallback ?? scriptedFallback)(world);
  /** AI 对战：已经问过进攻方的波（每波只问一次；进攻方选择保留默认波时不再等它） */
  let askedWave = -1;
  const attackDue = (): boolean => {
    const i = world.attackContext?.();
    return !!i && i.open && !i.current && askedWave !== i.wave;
  };
  agent.trace?.addSecret(config.apiKey);
  const engine = new DecisionEngine({
    world,
    opts,
    config,
    provider: agent.provider,
    fallback,
    elapse: (sec) => sched.elapse(sec),
    fallbackPlaysForHuman: true,
    signal: agent.signal,
    onSuggest: agent.onSuggest,
    onUsage: agent.onUsage,
    trace: agent.trace,
    onBudget: agent.onBudget,
    onBudgetExceeded: agent.onBudgetExceeded,
    ...(agent.attacker ? { holdWaveStart: attackDue } : {}),
  });
  // AI 对战：进攻方引擎（同一个世界、同一个调度器；不替真人防守，防守由上面的引擎负责）
  const atk = agent.attacker;
  const atkConfig = atk ? resolveConfig({ ...atk.config, role: 'attacker', decision: { ...atk.config.decision, mode: 'pause' } }) : null;
  if (atkConfig) agent.trace?.addSecret(atkConfig.apiKey);
  const attacker =
    atk && atkConfig
      ? new DecisionEngine({
          world,
          opts,
          config: atkConfig,
          provider: atk.provider,
          fallback,
          signal: agent.signal,
          trace: agent.trace,
        })
      : null;

  const waves: AgentWaveRow[] = [];
  let leaks = 0;
  let cleared = 0;
  sched.onEvent = (ev) => {
    engine.onWorldEvent(ev);
    attacker?.onWorldEvent(ev);
    if (ev.type === 'waveStart') fallback.onWaveStart?.(ev.wave);
    else if (ev.type === 'leak') {
      leaks++;
      fallback.onLeak?.(ev.enemy);
    } else if (ev.type === 'waveEnd') {
      fallback.onWaveEnd?.(ev.wave);
      cleared = Math.max(cleared, ev.wave);
      const row: AgentWaveRow = {
        wave: ev.wave,
        tick: s.tick,
        gold: Math.floor(s.gold),
        lives: s.lives,
        leaks,
        towers: [...s.towers.values()].filter((t) => t.id !== 'wall').length,
        score: s.score,
        tokens: usageTotal(engine.usage),
        weighted: budgetTokens(engine.usage),
        requests: engine.usage.requests,
        costUsd: engine.costUsd,
        decisions: engine.decisions.length,
        fallbacks: engine.decisions.filter((d) => d.by === 'fallback').length,
      };
      waves.push(row);
      leaks = 0;
      agent.onWave?.(row);
    }
  };

  // AI 对战：每波一开始就给再下一波出题（自动开波时下一波可能不经过建造阶段）
  if (attacker) sched.interrupt = attackDue;
  let cancelled = false;
  for (;;) {
    if (agent.signal?.aborted) {
      cancelled = true;
      break;
    }
    const point = sched.advance();
    if (!point) break;
    // 打断点（reasons 为空）：上一波刚开始、下一波还没出题 → 只让进攻方出题
    if (point.reasons.length === 0) {
      if (attacker && attackDue()) {
        askedWave = world.attackContext!()!.wave;
        const ar = await attacker.decide(point, []);
        ar.side = 'attack';
        agent.onDecision?.(ar, world);
      } else askedWave = world.attackContext?.()?.wave ?? askedWave;
      continue;
    }
    // AI 对战：进攻方先出题（必须在防守方开波之前），再轮到防守方
    const planFor = async (p: typeof point): Promise<void> => {
      if (!attacker || !attackDue() || !attacker.attackPending(p)) return;
      askedWave = world.attackContext!()!.wave;
      const ar = await attacker.decide({ ...p, reasons: p.reasons.slice() }, []);
      ar.side = 'attack';
      agent.onDecision?.(ar, world);
    };
    await planFor(point);
    const rec = await engine.decide(attacker ? { ...point, reasons: point.reasons.slice() } : point, sched.takeRecent());
    if (attacker) rec.side = 'defend';
    agent.onDecision?.(rec, world);
    // 防守方刚选完增益、回到建造阶段：下一波还没出题（开波被 holdWaveStart 挡住）→ 进攻方现在出题
    if (attacker && attackDue()) await planFor(sched.detector.point(world, ['build']));
    sched.markDecided();
  }
  sched.drain();

  const stop = sched.stopped;
  const tag = agent.provider ? agentTag({ ...config, provider: config.provider }) : { provider: 'baseline', model: fallback.name };
  const result: AgentRunResult = {
    outcome: cancelled ? 'cancelled' : (stop ?? 'cap'),
    wave: s.wave,
    cleared,
    score: s.score,
    lives: s.lives,
    maxLives: s.maxLives,
    kills: s.stats.kills,
    leaks: s.stats.leaks,
    gold: Math.floor(s.gold),
    ticks: s.tick,
    seconds: Math.round(s.time),
  };
  const mid = makeMidRun(world);
  const log = world.log.map((e) => ({ tick: e.tick, cmd: e.cmd }));
  const atkTag = atk && atkConfig ? (atk.provider ? agentTag(atkConfig) : { provider: 'scripted', model: 'scripted-attacker' }) : null;
  const replay: AgentReplay = {
    ...mid,
    agent: { ...tag, role: config.role ?? 'player' },
    ...(atkTag ? { attacker: atkTag } : {}),
  };
  return {
    result,
    log,
    replay,
    usage: engine.usage,
    totalTokens: usageTotal(engine.usage),
    costUsd: engine.costUsd,
    decisions: engine.decisions,
    waves,
    errors: engine.errors,
    suggestions: engine.suggestions,
    board: boardForOpts(opts),
    agent: replay.agent,
    config: saveableConfig(config),
    disabledReason: agent.provider ? engine.disabledReason : null,
    budget: config.budget?.tokens || config.budget?.usd ? engine.budgetState() : null,
    play: {
      idleGold: engine.buildGoldAfter.length
        ? Math.round(engine.buildGoldAfter.reduce((a, b) => a + b, 0) / engine.buildGoldAfter.length)
        : 0,
      idleSamples: engine.buildGoldAfter.length,
      rejected:
        engine.battle.stats.rejected +
        engine.decisions.reduce((a, d) => a + d.toolCalls.filter((c) => !c.ok && c.name !== 'act').length, 0),
      recovered: engine.battle.stats.recovered,
      towers: [...s.towers.values()].filter((t) => t.id !== 'wall').length,
      walls: [...s.towers.values()].filter((t) => t.id === 'wall').length,
      pathLen: pathAvg(world),
      pathLen0,
    },
    wallMs: Date.now() - t0,
    ...(attacker && atkTag
      ? {
          attacker: {
            agent: { ...atkTag, role: 'attacker' as const },
            usage: attacker.usage,
            totalTokens: usageTotal(attacker.usage),
            costUsd: attacker.costUsd,
            decisions: attacker.decisions,
            errors: attacker.errors,
            disabledReason: atk?.provider ? attacker.disabledReason : null,
            planned: log.filter((e) => e.cmd.type === 'overrideWave').length,
          },
        }
      : {}),
  };
}
