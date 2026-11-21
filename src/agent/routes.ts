/**
 * 进攻路线（文档 10 §5.3）：给 Agent 看"敌人从哪来、走哪条路、哪里适合放塔"，并能无副作用地预览改动。
 *
 *  - 地面路线：每个开放出生点（边缘 / 已打开的暗门 / 已落地的空降箱）以及预警中的空降箱（"将会出现的路线"）
 *    沿流场走到出口的格序列 → 只保留拐点的航点（相邻航点之间是 8 方向直线，可逐格还原，见 expandWaypoints）；
 *  - 最长直线段 + 段旁可建格数；全局"好位置"（射程 2.5 内覆盖路线格最多的可建空格）；
 *  - 飞行线：飞行敌人从出生格中心直线飞向（横向最近的）出口；沿线每 0.25 格采样，统计防空塔覆盖比例；
 *  - 覆盖：每座攻击塔射程内的路线格数（地面）与飞行线长度（空中）；
 *  - preview：一组假设的放置 / 拆除 → 合法性、每条路线的新航点与长度变化、覆盖得失。只读世界状态、不下指令、不改任何字段。
 *
 * 纯 TS、只依赖 core 的流场函数；与 World 内部的路线 / 校验逻辑保持同一规则（预警中的空降格视为障碍、
 * 空降箱从相邻格出发、不能贴墙角斜穿）。
 */
import { CellKind, type IWorld, type TowerId, type TowerState } from '../core/types';
import { computeDist, isPassableKind } from '../core/flowfield';
import { TOWERS } from '../config/towers';

export interface P {
  x: number;
  y: number;
}

export interface Route {
  id: string;
  kind: 'edge' | 'hidden' | 'drop';
  /** open = 正在出怪；warn = 空降预警中（落地后会出现的路线） */
  status: 'open' | 'warn';
  cells: P[];
  /** 路线格数（与 observe 的 path 相同口径） */
  len: number;
  wp: P[];
  /** 预警剩余秒数（status = warn） */
  eta?: number;
  /** 走不到出口（理论上不会发生：放置校验保证连通） */
  blocked?: boolean;
}

export interface FlightLine {
  id: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
  len: number;
  /** 0..1：沿线被防空塔覆盖的比例 */
  aa: number;
  /** 覆盖这条线的塔 uid */
  by: number[];
}

const N8X = [1, -1, 0, 0, 1, 1, -1, -1];
const N8Y = [0, 0, 1, -1, 1, -1, 1, -1];

// ───────────────────────── 航点压缩 ─────────────────────────

/** 只保留起点、拐点、终点 */
export function compressWaypoints(cells: readonly P[]): P[] {
  if (cells.length <= 2) return cells.map((c) => ({ x: c.x, y: c.y }));
  const out: P[] = [{ x: cells[0].x, y: cells[0].y }];
  let dx = cells[1].x - cells[0].x;
  let dy = cells[1].y - cells[0].y;
  for (let i = 1; i < cells.length - 1; i++) {
    const nx = cells[i + 1].x - cells[i].x;
    const ny = cells[i + 1].y - cells[i].y;
    if (nx !== dx || ny !== dy) {
      out.push({ x: cells[i].x, y: cells[i].y });
      dx = nx;
      dy = ny;
    }
  }
  const last = cells[cells.length - 1];
  out.push({ x: last.x, y: last.y });
  return out;
}

/** 航点 → 逐格序列（compressWaypoints 的逆运算；每段都是 8 方向直线） */
export function expandWaypoints(wp: readonly P[]): P[] {
  if (!wp.length) return [];
  const out: P[] = [{ x: wp[0].x, y: wp[0].y }];
  for (let i = 1; i < wp.length; i++) {
    let { x, y } = out[out.length - 1];
    const sx = Math.sign(wp[i].x - x);
    const sy = Math.sign(wp[i].y - y);
    for (let g = 0; g < 64 && (x !== wp[i].x || y !== wp[i].y); g++) {
      x += sx;
      y += sy;
      out.push({ x, y });
    }
  }
  return out;
}

