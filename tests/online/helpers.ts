import { createWorld, type IWorld, type RunOptions } from '../../src/core';
import type { ClaimedResult, LogEntry } from '../../src/shared/leaderboard';

export interface PlayedRun {
  opts: RunOptions;
  log: LogEntry[];
  result: ClaimedResult;
  /** core 内部量（用于精确得分校验） */
  cleared: number;
  bonus: number;
  world: IWorld;
}

/**
 * 真跑一局：不造塔，只开波，直到失败（或到 maxTicks）。
 * 得到的是 core 真实产出的日志与结算，用于端到端校验。
 */
export function playRun(opts: RunOptions, maxTicks = 60 * 60 * 30): PlayedRun {
  const w = createWorld(opts);
  w.command({ type: 'startWave' });
  let n = 0;
  while (w.state.phase !== 'lost' && n < maxTicks) {
    if (w.state.phase === 'perk') {
      w.command({ type: 'choosePerk', id: w.state.perkChoices![0].id });
      continue;
    }
    if (w.state.phase === 'build' && !(opts.autoWave ?? opts.difficulty !== 'easy')) w.command({ type: 'startWave' });
    w.step();
    if ((++n & 255) === 0) w.drainEvents();
  }
  const st = w.state;
  const internal = w as unknown as { lastCleared: number; bonusScore: number };
  const wavesSurvived = st.phase === 'lost' ? Math.max(0, st.wave - 1) : st.wave;
  return {
    opts: { ...st.opts, seed: st.seed },
    log: w.log.map((e) => ({ tick: e.tick, cmd: e.cmd })),
    result: { wave: wavesSurvived, score: st.score, kills: st.stats.kills, lives: st.lives, gold: st.gold, won: false, ticks: st.tick },
    cleared: internal.lastCleared,
    bonus: internal.bonusScore,
    world: w,
  };
}
