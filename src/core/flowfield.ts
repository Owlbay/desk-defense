import { CellKind } from './types';

const SQRT2 = 1.414;
const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];

export function isPassableKind(k: number): boolean {
  return k !== CellKind.Obstacle && k !== CellKind.Tower;
}

/**
 * Dijkstra 流场：从出口倒推到每格的距离。8 方向，斜走 1.414，不能贴墙角斜穿。
 * blockExtra：额外视为不可通行的格子索引（-1 表示无），用于放置预览。
 */
export function computeDist(
  cols: number,
  rows: number,
  cells: Uint8Array,
  exits: readonly { x: number; y: number }[],
  out: Float32Array,
  blockExtra = -1,
  unblockExtra = -1,
): Float32Array {
  const n = cols * rows;
  out.fill(Infinity);
  const done = scratchDone(n);
  done.fill(0);
  const pass = (i: number) => i !== blockExtra && (i === unblockExtra || isPassableKind(cells[i]));
  for (const e of exits) {
    const i = e.y * cols + e.x;
    if (pass(i)) out[i] = 0;
  }
  // 168 格，O(V²) 足够快
  for (;;) {
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < n; i++) {
      if (!done[i] && out[i] < bd) {
        bd = out[i];
        best = i;
      }
    }
    if (best < 0) break;
    done[best] = 1;
    const x = best % cols;
    const y = (best - x) / cols;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const ni = ny * cols + nx;
      if (done[ni] || !pass(ni)) continue;
      if (d >= 4) {
        // 不能贴墙角斜穿：两个正交邻格都必须可通行
        if (!pass(y * cols + nx) || !pass(ny * cols + x)) continue;
      }
      const nd = bd + (d >= 4 ? SQRT2 : 1);
      if (nd < out[ni]) out[ni] = nd;
    }
  }
  return out;
}

let doneBuf: Uint8Array | null = null;
function scratchDone(n: number): Uint8Array {
  if (!doneBuf || doneBuf.length < n) doneBuf = new Uint8Array(n);
  return doneBuf;
}

/** 沿流场的下一格（-1 = 无路或已在出口） */
export function nextCell(
  cols: number,
  rows: number,
  cells: Uint8Array,
  dist: Float32Array,
  i: number,
  blockExtra = -1,
  unblockExtra = -1,
): number {
  const here = dist[i];
  if (!(here < Infinity) || here === 0) return -1;
  const pass = (j: number) => j !== blockExtra && (j === unblockExtra || isPassableKind(cells[j]));
  const x = i % cols;
  const y = (i - x) / cols;
  let best = -1;
  let bv = Infinity;
  for (let d = 0; d < 8; d++) {
    const nx = x + DX[d];
    const ny = y + DY[d];
    if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
    const ni = ny * cols + nx;
    if (!pass(ni)) continue;
    if (d >= 4 && (!pass(y * cols + nx) || !pass(ny * cols + x))) continue;
    const dn = dist[ni];
    // 只走"下坡"；取 dist[ni]+步长 最小者（Float32 有舍入误差，比较时留容差）
    if (!(dn < here)) continue;
    const v = dn + (d >= 4 ? SQRT2 : 1);
    if (v < bv - 1e-4) {
      best = ni;
      bv = v;
    }
  }
  return best;
}

/** 从某格沿流场走到出口的格序列 */
export function tracePath(
  cols: number,
  rows: number,
  cells: Uint8Array,
  dist: Float32Array,
  start: number,
  blockExtra = -1,
  unblockExtra = -1,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  let i = start;
  for (let guard = 0; guard < cols * rows + 2 && i >= 0; guard++) {
    out.push({ x: i % cols, y: Math.floor(i / cols) });
    if (dist[i] === 0) break;
    i = nextCell(cols, rows, cells, dist, i, blockExtra, unblockExtra);
  }
  return out;
}
