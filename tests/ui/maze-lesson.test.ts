import { describe, expect, it } from 'vitest';

import { planMaze } from '../../src/agent/maze';
import { createWorld, type RunOptions } from '../../src/core';
import { CellKind } from '../../src/core/types';
import {
  builtSegments,
  firstStep,
  ghostSegment,
  lessonStep,
  MAZE_STEPS,
  type MazeStep,
  remainingCells,
} from '../../src/ui/hud/maze-lesson';

const none = () => false;

describe('摆迷宫教学：步骤推进（纯逻辑）', () => {
  it('从第一个没看过的步骤开始；都看过了返回 null', () => {
    expect(firstStep(none)).toBe('ch1-maze-row');
    expect(firstStep((s) => s === 'ch1-maze-row')).toBe('ch1-maze-snake');
    expect(firstStep(() => true)).toBeNull();
    // 已经建好两排：直接讲走廊之间放塔
    expect(firstStep(none, 2)).toBe('ch1-maze-lanes');
  });

  it('建好第 1 排 → 第 2 排 → 走廊放塔；没建好时停在原地', () => {
    expect(lessonStep('ch1-maze-row', { type: 'progress', built: 0 })).toEqual({ step: 'ch1-maze-row', seen: [] });
    expect(lessonStep('ch1-maze-row', { type: 'progress', built: 1 })).toEqual({ step: 'ch1-maze-snake', seen: ['ch1-maze-row'] });
    expect(lessonStep('ch1-maze-snake', { type: 'progress', built: 1 })).toEqual({ step: 'ch1-maze-snake', seen: [] });
    expect(lessonStep('ch1-maze-snake', { type: 'progress', built: 2 })).toEqual({ step: 'ch1-maze-lanes', seen: ['ch1-maze-snake'] });
    // 一次建好两排：连跳两步
    expect(lessonStep('ch1-maze-row', { type: 'progress', built: 3 })).toEqual({
      step: 'ch1-maze-lanes',
      seen: ['ch1-maze-row', 'ch1-maze-snake'],
    });
    // 最后一步只能手动结束
    expect(lessonStep('ch1-maze-lanes', { type: 'progress', built: 9 })).toEqual({ step: 'ch1-maze-lanes', seen: [] });
  });

  it('「知道了」进入下一步；最后一步结束教学', () => {
    expect(lessonStep('ch1-maze-row', { type: 'ok' })).toEqual({ step: 'ch1-maze-snake', seen: ['ch1-maze-row'] });
    expect(lessonStep('ch1-maze-snake', { type: 'ok' })).toEqual({ step: 'ch1-maze-lanes', seen: ['ch1-maze-snake'] });
    expect(lessonStep('ch1-maze-lanes', { type: 'ok' })).toEqual({ step: null, seen: ['ch1-maze-lanes'] });
  });

  it('跳过 / 开波：剩下的步骤全部记为已看过', () => {
    expect(lessonStep('ch1-maze-row', { type: 'skip' })).toEqual({ step: null, seen: [...MAZE_STEPS] });
    expect(lessonStep('ch1-maze-snake', { type: 'abort' })).toEqual({ step: null, seen: ['ch1-maze-snake', 'ch1-maze-lanes'] });
    expect(lessonStep(null, { type: 'ok' })).toEqual({ step: null, seen: [] });
  });

  it('整段流程：看过的步骤记下来后，重进不会再出现（重置后又从头开始）', () => {
    const seen = new Set<MazeStep>();
    let cur = firstStep((s) => seen.has(s));
    const feed = (ev: Parameters<typeof lessonStep>[1]) => {
      const r = lessonStep(cur, ev);
      r.seen.forEach((s) => seen.add(s));
      cur = r.step;
    };
    feed({ type: 'progress', built: 1 });
    expect(cur).toBe('ch1-maze-snake');
    feed({ type: 'progress', built: 2 });
    feed({ type: 'ok' });
    expect(cur).toBeNull();
    expect(firstStep((s) => seen.has(s))).toBeNull();
    seen.clear(); // 设置 → 重置新手引导（清空 tutorial 记录）
    expect(firstStep((s) => seen.has(s))).toBe('ch1-maze-row');
  });

  it('幽灵墙只在前两步显示，分别对应第 1、2 段', () => {
    expect(ghostSegment('ch1-maze-row')).toBe(0);
    expect(ghostSegment('ch1-maze-snake')).toBe(1);
    expect(ghostSegment('ch1-maze-lanes')).toBeNull();
    expect(ghostSegment(null)).toBeNull();
  });

  it('已完成段数：连续的、每格要么已占要么放不下', () => {
    const segs = [
      [1, 2, 3],
      [7, 8, 9],
    ];
    const occupied = new Set([1, 2]);
    const empty = (i: number) => !occupied.has(i);
    expect(builtSegments(segs, empty, () => true)).toBe(0);
    // 3 号格放不下（会堵路）→ 第 1 段算完成
    expect(builtSegments(segs, empty, (i) => i !== 3)).toBe(1);
    expect(remainingCells(segs[1], empty, () => true)).toEqual([7, 8, 9]);
    expect(remainingCells(undefined, empty, () => true)).toEqual([]);
  });
});

describe('摆迷宫教学 × 迷宫规划器（第一章）', () => {
  const opts: RunOptions = {
    mode: 'campaign',
    map: 'ch1',
    difficulty: 'normal',
    seed: 'maze-lesson',
    skills: ['eraser_strike', 'bell', 'whiteout_zone'],
    fixedLayout: true,
  };

  it('规划至少有两排挡板；按推荐摆完两排后路线明显变长、教学推进到第 3 步', () => {
    const w = createWorld(opts);
    const plan = planMaze(w);
    expect(plan.segments.length).toBeGreaterThanOrEqual(2);
    const { cols } = w.state.grid;
    const isEmpty = (i: number) => w.state.grid.cells[i] === CellKind.Empty;
    const placeable = (i: number) => {
      const r = w.canPlace('wall', i % cols, Math.floor(i / cols));
      return r.ok || r.code === 'noGold';
    };
    const len0 = Math.max(...w.currentPaths().map((p) => p.length));
    let cur: MazeStep | null = firstStep(none);
    for (let k = 0; k < 2; k++) {
      for (const i of remainingCells(plan.segments[k], isEmpty, placeable)) {
        w.command({ type: 'place', tower: 'wall', cx: i % cols, cy: Math.floor(i / cols) });
      }
      cur = lessonStep(cur, { type: 'progress', built: builtSegments(plan.segments, isEmpty, placeable) }).step;
    }
    expect(cur).toBe('ch1-maze-lanes');
    const len1 = Math.max(...w.currentPaths().map((p) => p.length));
    expect(len1).toBeGreaterThan(len0 + 8);
  });
});
