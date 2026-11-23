/**
 * Agent 参战 —— 公共 API（文档 10 §12，给之后的网页 UI 用）。
 *
 * 网页里的用法：
 *   const ctl = createAgentController({ config, session, onEvent });
 *   await ctl.start();          // 按需 dynamic import 对应的模型适配器（pi / 官方 SDK / 桥接器）
 *   ctl.pause(); ctl.resume(); ctl.stop();
 *   ctl.report();               // 用量、决策记录、回放（AI 榜专用）
 * 世界仍由 Session 按真实时间推进；控制器订阅 Session 事件、每 100ms 检查一次决策点：
 *   pause 模式：决策点到了就 session.togglePause(true)，模型做完再恢复；
 *   realtime 模式：世界不停，模型的指令在到达时经 session.command() 落地（帧号即落地时刻）。
 */
import type { Command, GameEvent, IWorld } from '../core/types';
import { makeMidRun } from '../meta/midrun';
import { steadyInterval } from '../shared/bgclock';
import { boardForOpts } from '../shared/leaderboard';
import { type AgentModelConfig, agentTag, configErrorMessage, resolveConfig, saveableConfig, validateConfig } from './config';
import { type BudgetChoice, type BudgetState, DecisionEngine } from './engine';
import { createProvider } from './factory';
import type { InstructionQueue } from './instructions';
import { scriptedFallback } from './providers/scripted';
import type { LLMProvider } from './providers/types';
import { DecisionDetector } from './scheduler';
import { AgentTrace, type TraceExport } from './trace';
import type { AgentReplay, DecisionReason, DecisionRecord, FallbackPolicy, Suggestion, TokenUsage } from './types';

export * from './types';
export * from './config';
export {
  AGENT_TOOLS,
  LEGACY_TOOLS,
  SLIM_TOOLS,
  ATTACK_PLAN_TOOL,
  ACT_TOOL_V1,
  ACT_TO_LEGACY,
  INTENT_KINDS,
  toolsForRole,
  legacyToolsForRole,
  executeTool,
  validateToolInput,
  validateAgainst,
  toCommand,
  actToLegacy,
  type AgentToolDef,
  type ToolContext,
  type JsonSchema,
  type ObjectSchema,
} from './tools';
export { observe, renderObservation, asciiMap, estimateTokens, MAP_LEGEND, type Observation } from './observation';
export { compactObservation, diffObs, applyObsDelta, terrainMap, rle, unrle, ENEMY_CODE, type CompactObs } from './compact';
export {
  groundRoutes,
  flightLines,
  coverage,
  coverageLines,
  routeSummary,
  previewChanges,
  previewText,
  compressWaypoints,
  expandWaypoints,
  type Route,
  type FlightLine,
  type PreviewInput,
  type PreviewResult,
} from './routes';
export { ContextBuilder, Memo, MEMO_MAX_TOKENS } from './context';
export { Planner, DEFAULT_BRANCH, routeSamples, airLineSamples, type PlannerState, type IntentOutcome } from './planner';
export {
  BattleLog,
  threatEstimate,
  threatLine,
  idleLine,
  eventLine,
  towerDps,
  IDLE_GOLD,
  THREAT_SAFE,
  THREAT_TIGHT,
  type ThreatLine,
} from './battle';
export { planMaze, layers, type MazePlan } from './maze';
export * from './doctrine';
export { gateDecision, cheapestUsefulAction, inDanger, eventNeedsDecision, EVENT_DECIDE, type GatingLevel } from './gating';
export { claudeThinkingPlan, piThinkingPlan, keepThinkingInHistory, mayCompactHistory, modelLevel } from './thinking';
export * from './modelinfo';
export { systemBlocks, catalogText, catalogEntry, cheatSheet, decisionMessage } from './prompts';
export { BUDGET_STAGE_AT, BUDGET_EXTEND, type BudgetStage, type BudgetState, type BudgetChoice } from './engine';
export { AgentScheduler, DecisionDetector, type SchedulerOptions } from './scheduler';
export { DecisionEngine } from './engine';
export { runAgentGame, type AgentRunConfig, type AgentRunReport, type AttackerRunReport, type PlayStats } from './runner';
export { createDuelController, type DuelControllerOptions, type DuelSideOptions } from './duel';
export { createProvider } from './factory';
export { listModels, testConnection, type ModelListing, type ConnectionDiagnostics } from './models';
export * from './relay';
export { connectBridge, originAllowed, makePairingCode, BRIDGE_PROTOCOL } from './bridge';
export { scriptedFallback, ScriptedProvider, scriptedIntentTurn } from './providers/scripted';
export { ScriptedAttackerProvider } from './providers/attacker';
export {
  AttackLedger,
  attackObservation,
  attackMessage,
  defenderSummary,
  planLine,
  scriptedAttackPlan,
  type AttackWaveRecord,
} from './attack';
export * from './instructions';
export type { LLMProvider, DecisionContext, DecisionOutcome } from './providers/types';
export * from './trace';
export { redactString, redactValue, redactJson, redactError, isSecretKey, REDACTED } from './redact';

