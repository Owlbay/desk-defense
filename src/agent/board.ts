/**
 * 棋盘体检（文档 10 §19.8）：给模型看"哪些格 / 墙 / 塔可以回收"、组合技状态、迷宫强弱。只读，不发指令。
 *
 *  - 无用墙：拆掉后没有任何路线变短、不在迷宫规划里、也不是给相邻塔加成的 Lv2+ 墙；
 *  - 零伤害塔：最近 2 波 0 伤害（情报模块统计），或射程内没有任何路线 / 飞行线；
 *  - 被挤占格：Lv1 墙占着覆盖路线最多的格（换成塔不改路线——塔本身也是墙）；
 *  - 组合技：已激活的配对、缺搭档的塔；
 *  - 迷宫：当前路线长度 vs 规划可达长度、直线长度，未利用的障碍物。
 */
import { CellKind, type IWorld, type TowerId, type TowerState } from '../core/types';
import { COMBOS, TOWERS } from '../config/towers';
import { ENEMIES } from '../config/enemies';
import { baseCells, coverage as towerCoverage, groundRoutes, type Route } from './routes';
import { planMaze, type MazePlan } from './maze';
import type { BattleIntel } from './intel';

const N4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** 每条路线（出生点 id → 格数） */
function lens(routes: Route[]): Map<string, number> {
  return new Map(routes.map((r) => [r.id, r.blocked ? Infinity : r.len]));
}

/** 去掉 / 加上这些格之后，是否有路线变短（或被堵） */
export function shortensRoutes(w: IWorld, remove: number[], add: number[] = []): boolean {
  const cells = baseCells(w);
  const before = lens(groundRoutes(w, cells));
  for (const i of remove) cells[i] = CellKind.Empty;
  for (const i of add) cells[i] = CellKind.Tower;
  const after = lens(groundRoutes(w, cells));
  for (const [id, l] of before) {
    const a = after.get(id);
    if (a === undefined || a < l || a === Infinity) return true;
  }
  return false;
}

/** 路线格（所有开放路线去重） */
export function routeCellSet(w: IWorld): Set<number> {
  const cols = w.state.grid.cols;
  const out = new Set<number>();
  for (const r of groundRoutes(w)) if (r.status === 'open') for (const c of r.cells) out.add(c.y * cols + c.x);
  return out;
}

/** 射程 r 内的开放路线格数（重复经过的路线分别计：每条路线各算一次） */
export function cellCoverage(w: IWorld, x: number, y: number, r = 2.5, routes: Route[] = groundRoutes(w)): number {
  let n = 0;
  for (const rt of routes) {
    if (rt.status !== 'open') continue;
    for (const c of rt.cells) if (Math.hypot(c.x - x, c.y - y) <= r) n++;
  }
  return n;
}

export interface WallInfo {
  uid: number;
  x: number;
  y: number;
  level: number;
  invested: number;
  inPlan: boolean;
  bonus: boolean;
  shortens: boolean;
  cov: number;
}

/** 每堵墙：拆掉会不会让路线变短、是否在规划里、是否给相邻攻击塔加成、所在格的路线覆盖 */
export function wallInfo(w: IWorld, plan: MazePlan = planMaze(w)): WallInfo[] {
  const s = w.state;
  const g = s.grid;
  const inPlan = new Set(plan.all);
  const routes = groundRoutes(w);
  const cells = baseCells(w);
  const before = lens(groundRoutes(w, cells));
  const out: WallInfo[] = [];
  for (const t of [...s.towers.values()].sort((a, b) => a.uid - b.uid)) {
    if (t.id !== 'wall') continue;
    const i = t.cy * g.cols + t.cx;
    cells[i] = CellKind.Empty;
    const after = lens(groundRoutes(w, cells));
    cells[i] = CellKind.Tower;
    let shortens = false;
    for (const [id, l] of before) {
      const a = after.get(id);
      if (a === undefined || a < l) shortens = true;
    }
    let bonus = false;
    if (t.level > 1) {
      for (const [dx, dy] of N4) {
        const o = s.towers.get(g.towerAt[(t.cy + dy) * g.cols + t.cx + dx]);
        if (o && TOWERS[o.id].attacks && t.cx + dx >= 0 && t.cx + dx < g.cols) bonus = true;
      }
    }
    out.push({
      uid: t.uid,
      x: t.cx,
      y: t.cy,
      level: t.level,
      invested: t.invested,
      inPlan: inPlan.has(i),
      bonus,
      shortens,
      cov: cellCoverage(w, t.cx, t.cy, 2.5, routes),
    });
  }
  return out;
}

