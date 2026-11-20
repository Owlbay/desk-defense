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
import { agentTag, resolveConfig, saveableConfig, validateConfig, type AgentModelConfig } from './config';
import { DecisionEngine } from './engine';
import { createProvider } from './factory';
import { DecisionDetector } from './scheduler';
import { scriptedFallback } from './providers/scripted';
import type { LLMProvider } from './providers/types';
import { aiBoardKey } from './runner';
import type { AgentReplay, DecisionRecord, FallbackPolicy, Suggestion, TokenUsage } from './types';

export * from './types';
export * from './config';
export { AGENT_TOOLS, toolsForRole, executeTool, validateToolInput, validateAgainst, toCommand, type AgentToolDef, type ToolContext, type JsonSchema, type ObjectSchema } from './tools';
export { observe, renderObservation, asciiMap, estimateTokens, MAP_LEGEND, type Observation } from './observation';
export { systemBlocks, catalogText, decisionMessage } from './prompts';
export { AgentScheduler, DecisionDetector, type SchedulerOptions } from './scheduler';
export { DecisionEngine } from './engine';
export { runAgentGame, aiBoardKey, type AgentRunConfig, type AgentRunReport } from './runner';
export { createProvider } from './factory';
export { listModels, testConnection, type ModelListing, type ConnectionDiagnostics } from './models';
export * from './relay';
export { connectBridge, originAllowed, makePairingCode, BRIDGE_PROTOCOL } from './bridge';
export { scriptedFallback, ScriptedProvider } from './providers/scripted';
export type { LLMProvider, DecisionContext, DecisionOutcome } from './providers/types';

/** Session 里控制器用到的部分（src/game/Session.ts 满足） */
export interface SessionLike {
  readonly world: IWorld;
  readonly paused: boolean;
  command(cmd: Command): { ok: boolean; reason?: string };
  togglePause(force?: boolean): void;
  on(fn: (ev: GameEvent) => void): () => void;
}

export type AgentStatus = 'idle' | 'loading' | 'running' | 'thinking' | 'paused' | 'stopped' | 'error';

export type AgentControllerEvent =
  | { type: 'status'; status: AgentStatus; detail?: string }
  | { type: 'decision'; record: DecisionRecord }
  | { type: 'usage'; usage: TokenUsage; costUsd: number }
  | { type: 'suggestion'; suggestion: Suggestion }
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
}

export interface AgentController {
  readonly status: AgentStatus;
  readonly usage: TokenUsage;
  readonly costUsd: number;
  readonly decisions: readonly DecisionRecord[];
  start(): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): void;
  /** 检查并（必要时）发起一次决策；pollMs = 0 时由 UI 每帧调用 */
  poll(): void;
  report(): AgentBrowserReport;
}

export interface AgentBrowserReport {
  agent: { provider: string; model: string; role: string };
  board: string;
  usage: TokenUsage;
  costUsd: number;
  decisions: DecisionRecord[];
  errors: string[];
  suggestions: Suggestion[];
  replay: AgentReplay;
  config: AgentModelConfig;
}

export function createAgentController(o: AgentControllerOptions): AgentController {
  const errs = validateConfig({ provider: 'claude-native', ...o.config });
  if (errs.length) throw new Error(`配置有误：${errs.join('；')}`);
  const config = resolveConfig({ ...o.config, decision: { ...o.config.decision, mode: o.mode ?? o.config.decision?.mode } });
  const session = o.session;
  const w = session.world;
  const detector = new DecisionDetector({ waveIntervalSec: config.decision?.waveIntervalSec ?? 10, minGapSec: 3 });
  const recent: GameEvent[] = [];
  const emit = (ev: AgentControllerEvent) => o.onEvent?.(ev);
  const ac = new AbortController();
  let status: AgentStatus = 'idle';
  let engine: DecisionEngine | null = null;
  let provider: LLMProvider | null = o.provider ?? null;
  let busy = false;
  let userPaused = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let unsub: (() => void) | null = null;

  const setStatus = (s: AgentStatus, detail?: string) => {
    status = s;
    emit({ type: 'status', status: s, detail });
  };

  const poll = () => {
    if (!engine || busy || userPaused || status === 'stopped' || status === 'error') return;
    const reasons = detector.check(w);
    if (!reasons) return;
    const point = detector.point(w, reasons);
    const pauseMode = (config.decision?.mode ?? 'pause') === 'pause';
    const wasPaused = session.paused;
    busy = true;
    if (pauseMode) session.togglePause(true);
    setStatus('thinking', reasons.join(','));
    const ev = recent.splice(0, recent.length);
    void engine.decide(point, ev).then((rec) => {
      detector.done(w);
      emit({ type: 'decision', record: rec });
    }).catch((e: unknown) => {
      emit({ type: 'error', message: e instanceof Error ? e.message : String(e) });
      detector.done(w);
    }).finally(() => {
      busy = false;
      if (status === 'stopped') return;
      if (pauseMode && !wasPaused && !userPaused) session.togglePause(false);
      setStatus(userPaused ? 'paused' : 'running');
    });
  };

  return {
    get status() { return status; },
    get usage() { return engine?.usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 }; },
    get costUsd() { return engine?.costUsd ?? 0; },
    get decisions() { return engine?.decisions ?? []; },
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
        world: w, opts: w.state.opts, config, provider,
        fallback: (o.fallback ?? scriptedFallback)(w),
        sink: (cmd) => session.command(cmd),
        signal: ac.signal,
        onSuggest: (s) => emit({ type: 'suggestion', suggestion: s }),
        onUsage: (u, c) => emit({ type: 'usage', usage: u, costUsd: c }),
      });
      unsub = session.on((ev) => {
        recent.push(ev);
        if (recent.length > 4000) recent.splice(0, 2000);
        detector.feed(ev, w);
      });
      const ms = o.pollMs ?? 100;
      if (ms > 0) timer = setInterval(poll, ms);
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
      ac.abort();
      if (timer) clearInterval(timer);
      unsub?.();
      provider?.dispose?.();
      setStatus('stopped');
    },
    poll,
    report() {
      const tag = provider ? agentTag(config) : { provider: 'none', model: 'none' };
      const role = config.role ?? 'player';
      return {
        agent: { ...tag, role },
        board: aiBoardKey(w.state.opts),
        usage: engine?.usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 },
        costUsd: engine?.costUsd ?? 0,
        decisions: engine?.decisions.slice() ?? [],
        errors: engine?.errors.slice() ?? [],
        suggestions: engine?.suggestions.slice() ?? [],
        replay: { ...makeMidRun(w), agent: { ...tag, role } },
        config: saveableConfig(config),
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
