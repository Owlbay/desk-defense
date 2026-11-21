/**
 * 迷宫规划与路线覆盖工具（只读 core 状态，不改 core）。内置机器人（scripts/bots）与 Agent 的意图规划器（planner.ts）共用。
 *
 * planMaze：在地图上枚举"横向挡板 + 两端交替缺口"的蛇形迷宫（挡板行间至少隔 1 行走廊），
 * 逐格放置并保证始终连通，选最长路线的一组；再贪心补格把残余捷径堵上。
 * 结果按段（每条挡板一段）排序，任意前缀都是合法（连通）的局部迷宫。
 */
import { CellKind, type IWorld, type MapId } from '../core/types';
import { computeDist, tracePath } from '../core/flowfield';

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
export interface Sample {
  x: number;
  y: number;
  w: number;
  f?: number;
}

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
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const x = c.x + dx;
      const y = c.y + dy;
      if ((dx === 0 && dy === 0) || x < 0 || y < 0 || x >= g.cols || y >= g.rows) continue;
      const i = y * g.cols + x;
      if (cells[i] === CellKind.Obstacle || cells[i] === CellKind.Tower || !(d[i] < Infinity)) continue;
      if (d[i] < bv) {
        bv = d[i];
        best = i;
      }
    }
  return best;
}

/** 开放的出生点（每个出生点一组格子）；空降点给出其格子 */
export function entranceGroups(w: IWorld): { x: number; y: number }[][] {
  return w.state.spawners.filter((sp) => sp.active).map((sp) => sp.cells);
}

/** 出生点集合签名（变化后需要重新采样） */
export function spawnerKey(w: IWorld): string {
  return w.state.spawners
    .filter((sp) => sp.active)
    .map((sp) => sp.id)
    .join(',');
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

/** 行 / 列组是否"塞满"：首尾离边界 ≤1，相邻间隔 ≤3（再也插不进一道间隔 ≥2 的挡板） */
function maximal(set: number[], lo: number, hi: number): boolean {
  if (set[0] - lo > 1 || hi - set[set.length - 1] > 1) return false;
  for (let k = 1; k < set.length; k++) if (set[k] - set[k - 1] > 3) return false;
  return true;
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

/** 一种挡板布局：每道挡板 = 一行（横向）或一列（纵向）上除缺口外的空格，缺口在两端交替 */
function barrierLayout(
  w: IWorld,
  base: Uint8Array,
  lines: number[],
  vertical: boolean,
  startFar: boolean,
  scratch: Float32Array,
): { segs: number[][]; len: number; n: number } | null {
  const g = w.state.grid;
  const { cols, rows } = g;
  const cells = base.slice();
  const segs: number[][] = [];
  let far = startFar;
  const span = vertical ? rows : cols;
  const at = (line: number, k: number): number => (vertical ? k * cols + line : line * cols + k);
  for (const line of lines) {
    // 缺口：靠一侧的第一个空格（障碍物 / 出生格 / 出口当作墙的一部分，不另花钱）
    let gap = -1;
    if (far) {
      for (let k = span - 1; k >= 0; k--)
        if (base[at(line, k)] === CellKind.Empty) {
          gap = k;
          break;
        }
    } else {
      for (let k = 0; k < span; k++)
        if (base[at(line, k)] === CellKind.Empty) {
          gap = k;
          break;
        }
    }
    if (gap < 0) return null;
    const list: number[] = [];
    for (let k = 0; k < span; k++) if (k !== gap && base[at(line, k)] === CellKind.Empty) list.push(at(line, k));
    for (const i of list) cells[i] = CellKind.Tower;
    if (routeLength(w, cells, scratch) < 0) {
      for (const i of list) cells[i] = CellKind.Empty;
      segs.push(applySeq(w, cells, list, scratch));
    } else segs.push(list);
    far = !far;
  }
  const len = routeLength(w, cells, scratch);
  return { segs, len, n: segs.reduce((a, b) => a + b.length, 0) };
}

/**
 * 迷宫规划的取舍：每多 1 格墙要多换来这么多格路线。试过 0.08（≈5 金币一格墙）：路线略短、生命不变，
 * 所以保持 0（路线最长，同长取墙少的）。
 */
const CELL_COST = 0;

/**
 * 迷宫规划（障碍物感知）：枚举横向（行）与纵向（列）蛇形挡板布局——障碍物、出生格、出口、棋盘边都当免费的墙
 * （挡板经过障碍物的格不花钱），用真实流场算路线长度，取最长的一组（同长取墙少的）；再贪心补格堵残余捷径。
 * 段按挡板顺序（入口一侧先建），任意前缀仍连通。
 */
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
  let best: { segs: number[][]; len: number; n: number; score: number } | null = null;
  const consider = (r: { segs: number[][]; len: number; n: number } | null) => {
    if (!r) return;
    const score = r.len - CELL_COST * r.n;
    if (!best || score > best.score + 1e-6 || (Math.abs(score - best.score) <= 1e-6 && r.n < best.n)) best = { ...r, score };
  };
  for (const rs of rowSets(1, rows - 2)) for (const far of [false, true]) consider(barrierLayout(w, base, rs, false, far, scratch));
  // 纵向只试"塞满"的列组（相邻挡板间隔 2～3 列、两端顶到边）：横向全枚举已经很贵，纵向全枚举会让规划耗时翻倍
  for (const cs of rowSets(1, cols - 2).filter((c) => maximal(c, 1, cols - 2)))
    for (const far of [false, true]) consider(barrierLayout(w, base, cs, true, far, scratch));
  const chosen = best as { segs: number[][]; len: number; n: number; score: number } | null;
  // 段按挡板从入口一侧往出口一侧建（试过按"每格墙的路线增量"排序：脚本评测生命 98% → 67%，弃用）
  const segs = chosen ? chosen.segs.slice() : [];
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
      if (dd < bd) {
        bd = dd;
        best = ex;
      }
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
