/**
 * 随机地形生成（文档 09 §5）：固定骨架 + 按种子摆放的杂物。
 * 纯函数、确定性；core 与地图选择界面（缩略图）共用。
 */
import { CellKind, GRID_COLS, GRID_ROWS, type MapId, type Obstacle, type SpawnerState } from './types';
import { Rng } from './rng';
import { computeDist, tracePath } from './flowfield';
import { MAPS, spawnerOpenWave, type MapDef } from '../config/maps';

export const LAYOUT_RULES = {
  minRoute: 14,
  maxRoute: 30,
  minBuildable: 0.7,
  /** 关键缺口（单格宽的通道）上限 */
  maxGaps: 4,
  placeTries: 50,
  attempts: 20,
};

export interface LayoutResult {
  obstacles: Obstacle[];
  spawners: SpawnerState[];
  exits: { x: number; y: number }[];
}

export interface LayoutCheck {
  ok: boolean;
  reachable: boolean;
  /** 起始开放的入口各自的路线长度（格数） */
  routes: number[];
  buildable: number;
  gaps: number;
}

function spawnerStates(def: MapDef, campaign: boolean): SpawnerState[] {
  return def.spawners.map((d) => {
    const open = spawnerOpenWave(d, campaign);
    const st: SpawnerState = {
      id: d.id, name: d.name, kind: d.kind, cells: d.cells.map((c) => ({ x: c.x, y: c.y })),
      active: d.kind === 'edge' && open === 1,
    };
    return st;
  });
}

/** 骨架格：障碍、入口、出口（隐藏出生点保持空地） */
export function skeletonCells(def: MapDef, obstacles: readonly Obstacle[]): Uint8Array {
  const cols = GRID_COLS;
  const cells = new Uint8Array(cols * GRID_ROWS);
  for (const o of obstacles) {
    for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++) cells[y * cols + x] = CellKind.Obstacle;
  }
  for (const sp of def.spawners) if (sp.kind === 'edge') for (const c of sp.cells) cells[c.y * cols + c.x] = CellKind.Spawn;
  for (const c of def.exits) cells[c.y * cols + c.x] = CellKind.Exit;
  return cells;
}

/** 单格宽通道数量：空格两侧（左右或上下）都被障碍 / 桌沿挡住，且至少一侧是障碍物 */
function countGaps(cells: Uint8Array): number {
  const cols = GRID_COLS;
  const rows = GRID_ROWS;
  const blocked = (x: number, y: number) => x < 0 || y < 0 || x >= cols || y >= rows || cells[y * cols + x] === CellKind.Obstacle;
  const obst = (x: number, y: number) => x >= 0 && y >= 0 && x < cols && y < rows && cells[y * cols + x] === CellKind.Obstacle;
  let n = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (cells[y * cols + x] !== CellKind.Empty) continue;
      const h = blocked(x - 1, y) && blocked(x + 1, y) && (obst(x - 1, y) || obst(x + 1, y));
      const v = blocked(x, y - 1) && blocked(x, y + 1) && (obst(x, y - 1) || obst(x, y + 1));
      if (h || v) n++;
    }
  }
  return n;
}

const distBuf = new Float32Array(GRID_COLS * GRID_ROWS);

/** 校验一张布局（测试与生成器共用） */
export function checkLayout(map: MapId, obstacles: readonly Obstacle[], campaign = false): LayoutCheck {
  const def = MAPS[map];
  const cols = GRID_COLS;
  const cells = skeletonCells(def, obstacles);
  const d = computeDist(cols, GRID_ROWS, cells, def.exits, distBuf);
  let reachable = true;
  const routes: number[] = [];
  for (const sp of def.spawners) {
    for (const c of sp.cells) if (!(d[c.y * cols + c.x] < Infinity)) reachable = false;
    if (sp.kind === 'edge' && spawnerOpenWave(sp, campaign) === 1) {
      const c = sp.cells[0];
      routes.push(reachable ? tracePath(cols, GRID_ROWS, cells, d, c.y * cols + c.x).length : 0);
    }
  }
  let empty = 0;
  for (let i = 0; i < cells.length; i++) if (cells[i] === CellKind.Empty) empty++;
  const buildable = empty / cells.length;
  const gaps = countGaps(cells);
  const ok = reachable
    && routes.every((r) => r >= LAYOUT_RULES.minRoute && r <= LAYOUT_RULES.maxRoute)
    && buildable >= LAYOUT_RULES.minBuildable
    && gaps <= LAYOUT_RULES.maxGaps;
  return { ok, reachable, routes, buildable, gaps };
}