/** Session 里控制器用到的部分（src/game/Session.ts 满足） */
export interface SessionLike {
  readonly world: IWorld;
  readonly paused: boolean;
  command(cmd: Command): { ok: boolean; reason?: string };
  togglePause(force?: boolean): void;
  on(fn: (ev: GameEvent) => void): () => void;
  /** 开波闸门（AI 出题：进攻方出题期间挡住手动开波）；可选 */
  holdStart?: (() => boolean) | null;
}

export type AgentStatus = 'idle' | 'loading' | 'running' | 'thinking' | 'paused' | 'stopped' | 'error';

export type AgentControllerEvent =
  /** side：AI 对战（createDuelController）里是哪一方的状态；单模型控制器不设 */
  | { type: 'status'; status: AgentStatus; detail?: string; side?: import('./types').DuelSide }
  | { type: 'decision'; record: DecisionRecord }
  | { type: 'usage'; usage: TokenUsage; costUsd: number }
  | { type: 'suggestion'; suggestion: Suggestion }
  /** 预算分级变化（70% 省流 / 90% 无思考 / 100% 最省或交给机器人） */
  | { type: 'budget'; budget: BudgetState }
  /** budget.mode = 'ask' 用完预算：游戏已暂停，等 resolveBudget() */
  | { type: 'budget_ask'; budget: BudgetState }
  /** 中心策略变了（模型 / 玩家改了，或模型在锁定时提了建议） */
  | { type: 'doctrine'; doctrine: import('./doctrine').DoctrineState }
  | { type: 'error'; message: string };

export interface AgentControllerOptions {
  config: Partial<AgentModelConfig>;
  session: SessionLike;
  /** 覆盖 config.decision.mode */
  mode?: 'pause' | 'realtime';
  /** 预先构造的适配器（测试 / 桥接器已连好时）；缺省按 config 动态加载 */
  provider?: LLMProvider;
  /** 兜底策略（缺省：脚本策略） */
  fallback?: (w: IWorld) => FallbackPolicy;
  onEvent?: (ev: AgentControllerEvent) => void;
  /** 自动每 pollMs 检查决策点（默认 100；0 = 由 UI 每帧调用 poll()） */
  pollMs?: number;
  /** 思路与请求的缓冲区（缺省新建一个；UI 换模型重启控制器时传同一个，面板不断档） */
  trace?: AgentTrace;
  /** 玩家指令队列（「给 AI 下指令」）：有等待中的一次性指令时立即决策（绕过最小间隔与门控） */
  instructions?: InstructionQueue;
}