export const fmtWp = (wp: readonly P[]): string => wp.map((p) => `${p.x},${p.y}`).join('>');

// ───────────────────────── 地形副本与流场 ─────────────────────────

/** 当前格子的副本（预警中的空降格视为障碍，与 World.tempCells 同规则） */
export function baseCells(w: IWorld): Uint8Array {
  const s = w.state;
  const g = s.grid;
  const tmp = new Uint8Array(g.cells);
  for (const sp of s.spawners) if (isWarnDrop(w, sp)) for (const c of sp.cells) tmp[c.y * g.cols + c.x] = CellKind.Obstacle;
  return tmp;
}

const isWarnDrop = (w: IWorld, sp: IWorld['state']['spawners'][number]): boolean =>
  sp.kind === 'drop' && !sp.active && sp.warnUntil !== undefined && sp.warnUntil > w.state.time;

function exitStep(cols: number, rows: number, cells: Uint8Array, d: Float32Array, i: number): number {
  const x = i % cols;
  const y = (i - x) / cols;
  let best = -1;
  let bv = Infinity;
  for (let k = 0; k < 8; k++) {
    const nx = x + N8X[k];
    const ny = y + N8Y[k];
    if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
    const ni = ny * cols + nx;
    if (!isPassableKind(cells[ni]) || !(d[ni] < Infinity)) continue;
    if (k >= 4 && (!isPassableKind(cells[y * cols + nx]) || !isPassableKind(cells[ny * cols + x]))) continue;
    const v = d[ni] + (k >= 4 ? 1.414 : 1);
    if (v < bv - 1e-4) {
      bv = v;
      best = ni;
    }
  }
  return best;
}

function nextDown(cols: number, rows: number, cells: Uint8Array, d: Float32Array, i: number): number {
  const here = d[i];
  if (!(here < Infinity) || here === 0) return -1;
  const x = i % cols;
  const y = (i - x) / cols;
  let best = -1;
  let bv = Infinity;
  for (let k = 0; k < 8; k++) {
    const nx = x + N8X[k];
    const ny = y + N8Y[k];
    if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
    const ni = ny * cols + nx;
    if (!isPassableKind(cells[ni])) continue;
    if (k >= 4 && (!isPassableKind(cells[y * cols + nx]) || !isPassableKind(cells[ny * cols + x]))) continue;
    const dn = d[ni];
    if (!(dn < here)) continue;
    const v = dn + (k >= 4 ? 1.414 : 1);
    if (v < bv - 1e-4) {
      best = ni;
      bv = v;
    }
  }
  return best;
}

function trace(cols: number, rows: number, cells: Uint8Array, d: Float32Array, start: number): P[] {
  const out: P[] = [];
  let i = start;
  for (let guard = 0; guard < cols * rows + 2 && i >= 0; guard++) {
    out.push({ x: i % cols, y: Math.floor(i / cols) });
    if (d[i] === 0) break;
    i = nextDown(cols, rows, cells, d, i);
  }
  return out;
}

/** 流场（新缓冲区，不碰世界的 dist） */
export function distFor(w: IWorld, cells: Uint8Array): Float32Array {
  const g = w.state.grid;
  return computeDist(g.cols, g.rows, cells, g.exits, new Float32Array(g.cols * g.rows));
}

/**
 * 每个开放出生点 + 预警中的空降点 → 地面路线。
 * 不传 cells：开放路线用世界真实的格子与流场（敌人实际怎么走），预警路线用"箱子落地后"的格子（预警格视为障碍）；
 * 传 cells（preview 的假设地形）：全部按给定格子计算。
 */
