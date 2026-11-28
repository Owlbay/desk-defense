import type { Command, GameEvent, IWorld, RunOptions } from '../core/types';

/**
 * 回放驱动与跳转（观看回放的进度条用）。
 *
 * 规则与 midrun.replayChunk 完全相同：在帧 t（state.tick === t）先执行所有 tick <= t 的指令，再 step()。
 * 往后跳：同一个 World 继续快进；往前跳：用同样的开局参数新建 World，从头快进到目标帧（没有存档快照，只能重算）。
 * 纯逻辑，不碰 DOM；分片快进（advanceAsync）只用 setTimeout 让出主线程。
 */

export interface ReplayEntry {
  tick: number;
  cmd: Command;
}

/** 一条可观看的回放：开局参数（含种子）+ 指令日志 + 结束帧 */
export interface ReplayRun {
  opts: RunOptions;
  log: readonly ReplayEntry[];
  /** 结束帧（成绩的 ticks / 本地对局结束时的帧号） */
  tick: number;
}

type DriverWorld = Pick<IWorld, 'step' | 'command' | 'drainEvents'> & {
  readonly state: { tick: number; phase: string };
};

export class ReplayDriver {
  /** 下一条要执行的指令下标 */
  next = 0;
  /** 播放时（不是快进时）每条指令执行前调用：界面据此显示与对局时相同的反馈 */
  onCommand: ((cmd: Command) => void) | null = null;
  private readonly rawStep: () => void;
  private quiet = false;

  constructor(
    readonly world: DriverWorld,
    readonly run: ReplayRun,
  ) {
    this.rawStep = world.step.bind(world);
  }

  get endTick(): number {
    return Math.max(0, this.run.tick);
  }

  get tick(): number {
    return this.world.state.tick;
  }

  /** 执行所有 tick <= 当前帧 的指令（单条失败不影响后面的） */
  feed(): void {
    const log = this.run.log;
    const t = this.world.state.tick;
    while (this.next < log.length && log[this.next].tick <= t) {
      const cmd = log[this.next].cmd;
      this.next++;
      if (!this.quiet) this.onCommand?.(cmd);
      try {
        this.world.command(cmd);
      } catch (e) {
        console.warn('[replay] command failed', e);
      }
    }
  }

  /** 当前帧还没执行的下一条指令（增益三选一停留展示用） */
  pending(): Command | null {
    const e = this.run.log[this.next];
    return e && e.tick <= this.world.state.tick ? e.cmd : null;
  }

  /** 逻辑不会再前进：到了结束帧、分出胜负，或停在增益选择而日志里没有当帧的选择（数据异常） */
  get atEnd(): boolean {
    const st = this.world.state;
    if (st.phase === 'won' || st.phase === 'lost') return true;
    if (st.tick >= this.endTick) return true;
    return st.phase === 'perk' && this.pending() === null;
  }

  /**
   * 换掉 world.step：Session 每推进一步之前先喂入该帧的指令；到结束帧后不再推进。
   * 返回还原函数。
   */
  install(): () => void {
    const w = this.world as { step: () => void };
    w.step = () => {
      this.feed();
      if (this.world.state.tick >= this.endTick) return;
      this.rawStep();
    };
    return () => {
      w.step = this.rawStep;
    };
  }

  /**
   * 快进到 target 帧（不超过结束帧），最多走 maxSteps 步；事件取走丢弃（或交给 sink）。
   * 返回 true 表示已到目标（或已到结束、无法再前进）。
   */
  advance(target: number, maxSteps: number, sink?: (evs: GameEvent[], tick: number) => void): boolean {
    const goal = Math.min(Math.max(0, Math.floor(target)), this.endTick);
    const w = this.world;
    this.quiet = true;
    let steps = 0;
    let done = false;
    try {
      for (;;) {
        this.feed();
        if (w.state.tick >= goal || this.atEnd) {
          done = true;
          break;
        }
        if (steps >= maxSteps) break;
        this.rawStep();
        steps++;
        if (sink) sink(w.drainEvents(), w.state.tick);
        else if ((steps & 255) === 0) w.drainEvents();
      }
    } finally {
      this.quiet = false;
    }
    const rest = w.drainEvents();
    if (sink && rest.length) sink(rest, w.state.tick);
    return done;
  }
}

