/**
 * 回放进度条的跳转逻辑（src/meta/replay.ts）：往后快进 / 从头重建都要和直接回放到同一帧得到相同的 stateHash。
 */
import { describe, expect, it } from 'vitest';

import { type Command, createWorld, type IWorld, type RunOptions, stateHash } from '../../src/core';
import { Session } from '../../src/game/Session';
import { replaySync } from '../../src/meta/midrun';
import {
  advanceAsync,
  advanceSync,
  collectWaveMarks,
  fmtClock,
  ReplayDriver,
  type ReplayRun,
  seekPlan,
  waveAt,
  type WaveMark,
  waveSeekTarget,
} from '../../src/meta/replay';

const OPTS: RunOptions = {
  mode: 'endless',
  map: 'ch1',
  difficulty: 'normal',
  seed: 'replay-seek',
  skills: ['eraser_strike', 'bell', 'whiteout_zone'],
};

/** 真跑一局：每个布防阶段试着造 / 升几座塔，拾取掉落、选补给、选增益，直到失败或 maxTicks */
function playGame(maxTicks: number): { run: ReplayRun; world: IWorld } {
  const w = createWorld(OPTS);
  let n = 0;
  let lastBuild = -1;
  while (w.state.phase !== 'lost' && w.state.phase !== 'won' && n < maxTicks) {
    const st = w.state;
    if (st.phase === 'perk') {
      w.command({ type: 'choosePerk', id: st.perkChoices![0].id });
      continue;
    }
    if (st.crateChoice) w.command({ type: 'chooseCrate', option: st.crateChoice.options[0].id });
    for (const pk of [...st.pickups]) w.command({ type: 'collect', uid: pk.uid });
    if (st.phase === 'build' && lastBuild !== st.wave) {
      lastBuild = st.wave;
      let placed = 0;
      for (let cy = 2; cy < st.grid.rows - 2 && placed < 3; cy += 2) {
        for (let cx = 3; cx < st.grid.cols - 3 && placed < 3; cx += 3) {
          if (w.command({ type: 'place', tower: 'pencil', cx, cy }).ok) placed++;
        }
      }
      for (const t of st.towers.values()) w.command({ type: 'upgrade', uid: t.uid } as Command);
      w.command({ type: 'startWave' });
    }
    w.step();
    if ((++n & 255) === 0) w.drainEvents();
  }
  w.drainEvents();
  return {
    run: { opts: { ...w.state.opts, seed: w.state.seed }, log: w.log.map((e) => ({ tick: e.tick, cmd: e.cmd })), tick: w.state.tick },
    world: w,
  };
}

const game = playGame(60 * 60 * 6);
const run = game.run;

/** 基准：midrun.replaySync 直接回放到 tick */
function straight(tick: number): string {
  const w = createWorld(run.opts);
  replaySync(w, { v: 1, opts: run.opts, log: run.log.slice(), tick, wave: 0, savedAt: 0 });
  return stateHash(w);
}

function fresh(): ReplayDriver {
  return new ReplayDriver(createWorld(run.opts), run);
}