export function groundRoutes(w: IWorld, cells?: Uint8Array, d?: Float32Array): Route[] {
  if (!cells) {
    const g = w.state.grid;
    const real = groundRoutesOn(w, g.cells, g.dist, 'open');
    if (!w.state.spawners.some((sp) => isWarnDrop(w, sp))) return real;
    const bc = baseCells(w);
    const warn = groundRoutesOn(w, bc, distFor(w, bc), 'warn');
    // 保持出生点顺序
    return w.state.spawners
      .map((sp) => real.find((r) => r.id === sp.id) ?? warn.find((r) => r.id === sp.id))
      .filter((r): r is Route => !!r);
  }
  return groundRoutesOn(w, cells, d ?? distFor(w, cells), 'all');
}

function groundRoutesOn(w: IWorld, cells: Uint8Array, d: Float32Array, which: 'open' | 'warn' | 'all'): Route[] {
  const s = w.state;
  const g = s.grid;
  const out: Route[] = [];
  for (const sp of s.spawners) {
    const warn = isWarnDrop(w, sp);
    if (!sp.active && !warn) continue;
    if ((which === 'open' && warn) || (which === 'warn' && !warn)) continue;
    const c = sp.cells[0];
    const i = c.y * g.cols + c.x;
    let path: P[];
    if (sp.kind === 'drop' || !isPassableKind(cells[i])) {
      const n = exitStep(g.cols, g.rows, cells, d, i);
      path = n < 0 ? [{ x: c.x, y: c.y }] : [{ x: c.x, y: c.y }, ...trace(g.cols, g.rows, cells, d, n)];
    } else path = trace(g.cols, g.rows, cells, d, i);
    const last = path[path.length - 1];
    const blocked = !(d[last.y * g.cols + last.x] === 0);
    const r: Route = {
      id: sp.id,
      kind: sp.kind,
      status: warn ? 'warn' : 'open',
      cells: path,
      len: path.length,
      wp: compressWaypoints(path),
    };
    if (warn) r.eta = Math.round(Math.max(0, (sp.warnUntil ?? 0) - s.time) * 10) / 10;
    if (blocked) r.blocked = true;
    out.push(r);
  }
  return out;
}

// ───────────────────────── 射程 / 覆盖 ─────────────────────────

export interface Shooter {
  key: string;
  uid?: number;
  id: TowerId;
  x: number;
  y: number;
  range: number;
  inner: number;
  air: boolean;
  ground: boolean;
}

/** 现有的攻击塔（当前射程；瘫痪的塔照算） */
export function shooters(w: IWorld): Shooter[] {
  const out: Shooter[] = [];
  for (const t of w.state.towers.values()) {
    const def = TOWERS[t.id];
    if (!def.attacks) continue;
    out.push(shooterOf(w, t));
  }
  return out;
}

function shooterOf(w: IWorld, t: TowerState): Shooter {
  const def = TOWERS[t.id];
  const info = w.getTowerInfo(t.uid);
  return {
    key: `#${t.uid}`,
    uid: t.uid,
    id: t.id,
    x: t.cx,
    y: t.cy,
    range: info?.range || w.baseRange(t.id).range,
    inner: info?.innerRange ?? 0,
    air: def.hitsAir,
    ground: def.hitsGround,
  };
}

function newShooter(w: IWorld, id: TowerId, x: number, y: number): Shooter | null {
  const def = TOWERS[id];
  if (!def?.attacks) return null;
  const r = w.baseRange(id);
  return { key: `new ${id}@${x},${y}`, id, x, y, range: r.range, inner: r.inner ?? 0, air: def.hitsAir, ground: def.hitsGround };
}

const inRange = (s: Shooter, px: number, py: number): boolean => {
  const d = Math.hypot(px - (s.x + 0.5), py - (s.y + 0.5));
  return d <= s.range + 1e-6 && d >= s.inner;
};