/** 所有边缘入口（含后期开放的）的最长路线不超过上限 */
function routesWithinMax(def: MapDef, cells: Uint8Array): boolean {
  const cols = GRID_COLS;
  const d = computeDist(cols, GRID_ROWS, cells, def.exits, distBuf);
  for (const sp of def.spawners) {
    for (const c of sp.cells) if (!(d[c.y * cols + c.x] < Infinity)) return false;
    if (sp.kind !== 'edge') continue;
    const c = sp.cells[0];
    if (tracePath(cols, GRID_ROWS, cells, d, c.y * cols + c.x).length > LAYOUT_RULES.maxRoute) return false;
  }
  return true;
}

function tryGenerate(def: MapDef, rng: Rng): Obstacle[] | null {
  const cols = GRID_COLS;
  const rows = GRID_ROWS;
  const cells = skeletonCells(def, def.landmarks);
  // 禁放区：出生点（含隐藏）与出口周围 1 格
  const forbid = new Uint8Array(cols * rows);
  const mark = (cx: number, cy: number) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x >= 0 && y >= 0 && x < cols && y < rows) forbid[y * cols + x] = 1;
    }
  };
  for (const sp of def.spawners) for (const c of sp.cells) mark(c.x, c.y);
  for (const c of def.exits) mark(c.x, c.y);
  // 已有障碍（骨架标志物）周围 1 格：杂物之间至少隔 1 格
  const near = new Uint8Array(cols * rows);
  const markObst = (o: Obstacle) => {
    for (let y = o.y - 1; y <= o.y + o.h; y++) for (let x = o.x - 1; x <= o.x + o.w; x++) {
      if (x >= 0 && y >= 0 && x < cols && y < rows) near[y * cols + x] = 1;
    }
  };
  for (const o of def.landmarks) markObst(o);

  const [bMin, bMax] = def.clutterBudget;
  const budget = bMin + rng.int(bMax - bMin + 1);
  const used = new Map<string, number>();
  const out: Obstacle[] = [];
  let area = 0;
  for (let draw = 0; draw < 24 && area < budget; draw++) {
    const pool = def.clutter.filter((c) => (used.get(c.kind) ?? 0) < (c.max ?? 9) && area + c.w * c.h <= bMax);
    if (!pool.length) break;
    const item = pool[rng.weighted(pool.map((c) => c.weight))];
    used.set(item.kind, (used.get(item.kind) ?? 0) + 1);
    let placed = false;
    for (let t = 0; t < LAYOUT_RULES.placeTries && !placed; t++) {
      const rot = item.w !== item.h && rng.chance(0.5);
      const w = rot ? item.h : item.w;
      const h = rot ? item.w : item.h;
      const x0 = rng.int(cols - w + 1);
      const y0 = rng.int(rows - h + 1);
      let ok = true;
      for (let y = y0; y < y0 + h && ok; y++) for (let x = x0; x < x0 + w; x++) {
        const i = y * cols + x;
        if (cells[i] !== CellKind.Empty || forbid[i] || near[i]) { ok = false; break; }
      }
      if (!ok) continue;
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) cells[y * cols + x] = CellKind.Obstacle;
      if (!routesWithinMax(def, cells)) {
        for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) cells[y * cols + x] = CellKind.Empty;
        continue;
      }
      const o: Obstacle = { kind: item.kind, x: x0, y: y0, w, h };
      out.push(o);
      markObst(o);
      area += w * h;
      placed = true;
    }
  }
  if (area < bMin) return null;
  return out;
}

/** 生成布局：obstacles = 标志物 + 杂物；spawners 为开局状态 */
export function generateLayout(map: MapId, seed: string, fixedLayout = false, campaign = false): LayoutResult {
  const def = MAPS[map] ?? MAPS.ch1;
  const spawners = spawnerStates(def, campaign);
  const exits = def.exits.map((e) => ({ x: e.x, y: e.y }));
  const fallback = (): LayoutResult => ({
    obstacles: [...def.landmarks, ...def.defaultClutter].map((o) => ({ ...o })),
    spawners, exits,
  });
  if (fixedLayout) return fallback();
  for (let attempt = 0; attempt < LAYOUT_RULES.attempts; attempt++) {
    const rng = new Rng(`${def.chapterSeed}|${seed}|layout|${attempt}`);
    const clutter = tryGenerate(def, rng);
    if (!clutter) continue;
    const obstacles = [...def.landmarks.map((o) => ({ ...o })), ...clutter];
    if (checkLayout(def.id, obstacles, campaign).ok) return { obstacles, spawners, exits };
  }
  return fallback();
}
