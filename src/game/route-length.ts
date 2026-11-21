/**
 * 路线长度（纯计算，无 DOM / Phaser）：HUD 的「路线 N 格（×R 直线）」与放置预览的「+M 格」共用。
 *
 * - 路线格数 = 路径上的格子数（含入口格与出口格），与 world.currentPaths() / previewPath() 的格序列一致。
 * - 主地面路线 = 所有开放出生点里最长的一条（敌人主力走得最久的那条）。
 * - 倍数 R = 路线格数 / 基准格数；基准 = 同一起点在「拆掉所有塔」的棋盘上的最短路线（杂物照算），
 *   缺省时退回直线下限（8 方向移动的切比雪夫距离 + 1）。开局什么都没建时 R = 1.0。
 */
import { computeDist, tracePath } from '../core/flowfield';
import { CellKind } from '../core/types';

export type RouteCell = { x: number; y: number };

export interface RouteLength {
  /** 主地面路线的格数 */
  cells: number;
  /** 基准格数（空棋盘最短 / 直线） */
  base: number;
  /** cells / base（未取整；显示时保留 1 位小数） */
  ratio: number;
  /** 主路线在 paths 里的下标 */
  index: number;
}

/** 8 方向移动时起点到终点最少要走的格数（含两端）：切比雪夫距离 + 1 */
export function straightCells(p: readonly RouteCell[]): number {
  if (p.length === 0) return 0;
  const a = p[0];
  const b = p[p.length - 1];
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) + 1;
}

/** 最长一条路线的格数（没有路线为 0） */
export function maxCells(paths: readonly (readonly RouteCell[])[] | null | undefined): number {
  let m = 0;
  if (paths) for (const p of paths) if (p.length > m) m = p.length;
  return m;
}

/** 主地面路线的长度与倍数；没有路线时返回 null */
export function routeLength(paths: readonly (readonly RouteCell[])[], baselines?: readonly (number | undefined)[]): RouteLength | null {
  let index = -1;
  let cells = 0;
  paths.forEach((p, i) => {
    if (p.length > cells) {
      cells = p.length;
      index = i;
    }
  });
  if (index < 0) return null;
  const b = baselines?.[index];
  const base = Math.max(1, b !== undefined && b > 0 ? b : straightCells(paths[index]));
  return { cells, base, ratio: cells / base, index };
}

/** 放一座塔前后主路线格数之差（预览不可放 / 无路线时为 0） */
export function routeDelta(current: readonly (readonly RouteCell[])[], preview: readonly (readonly RouteCell[])[] | null): number {
  if (!preview) return 0;
  const a = maxCells(current);
  const b = maxCells(preview);
  return a > 0 && b > 0 ? b - a : 0;
}

/** 倍数显示：保留 1 位小数 */
export const fmtRatio = (r: number): string => (Math.round(r * 10) / 10).toFixed(1);

export interface GridLike {
  cols: number;
  rows: number;
  cells: Uint8Array;
  exits: readonly RouteCell[];
}

/**
 * 每条路线的基准格数：拆掉所有塔（杂物、出生格等保持不变）后，从同一起点到出口的最短路线格数。
 * 起点本身不可走（空降纸箱）时，从相邻离出口最近的格子出发再 +1。
 */
export function emptyBoardBaselines(grid: GridLike, paths: readonly (readonly RouteCell[])[]): number[] {
  const { cols, rows } = grid;
  const cells = grid.cells.slice();
  for (let i = 0; i < cells.length; i++) if (cells[i] === CellKind.Tower) cells[i] = CellKind.Empty;
  const d = computeDist(cols, rows, cells, grid.exits, new Float32Array(cols * rows));
  return paths.map((p) => {
    if (p.length === 0) return 0;
    const s = p[0];
    let i = s.y * cols + s.x;
    let extra = 0;
    if (!(d[i] < Infinity)) {
      let best = -1;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = s.x + dx;
          const y = s.y + dy;
          if ((dx === 0 && dy === 0) || x < 0 || y < 0 || x >= cols || y >= rows) continue;
          const j = y * cols + x;
          if (d[j] < Infinity && (best < 0 || d[j] < d[best])) best = j;
        }
      if (best < 0) return straightCells(p);
      i = best;
      extra = 1;
    }
    return tracePath(cols, rows, cells, d, i).length + extra;
  });
}