/** 飞行线：出生格中心 → 横向最近出口中心 */
export function flightLines(w: IWorld, sh: Shooter[] = shooters(w)): FlightLine[] {
  const s = w.state;
  const exits = s.grid.exits;
  const out: FlightLine[] = [];
  for (const sp of s.spawners) {
    if (!sp.active && !isWarnDrop(w, sp)) continue;
    const c = sp.cells[0];
    const x0 = c.x + 0.5;
    const y0 = c.y + 0.5;
    let best = exits[0];
    let bd = Infinity;
    for (const ex of exits) {
      const dd = Math.abs(ex.x + 0.5 - x0);
      if (dd < bd) {
        bd = dd;
        best = ex;
      }
    }
    if (!best) continue;
    const x1 = best.x + 0.5;
    const y1 = best.y + 0.5;
    const len = Math.hypot(x1 - x0, y1 - y0);
    const { frac, by } = lineCoverage(
      sh.filter((q) => q.air),
      x0,
      y0,
      x1,
      y1,
    );
    out.push({ id: sp.id, from: { x: x0, y: y0 }, to: { x: x1, y: y1 }, len: Math.round(len * 10) / 10, aa: frac, by });
  }
  return out;
}

function lineCoverage(
  aa: Shooter[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): { frac: number; by: number[]; perShooter: Map<string, number> } {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.max(1, Math.ceil(len / 0.25));
  let covered = 0;
  const by = new Set<number>();
  const per = new Map<string, number>();
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const px = x0 + (x1 - x0) * f;
    const py = y0 + (y1 - y0) * f;
    let any = false;
    for (const q of aa) {
      if (!inRange(q, px, py)) continue;
      any = true;
      if (q.uid !== undefined) by.add(q.uid);
      per.set(q.key, (per.get(q.key) ?? 0) + len / (n + 1));
    }
    if (any) covered++;
  }
  return { frac: Math.round((covered / (n + 1)) * 100) / 100, by: [...by].sort((a, b) => a - b), perShooter: per };
}

export interface TowerCoverage {
  key: string;
  uid?: number;
  id: TowerId;
  ground: number;
  air: number;
}

/** 每座攻击塔：射程内的地面路线格数（所有路线去重）、飞行线在射程内的长度 */
export function coverage(w: IWorld, routes: Route[] = groundRoutes(w), sh: Shooter[] = shooters(w), lines?: FlightLine[]): TowerCoverage[] {
  const cells = uniqueCells(routes);
  const ln = lines ?? flightLines(w, sh);
  return sh.map((q) => {
    let ground = 0;
    if (q.ground) for (const c of cells) if (inRange(q, c.x + 0.5, c.y + 0.5)) ground++;
    let air = 0;
    if (q.air) for (const l of ln) air += lineCoverage([q], l.from.x, l.from.y, l.to.x, l.to.y).perShooter.get(q.key) ?? 0;
    return { key: q.key, uid: q.uid, id: q.id, ground, air: Math.round(air * 10) / 10 };
  });
}

function uniqueCells(routes: Route[]): P[] {
  const seen = new Set<number>();
  const out: P[] = [];
  for (const r of routes)
    for (const c of r.cells) {
      const k = c.y * 100 + c.x;
      if (!seen.has(k)) {
        seen.add(k);
        out.push(c);
      }
    }
  return out;
}

// ───────────────────────── 线段与好位置 ─────────────────────────

const buildable = (w: IWorld, cells: Uint8Array, onRoute: Set<number>, x: number, y: number): boolean => {
  const g = w.state.grid;
  if (x < 0 || y < 0 || x >= g.cols || y >= g.rows) return false;
  return cells[y * g.cols + x] === CellKind.Empty && !onRoute.has(y * 100 + x);
};

/** 一条路线最长的几段直线（格数）及段旁可建空格数 */
export function longestSegments(
  w: IWorld,
  r: Route,
  cells: Uint8Array,
  onRoute: Set<number>,
  k = 2,
): { a: P; b: P; len: number; spots: number }[] {
  const segs: { a: P; b: P; len: number; spots: number }[] = [];
  for (let i = 1; i < r.wp.length; i++) {
    const a = r.wp[i - 1];
    const b = r.wp[i];
    const len = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) + 1;
    if (len < 3) continue;
    const near = new Set<number>();
    for (const c of expandWaypoints([a, b])) {
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (buildable(w, cells, onRoute, c.x + dx, c.y + dy)) near.add((c.y + dy) * 100 + c.x + dx);
        }
    }
    segs.push({ a, b, len, spots: near.size });
  }
  return segs.sort((p, q) => q.len - p.len || q.spots - p.spots).slice(0, k);
}