/** 无用墙：拆掉不缩短任何路线、不在规划里、不是加成墙。按所在格覆盖从高到低（先腾出好格） */
export function uselessWalls(w: IWorld, plan?: MazePlan): WallInfo[] {
  return wallInfo(w, plan)
    .filter((x) => !x.shortens && !x.inPlan && !x.bonus)
    .sort((a, b) => b.cov - a.cov || a.uid - b.uid);
}

/** 被挤占格：Lv1 墙占着的、覆盖不少于最好空格的格（换塔不改路线） */
export function crowdedCells(w: IWorld, walls: WallInfo[] = wallInfo(w)): WallInfo[] {
  const g = w.state.grid;
  const routes = groundRoutes(w);
  const onRoute = routeCellSet(w);
  let bestEmpty = 0;
  for (let y = 0; y < g.rows; y++)
    for (let x = 0; x < g.cols; x++) {
      const i = y * g.cols + x;
      if (g.cells[i] !== CellKind.Empty || onRoute.has(i)) continue;
      bestEmpty = Math.max(bestEmpty, cellCoverage(w, x, y, 2.5, routes));
    }
  return walls.filter((x) => x.level === 1 && x.cov >= Math.max(6, bestEmpty)).sort((a, b) => b.cov - a.cov || a.uid - b.uid);
}

/** 射程内没有任何路线 / 飞行线的攻击塔 */
export function outOfReach(w: IWorld): number[] {
  return towerCoverage(w)
    .filter((c) => c.uid !== undefined && c.ground === 0 && c.air === 0)
    .map((c) => c.uid!);
}

/** 可以回收的攻击塔：最近 2 波 0 伤害 ∪ 够不着任何路线 */
export function idleTowers(w: IWorld, intel?: BattleIntel): number[] {
  const set = new Set([...(intel?.idleTowers(2) ?? []), ...outOfReach(w)]);
  return [...set].filter((u) => w.state.towers.has(u)).sort((a, b) => a - b);
}

// ───────────────────────── 组合技 ─────────────────────────

export interface ComboState {
  active: { a: number; b: number; name: string }[];
  /** 缺搭档：塔 uid、类型、缺的搭档类型 */
  lonely: { uid: number; id: TowerId; partner: TowerId }[];
}

/** 组合技 / 相邻加成是惰性重算的（放塔后到下一帧之前 comboWith 还是旧的）：读之前先让世界算一遍 */
export function refreshStats(w: IWorld): void {
  const first = w.state.towers.keys().next();
  if (!first.done) w.getTowerInfo(first.value);
}

export function comboState(w: IWorld): ComboState {
  refreshStats(w);
  const s = w.state;
  const active: ComboState['active'] = [];
  const lonely: ComboState['lonely'] = [];
  const unlocked = new Set(
    w
      .getBuildOptions()
      .filter((b) => b.unlocked)
      .map((b) => b.id),
  );
  for (const t of [...s.towers.values()].sort((a, b) => a.uid - b.uid)) {
    for (const u of t.comboWith) {
      if (u <= t.uid) continue;
      const o = s.towers.get(u);
      if (!o) continue;
      const cb = COMBOS.find((c) => (c.a === t.id && c.b === o.id) || (c.b === t.id && c.a === o.id));
      active.push({ a: t.uid, b: u, name: cb?.name ?? `${t.id}+${o.id}` });
    }
    if (t.comboWith.length) continue;
    const cb = COMBOS.find((c) => c.a === t.id || c.b === t.id);
    if (!cb) continue;
    const partner = cb.a === t.id ? cb.b : cb.a;
    if (unlocked.has(partner)) lonely.push({ uid: t.uid, id: t.id, partner });
  }
  return { active, lonely };
}