export interface AgentController {
  readonly status: AgentStatus;
  readonly usage: TokenUsage;
  readonly costUsd: number;
  readonly decisions: readonly DecisionRecord[];
  /** 思路与请求（文档 10 §12.1） */
  readonly trace: AgentTrace;
  start(): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): void;
  /** 检查并（必要时）发起一次决策；pollMs = 0 时由 UI 每帧调用 */
  poll(): void;
  /** 当前预算分级 */
  budget(): BudgetState | null;
  /** 回答"预算用完了"的询问：continue = 最省模式继续；extend = 追加 50 万；bot = 交给机器人 */
  resolveBudget(choice: BudgetChoice): void;
  /** 是否正在等玩家回答预算询问 */
  readonly budgetPending: boolean;
  report(): AgentBrowserReport;
  /** 中心策略（§20）：当前状态（进攻方 / 未启动 = null） */
  doctrine?(): import('./doctrine').DoctrineState | null;
  /** 玩家改中心策略（立即触发一次决策）；locked 改锁定 */
  setDoctrine?(input: import('./doctrine').DoctrineInput & { locked?: boolean }): { ok: boolean; text: string };
}

/** AI 对战里一方的统计（报告 / 本地记录 / 上传对战榜用） */
export interface DuelSideReport {
  provider: string;
  model: string;
  effort?: import('./config').ThinkingLevel;
  decisions: number;
  /** 由内置机器人兜底的决策数 */
  fallback: number;
  usage: TokenUsage;
  costUsd: number;
  errors: string[];
}

export interface AgentBrowserReport {
  /** effort：思考档位（内置机器人没有）；provider 是渠道，只留在本地，不上传 */
  agent: { provider: string; model: string; role: string; effort?: import('./config').ThinkingLevel };
  board: string;
  usage: TokenUsage;
  costUsd: number;
  decisions: DecisionRecord[];
  errors: string[];
  suggestions: Suggestion[];
  replay: AgentReplay;
  config: AgentModelConfig;
  /** 思路与请求记录（已脱敏、封顶约 1.5M 字符；原始请求 / 响应可能被去掉） */
  trace: TraceExport;
  /** AI 对战：进攻方模型（agent 是防守方，role = 'duel'） */
  attacker?: { provider: string; model: string; effort?: import('./config').ThinkingLevel };
  /** AI 对战：双方各自的决策数 / 用量 / 费用 / 错误 */
  duel?: { attack: DuelSideReport; defend: DuelSideReport };
}

