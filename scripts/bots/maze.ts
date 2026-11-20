/**
 * 迷宫规划与路线覆盖工具（只读 core 状态，不改 core）。
 *
 * planMaze：在地图上枚举"横向挡板 + 两端交替缺口"的蛇形迷宫（挡板行间至少隔 1 行走廊），
 * 逐格放置并保证始终连通，选最长路线的一组；再贪心补格把残余捷径堵上。
 * 结果按段（每条挡板一段）排序，任意前缀都是合法（连通）的局部迷宫。
 */
import { CellKind, type IWorld, type MapId } from '../../src/core';
import { computeDist, tracePath } from '../../src/core/flowfield';

export interface MazePlan {
  /** 有序的段，每段是若干格子索引（y*cols+x） */
  segments: number[][];
  /** 全部格子（含补格），按建造顺序 */
  all: number[];
  /** 建满后的最短入口路线长度（格） */
  length: number;
  /** 不建迷宫时的路线长度 */
  baseLength: number;
}

/** 路线采样点；f 为沿路线的进度 0（入口）..1（出口） */
export interface Sample { x: number; y: number; w: number; f?: number }

const planCache = new Map<string, MazePlan>();

/**
 * 所有必须连通的出生点（全部边缘入口 + 开放的隐藏出生点 + 空降点的相邻格）都可达时，
 * 返回开放入口（取各入口格平均）的路线长度中的最小值；不连通返回 -1
 */
export function routeLength(w: IWorld, cells: Uint8Array, scratch: Float32Array): number {
  const g = w.state.grid;
  const d = computeDist(g.cols, g.rows, cells, g.exits, scratch);
  let min = Infinity;
  for (const sp of w.state.spawners) {
    if (sp.kind === 'hidden' && !sp.active) continue;
    if (sp.kind === 'drop') {
      if (dropStart(w, sp.cells[0], cells, d) < 0) return -1;
      continue;
    }
    let s = 0;
    for (const c of sp.cells) {
      const v = d[c.y * g.cols + c.x];
      if (!(v < Infinity)) return -1;
      s += v;
    }
    if (sp.active) min = Math.min(min, s / sp.cells.length);
  }
  return min === Infinity ? 0 : min;
}

/** 空降点（本身是障碍）出发的第一格：相邻可走格里离出口最近的；-1 = 无 */
export function dropStart(w: IWorld, c: { x: number; y: number }, cells: Uint8Array, d: Float32Array): number {
  const g = w.state.grid;
  let best = -1;
  let bv = Infinity;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const x = c.x + dx;
    const y = c.y + dy;
    if ((dx === 0 && dy === 0) || x < 0 || y < 0 || x >= g.cols || y >= g.rows) continue;
    const i = y * g.cols + x;
    if (cells[i] === CellKind.Obstacle || cells[i] === CellKind.Tower || !(d[i] < Infinity)) continue;
    if (d[i] < bv) { bv = d[i]; best = i; }
  }
  return best;
}

/** 开放的出生点（每个出生点一组格子）；空降点给出其格子 */
export function entranceGroups(w: IWorld): { x: number; y: number }[][] {
  return w.state.spawners.filter((sp) => sp.active).map((sp) => sp.cells);
}

/** 出生点集合签名（变化后需要重新采样） */
export function spawnerKey(w: IWorld): string {
  return w.state.spawners.filter((sp) => sp.active).map((sp) => sp.id).join(',');
}

function rowSets(minRow: number, maxRow: number): number[][] {
  const out: number[][] = [];
  const rec = (start: number, cur: number[]) => {
    if (cur.length >= 2) out.push(cur.slice());
    for (let r = start; r <= maxRow; r++) {
      cur.push(r);
      rec(r + 2, cur);
      cur.pop();
    }
  };
  rec(minRow, []);
  return out;
}

/** 依次尝试堵格，跳过会断路的格子；返回实际堵上的格子 */
function applySeq(w: IWorld, cells: Uint8Array, list: number[], scratch: Float32Array): number[] {
  const done: number[] = [];
  for (const i of list) {
    if (cells[i] !== CellKind.Empty) continue;
    cells[i] = CellKind.Tower;
    if (routeLength(w, cells, scratch) < 0) cells[i] = CellKind.Empty;
    else done.push(i);
  }
  return done;
}