const pairName = (a: TowerId, b: TowerId): string => {
  const cb = COMBOS.find((c) => (c.a === a && c.b === b) || (c.a === b && c.b === a));
  return cb ? `${cb.a}+${cb.b}` : `${a}+${b}`;
};

/** CB 行：已激活的组合技与缺搭档的塔（建造阶段） */
export function comboLine(w: IWorld): string | undefined {
  const st = comboState(w);
  const s = w.state;
  const atk = [...s.towers.values()].filter((t) => TOWERS[t.id].attacks);
  if (atk.length < 4 && !st.active.length) return undefined;
  const types = new Set(atk.map((t) => t.id));
  const parts: string[] = [];
  parts.push(
    st.active.length
      ? `激活 ${st.active
          .map((p) => `#${p.a}+#${p.b} ${p.name}`)
          .slice(0, 4)
          .join('; ')}`
      : '激活 0',
  );
  if (st.lonely.length)
    parts.push(
      `缺搭档 ${st.lonely
        .slice(0, 4)
        .map((l) => `#${l.uid}${l.id}(配${l.partner})`)
        .join(' ')}`,
    );
  parts.push(`塔种 ${types.size}: ${[...types].join(',')}`);
  // 建议：收益大的组合优先（胶水→订书机、台灯↔钢笔、尺子↔圆规）；铅笔→橡皮擦只在下一波有护甲时
  const armorNext = s.nextWave.groups.some((g) => ENEMIES[g.enemy].armor >= 2);
  const rank = (l: ComboState['lonely'][number]): number => {
    const k = `${l.id}>${l.partner}`;
    return (
      (
        {
          'glue>stapler': 0,
          'stapler>glue': 1,
          'lamp>pen': 2,
          'pen>lamp': 2,
          'compass>ruler': 3,
          'ruler>compass': 3,
          'eraser>pencil': 4,
        } as Record<string, number>
      )[k] ?? (k === 'pencil>eraser' && armorNext ? 5 : 99)
    );
  };
  const best = st.lonely.filter((l) => rank(l) < 99).sort((a, b) => rank(a) - rank(b))[0];
  const sug = best ? ` → {do:"combo",pair:"${pairName(best.id, best.partner)}"}` : '';
  return `CB ${parts.join(' | ')}${sug}`;
}

// ───────────────────────── 回收 ─────────────────────────

/** RC 行：无用墙 / 零伤害塔 / 被挤占格（有才发） */
export function reclaimLine(w: IWorld, intel?: BattleIntel, plan: MazePlan = planMaze(w)): string | undefined {
  const s = w.state;
  const walls = wallInfo(w, plan);
  const useless = walls.filter((x) => !x.shortens && !x.inPlan && !x.bonus);
  const idle = idleTowers(w, intel);
  const crowded = crowdedCells(w, walls);
  const parts: string[] = [];
  const fix: string[] = [];
  if (useless.length >= 2) {
    parts.push(
      `无用墙 ${useless.length}（拆了路线不变，各退≈${Math.floor(useless[0].invested * 0.7)}g）: ${useless
        .slice(0, 5)
        .map((x) => `#${x.uid}@${x.x},${x.y}`)
        .join(' ')}`,
    );
    fix.push(`{do:"reclaim",target:"useless_walls"${useless.some((x) => x.cov >= 6) ? ',replaceWith:"dps"' : ''}}`);
  }
  if (idle.length) {
    parts.push(
      `零伤害塔 ${idle
        .slice(0, 4)
        .map((u) => `#${u}${s.towers.get(u)?.id ?? ''}`)
        .join(' ')}`,
    );
    fix.push('{do:"reclaim",target:"idle_towers",replaceWith:"dps"}');
  }
  if (crowded.length) {
    parts.push(
      `被挤占格 ${crowded
        .slice(0, 3)
        .map((x) => `${x.x},${x.y}:${x.cov}`)
        .join(' ')}（Lv1 墙占着好格，换塔不改路线）`,
    );
    fix.push('{do:"reclaim",target:"cells"}');
  }
  if (!parts.length) return undefined;
  return `RC ${parts.join(' | ')} → ${fix.join(' ')}`;
}

// ───────────────────────── 迷宫 ─────────────────────────

/** 迷宫强弱：当前路线 vs 规划可达 vs 直线；规划完成度；未利用的障碍物 */
export function mazeStatus(
  w: IWorld,
  plan: MazePlan = planMaze(w),
): { len: number; plan: number; base: number; built: number; total: number; left: number; idleObstacles: string[] } {
  const g = w.state.grid;
  const routes = groundRoutes(w).filter((r) => r.status === 'open' && r.kind !== 'drop');
  const len = routes.length ? Math.min(...routes.map((r) => r.len)) : 0;
  let built = 0;
  let left = 0;
  for (const i of plan.all) {
    if (g.cells[i] !== CellKind.Empty) built++;
    else left++;
  }
  // 未利用的障碍物：与规划里还没建的格相邻、且四周没有任何塔 / 墙
  const unbuilt = new Set(plan.all.filter((i) => g.cells[i] === CellKind.Empty));
  const idleObstacles: string[] = [];
  for (const o of g.obstacles) {
    let touchPlan = false;
    let touchTower = false;
    for (let y = o.y - 1; y <= o.y + o.h; y++)
      for (let x = o.x - 1; x <= o.x + o.w; x++) {
        if (x < 0 || y < 0 || x >= g.cols || y >= g.rows) continue;
        const i = y * g.cols + x;
        if (unbuilt.has(i)) touchPlan = true;
        if (g.cells[i] === CellKind.Tower) touchTower = true;
      }
    if (touchPlan && !touchTower) idleObstacles.push(`${o.x},${o.y} ${o.w}×${o.h}`);
  }
  return { len, plan: Math.round(plan.length), base: Math.round(plan.baseLength), built, total: plan.all.length, left, idleObstacles };
}

/** MZ 行（建造阶段）：路线明显短于规划可达时提醒 */
export function mazeLine(w: IWorld, plan: MazePlan = planMaze(w), wallCost = 5): string | undefined {
  const m = mazeStatus(w, plan);
  if (!m.len || !m.base) return undefined;
  const ratio = m.len / m.base;
  if (m.left === 0 || ratio >= 0.85 * (m.plan / m.base)) return undefined;
  const obs = m.idleObstacles.length ? ` | 未利用障碍 ${m.idleObstacles.slice(0, 3).join('; ')}（规划把它们当墙用）` : '';
  const weak = ratio < 2.5 ? '偏短' : '可再长';
  return `MZ 路线 L${m.len} = 直线 ${m.base} 的 ${ratio.toFixed(1)}×（${weak}），规划可达 L${m.plan}（${(m.plan / m.base).toFixed(1)}×）| 迷宫 ${m.built}/${m.total} 格，还差 ≈${m.left * wallCost}g${obs} → {do:"maze"}（不给 budget = 建到 ≥2.5× 或下一道挡板）`;
}

/** 攻击塔平均覆盖几段路线（同一条路线在射程内断开再进入算一段；评测 / 测试用） */
export function passesPerTower(w: IWorld): number {
  const s = w.state;
  const paths = w.currentPaths();
  const atk = [...s.towers.values()].filter((t: TowerState) => TOWERS[t.id].attacks && TOWERS[t.id].hitsGround);
  if (!atk.length) return 0;
  let tot = 0;
  for (const t of atk) {
    const info = w.getTowerInfo(t.uid);
    const r = info?.range || w.baseRange(t.id).range;
    const inner = info?.innerRange ?? 0;
    for (const p of paths) {
      let inside = false;
      for (const c of p) {
        const d = Math.hypot(c.x - t.cx, c.y - t.cy);
        const now = d <= r + 1e-6 && d >= inner;
        if (now && !inside) tot++;
        inside = now;
      }
    }
  }
  return Math.round((tot / atk.length) * 100) / 100;
}
