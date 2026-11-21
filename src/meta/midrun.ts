import type { Command, IWorld, RunOptions } from '../core/types';
import { cloneAssist, type AiAssist } from './aiAssist';
import type { MidRun } from './profile';

/**
 * 中途存档：保存「开局参数（含种子）+ 指令序列 + 帧号」，
 * 恢复时用同样的参数新建 World，逐帧推进并在对应帧重新下达指令（快进，不渲染）。
 */

/** 只需要 World 的这部分能力即可回放 */
export type ReplayWorld = Pick<IWorld, 'step' | 'command' | 'drainEvents'> & {
  readonly state: { tick: number; phase: string; wave: number; seed: string };
};

export function makeMidRun(world: Pick<IWorld, 'log'> & { state: { tick: number; seed: string; wave: number; opts: RunOptions } }, aiAssist?: AiAssist | null): MidRun {
  const opts: RunOptions = { ...world.state.opts, seed: world.state.opts.seed ?? world.state.seed };
  const assist = cloneAssist(aiAssist);
  return {
    v: 1,
    opts: JSON.parse(JSON.stringify(opts)) as RunOptions,
    tick: world.state.tick,
    log: world.log.map((e) => ({ tick: e.tick, cmd: JSON.parse(JSON.stringify(e.cmd)) as Command })),
    wave: world.state.wave,
    savedAt: Date.now(),
    // AI 助手的公平性标记随存档保存（读档后本局仍是「AI 协助」）
    ...(assist ? { aiAssist: assist } : {}),
  };
}

export interface ReplayCursor {
  run: MidRun;
  /** 下一条要执行的指令下标 */
  next: number;
  done: boolean;
}

export function replayCursor(run: MidRun): ReplayCursor {
  return { run, next: 0, done: false };
}

/**
 * 推进最多 maxSteps 个逻辑步，返回是否已完成。
 * 规则：在帧 t（state.tick === t）先执行所有 tick === t 的指令，再 step()。
 */
export function replayChunk(world: ReplayWorld, cur: ReplayCursor, maxSteps: number): boolean {
  const { run } = cur;
  const log = run.log;
  let steps = 0;
  while (!cur.done) {
    const t = world.state.tick;
    while (cur.next < log.length && log[cur.next].tick <= t) {
      world.command(log[cur.next].cmd);
      cur.next++;
    }
    const ph = world.state.phase;
    if (t >= run.tick || ph === 'won' || ph === 'lost') {
      cur.done = true;
      break;
    }
    if (ph === 'perk' && cur.next < log.length && log[cur.next].tick > t) {
      // 选择增益阶段逻辑不前进；日志里的下一条指令却在更晚的帧——数据异常，强制停止
      cur.done = true;
      break;
    }
    if (steps >= maxSteps) break;
    world.step();
    steps++;
    if ((steps & 255) === 0) world.drainEvents();
  }
  world.drainEvents();
  return cur.done;
}

/** 同步回放（测试 / 小存档） */
export function replaySync(world: ReplayWorld, run: MidRun): void {
  const cur = replayCursor(run);
  while (!replayChunk(world, cur, 1e9)) {
    /* loop */
  }
}

/** 分片回放，不阻塞界面；onProgress 0..1 */
export function replayAsync(world: ReplayWorld, run: MidRun, onProgress?: (p: number) => void, budgetMs = 12): Promise<void> {
  const cur = replayCursor(run);
  const total = Math.max(1, run.tick);
  return new Promise((resolve, reject) => {
    const tickFn = () => {
      try {
        const t0 = performance.now();
        let done = false;
        while (!done && performance.now() - t0 < budgetMs) done = replayChunk(world, cur, 600);
        onProgress?.(Math.min(1, world.state.tick / total));
        if (done) resolve();
        else setTimeout(tickFn, 0);
      } catch (e) {
        reject(e);
      }
    };
    tickFn();
  });
}