/** 射程 r 内覆盖路线格最多的可建空格（前 k 个） */
export function bestSpots(
  w: IWorld,
  routes: Route[],
  cells: Uint8Array = baseCells(w),
  k = 3,
  r = 2.5,
): { x: number; y: number; n: number }[] {
  const g = w.state.grid;
  const rc = uniqueCells(routes.filter((x) => x.status === 'open'));
  const onRoute = new Set(rc.map((c) => c.y * 100 + c.x));
  const out: { x: number; y: number; n: number }[] = [];
  for (let y = 0; y < g.rows; y++)
    for (let x = 0; x < g.cols; x++) {
      if (!buildable(w, cells, onRoute, x, y)) continue;
      let n = 0;
      for (const c of rc) if (Math.hypot(c.x - x, c.y - y) <= r) n++;
      if (n > 0) out.push({ x, y, n });
    }
  return out.sort((a, b) => b.n - a.n || a.y - b.y || a.x - b.x).slice(0, k);
}

// ───────────────────────── 观测摘要 ─────────────────────────

export interface RouteSummary {
  /** "north:5,0>5,4>9,4>9,13 L24" 每条一行（预警的加 "warn 8s"） */
  ground: string[];
  /** 最长直线段："north 5,4>9,4 L5 b7"（b = 段旁可建空格数） */
  segs: string[];
  /** 好位置："4,5:14"（射程 2.5 内覆盖的路线格数） */
  spots: string[];
  /** 飞行线："north 5.5,0.5>5.5,13.5 L13 aa38% #3,#7" */
  air: string[];
  /** 下一波按出生点："north: crumb×8 plane×4" */
  next: string[];
}

export function routeSummary(w: IWorld): RouteSummary {
  const cells = baseCells(w);
  const routes = groundRoutes(w);
  const onRoute = new Set(uniqueCells(routes).map((c) => c.y * 100 + c.x));
  const sh = shooters(w);
  const lines = flightLines(w, sh);
  const ground = routes.map(
    (r) => `${r.id}:${fmtWp(r.wp)} L${r.len}${r.status === 'warn' ? ` warn ${r.eta}s` : ''}${r.blocked ? ' BLOCKED' : ''}`,
  );
  const segs: string[] = [];
  for (const r of routes)
    for (const sg of longestSegments(w, r, cells, onRoute, routes.length > 2 ? 1 : 2))
      segs.push(`${r.id} ${sg.a.x},${sg.a.y}>${sg.b.x},${sg.b.y} L${sg.len} b${sg.spots}`);
  const spots = bestSpots(w, routes, cells).map((p) => `${p.x},${p.y}:${p.n}`);
  const air = lines.map(
    (l) =>
      `${l.id} ${l.from.x},${l.from.y}>${l.to.x},${l.to.y} L${l.len} aa${Math.round(l.aa * 100)}%${l.by.length ? ` ${l.by.map((u) => `#${u}`).join(',')}` : ''}`,
  );
  const byS = new Map<string, string[]>();
  for (const g of w.state.nextWave.groups) {
    const k = g.spawner || '*';
    if (!byS.has(k)) byS.set(k, []);
    byS.get(k)!.push(`${g.enemy}×${g.count}${g.elite ? `(e${g.elite})` : ''}`);
  }
  const next = [...byS].map(([k, v]) => `${k}: ${v.join(' ')}`);
  return { ground, segs, spots, air, next };
}

