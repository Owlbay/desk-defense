/**
 * 决策节奏（文档 10 §4）。
 *
 * DecisionDetector：只看事件 + 状态，判断"现在是不是决策点"。不推进世界——
 *   浏览器里由 Session 按真实时间推进，控制器每帧调用 feed/check；
 * AgentScheduler：无头驱动（CLI / MCP / 测试）。自己调用 world.step()，在决策点停下：
 *   - pause 模式：停下后世界冻结，直到 Agent 完成本次决策（end_turn / 用完工具调用 / 超时）；
 *   - realtime 模式：停下只是"通知 Agent"，Agent 每发一次模型请求，世界就按（固定或实测的）延迟前进 elapse(秒)，
 *     之后到达的指令落在更晚的帧上（world.log 自带帧号，回放与真人一致）。
 *
 * 决策点：
 *   game_start  开局第一帧
 *   build       建造阶段（手动开波：每次等待开波时；自动开波：每波结束时）
 *   wave_interval 波次进行中每 N 秒（默认 10 秒）
 *   event_warn / drop_warn  随机事件预警（含无预警但相关的怪物类事件开始）/ 空降出生点预警
 *   boss_spawn  Boss 出场
 *   perk        增益三选一（世界已自动暂停）
 *   crate       补给箱打开待选
 *   leak        只作为附加原因
 * 事件型原因在距上次决策不足 minGapSec 时先挂起，到时间再合并触发（避免一波里频繁打断）。
 */
import type { GameEvent, IWorld } from '../core/types';
import type { DecisionMode, DecisionPoint, DecisionReason } from './types';
import { eventNeedsDecision } from './gating';

export interface SchedulerOptions {
  mode?: DecisionMode;
  /** 波次进行中每隔多少秒决策一次（默认 10；0 = 关闭） */
  waveIntervalSec?: number;
  /** 事件型决策的最小间隔（秒，默认 3） */
  minGapSec?: number;
  /** 自动捡硬币 / 补给箱（默认 true；真人点一下就行，不值得每次唤醒模型） */
  autoCollect?: boolean;
  /** 打到第几波（该波结束）就停（无尽模式封顶） */
  maxWaves?: number;
  /** 游戏时间上限（秒，默认 3 小时） */
  maxGameSeconds?: number;
}

export type SchedulerStop = 'won' | 'lost' | 'cap' | 'timeout' | null;

/** 纯判定：喂事件、查状态 → 决策原因 */
export class DecisionDetector {
  private pending = new Set<DecisionReason>();
  private lastTime = -Infinity;
  private started = false;
  private crateSeen = -1;
  seq = 0;

  constructor(private readonly o: Required<Pick<SchedulerOptions, 'waveIntervalSec' | 'minGapSec'>>) {}

  feed(ev: GameEvent, w: IWorld): void {
    const auto = w.state.autoWave.enabled && w.state.autoWave.started;
    switch (ev.type) {
      case 'waveEnd': if (auto) this.pending.add('build'); break;
      case 'randomEvent':
        // 预警；或没有预警、直接开始且与当前局面相关的怪物类事件（gating.eventNeedsDecision）
        if (ev.phase === 'warn' || (ev.phase === 'start' && eventNeedsDecision(ev.id, w))) this.pending.add('event_warn');
        break;
      case 'spawnerDrop': if (ev.phase === 'warn') this.pending.add('drop_warn'); break;
      case 'spawn': if (ev.boss) this.pending.add('boss_spawn'); break;
      case 'leak': this.pending.add('leak'); break;
    }
  }

  /** 现在是否需要决策；返回原因列表（不含仅 leak 的情况） */
  check(w: IWorld): DecisionReason[] | null {
    const s = w.state;
    if (s.phase === 'won' || s.phase === 'lost') return null;
    const r = new Set<DecisionReason>();
    if (!this.started) { r.add('game_start'); r.add('build'); }
    if (s.phase === 'perk') r.add('perk');
    if (s.crateChoice && s.crateChoice.uid !== this.crateSeen) r.add('crate');
    const manualWait = s.phase === 'build' && !(s.autoWave.enabled && s.autoWave.started);
    if (manualWait) r.add('build');
    const gap = s.time - this.lastTime;
    if (gap >= this.o.minGapSec) {
      for (const p of this.pending) r.add(p);
      if (s.phase === 'wave' && this.o.waveIntervalSec > 0 && gap >= this.o.waveIntervalSec) r.add('wave_interval');
    }
    if (r.size === 0 || (r.size === 1 && r.has('leak'))) return null;
    if (this.pending.has('leak')) r.add('leak');
    return [...r];
  }