export function planMaze(w: IWorld): MazePlan {
  // 杂物每局不同：按地图 + 障碍布局缓存
  const key = `${w.state.opts.map as MapId}|${w.state.grid.obstacles.map((o) => `${o.x},${o.y},${o.w},${o.h}`).join(';')}`;
  const hit = planCache.get(key);
  if (hit) return hit;
  const g = w.state.grid;
  const { cols, rows } = g;
  const base = new Uint8Array(g.cells.length);
  for (let i = 0; i < base.length; i++) base[i] = g.cells[i] === CellKind.Tower ? CellKind.Empty : g.cells[i];
  const scratch = new Float32Array(cols * rows);
  const baseLength = routeLength(w, base, scratch);
  let best: { segs: number[][]; len: number; n: number } | null = null;
  for (const rs of rowSets(1, rows - 2)) {
    for (const startRight of [false, true]) {
      const cells = base.slice();
      const segs: number[][] = [];
      let right = startRight;
      let ok = true;
      for (const y of rs) {
        // 缺口：靠一侧的第一个非障碍格
        let gap = -1;
        if (right) { for (let x = cols - 1; x >= 0; x--) if (base[y * cols + x] === CellKind.Empty) { gap = x; break; } }
        else { for (let x = 0; x < cols; x++) if (base[y * cols + x] === CellKind.Empty) { gap = x; break; } }
        if (gap < 0) { ok = false; break; }
        const list: number[] = [];
        for (let x = 0; x < cols; x++) if (x !== gap && base[y * cols + x] === CellKind.Empty) list.push(y * cols + x);
        // 先整段尝试，断路再逐格
        for (const i of list) cells[i] = CellKind.Tower;
        if (routeLength(w, cells, scratch) < 0) {
          for (const i of list) cells[i] = CellKind.Empty;
          segs.push(applySeq(w, cells, list, scratch));
        } else segs.push(list);
        right = !right;
      }
      if (!ok) continue;
      const len = routeLength(w, cells, scratch);
      const n = segs.reduce((s, a) => s + a.length, 0);
      if (!best || len > best.len + 1e-6 || (Math.abs(len - best.len) < 1e-6 && n < best.n)) best = { segs, len, n };
    }
  }
  const segs = best ? best.segs : [];
  const cells = base.slice();
  for (const sgm of segs) for (const i of sgm) cells[i] = CellKind.Tower;
  // 贪心补格：只要能让路线更长就堵上
  let len = routeLength(w, cells, scratch);
  const extras: number[] = [];
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (let i = 0; i < cells.length; i++) {
      if (cells[i] !== CellKind.Empty) continue;
      cells[i] = CellKind.Tower;
      const l2 = routeLength(w, cells, scratch);
      if (l2 > len + 0.5) {
        len = l2;
        extras.push(i);
        changed = true;
      } else cells[i] = CellKind.Empty;
    }
    if (!changed) break;
  }
  if (extras.length) segs.push(extras);
  const plan: MazePlan = { segments: segs, all: segs.flat(), length: len, baseLength };
  planCache.set(key, plan);
  return plan;
}

/**
 * 假设把 plan 的前 nSeg 段全部堵上（跳过已占/会断路的格）后的格子数组。
 * 用于给塔选位时预估"迷宫建成后的路线"。
 */
export function targetCells(w: IWorld, plan: MazePlan, nSeg: number, scratch: Float32Array): Uint8Array {
  const cells = w.state.grid.cells.slice();
  const list: number[] = [];
  for (let s = 0; s < Math.min(nSeg, plan.segments.length); s++) list.push(...plan.segments[s]);
  applySeq(w, cells, list, scratch);
  return cells;
}

/** 地面路线采样（每入口一条，按入口数平分权重；相邻格之间补中点） */
export function groundSamples(w: IWorld, cells: Uint8Array, scratch: Float32Array): Sample[] {
  const g = w.state.grid;
  const d = computeDist(g.cols, g.rows, cells, g.exits, scratch);
  const ents = w.state.spawners.filter((sp) => sp.active);
  const out: Sample[] = [];
  const wt = 1 / Math.max(1, ents.length);
  for (const sp of ents) {
    const c0 = sp.cells[0];
    let start = c0.y * g.cols + c0.x;
    if (sp.kind === 'drop') start = dropStart(w, c0, cells, d);
    if (start < 0 || !(d[start] < Infinity)) continue;
    const p = tracePath(g.cols, g.rows, cells, d, start);
    for (let k = 0; k < p.length; k++) {
      const f = k / Math.max(1, p.length - 1);
      out.push({ x: p[k].x + 0.5, y: p[k].y + 0.5, w: wt * 0.5, f });
      if (k + 1 < p.length) out.push({ x: (p[k].x + p[k + 1].x) / 2 + 0.5, y: (p[k].y + p[k + 1].y) / 2 + 0.5, w: wt * 0.5, f });
    }
  }
  return out;
}

/** 飞行路线采样：每个入口格中心直线飞向最近出口 */
export function airSamples(w: IWorld): Sample[] {
  const g = w.state.grid;
  const out: Sample[] = [];
  const wt = 1 / Math.max(1, g.spawns.length);
  for (const sp of g.spawns) {
    const x0 = sp.x + 0.5;
    const y0 = sp.y + 0.5;
    let best = g.exits[0];
    let bd = Infinity;
    for (const ex of g.exits) {
      const dd = Math.abs(ex.x + 0.5 - x0);
      if (dd < bd) { bd = dd; best = ex; }
    }
    const x1 = best.x + 0.5;
    const y1 = best.y + 0.5;
    const L = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.round(L / 0.5));
    for (let k = 0; k <= n; k++) out.push({ x: x0 + ((x1 - x0) * k) / n, y: y0 + ((y1 - y0) * k) / n, w: wt * 0.5 });
  }
  return out;
}

/** 某格塔对采样路线的覆盖（≈ 敌人在射程内经过的格数） */
export function coverage(cx: number, cy: number, range: number, inner: number, samples: Sample[]): number {
  const x = cx + 0.5;
  const y = cy + 0.5;
  const r2 = range * range;
  const i2 = inner * inner;
  let v = 0;
  for (const s of samples) {
    const dx = s.x - x;
    const dy = s.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= r2 && d2 >= i2) v += s.w;
  }
  return v;
}