/** 同步快进到 target（测试 / 短回放） */
export function advanceSync(d: ReplayDriver, target: number): void {
  while (!d.advance(target, 1e9)) {
    /* loop */
  }
}

export interface AdvanceTask {
  readonly promise: Promise<boolean>;
  /** 取消：promise 以 false 结束（已执行的步不回退） */
  cancel(): void;
}

/** 分片快进，不阻塞界面；onProgress 0..1。完成为 true，被取消为 false */
export function advanceAsync(
  d: ReplayDriver,
  target: number,
  onProgress?: (p: number) => void,
  o: { budgetMs?: number; sink?: (evs: GameEvent[], tick: number) => void } = {},
): AdvanceTask {
  const budget = o.budgetMs ?? 12;
  const from = d.tick;
  const goal = Math.min(Math.max(0, target), d.endTick);
  const span = Math.max(1, goal - from);
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settle: (v: boolean) => void = () => {};
  const promise = new Promise<boolean>((resolve, reject) => {
    settle = resolve;
    const run = (): void => {
      timer = null;
      if (cancelled) return;
      try {
        const t0 = performance.now();
        let done = false;
        while (!done && performance.now() - t0 < budget) done = d.advance(goal, 600, o.sink);
        onProgress?.(Math.min(1, Math.max(0, (d.tick - from) / span)));
        if (done) resolve(true);
        else timer = setTimeout(run, 0);
      } catch (e) {
        reject(e);
      }
    };
    run();
  });
  return {
    promise,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      settle(false);
    },
  };
}

/** 跳转方式：同一个 World 往后快进，或从头重建 */
export function seekPlan(current: number, target: number): 'none' | 'forward' | 'rebuild' {
  if (target === current) return 'none';
  return target > current ? 'forward' : 'rebuild';
}

/** 进度条上的波次刻度 */
export interface WaveMark {
  wave: number;
  tick: number;
  boss: boolean;
}

/** 从一批事件里取出开波刻度（tick 为这批事件所在的帧） */
export function collectWaveMarks(evs: readonly GameEvent[], tick: number, out: WaveMark[]): void {
  for (const ev of evs) {
    if (ev.type !== 'waveStart') continue;
    if (out.length && out[out.length - 1].wave >= ev.wave) continue;
    out.push({ wave: ev.wave, tick, boss: ev.tags.includes('boss') });
  }
}

/** 当前帧所在的波（刻度按 tick 升序）：没开过波为 0 */
export function waveAt(marks: readonly WaveMark[], tick: number): number {
  let w = 0;
  for (const m of marks) {
    if (m.tick > tick) break;
    w = m.wave;
  }
  return w;
}

/** 进度条上的时间：m:ss，超过一小时 h:mm:ss */
export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const pad = (n: number): string => String(n).padStart(2, '0');
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(s % 60)}` : `${mm}:${pad(s % 60)}`;
}

/** 键盘 / 按钮的「上一波 / 下一波」目标帧：没有更前 / 更后的刻度时返回 null */
export function waveSeekTarget(marks: readonly WaveMark[], tick: number, dir: -1 | 1): number | null {
  if (dir > 0) {
    for (const m of marks) if (m.tick > tick) return m.tick;
    return null;
  }
  // 往前：刚过某波开头不到 2 秒时跳到再前一波（与播放器的「上一首」习惯一致）
  const grace = 120;
  let best: number | null = null;
  for (const m of marks) {
    if (m.tick + grace < tick) best = m.tick;
    else break;
  }
  return best ?? (tick > 0 ? 0 : null);
}
