import { createWorld } from '../core';
import { DT, type Command, type CommandResult, type GameEvent, type IWorld, type RunOptions } from '../core/types';

export type Speed = 1 | 2 | 3;
type Listener = (ev: GameEvent) => void;

/**
 * 一局游戏的运行控制：固定步长推进、加速、暂停、事件分发。
 * 由渲染层每帧调用 update(dtMs)。UI 与渲染层都通过 on() 订阅事件。
 */
export class Session {
  readonly world: IWorld;
  speed: Speed = 1;
  paused = false;
  /** 被系统（切后台、菜单）暂停，与玩家手动暂停区分 */
  autoPaused = false;
  private acc = 0;
  private listeners = new Set<Listener>();
  private changeListeners = new Set<() => void>();
  private ended = false;

  constructor(readonly opts: RunOptions) {
    this.world = createWorld(opts);
  }

  get running(): boolean {
    return !this.paused && !this.autoPaused && !this.ended;
  }

  update(dtMs: number): void {
    if (!this.running) {
      this.flush();
      return;
    }
    const phase = this.world.state.phase;
    // 选择增益时逻辑暂停，等待玩家选择
    if (phase === 'perk' || phase === 'won' || phase === 'lost') {
      this.flush();
      return;
    }
    // 防止切回前台时一次补跑太多
    this.acc += Math.min(dtMs / 1000, 0.25) * this.speed;
    let steps = 0;
    while (this.acc >= DT && steps < 30) {
      this.world.step();
      this.acc -= DT;
      steps++;
      const p = this.world.state.phase;
      if (p === 'perk' || p === 'won' || p === 'lost') {
        this.acc = 0;
        break;
      }
    }
    this.flush();
  }

  /** 插值系数（渲染可选用） */
  get alpha(): number {
    return this.acc / DT;
  }

  command(cmd: Command): CommandResult {
    const r = this.world.command(cmd);
    this.flush();
    this.emitChange();
    return r;
  }

  setSpeed(s: Speed): void {
    this.speed = s;
    this.emitChange();
  }

  togglePause(force?: boolean): void {
    this.paused = force ?? !this.paused;
    this.emitChange();
  }

  setAutoPaused(v: boolean): void {
    this.autoPaused = v;
    this.emitChange();
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 非事件型的变化（速度、暂停等）通知 */
  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  dispose(): void {
    this.ended = true;
    this.listeners.clear();
    this.changeListeners.clear();
  }

  private emitChange(): void {
    for (const fn of this.changeListeners) fn();
  }

  private flush(): void {
    const evs = this.world.drainEvents();
    if (evs.length === 0) return;
    for (const ev of evs) {
      for (const fn of this.listeners) fn(ev);
    }
  }
}
