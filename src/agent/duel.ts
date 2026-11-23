/**
 * AI 对战（双模型，文档 10 §2.3）—— 网页控制器：进攻方模型 + 防守方模型在同一个对局里。
 *
 * 与 createAgentController 同形（AgentController），HUD 不用区分；内部是两个 DecisionEngine 共用
 * 一个 DecisionDetector、一个轮询、一次暂停：
 *   - 每个决策点只暂停一次；建造阶段（下一波还能改写、这一波还没出过题）先让进攻方出题（overrideWave），
 *     再让防守方决策——防守方的推进保证会自动开波，所以进攻方必须排在前面；
 *   - 其余决策点只有防守方决策；
 *   - 两边都固定为暂停模式（实时模式下进攻方来不及在开波前出题）。
 * 决策事件带 side（attack / defend），状态事件也带 side，面板据此显示两行状态并给记录打标签。
 * 这种局不进玩家 / AI 玩家的三类榜（report().agent.role = 'duel'）：完整数据记本地（src/meta/duels.ts），
 * 成绩上传到独立的 AI 对战榜（/api/duels，只带模型名 + 思考档位）。report().duel 是双方各自的统计。
 */
import type { GameEvent } from '../core/types';
import { makeMidRun } from '../meta/midrun';
import { steadyInterval } from '../shared/bgclock';
import { boardForOpts } from '../shared/leaderboard';
import { type AgentModelConfig, agentTag, configErrorMessage, resolveConfig, saveableConfig, validateConfig } from './config';
import { type BudgetChoice, DecisionEngine } from './engine';
import { createProvider } from './factory';
import type { AgentController, AgentControllerEvent, AgentStatus, SessionLike } from './index';
import { scriptedFallback } from './providers/scripted';
import type { LLMProvider } from './providers/types';
import { DecisionDetector } from './scheduler';
import { AgentTrace } from './trace';
import { addUsage, type DecisionRecord, type DuelSide, emptyUsage, type FallbackPolicy } from './types';

export interface DuelSideOptions {
  config: Partial<AgentModelConfig>;
  /** 预先构造的适配器（本机桥接器 / 测试）；缺省按 config 动态加载 */
  provider?: LLMProvider;
}

export interface DuelControllerOptions {
  session: SessionLike;
  /** 进攻方（role 强制为 attacker） */
  attacker: DuelSideOptions;
  /** 防守方（role 强制为 player） */
  defender: DuelSideOptions;
  /** 防守方兜底（缺省：脚本策略） */
  fallback?: (w: SessionLike['world']) => FallbackPolicy;
  onEvent?: (ev: AgentControllerEvent) => void;
  /** 自动每 pollMs 检查决策点（默认 100；0 = 由 UI 调用 poll()） */
  pollMs?: number;
  trace?: AgentTrace;
}

const pauseCfg = (c: Partial<AgentModelConfig>, role: 'attacker' | 'player'): Partial<AgentModelConfig> => ({
  ...c,
  role,
  decision: { ...c.decision, mode: 'pause', ...(role === 'attacker' ? { waveIntervalSec: 0 } : {}) },
});

/** 一方的统计（report().duel） */
function sideStats(e: DecisionEngine | null) {
  return {
    decisions: e?.decisions.length ?? 0,
    fallback: e?.decisions.filter((d) => d.by === 'fallback').length ?? 0,
    usage: e?.usage ?? emptyUsage(),
    costUsd: e?.costUsd ?? 0,
    errors: e?.errors.slice() ?? [],
  };
}