/** observe(full) 用：每座攻击塔 "#3 pencil g14 a3.5" */
export function coverageLines(w: IWorld): string[] {
  return coverage(w).map((c) => `${c.key} ${c.id} g${c.ground}${c.air ? ` a${c.air}` : ''}`);
}

// ───────────────────────── preview ─────────────────────────

export interface PreviewInput {
  place?: { tower: TowerId; x: number; y: number }[];
  /** 假设拆除（出售）的塔 uid */
  remove?: number[];
}

export interface PreviewResult {
  ok: boolean;
  /** 每个放置 / 拆除的结果（顺序与输入一致：先拆除后放置） */
  steps: string[];
  routes: { id: string; before: number; after: number; wp: string }[];
  gains: string[];
  losses: string[];
  air: { id: string; before: number; after: number }[];
  cost: number;
  goldAfter: number;
}

/**
 * 假设的放置 / 拆除 → 合法性、路线、覆盖变化。只读：不调用 world.command，不写任何状态字段
 * （流场用新缓冲区计算；第一处放置在没有拆除时用 world.canPlace 拿到与真实放置完全一致的结论）。
 */
export function previewChanges(w: IWorld, inp: PreviewInput): PreviewResult {
  const s = w.state;
  const g = s.grid;
  const cells = baseCells(w);
  const before = groundRoutes(w, cells);
  const shBefore = shooters(w);
  const covBefore = coverage(w, before, shBefore);
  const linesBefore = flightLines(w, shBefore);
  const steps: string[] = [];
  let ok = true;
  let gold = s.gold;
  let cost = 0;
  const removed = new Set<number>();
  for (const uid of inp.remove ?? []) {
    const t = s.towers.get(uid);
    if (!t) {
      steps.push(`remove #${uid}: no such tower`);
      ok = false;
      continue;
    }
    const info = w.getTowerInfo(uid);
    cells[t.cy * g.cols + t.cx] = CellKind.Empty;
    removed.add(uid);
    gold += info?.sellValue ?? 0;
    steps.push(`remove #${uid} ${t.id}@${t.cx},${t.cy} ok (+${info?.sellValue ?? 0}g)`);
  }
  const added: Shooter[] = [];
  const opts = w.getBuildOptions();
  (inp.place ?? []).forEach((p, idx) => {
    const tag = `place ${p.tower}@${p.x},${p.y}`;
    const b = opts.find((o) => o.id === p.tower);
    if (!b || !b.unlocked) {
      steps.push(`${tag}: not unlocked`);
      ok = false;
      return;
    }
    let reason: string | null = null;
    if (idx === 0 && !removed.size) {
      const chk = w.canPlace(p.tower, p.x, p.y);
      if (!chk.ok && chk.code !== 'noGold') reason = chk.reason ?? 'invalid';
    } else reason = geomCheck(w, cells, p.x, p.y);
    if (reason) {
      steps.push(`${tag}: ${reason}`);
      ok = false;
      return;
    }
    if (gold < b.cost) {
      steps.push(`${tag}: 金币不足 (cost ${b.cost}, gold ${Math.floor(gold)})`);
      ok = false;
    }
    gold -= b.cost;
    cost += b.cost;
    cells[p.y * g.cols + p.x] = CellKind.Tower;
    const ns = newShooter(w, p.tower, p.x, p.y);
    if (ns) added.push(ns);
    if (!steps.some((x) => x.startsWith(`${tag}:`))) steps.push(`${tag}: ok (-${b.cost}g)`);
  });
  const after = groundRoutes(w, cells);
  const shAfter = [...shBefore.filter((q) => q.uid === undefined || !removed.has(q.uid)), ...added];
  const covAfter = coverage(w, after, shAfter);
  const linesAfter = flightLines(w, shAfter);
  const gains: string[] = [];
  const losses: string[] = [];
  const prev = new Map(covBefore.map((c) => [c.key, c]));
  for (const c of covAfter) {
    const b0 = prev.get(c.key);
    const dg = c.ground - (b0?.ground ?? 0);
    const da = Math.round((c.air - (b0?.air ?? 0)) * 10) / 10;
    const txt = `${c.key}${b0 ? '' : ''} g${dg >= 0 ? '+' : ''}${dg}${da ? ` a${da >= 0 ? '+' : ''}${da}` : ''}`;
    if (dg > 0 || da > 0) gains.push(txt);
    else if (dg < 0 || da < 0) losses.push(txt);
  }
  for (const c of covBefore)
    if (c.uid !== undefined && removed.has(c.uid)) losses.push(`${c.key} removed g-${c.ground}${c.air ? ` a-${c.air}` : ''}`);
  const routes = after.map((r) => {
    const b0 = before.find((x) => x.id === r.id);
    return { id: r.id, before: b0?.len ?? 0, after: r.len, wp: fmtWp(r.wp) + (r.blocked ? ' BLOCKED' : '') };
  });
  if (after.some((r) => r.blocked)) ok = false;
  const air = linesAfter.map((l) => ({ id: l.id, before: linesBefore.find((x) => x.id === l.id)?.aa ?? 0, after: l.aa }));
  return { ok, steps, routes, gains, losses, air, cost, goldAfter: Math.floor(gold) };
}