describe('回放跳转', () => {
  it('测试局足够长、指令够多', () => {
    expect(run.tick).toBeGreaterThan(3000);
    expect(run.log.length).toBeGreaterThan(10);
    expect(game.world.state.wave).toBeGreaterThan(2);
  });

  it('快进到结束帧与原局一致', () => {
    const d = fresh();
    advanceSync(d, run.tick);
    expect(d.atEnd).toBe(true);
    expect(stateHash(d.world as IWorld)).toBe(stateHash(game.world));
  });

  it('往后跳（同一个 World 分段快进）与直接回放到该帧一致', () => {
    const d = fresh();
    const marks = [Math.floor(run.tick * 0.2), Math.floor(run.tick * 0.45), Math.floor(run.tick * 0.8)];
    for (const t of marks) {
      expect(seekPlan(d.tick, t)).toBe('forward');
      advanceSync(d, t);
      expect(d.tick).toBe(t);
      expect(stateHash(d.world as IWorld)).toBe(straight(t));
    }
  });

  it('往前跳（从头重建再快进）与直接回放到该帧一致', () => {
    let d = fresh();
    advanceSync(d, Math.floor(run.tick * 0.9));
    const back = Math.floor(run.tick * 0.3);
    expect(seekPlan(d.tick, back)).toBe('rebuild');
    d = fresh();
    advanceSync(d, back);
    expect(stateHash(d.world as IWorld)).toBe(straight(back));
    // 再往后跳回去：和一路播放到那里相同
    advanceSync(d, Math.floor(run.tick * 0.9));
    expect(stateHash(d.world as IWorld)).toBe(straight(Math.floor(run.tick * 0.9)));
  });

  it('install 后按 Session 的方式逐步推进，与快进结果相同；到结束帧后不再前进', () => {
    const d = fresh();
    const restore = d.install();
    const w = d.world;
    const target = Math.floor(run.tick * 0.6);
    let guard = 0;
    while (w.state.tick < target && guard++ < run.tick * 2) {
      // Session.update：选择增益时逻辑不前进，由外面的循环补喂
      if (w.state.phase === 'perk') d.feed();
      else w.step();
    }
    d.feed();
    expect(stateHash(w as IWorld)).toBe(straight(target));
    // 一直推到结束帧之后：tick 停在结束帧
    while (!d.atEnd && guard++ < run.tick * 4) {
      if (w.state.phase === 'perk') d.feed();
      else w.step();
    }
    for (let i = 0; i < 50; i++) w.step();
    expect(w.state.tick).toBeLessThanOrEqual(run.tick);
    restore();
  });

  it('快进时不触发 onCommand，播放时触发', () => {
    const d = fresh();
    const seen: Command[] = [];
    d.onCommand = (c) => seen.push(c);
    advanceSync(d, Math.floor(run.tick / 2));
    expect(seen).toHaveLength(0);
    d.install();
    const before = d.next;
    while (d.next === before && !d.atEnd) {
      if (d.world.state.phase === 'perk') d.feed();
      else d.world.step();
    }
    expect(seen.length).toBe(d.next - before);
  });

  it('分片快进：与同步结果一致，可取消', async () => {
    const d = fresh();
    const ps: number[] = [];
    const ok = await advanceAsync(d, Math.floor(run.tick * 0.7), (p) => ps.push(p), { budgetMs: 1 }).promise;
    expect(ok).toBe(true);
    expect(ps[ps.length - 1]).toBe(1);
    expect(stateHash(d.world as IWorld)).toBe(straight(Math.floor(run.tick * 0.7)));

    const d2 = fresh();
    const task = advanceAsync(d2, run.tick, undefined, { budgetMs: 0 });
    task.cancel();
    expect(await task.promise).toBe(false);
    expect(d2.tick).toBeLessThan(run.tick);
  });

  it('扫描得到每一波的开波帧，Boss 波单独标出', () => {
    const d = fresh();
    const marks: WaveMark[] = [];
    while (!d.advance(run.tick, 5000, (evs, tick) => collectWaveMarks(evs, tick, marks))) {
      /* loop */
    }
    expect(marks.length).toBe(game.world.state.wave);
    expect(marks.map((m) => m.wave)).toEqual(marks.map((_, i) => i + 1));
    // 刻度帧处于该波：从头快进到刻度帧，当前波次就是它
    const m = marks[1];
    const d2 = fresh();
    advanceSync(d2, m.tick);
    expect((d2.world as IWorld).state.wave).toBe(m.wave);
    expect(waveAt(marks, m.tick)).toBe(m.wave);
    expect(waveAt(marks, m.tick - 1)).toBe(m.wave - 1);
  });

  it('上一波 / 下一波的目标帧', () => {
    const marks: WaveMark[] = [
      { wave: 1, tick: 100, boss: false },
      { wave: 2, tick: 1000, boss: false },
      { wave: 3, tick: 2000, boss: true },
    ];
    expect(waveSeekTarget(marks, 0, 1)).toBe(100);
    expect(waveSeekTarget(marks, 1500, 1)).toBe(2000);
    expect(waveSeekTarget(marks, 2500, 1)).toBeNull();
    expect(waveSeekTarget(marks, 1500, -1)).toBe(1000);
    // 刚过第 2 波开头：跳到第 1 波
    expect(waveSeekTarget(marks, 1050, -1)).toBe(100);
    expect(waveSeekTarget(marks, 50, -1)).toBe(0);
    expect(waveSeekTarget(marks, 0, -1)).toBeNull();
  });
});

describe('回放播放（Session 驱动）', () => {
  it('只读 Session 拒绝界面指令，回放日志照常执行，结果与原局一致', () => {
    const s = new Session(run.opts);
    s.readOnly = true;
    const d = new ReplayDriver(s.world, run);
    d.install();
    // 界面 / 棋盘发出的指令：一律拒绝，不进日志
    const r = s.command({ type: 'startWave' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('replayReadOnly');
    expect(s.world.log).toHaveLength(0);
    s.setSpeed(3);
    let guard = 0;
    while (!d.atEnd && guard++ < run.tick) {
      // 增益选择阶段 Session 不推进：由播放器补喂（这里不停留）
      if (s.world.state.phase === 'perk') d.feed();
      s.update(250);
    }
    expect(s.world.state.tick).toBe(run.tick);
    expect(stateHash(s.world)).toBe(stateHash(game.world));
    expect(s.world.log.length).toBe(run.log.length);
    s.dispose();
  });

  it('时间格式', () => {
    expect(fmtClock(0)).toBe('0:00');
    expect(fmtClock(65.9)).toBe('1:05');
    expect(fmtClock(3600 + 62)).toBe('1:01:02');
  });
});