export function createAgentController(o: AgentControllerOptions): AgentController {
  const errs = validateConfig({ provider: 'claude-native', ...o.config });
  if (errs.length) throw new Error(configErrorMessage(errs));
  const config = resolveConfig({ ...o.config, decision: { ...o.config.decision, mode: o.mode ?? o.config.decision?.mode } });
  const session = o.session;
  const w = session.world;
  const detector = new DecisionDetector({ waveIntervalSec: config.decision?.waveIntervalSec ?? 15, minGapSec: 3 });
  const recent: GameEvent[] = [];
  const emit = (ev: AgentControllerEvent) => o.onEvent?.(ev);
  const ac = new AbortController();
  const trace = o.trace ?? new AgentTrace();
  trace.addSecret(config.apiKey);
  let status: AgentStatus = 'idle';
  let engine: DecisionEngine | null = null;
  let provider: LLMProvider | null = o.provider ?? null;
  let busy = false;
  let userPaused = false;
  let stopTimer: (() => void) | null = null;
  let unsub: (() => void) | null = null;
  let budgetResolve: ((c: BudgetChoice) => void) | null = null;
  /** 进攻方：已为哪一波出过题（每波只问一次） */
  let attackPlanned = -1;
  /** 玩家刚改了中心策略：下一次 poll 立即决策 */
  let forceNext = false;
  /** 进攻方正在出题 */
  let planning = false;
  /** 自动开波快到了、题还没出完 → 临时暂停了游戏 */
  let autoHeld = false;
  /** 出题期间：挡住手动开波；自动开波倒计时快到时暂停游戏 */
  const guardAuto = (): void => {
    if (!planning || autoHeld || session.paused) return;
    const s = w.state;
    const au = s.autoWave;
    const due = au.enabled ? (s.phase === 'build' ? au.nextAt : au.deadline) : null;
    if (typeof due === 'number' && due - s.time < 1) {
      autoHeld = true;
      session.togglePause(true);
    }
  };

  const setStatus = (s: AgentStatus, detail?: string) => {
    status = s;
    emit({ type: 'status', status: s, detail });
  };

  const poll = () => {
    guardAuto();
    if (!engine || busy || userPaused || status === 'stopped' || status === 'error') return;
    const attacker = config.role === 'attacker';
    let reasons: DecisionReason[] | null;
    if (attacker) {
      // 进攻方（文档 10 §2.3）：真人防守。下一波一开始就为再下一波出题（战斗 / 建造 / 选增益阶段都行），
      // 不等建造阶段，所以自动开波、选完增益马上开波都来得及；其余决策点直接忽略（不暂停、不记录）
      const info = w.attackContext?.();
      if (!info?.open || info.current || attackPlanned === info.wave) return;
      attackPlanned = info.wave;
      planning = true;
      reasons = ['build'];
    } else {
      reasons = detector.check(w, !!o.instructions?.hasPending() || forceNext);
      if (!reasons) return;
      forceNext = false;
    }
    const point = detector.point(w, reasons);
    // 进攻方出题时不暂停：真人照常操作，只是开波要等题出完（session.holdStart + 自动开波前暂停）
    const pauseMode = !attacker && (config.decision?.mode ?? 'pause') === 'pause';
    const wasPaused = session.paused;
    busy = true;
    if (pauseMode) session.togglePause(true);
    setStatus('thinking', reasons.join(','));
    const ev = recent.splice(0, recent.length);
    void engine
      .decide(point, ev)
      .then((rec) => {
        detector.done(w);
        emit({ type: 'decision', record: rec });
      })
      .catch((e: unknown) => {
        emit({ type: 'error', message: e instanceof Error ? e.message : String(e) });
        detector.done(w);
      })
      .finally(() => {
        busy = false;
        planning = false;
        if (autoHeld) {
          autoHeld = false;
          if (!userPaused && status !== 'stopped') session.togglePause(false);
        }
        if (status === 'stopped') return;
        if (pauseMode && !wasPaused && !userPaused) session.togglePause(false);
        setStatus(userPaused ? 'paused' : 'running');
      });
  };

  return {
    get status() {
      return status;
    },
    get usage() {
      return engine?.usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 };
    },
    get costUsd() {
      return engine?.costUsd ?? 0;
    },
    get decisions() {
      return engine?.decisions ?? [];
    },
    trace,
    async start() {
      if (engine) return;
      setStatus('loading');
      try {
        provider = provider ?? (await createProvider(config));
      } catch (e) {
        setStatus('error', e instanceof Error ? e.message : String(e));
        return;
      }
      engine = new DecisionEngine({
        world: w,
        opts: w.state.opts,
        config,
        provider,
        fallback: (o.fallback ?? scriptedFallback)(w),
        sink: (cmd) => session.command(cmd),
        signal: ac.signal,
        onSuggest: (s) => emit({ type: 'suggestion', suggestion: s }),
        onDoctrine: (d) => emit({ type: 'doctrine', doctrine: d }),
        onUsage: (u, c) => emit({ type: 'usage', usage: u, costUsd: c }),
        onBudget: (b) => emit({ type: 'budget', budget: b }),
        instructions: o.instructions,
        onBudgetExceeded: (b) =>
          new Promise<BudgetChoice>((resolve) => {
            // 暂停并询问：游戏停住（实时模式也停），等玩家选
            session.togglePause(true);
            budgetResolve = (c) => {
              budgetResolve = null;
              resolve(c);
            };
            setStatus('paused', 'budget');
            emit({ type: 'budget_ask', budget: b });
          }),
        trace,
      });
      unsub = session.on((ev) => {
        engine?.onWorldEvent(ev);
        recent.push(ev);
        if (recent.length > 4000) recent.splice(0, 2000);
        detector.feed(ev, w);
      });
      // 进攻方出题期间挡住手动开波（真人点「开始」或快捷键都走 session.command）
      if (config.role === 'attacker') session.holdStart = () => planning;
      const ms = o.pollMs ?? 100;
      if (ms > 0) stopTimer = steadyInterval(poll, ms);
      setStatus('running');
    },
    pause() {
      userPaused = true;
      session.togglePause(true);
      setStatus('paused');
    },
    resume() {
      userPaused = false;
      if (!busy) session.togglePause(false);
      setStatus(busy ? 'thinking' : 'running');
    },
    stop() {
      budgetResolve?.('bot');
      ac.abort();
      stopTimer?.();
      stopTimer = null;
      if (config.role === 'attacker') session.holdStart = null;
      if (autoHeld) {
        autoHeld = false;
        session.togglePause(false);
      }
      unsub?.();
      provider?.dispose?.();
      setStatus('stopped');
    },
    poll,
    budget: () => engine?.budgetState() ?? null,
    get budgetPending() {
      return budgetResolve !== null;
    },
    resolveBudget(choice: BudgetChoice) {
      const r = budgetResolve;
      if (!r) return;
      setStatus('thinking', choice);
      r(choice);
    },
    doctrine: () => engine?.doctrine ?? null,
    setDoctrine(input) {
      if (!engine || config.role === 'attacker') return { ok: false, text: 'doctrine: not available' };
      const r = engine.setDoctrine(input, 'player');
      if (r.ok && (input.preset !== undefined || input.core !== undefined || input.maze !== undefined)) forceNext = true;
      return r;
    },
    report() {
      const tag = provider ? agentTag(config) : { provider: 'none', model: 'none' };
      const role = config.role ?? 'player';
      return {
        agent: { ...tag, role },
        board: boardForOpts(w.state.opts),
        usage: engine?.usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 },
        costUsd: engine?.costUsd ?? 0,
        decisions: engine?.decisions.slice() ?? [],
        errors: engine?.errors.slice() ?? [],
        suggestions: engine?.suggestions.slice() ?? [],
        replay: { ...makeMidRun(w), agent: { ...tag, role } },
        config: saveableConfig(config),
        trace: trace.export({ maxChars: 1_500_000 }),
      };
    },
  };
}