/** 多处放置时的几何校验（与 World.placeGeom 同规则的近似：越界 / 非空地 / 有地面敌人 / 堵路 / 困住敌人） */
function geomCheck(w: IWorld, cells: Uint8Array, x: number, y: number): string | null {
  const s = w.state;
  const g = s.grid;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= g.cols || y >= g.rows) return '超出棋盘';
  const i = y * g.cols + x;
  if (cells[i] === CellKind.Tower) return '已经有塔了';
  if (cells[i] !== CellKind.Empty) return '这里不能建造';
  for (const e of s.enemies) {
    if (e.flying) continue;
    const ex = e as unknown as { ccx?: number; ccy?: number; tcx?: number; tcy?: number };
    const hit = (ex.ccx === x && ex.ccy === y) || (ex.tcx === x && ex.tcy === y) || (Math.floor(e.x) === x && Math.floor(e.y) === y);
    if (hit) return '有敌人在这里';
  }
  const tmp = new Uint8Array(cells);
  tmp[i] = CellKind.Tower;
  const d = distFor(w, tmp);
  const reach = (j: number): boolean => d[j] < Infinity || (!isPassableKind(tmp[j]) && exitStep(g.cols, g.rows, tmp, d, j) >= 0);
  for (const sp of s.spawners) {
    const need = sp.kind === 'edge' || sp.active || (sp.kind === 'drop' && sp.warnUntil !== undefined);
    if (!need) continue;
    for (const c of sp.cells) if (!reach(c.y * g.cols + c.x)) return '会堵死道路';
  }
  for (const e of s.enemies) {
    if (e.flying) continue;
    const j = Math.floor(e.y) * g.cols + Math.floor(e.x);
    if (j >= 0 && j < tmp.length && !reach(j)) return '会困住敌人';
  }
  return null;
}

/** preview 结果 → 给模型的紧凑文本 */
export function previewText(r: PreviewResult): string {
  const lines = [`${r.ok ? 'VALID' : 'INVALID'} cost ${r.cost}g → gold ${r.goldAfter}`, ...r.steps];
  for (const x of r.routes)
    lines.push(`route ${x.id} L${x.before}→${x.after} (${x.after - x.before >= 0 ? '+' : ''}${x.after - x.before}) ${x.wp}`);
  if (r.gains.length) lines.push(`cover+ ${r.gains.join('; ')}`);
  if (r.losses.length) lines.push(`cover- ${r.losses.join('; ')}`);
  const airCh = r.air.filter((a) => a.after !== a.before);
  if (airCh.length)
    lines.push(`air ${airCh.map((a) => `${a.id} aa${Math.round(a.before * 100)}→${Math.round(a.after * 100)}%`).join(' ')}`);
  return lines.join('\n');
}