  point(w: IWorld, reasons: DecisionReason[]): DecisionPoint {
    const s = w.state;
    return { seq: ++this.seq, tick: s.tick, time: s.time, wave: s.wave, phase: s.phase, reasons };
  }

  /** 决策完成：清掉挂起原因、记下时间 */
  done(w: IWorld): void {
    this.started = true;
    this.pending.clear();
    this.lastTime = w.state.time;
    if (w.state.crateChoice) this.crateSeen = w.state.crateChoice.uid;
  }
}

/** 无头驱动 */
export class AgentScheduler {
  readonly detector: DecisionDetector;
  readonly opts: Required<SchedulerOptions>;
  /** 自上次 takeRecent() 以来的事件（观测里的 recent 摘要用） */
  private recent: GameEvent[] = [];
  private stop: SchedulerStop = null;
  private maxWaveEnded = false;
  /** 事件监听（runner 用来驱动兜底机器人的 onWaveStart 等钩子、统计每波数据） */
  onEvent?: (ev: GameEvent) => void;

  constructor(readonly world: IWorld, o: SchedulerOptions = {}) {
    this.opts = {
      mode: o.mode ?? 'pause',
      waveIntervalSec: o.waveIntervalSec ?? 10,
      minGapSec: o.minGapSec ?? 3,
      autoCollect: o.autoCollect ?? true,
      maxWaves: o.maxWaves ?? 0,
      maxGameSeconds: o.maxGameSeconds ?? 3 * 3600,
    };
    this.detector = new DecisionDetector(this.opts);
  }

  get stopped(): SchedulerStop {
    const s = this.world.state;
    if (s.phase === 'won' || s.phase === 'lost') return s.phase;
    return this.stop;
  }

  takeRecent(): GameEvent[] {
    const r = this.recent;
    this.recent = [];
    return r;
  }

  /** 推进一步（处理自动拾取、事件分发、封顶判断）。返回 false = 不能再推进 */
  private stepOnce(): boolean {
    const w = this.world;
    const s = w.state;
    if (this.stopped) return false;
    if (s.phase === 'perk') return false;
    if (this.opts.autoCollect && s.pickups.length) {
      for (const p of s.pickups.slice()) {
        if (p.kind === 'crate' && s.crateChoice) continue;
        w.command({ type: 'collect', uid: p.uid });
      }
    }
    w.step();
    this.drain();
    if (this.opts.maxWaves > 0 && this.maxWaveEnded) this.stop = 'cap';
    if (s.time >= this.opts.maxGameSeconds) this.stop = 'timeout';
    return true;
  }

  /** 取走世界事件，分发给探测器 / 监听者 */
  drain(): void {
    const w = this.world;
    for (const ev of w.drainEvents()) {
      this.recent.push(ev);
      if (this.recent.length > 4000) this.recent.splice(0, 2000);
      this.detector.feed(ev, w);
      if (ev.type === 'waveEnd' && this.opts.maxWaves > 0 && ev.wave >= this.opts.maxWaves) this.maxWaveEnded = true;
      this.onEvent?.(ev);
    }
    if (this.opts.maxWaves > 0 && this.maxWaveEnded) this.stop = 'cap';
  }

  /**
   * 推进到下一个决策点。返回 null = 本局结束 / 封顶 / 超时 / 达到 maxTicks。
   * pause 与 realtime 共用；区别只在 Agent 思考期间是否调用 elapse()。
   */
  advance(maxTicks = Infinity): DecisionPoint | null {
    const w = this.world;
    let n = 0;
    for (;;) {
      this.drain();
      if (this.stopped) return null;
      const reasons = this.detector.check(w);
      if (reasons) return this.detector.point(w, reasons);
      if (n >= maxTicks) return null;
      if (!this.stepOnce()) return null;
      n++;
    }
  }

  /** realtime：Agent 思考期间世界照常前进（不触发新的决策点，原因会挂起到下次）。返回 false = 本局已结束 */
  elapse(seconds: number): boolean {
    const ticks = Math.max(0, Math.round(seconds * 60));
    for (let i = 0; i < ticks; i++) if (!this.stepOnce()) break;
    return !this.stopped;
  }

  /** 推进固定秒数（MCP advance 的 seconds 参数），不在决策点停 */
  run(seconds: number): void {
    this.elapse(seconds);
  }

  markDecided(): void {
    this.drain();
    this.detector.done(this.world);
  }
}
