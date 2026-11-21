import { describe, expect, it } from 'vitest';
import type { Command, RunOptions } from '../../src/core/types';
import { dailyInfo, dailyRunOptions } from '../../src/shared/leaderboard';
import {
  boardOfRun,
  dailyDayOfOpts,
  fmtCountdown,
  isEligibleRun,
  makeFeeder,
  msUntilNextDay,
  nicknameError,
} from '../../src/ui/online/util';

const base: RunOptions = { mode: 'endless', map: 'ch1', difficulty: 'normal', skills: [], seed: 'ABC123', autoWave: true };

describe('online ui helpers', () => {
  it('detects daily runs by seed + map + difficulty', () => {
    const info = dailyInfo('2026-11-20');
    const opts = dailyRunOptions(info, ['bell']);
    expect(dailyDayOfOpts(opts)).toBe('2026-11-20');
    expect(boardOfRun(opts)).toBe('daily:2026-11-20');
    expect(dailyDayOfOpts({ ...opts, map: info.map === 'ch1' ? 'ch2' : 'ch1' })).toBeNull();
    expect(dailyDayOfOpts({ ...opts, pure: false })).toBeNull();
    expect(dailyDayOfOpts(base)).toBeNull();
    expect(boardOfRun(base)).toBe('normal:auto');
  });

  it('eligibility: endless only, no custom / events / fixed layout', () => {
    expect(isEligibleRun(base)).toBe(true);
    expect(isEligibleRun({ ...base, mode: 'campaign' })).toBe(false);
    expect(isEligibleRun({ ...base, mode: 'custom' })).toBe(false);
    expect(isEligibleRun({ ...base, custom: { lives: 5 } })).toBe(false);
    expect(isEligibleRun({ ...base, seed: undefined })).toBe(false);
  });

  it('countdown to next UTC+8 midnight', () => {
    // 2026-11-20 15:00 UTC = 23:00 北京时间 → 还剩 1 小时
    expect(msUntilNextDay(Date.UTC(2026, 10, 20, 15, 0, 0))).toBe(3600_000);
    // 16:00 UTC = 北京零点整 → 整整一天
    expect(msUntilNextDay(Date.UTC(2026, 10, 20, 16, 0, 0))).toBe(86_400_000);
    expect(fmtCountdown(3_723_000)).toBe('01:02:03');
    expect(fmtCountdown(-5)).toBe('00:00:00');
  });

  it('nickname validation', () => {
    expect(nicknameError('')).not.toBeNull();
    expect(nicknameError('小明')).toBeNull();
    expect(nicknameError('一二三四五六七八九十一二三')).not.toBeNull();
  });

  it('feeder issues commands at their ticks', () => {
    const issued: number[] = [];
    const world = { state: { tick: 0 }, command: (c: Command) => issued.push((c as { uid: number }).uid) };
    const log = [
      { tick: 0, cmd: { type: 'sell', uid: 1 } as Command },
      { tick: 2, cmd: { type: 'sell', uid: 2 } as Command },
      { tick: 2, cmd: { type: 'sell', uid: 3 } as Command },
    ];
    const f = makeFeeder(world, log);
    f.feed();
    expect(issued).toEqual([1]);
    world.state.tick = 1;
    f.feed();
    expect(issued).toEqual([1]);
    world.state.tick = 2;
    f.feed();
    expect(issued).toEqual([1, 2, 3]);
    expect(f.done).toBe(true);
  });
});