export function createDuelController(o: DuelControllerOptions): AgentController {
  const acfgIn = pauseCfg(o.attacker.config, 'attacker');
  const dcfgIn = pauseCfg(o.defender.config, 'player');
  for (const c of [acfgIn, dcfgIn]) {
    const errs = validateConfig({ provider: 'claude-native', ...c });
    if (errs.length) throw new Error(configErrorMessage(errs));
  }
  const acfg = resolveConfig(acfgIn);
  const dcfg = resolveConfig(dcfgIn);
  const session = o.session;
  const w = session.world;
  const detector = new DecisionDetector({ waveIntervalSec: dcfg.decision?.waveIntervalSec ?? 15, minGapSec: 3 });
  const recent: GameEvent[] = [];
  const emit = (ev: AgentControllerEvent): void => o.onEvent?.(ev);
  const ac = new AbortController();
  const trace = o.trace ?? new AgentTrace();
  trace.addSecret(acfg.apiKey);
  trace.addSecret(dcfg.apiKey);
  let status: AgentStatus = 'idle';
  let att: DecisionEngine | null = null;
  let def: DecisionEngine | null = null;
  let aProv: LLMProvider | null = o.attacker.provider ?? null;
  let dProv: LLMProvider | null = o.defender.provider ?? null;
  let busy = false;
  let userPaused = false;
  let stopTimer: (() => void) | null = null;
  let unsub: (() => void) | null = null;
  let budgetResolve: ((c: BudgetChoice) => void) | null = null;
  /** 已为哪一波出过题（每波只问一次） */
  let attackPlanned = -1;
  const all: DecisionRecord[] = [];

  const stopped = (): boolean => status === 'stopped';
  const setStatus = (s: AgentStatus, detail?: string, side?: DuelSide): void => {
    status = s;
    emit({ type: 'status', status: s, detail, ...(side ? { side } : {}) });
  };
  const usageNow = () => addUsage(att?.usage ?? emptyUsage(), def?.usage ?? emptyUsage());
  const costNow = (): number => (att?.costUsd ?? 0) + (def?.costUsd ?? 0);
  const onUsage = (): void => emit({ type: 'usage', usage: usageNow(), costUsd: costNow() });

  const decideSide = async (eng: DecisionEngine, side: DuelSide, point: ReturnType<DecisionDetector['point']>, ev: GameEvent[]) => {
    setStatus('thinking', point.reasons.join(','), side);
    const rec = await eng.decide({ ...point, reasons: point.reasons.slice() }, ev);
    rec.side = side;
    all.push(rec);
    emit({ type: 'decision', record: rec });
    return rec;
  };

  /** 下一波可以改写、还没改写、也还没问过进攻方 */
  const attackDue = (): boolean => {
    const i = w.attackContext?.();
    return !!i && i.open && !i.current && attackPlanned !== i.wave;
  };
  const planNow = async (eng: DecisionEngine, point: ReturnType<DecisionDetector['point']>): Promise<void> => {
    const i = w.attackContext?.();
    if (i) attackPlanned = i.wave;
    await decideSide(eng, 'attack', point, []);
  };

  const poll = (): void => {
    if (!att || !def || busy || userPaused || status === 'stopped' || status === 'error') return;
    const reasons = detector.check(w);
    // 下一波一开始就出题（战斗中也行），自动开波 / 选完增益马上开波都不会漏
    const attackNow = attackDue();
    if (!reasons && !attackNow) return;
    const point = detector.point(w, reasons ?? []);
    const wasPaused = session.paused;
    busy = true;
    session.togglePause(true);
    const ev = reasons ? recent.splice(0, recent.length) : [];
    const a = att;
    const d = def;
    void (async () => {
      try {
        // 进攻方先出题：防守方的推进保证会开波，顺序不能反
        if (attackNow) await planNow(a, point);
        if (stopped()) return;
        if (reasons) await decideSide(d, 'defend', point, ev);
        // 防守方刚选完增益、回到建造阶段：下一波还没出题（开波被 holdWaveStart 挡住）→ 进攻方现在出题
        if (!stopped() && attackDue()) await planNow(a, detector.point(w, ['build']));
      } catch (e) {
        emit({ type: 'error', message: e instanceof Error ? e.message : String(e) });
      } finally {
        if (reasons) detector.done(w);
        busy = false;
        if (!stopped()) {
          if (!wasPaused && !userPaused) session.togglePause(false);
          setStatus(userPaused ? 'paused' : 'running');
        }
      }
    })();
  };

  const engineFor = (cfg: AgentModelConfig, provider: LLMProvider, defender = false): DecisionEngine =>
    new DecisionEngine({
      world: w,
      opts: w.state.opts,
      config: cfg,
      provider,
      fallback: (o.fallback ?? scriptedFallback)(w),
      sink: (cmd) => session.command(cmd),
      signal: ac.signal,
      onUsage,
      onBudget: (b) => emit({ type: 'budget', budget: b }),
      onBudgetExceeded: (b) =>
        new Promise<BudgetChoice>((resolve) => {
          session.togglePause(true);
          budgetResolve = (c) => {
            budgetResolve = null;
            resolve(c);
          };
          setStatus('paused', 'budget');
          emit({ type: 'budget_ask', budget: b });
        }),
      trace,
      ...(defender ? { holdWaveStart: attackDue, onDoctrine: (d) => emit({ type: 'doctrine', doctrine: d }) } : {}),
    });

  return {
    get status() {
      return status;
    },
    get usage() {
      return usageNow();
    },
    get costUsd() {
      return costNow();
    },
    get decisions() {
      return all;
    },
    trace,
    async start() {
      if (att) return;
      setStatus('loading');
      try {
        [aProv, dProv] = await Promise.all([aProv ?? createProvider(acfg), dProv ?? createProvider(dcfg)]);
      } catch (e) {
        setStatus('error', e instanceof Error ? e.message : String(e));
        return;
      }
      if (status === 'stopped') return;
      att = engineFor(acfg, aProv);
      def = engineFor(dcfg, dProv, true);
      unsub = session.on((ev) => {
        att?.onWorldEvent(ev);
        def?.onWorldEvent(ev);
        recent.push(ev);
        if (recent.length > 4000) recent.splice(0, 2000);
        detector.feed(ev, w);
      });
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
      unsub?.();
      aProv?.dispose?.();
      if (dProv !== aProv) dProv?.dispose?.();
      setStatus('stopped');
    },
    poll,
    doctrine: () => def?.doctrine ?? null,
    setDoctrine: (input) => def?.setDoctrine(input, 'player') ?? { ok: false, text: 'doctrine: not available' },
    budget: () => def?.budgetState() ?? null,
    get budgetPending() {
      return budgetResolve !== null;
    },
    resolveBudget(choice: BudgetChoice) {
      const r = budgetResolve;
      if (!r) return;
      setStatus('thinking', choice);
      r(choice);
    },
    report() {
      const dtag = dProv ? agentTag(dcfg) : { provider: 'none', model: 'none' };
      const atag = aProv ? agentTag(acfg) : { provider: 'none', model: 'none' };
      return {
        // 防守方是「玩家」；role = duel：不进三类榜，上传到独立的 AI 对战榜
        agent: { ...dtag, role: 'duel' },
        attacker: atag,
        duel: {
          attack: { ...atag, ...sideStats(att) },
          defend: { ...dtag, ...sideStats(def) },
        },
        board: boardForOpts(w.state.opts),
        usage: usageNow(),
        costUsd: costNow(),
        decisions: all.slice(),
        errors: [...(att?.errors ?? []).map((e) => `[攻] ${e}`), ...(def?.errors ?? []).map((e) => `[守] ${e}`)],
        suggestions: [],
        replay: { ...makeMidRun(w), agent: { ...dtag, role: 'player' }, attacker: atag },
        config: saveableConfig(dcfg),
        trace: trace.export({ maxChars: 1_500_000 }),
      };
    },
  };
}
