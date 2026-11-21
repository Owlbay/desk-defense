import { describe, expect, it } from 'vitest';

import { createWorld, type RunOptions } from '../../src/core';
import { CellKind } from '../../src/core/types';
import { emptyBoardBaselines, fmtRatio, maxCells, routeDelta, routeLength, straightCells } from '../../src/game/route-length';

const line = (x: number, y0: number, y1: number) => Array.from({ length: y1 - y0 + 1 }, (_, k) => ({ x, y: y0 + k }));

const opts = (o: Partial<RunOptions> = {}): RunOptions => ({
  mode: 'campaign',
  map: 'ch1',
  difficulty: 'normal',
  seed: 'route-len',
  skills: ['eraser_strike', 'bell', 'whiteout_zone'],
  fixedLayout: true,
  ...o,
});

describe('路线长度（纯计算）', () => {
  it('直线下限 = 切比雪夫距离 + 1（8 方向移动）', () => {
    expect(straightCells([])).toBe(0);
    expect(straightCells([{ x: 3, y: 0 }])).toBe(1);
    expect(
      straightCells([
        { x: 0, y: 0 },
        { x: 2, y: 5 },
      ]),
    ).toBe(6);
    expect(
      straightCells([
        { x: 5, y: 1 },
        { x: 0, y: 3 },
      ]),
    ).toBe(6);
  });

  it('主路线取最长的一条，倍数相对它自己的基准', () => {
    const a = line(0, 0, 9); // 10 格，直线 10
    const b = [...line(3, 0, 4), ...line(4, 4, 4), ...line(5, 4, 9).slice(1)]; // 弯路
    const r = routeLength([a, b])!;
    expect(r.cells).toBe(Math.max(a.length, b.length));
    expect(r.index).toBe(a.length >= b.length ? 0 : 1);
    expect(r.ratio).toBeCloseTo(r.cells / r.base);
    // 给了基准就用基准
    const r2 = routeLength([a, line(1, 0, 19)], [10, 5])!;
    expect(r2).toMatchObject({ cells: 20, base: 5, index: 1 });
    expect(fmtRatio(r2.ratio)).toBe('4.0');
    // 基准缺省 / 非正数时退回直线
    expect(routeLength([line(0, 0, 4)], [0])!.base).toBe(5);
  });

  it('没有路线返回 null；倍数保留 1 位小数', () => {
    expect(routeLength([])).toBeNull();
    expect(routeLength([[]])).toBeNull();
    expect(fmtRatio(25 / 7)).toBe('3.6');
    expect(fmtRatio(1)).toBe('1.0');
  });

  it('放置预览的路线变化 = 最长路线之差；不可放（null）为 0', () => {
    const cur = [line(0, 0, 9)];
    expect(maxCells(cur)).toBe(10);
    expect(routeDelta(cur, [line(0, 0, 13)])).toBe(4);
    expect(routeDelta(cur, [line(0, 0, 7)])).toBe(-2);
    expect(routeDelta(cur, null)).toBe(0);
    expect(routeDelta([], [line(0, 0, 3)])).toBe(0);
  });

  it('空棋盘基准：拆掉所有塔后的最短路线，开局倍数为 1.0，砌墙后变长', () => {
    const w = createWorld(opts({ mode: 'custom', custom: { startGold: 100000 } }));
    const st = w.state;
    const before = w.currentPaths();
    const r0 = routeLength(before, emptyBoardBaselines(st.grid, before))!;
    expect(r0.cells).toBeGreaterThan(1);
    expect(fmtRatio(r0.ratio)).toBe('1.0');
    // 第 3 行横墙、缺口在最右：路线变长，倍数 > 1
    const { cols } = st.grid;
    let placed = 0;
    for (let x = 0; x < cols - 1; x++) if (w.command({ type: 'place', tower: 'wall', cx: x, cy: 3 }).ok) placed++;
    expect(placed).toBeGreaterThan(5);
    const after = w.currentPaths();
    const base = emptyBoardBaselines(st.grid, after);
    const r1 = routeLength(after, base)!;
    expect(r1.cells).toBeGreaterThan(r0.cells);
    expect(r1.base).toBe(r0.base);
    expect(r1.ratio).toBeGreaterThan(1.2);
    // 基准不受塔影响：塔格当空地
    expect(st.grid.cells.some((c) => c === CellKind.Tower)).toBe(true);
  });

  it('预览差值与真实放置一致', () => {
    const w = createWorld(opts({ mode: 'custom', custom: { startGold: 100000 } }));
    const { cols } = w.state.grid;
    for (let x = 0; x < cols - 2; x++) w.command({ type: 'place', tower: 'wall', cx: x, cy: 3 });
    const cur = w.currentPaths();
    const pv = w.previewPath('wall', cols - 2, 3);
    expect(pv).not.toBeNull();
    const d = routeDelta(cur, pv);
    expect(w.command({ type: 'place', tower: 'wall', cx: cols - 2, cy: 3 }).ok).toBe(true);
    expect(maxCells(w.currentPaths()) - maxCells(cur)).toBe(d);
  });
});