/**
 * BYO key 的存放：默认只在内存；remember = true 时放 sessionStorage（关标签页即清除）。永不写 localStorage、永不发给我们的服务器。
 */
export function createKeyStore(storageKey = 'dd.agent.key') {
  let mem: string | undefined;
  const ss = (): Storage | null => {
    try {
      return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
    } catch {
      return null;
    }
  };
  return {
    get(): string | undefined {
      if (mem) return mem;
      try {
        return ss()?.getItem(storageKey) ?? undefined;
      } catch {
        return undefined;
      }
    },
    set(key: string, remember = false): void {
      mem = key;
      try {
        if (remember) ss()?.setItem(storageKey, key);
        else ss()?.removeItem(storageKey);
      } catch {
        /* 隐私模式等 */
      }
    },
    clear(): void {
      mem = undefined;
      try {
        ss()?.removeItem(storageKey);
      } catch {
        /* ignore */
      }
    },
  };
}

/** 浏览器 BYO key 模式的警告文案（UI 原样展示） */
export const BYO_KEY_WARNING =
  '你的 API Key 只保存在本页内存中（勾选"本次会话记住"则存入 sessionStorage，关闭标签页即清除），由浏览器直接发给模型服务商，' +
  '不会经过我们的服务器。但任何能在本页运行脚本的扩展都可能读到它：请使用单独的、设了额度上限的 Key，用完可在服务商后台作废。';
