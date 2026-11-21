/**
 * 意图规划器（文档 10 §19）：模型在 act 里给出高层意图（造迷宫 / 在哪类位置放几座某塔 / 升级最值的 / 补防空 / 花到剩多少 / 存钱），
 * 由这里确定性地挑具体格子与目标，逐条经 send(cmd)（= World.command 或浏览器的排队出口）执行。
 *
 *  - 迷宫与选位复用内置机器人的逻辑（./maze.ts：蛇形挡板规划、路线采样、射程覆盖）；
 *  - 不直接改任何状态：所有改动都是 Command，被拒就记下原因、换下一个候选；
 *  - 无随机数、遍历顺序固定：同一局面 ⇒ 同一结果；
 *  - 每个意图返回一行"做了什么"（格子、花费、路线长度变化）与被拒 / 跳过的原因。
 */
import { CellKind, type Branch, type Command, type CommandResult, type IWorld, type TowerId, type TowerState } from '../core/types';
import { COMBOS, TOWERS } from '../config/towers';
import { computeDist, tracePath } from '../core/flowfield';
import { threatEstimate } from './battle';
import { coverage as sampleCov, dropStart, planMaze, routeLength, targetCells, type MazePlan, type Sample } from './maze';
import { crowdedCells, idleTowers, refreshStats, shortensRoutes, uselessWalls, wallInfo } from './board';
import type { BattleIntel } from './intel';
import { PURPOSES, PURPOSE_TARGET, PURPOSE_TOWERS, type Purpose } from './purpose';

export { PURPOSES, PURPOSE_TOWERS, type Purpose } from './purpose';

export type Send = (cmd: Command) => CommandResult & { queuedFor?: number };

/** 跨决策的规划器状态（引擎持有；save 意图写这里） */
export interface PlannerState {
  /** 存钱目标：金币低于它时不催花钱 */
  saveUntil?: number;
  /** 存钱目标在第几波设下（过两波自动失效） */
  saveWave?: number;
  /** 战场情报（零伤害塔等；引擎注入） */
  intel?: BattleIntel;
}

export const COMBO_PAIRS = COMBOS.map((c) => `${c.a}+${c.b}`);

export interface IntentOutcome {
  ok: boolean;
  text: string;
  /** 实际花掉的金币（出售退款记为负） */
  spent: number;
  /** 成功的指令数 */
  done: number;
}

/** 每种塔"单位覆盖"的大致价值（秒伤量级），只用于买 / 升比较（与 scripts/bots/strategy.ts 一致） */
export const POWER: Record<TowerId, number> = {
  wall: 0,
  pencil: 16,
  stapler: 26,
  glue: 12,
  lamp: 24,
  compass: 40,
  eraser: 10,
  ruler: 24,
  pen: 20,
  calculator: 0,
  piggy: 0,
  swatter: 30,
};

/** 传奇分支缺省（高手机器人的选择） */
export const DEFAULT_BRANCH: Partial<Record<TowerId, Branch>> = {
  pencil: 'A',
  stapler: 'B',
  glue: 'B',
  lamp: 'A',
  compass: 'B',
  eraser: 'A',
  ruler: 'B',
  pen: 'B',
  calculator: 'A',
  piggy: 'A',
  swatter: 'A',
};

/** spend 的买塔轮换（无状态：按已有数量决定下一座） */
const ROTATION: TowerId[] = [
  'pencil',
  'pencil',
  'pencil',
  'pencil',
  'eraser',
  'pencil',
  'pencil',
  'lamp',
  'pencil',
  'pencil',
  'glue',
  'pencil',
  'lamp',
  'pencil',
  'eraser',
  'pencil',
  'compass',
  'pencil',
  'lamp',
  'pencil',
  'stapler',
  'pencil',
  'compass',
  'ruler',
  'lamp',
  'pencil',
];
/** 墙的投入上限：塔投入的这个比例 + 25（高手机器人 0.5） */
const WALL_SHARE = 0.5;

function levelGain(id: TowerId, next: number): number {
  let g = 0.186;
  if (next === 4)
    g += ({ pencil: 0.15, compass: 0.25, lamp: 0.3, stapler: 0.1, eraser: 0.3, pen: 0.2 } as Partial<Record<TowerId, number>>)[id] ?? 0.1;
  if (next === 7)
    g +=
      (
        { pencil: 1.0, lamp: 0.8, ruler: 1.6, compass: 0.4, stapler: 0.3, pen: 0.3, glue: 0.3, eraser: 0.3 } as Partial<
          Record<TowerId, number>
        >
      )[id] ?? 0.2;
  if (next === 10) g += 0.5;
  return g;
}

/** 路线采样（带出生点 id 与进度 f） */
export interface RSample extends Sample {
  sp: string;
  f: number;
}

interface Slot {
  x: number;
  y: number;
  i: number;
  wallUid: number;
  plan: boolean;
}

// 可自动挪位的放置失败原因（CommandResult.code，与界面语言无关）
const FIXABLE = new Set(['enemyHere', 'cantBuild', 'occupied', 'blocksPath', 'trapsEnemy']);

/** 每次 act 新建一个（局面快照），意图之间共享"已排队但未落地"的格子与金币 */
export class Planner {
  readonly plan: MazePlan;
  private readonly cols: number;
  private readonly rows: number;
  private readonly scratch: Float32Array;
  /** realtime 排队的放置：格子已占用、金币已扣 */
  private reserved = new Set<number>();
  private pendingGold = 0;
  private cacheKey = '';
  private gS: RSample[] = [];
  private aS: RSample[] = [];
  /** 规划完全建成后的路线采样（规划外的格子按它打分：迷宫建完后仍在射程内才有用） */
  private fS: RSample[] = [];
  /** 当前（真实）路线采样：新塔现在就要打得到 */
  private cS: RSample[] = [];
  /** 规划路线（迷宫建成后）经过的格子：不在这里放塔，免得堵住规划 */
  private planned = new Set<number>();

  constructor(
    readonly w: IWorld,
    private readonly send: Send,
    readonly state: PlannerState = {},
  ) {
    this.plan = planMaze(w);
    this.cols = w.state.grid.cols;
    this.rows = w.state.grid.rows;
    this.scratch = new Float32Array(this.cols * this.rows);
  }

  // ───────────── 基础 ─────────────

  gold(): number {
    return Math.floor(this.w.state.gold - this.pendingGold);
  }

  cost(id: TowerId): number {
    return this.w.getBuildOptions().find((o) => o.id === id)?.cost ?? TOWERS[id].cost;
  }

  private unlocked(id: TowerId): boolean {
    const b = this.w.getBuildOptions().find((o) => o.id === id);
    return !!b && b.unlocked && !b.limitReached;
  }

  private towers(): TowerState[] {
    return [...this.w.state.towers.values()];
  }

  private attackers(): TowerState[] {
    return this.towers().filter((t) => TOWERS[t.id].attacks);
  }

  private exec(cmd: Command): CommandResult & { queuedFor?: number } {
    const r = this.send(cmd);
    // realtime 排队：格子与金币先记在本地，后续候选不会重复用到
    if (r.ok && r.queuedFor !== undefined && cmd.type === 'place') {
      this.reserved.add(cmd.cy * this.cols + cmd.cx);
      this.pendingGold += this.cost(cmd.tower);
    }
    if (r.ok) this.cacheKey = '';
    return r;
  }

  private empty(i: number): boolean {
    return this.w.state.grid.cells[i] === CellKind.Empty && !this.reserved.has(i);
  }

  pathLens(): number[] {
    return this.w.currentPaths().map((p) => p.length);
  }

  /** 规划里已建成的段数 + 1（只看近期能建成的部分；与机器人同规则） */
  private activeSegments(): number {
    const g = this.w.state.grid;
    let built = 0;
    for (; built < this.plan.segments.length; built++) {
      if (this.plan.segments[built].some((i) => g.cells[i] === CellKind.Empty && this.wallPlaceable(i))) break;
    }
    return Math.min(this.plan.segments.length, built + 1);
  }

  private wallPlaceable(i: number): boolean {
    const r = this.w.canPlace('wall', i % this.cols, Math.floor(i / this.cols));
    return r.ok || r.code === 'noGold' || r.code === 'enemyHere';
  }

  /** 迷宫完成度：规划格里已被占用（墙或塔）的比例 */
  mazeProgress(): { built: number; total: number; left: number } {
    const g = this.w.state.grid;
    let built = 0;
    let left = 0;
    for (const i of this.plan.all) {
      if (g.cells[i] !== CellKind.Empty) built++;
      else if (this.wallPlaceable(i)) left++;
    }
    return { built, total: this.plan.all.length, left };
  }

  /** 路线采样（按规划的前 nSeg 段建成后的格子） */
  private refresh(): void {
    const g = this.w.state.grid;
    const nSeg = this.activeSegments();
    const key = `${g.version}|${nSeg}|${this.w.state.spawners
      .filter((s) => s.active)
      .map((s) => s.id)
      .join(',')}|${this.reserved.size}`;
    if (key === this.cacheKey) return;
    this.cacheKey = key;
    const cells = targetCells(this.w, this.plan, nSeg, this.scratch);
    for (const i of this.reserved) cells[i] = CellKind.Tower;
    this.gS = routeSamples(this.w, cells, this.scratch);
    const cur = g.cells.slice();
    for (const i of this.reserved) cur[i] = CellKind.Tower;
    this.cS = routeSamples(this.w, cur, this.scratch);
    this.aS = airLineSamples(this.w);
    // 规划完全建成后的路线：不在上面放塔（任何不在这条路线上的格子都不可能让规划失效）
    const full = targetCells(this.w, this.plan, this.plan.segments.length, this.scratch);
    for (const i of this.reserved) full[i] = CellKind.Tower;
    this.fS = routeSamples(this.w, full, this.scratch);
    this.planned = new Set(this.fS.map((s) => Math.floor(s.y) * this.cols + Math.floor(s.x)));
  }

  /** 候选格：规划的迷宫格（空格或可替换的 Lv1 墙）+ 不在当前 / 规划路线上的空格 */
  private slots(): Slot[] {
    const g = this.w.state.grid;
    const out: Slot[] = [];
    const seen = new Set<number>();
    const nSeg = this.activeSegments();
    for (let k = 0; k < nSeg; k++) {
      for (const i of this.plan.segments[k]) {
        seen.add(i);
        const x = i % this.cols;
        const y = (i - x) / this.cols;
        if (this.empty(i)) out.push({ x, y, i, wallUid: 0, plan: true });
        else if (g.cells[i] === CellKind.Tower) {
          const t = this.w.state.towers.get(g.towerAt[i]);
          if (t && t.id === 'wall' && t.level === 1) out.push({ x, y, i, wallUid: t.uid, plan: true });
        }
      }
    }
    const onRoute = new Set<number>();
    for (const p of this.w.currentPaths()) for (const c of p) onRoute.add(c.y * this.cols + c.x);
    for (let i = 0; i < g.cells.length; i++) {
      if (seen.has(i) || !this.empty(i) || onRoute.has(i) || this.planned.has(i)) continue;
      out.push({ x: i % this.cols, y: Math.floor(i / this.cols), i, wallUid: 0, plan: false });
    }
    return out;
  }

  private range(id: TowerId): { r: number; inner: number } {
    const b = this.w.baseRange(id);
    return { r: b.range + 0.3, inner: b.inner ?? 0 };
  }

  private adjacent(x: number, y: number, id: TowerId): boolean {
    const g = this.w.state.grid;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
      const t = this.w.state.towers.get(g.towerAt[ny * this.cols + nx]);
      if (t && t.id === id) return true;
    }
    return false;
  }

  /** 目标 → 采样集合与对空权重 */
  private samplesFor(
    id: TowerId,
    target: string,
    which: 'near' | 'final' | 'current' = 'near',
  ): { ground: RSample[]; air: RSample[]; airW: number } {
    this.refresh();
    const def = TOWERS[id];
    const [kind, arg] = target.split(':');
    const base = which === 'final' ? this.fS : which === 'current' ? this.cS : this.gS;
    let ground = def.hitsGround ? base : [];
    let air = def.hitsAir ? this.aS : [];
    let airW = 1;
    switch (kind) {
      case 'early':
        ground = ground.filter((s) => s.f <= 0.4);
        break;
      case 'exit':
        ground = ground.filter((s) => s.f >= 0.6);
        air = air.filter((s) => s.f >= 0.5);
        break;
      case 'route':
        if (arg) {
          ground = ground.filter((s) => s.sp === arg);
          air = air.filter((s) => s.sp === arg);
        }
        break;
      case 'seg': {
        // seg:x1,y1-x2,y2 → 只看这个矩形（外扩半格）里的路线采样（漏怪缺口）
        const m = /^(\d+),(\d+)-(\d+),(\d+)$/.exec(arg ?? '');
        if (m) {
          const [x1, y1, x2, y2] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
          const inBox = (q: RSample) =>
            q.x >= Math.min(x1, x2) - 0.5 &&
            q.x <= Math.max(x1, x2) + 1.5 &&
            q.y >= Math.min(y1, y2) - 0.5 &&
            q.y <= Math.max(y1, y2) + 1.5;
          ground = ground.filter(inBox);
          air = air.filter(inBox);
        }
        break;
      }
      case 'air':
      case 'airline': {
        air = def.hitsAir ? this.aS.filter((s) => !arg || s.sp === arg) : [];
        ground = ground.map((s) => ({ ...s, w: s.w * 0.1 }));
        airW = 3;
        break;
      }
      case 'chokepoint': {
        // 多条路线汇合处：每个采样按附近（0.75 格内）经过的路线条数加权
        const near = (s: RSample) =>
          new Set(this.gS.filter((o) => Math.abs(o.x - s.x) <= 0.75 && Math.abs(o.y - s.y) <= 0.75).map((o) => o.sp)).size;
        ground = ground.map((s) => ({ ...s, w: s.w * near(s) ** 2 }));
        void base;
        break;
      }
      default:
        break;
    }
    return { ground, air, airW };
  }

  /** 某塔放在某格的价值（覆盖 × 组合技加成；计算器 / 存钱罐按机器人的规则） */
  private slotValue(id: TowerId, sl: { x: number; y: number }, s: { ground: RSample[]; air: RSample[]; airW: number }): number {
    if (id === 'calculator') {
      let v = 0;
      for (const t of this.attackers()) {
        if ((t.cx - sl.x) ** 2 + (t.cy - sl.y) ** 2 <= 4 + 1e-6) v += 1.19 ** (t.level - 1) * (POWER[t.id] || 10);
      }
      return this.adjacent(sl.x, sl.y, 'piggy') ? v * 1.15 : v;
    }
    if (id === 'piggy') return 100 - sampleCov(sl.x, sl.y, 2.5, 0, this.gS) + (this.adjacent(sl.x, sl.y, 'calculator') ? 50 : 0);
    const { r, inner } = this.range(id);
    let v = s.ground.length ? sampleCov(sl.x, sl.y, r, inner, s.ground) : 0;
    if (s.air.length) v += s.airW * sampleCov(sl.x, sl.y, r, 0, s.air);
    for (const cb of COMBOS) {
      const partner = cb.a === id ? cb.b : cb.b === id ? cb.a : null;
      if (partner && this.adjacent(sl.x, sl.y, partner)) v *= 1.15;
    }
    return v;
  }

  /**
   * 最佳格（不含 exclude）；只返回 canPlace 通过（或是可替换的墙）的格。
   * 先看规划的迷宫格（与机器人相同：按近期路线打分，塔同时是迷宫墙）；没有有用的规划格时（迷宫已建满 / 对空目标）
   * 才用规划外的空格，并按"迷宫建完后的路线"打分——否则塔会放在迷宫建成后就够不着的地方。
   */
  bestSlot(id: TowerId, target = 'route', exclude?: Set<number>): { slot: Slot; v: number } | null {
    const near = this.samplesFor(id, target);
    const cur = this.samplesFor(id, target, 'current');
    const far = this.samplesFor(id, target, 'final');
    const airTarget = /^air/.test(target);
    const all = this.slots();
    const pick = (list: Slot[], s: (sl: Slot) => number): { slot: Slot; v: number } | null => {
      let best: Slot | null = null;
      let bv = 0;
      for (const sl of list) {
        if (exclude?.has(sl.i)) continue;
        const v = s(sl);
        if (v <= bv + 1e-9) continue;
        if (!sl.wallUid) {
          const r = this.w.canPlace(id, sl.x, sl.y);
          if (!r.ok && r.code !== 'noGold') continue;
        }
        best = sl;
        bv = v;
      }
      return best ? { slot: best, v: bv } : null;
    };
    const planSlots = all.filter((sl) => sl.plan);
    const offSlots = all.filter((sl) => !sl.plan);
    if (airTarget) return pick(all, (sl) => this.slotValue(id, sl, sl.plan ? near : far));
    // 规划格：一半看"下一道挡板建成后"的路线（机器人的口径），一半看现在的路线（这一波就要打得到）
    const p = pick(planSlots, (sl) => 0.5 * this.slotValue(id, sl, near) + 0.5 * this.slotValue(id, sl, cur));
    if (p && (p.v >= 1 || id === 'piggy' || id === 'calculator')) return p;
    const o = pick(offSlots, (sl) => this.slotValue(id, sl, far));
    return o && (!p || o.v > p.v) ? o : p;
  }

  /** 放一座塔（必要时先卖掉该格的 Lv1 墙）；返回结果行 */
  private placeAt(id: TowerId, sl: Slot): { ok: boolean; line: string; spent: number } {
    const cost = this.cost(id);
    if (this.gold() + (sl.wallUid ? 3 : 0) < cost)
      return { ok: false, line: `${id}@${sl.x},${sl.y} 金币不足 (cost ${cost}, gold ${this.gold()})`, spent: 0 };
    const g0 = this.w.state.gold;
    if (sl.wallUid) {
      const r = this.exec({ type: 'sell', uid: sl.wallUid });
      if (!r.ok) return { ok: false, line: `${id}@${sl.x},${sl.y} sell wall #${sl.wallUid}: ${r.reason}`, spent: 0 };
    }
    const r = this.exec({ type: 'place', tower: id, cx: sl.x, cy: sl.y });
    if (!r.ok) {
      if (sl.wallUid) this.exec({ type: 'place', tower: 'wall', cx: sl.x, cy: sl.y });
      return { ok: false, line: `${id}@${sl.x},${sl.y} ${r.reason}`, spent: Math.round(g0 - this.w.state.gold) };
    }
    const uid = this.w.state.grid.towerAt[sl.i];
    if (id === 'lamp' && uid && r.queuedFor === undefined) this.exec({ type: 'setTarget', uid, mode: 'strong' });
    const spent = r.queuedFor !== undefined ? cost : Math.round(g0 - this.w.state.gold);
    return {
      ok: true,
      line: `${id}#${r.queuedFor !== undefined ? '?' : uid}@${sl.x},${sl.y}${sl.wallUid ? '(replaced wall)' : ''} -${spent}g`,
      spent,
    };
  }

  // ───────────── 意图 ─────────────

  /** maze：按规划逐格放墙（serpentine）或贪心放能让路线变长最多的墙（funnel），最多花 budget */
  maze(style: 'serpentine' | 'funnel' = 'serpentine', budget?: number, route?: string, exact = false): IntentOutcome {
    const wallCost = this.cost('wall');
    // 预算（模型的意图）：不给 = 建到路线 ≥ 2.5× 直线（或至少下一道挡板）；给了也至少补完正在建的这道挡板（半道挡板不拉长路线）。
    // exact：spend 内部调用，按给的预算
    const want = style === 'serpentine' && !exact ? this.mazeBudget(budget) : budget;
    const cap = Math.min(want ?? Infinity, this.gold());
    const before = this.pathLens();
    let spent = 0;
    let done = 0;
    const skipped = new Map<string, number>();
    const skip = (why: string) => skipped.set(why, (skipped.get(why) ?? 0) + 1);
    if (style === 'funnel') {
      for (let guard = 0; guard < 24 && spent + wallCost <= cap; guard++) {
        const c = this.bestFunnelWall(route);
        if (!c) break;
        const r = this.exec({ type: 'place', tower: 'wall', cx: c.x, cy: c.y });
        if (!r.ok) {
          skip(r.reason ?? 'invalid');
          break;
        }
        spent += wallCost;
        done++;
      }
    } else {
      outer: for (const seg of this.plan.segments) {
        for (const i of seg) {
          if (!this.empty(i)) continue;
          if (spent + wallCost > cap || this.gold() < wallCost) break outer;
          const r = this.exec({ type: 'place', tower: 'wall', cx: i % this.cols, cy: Math.floor(i / this.cols) });
          if (r.ok) {
            spent += wallCost;
            done++;
          } else skip(r.reason ?? 'invalid');
        }
      }
    }
    const after = this.pathLens();
    const pg = this.mazeProgress();
    const sk = skipped.size ? ` skipped ${[...skipped].map(([k, v]) => `${k}×${v}`).join(',')}` : '';
    const tail =
      style === 'serpentine'
        ? ` | plan ${pg.built}/${pg.total} cells, L${Math.round(this.plan.length)} when done, ${pg.left} left ≈${pg.left * wallCost}g`
        : '';
    const text = done
      ? `maze ${style}: +${done} walls -${spent}g path ${before.join('/')}→${after.join('/')}${sk}${tail}`
      : `maze ${style}: nothing built (${this.gold() < wallCost ? `gold ${this.gold()}` : pg.left === 0 && style === 'serpentine' ? 'plan complete' : 'no useful wall'})${sk}${tail}`;
    return { ok: done > 0 || (style === 'serpentine' && pg.left === 0), text, spent, done };
  }

  /** serpentine 的预算：见 maze() */
  private mazeBudget(budget?: number): number | undefined {
    const g = this.w.state.grid;
    const wallCost = this.cost('wall');
    const segLeft = this.plan.segments.map((seg) => seg.filter((i) => g.cells[i] === CellKind.Empty && !this.reserved.has(i)).length);
    const k = segLeft.findIndex((n) => n > 0);
    if (k < 0) return budget;
    const finishCur = segLeft[k] * wallCost;
    if (budget !== undefined) return Math.max(budget, finishCur);
    // 按规划顺序累加，直到路线 ≥ 2.5× 直线
    const cells = g.cells.slice();
    const target = 2.5 * Math.max(1, this.plan.baseLength);
    let need = 0;
    for (let j = k; j < this.plan.segments.length; j++) {
      if (routeLength(this.w, cells, this.scratch) >= target && need >= finishCur) break;
      for (const i of this.plan.segments[j]) {
        if (cells[i] !== CellKind.Empty || this.reserved.has(i)) continue;
        cells[i] = CellKind.Tower;
        if (routeLength(this.w, cells, this.scratch) < 0) cells[i] = CellKind.Empty;
        else need += wallCost;
      }
    }
    return Math.max(need, finishCur);
  }

  /** 让（指定 / 全部）路线变长最多的单格墙（只看当前路线旁边的格子；用 previewPath，与真实放置同规则） */
  private bestFunnelWall(route?: string): { x: number; y: number; gain: number } | null {
    const w = this.w;
    const ids = w.state.spawners.filter((s) => s.active).map((s) => s.id);
    const paths = w.currentPaths();
    const pick = (ps: { x: number; y: number }[][]): number => {
      if (route) {
        const k = ids.indexOf(route);
        if (k >= 0 && ps[k]) return ps[k].length;
      }
      return ps.reduce((a, p) => a + p.length, 0);
    };
    const cur = pick(paths);
    const cand = new Set<number>();
    for (const p of paths)
      for (const c of p) {
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const x = c.x + dx;
            const y = c.y + dy;
            if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) continue;
            const i = y * this.cols + x;
            if (this.empty(i)) cand.add(i);
          }
      }
    let best: { x: number; y: number; gain: number } | null = null;
    for (const i of [...cand].sort((a, b) => a - b)) {
      const x = i % this.cols;
      const y = Math.floor(i / this.cols);
      if (!w.canPlace('wall', x, y).ok) continue;
      const pv = w.previewPath('wall', x, y);
      if (!pv) continue;
      const gain = pick(pv) - cur;
      if (gain >= 1 && (!best || gain > best.gain)) best = { x, y, gain };
    }
    return best;
  }

  /** build_near：在 target 类位置放 count 座 tower */
  buildNear(id: TowerId, target = 'route', count = 1): IntentOutcome {
    if (!TOWERS[id]) return { ok: false, text: `build_near: unknown tower ${id}`, spent: 0, done: 0 };
    if (id === 'wall') return { ok: false, text: 'build_near: walls → use {do:"maze"}', spent: 0, done: 0 };
    if (!this.unlocked(id)) return { ok: false, text: `build_near ${id}: locked or at limit`, spent: 0, done: 0 };
    const tgt = target || (id === 'eraser' || id === 'glue' ? 'early' : 'route');
    const lines: string[] = [];
    let spent = 0;
    let done = 0;
    const tried = new Set<number>();
    for (let k = 0; k < Math.min(8, Math.max(1, count)); k++) {
      if (this.gold() < this.cost(id)) {
        lines.push(`stop: 金币不足 (cost ${this.cost(id)}, gold ${this.gold()})`);
        break;
      }
      let placed = false;
      for (let attempt = 0; attempt < 4 && !placed; attempt++) {
        const b = this.bestSlot(id, tgt, tried);
        if (!b) {
          lines.push('stop: no valid cell');
          k = 99;
          break;
        }
        tried.add(b.slot.i);
        const r = this.placeAt(id, b.slot);
        if (r.ok) {
          placed = true;
          spent += r.spent;
          done++;
          lines.push(`${r.line} cov${Math.round(b.v * 10) / 10}`);
        } else lines.push(`skip ${r.line}`);
      }
      if (!placed && k < 99) break;
    }
    return { ok: done > 0, text: `build_near ${id} ${tgt}: ${lines.join('; ')} → path ${this.pathLens().join('/')}`, spent, done };
  }

  /** 升级价值（每金币收益）；与机器人 bestUpgrade 同口径。metric=coverage 不除以价格 */
  private upgradeCandidates(metric: 'dps' | 'coverage'): { t: TowerState; cost: number; eff: number; evolve: boolean }[] {
    this.refresh();
    const out: { t: TowerState; cost: number; eff: number; evolve: boolean }[] = [];
    for (const t of this.towers()) {
      if (t.id === 'wall') continue;
      const info = this.w.getTowerInfo(t.uid);
      if (!info) continue;
      const evolve = t.level >= 10;
      const cost = evolve ? info.evolveCost : info.upgradeCost;
      if (cost === null) continue;
      let val: number;
      if (t.id === 'piggy') val = t.level < 9 && !evolve ? 10 : 0.02;
      else if (t.id === 'calculator') val = 0.01 * this.slotValue('calculator', { x: t.cx, y: t.cy }, { ground: [], air: [], airW: 1 }) * 3;
      else {
        const r = this.range(t.id);
        let cov = TOWERS[t.id].hitsGround ? sampleCov(t.cx, t.cy, r.r, r.inner, this.gS) : 0;
        if (TOWERS[t.id].hitsAir) cov += sampleCov(t.cx, t.cy, r.r, 0, this.aS);
        const power = evolve ? POWER[t.id] * 1.186 ** 9 * 1.5 : POWER[t.id] * 1.186 ** (t.level - 1);
        val = cov * power * (evolve ? (t.stars === 2 ? 0.35 : 0.16) : levelGain(t.id, t.level + 1));
      }
      out.push({ t, cost, eff: metric === 'coverage' ? val : val / cost, evolve });
    }
    return out.sort((a, b) => b.eff - a.eff || a.t.uid - b.t.uid);
  }

  upgradeBest(n = 1, metric: 'dps' | 'coverage' = 'dps', budget?: number): IntentOutcome {
    const lines: string[] = [];
    let spent = 0;
    let done = 0;
    const cap = budget ?? Infinity;
    for (let k = 0; k < Math.min(10, Math.max(1, n)); k++) {
      const c = this.upgradeCandidates(metric).find((x) => x.cost <= this.gold() && spent + x.cost <= cap);
      if (!c) {
        const top = this.upgradeCandidates(metric)[0];
        lines.push(top ? `stop: best #${top.t.uid} ${top.t.id} needs ${top.cost}g (gold ${this.gold()})` : 'stop: nothing to upgrade');
        break;
      }
      const r = this.upgradeOne(c.t, c.evolve);
      if (!r.ok) {
        lines.push(`#${c.t.uid} ${r.reason}`);
        break;
      }
      spent += r.spent;
      done++;
      lines.push(r.line);
    }
    return { ok: done > 0, text: `upgrade_best ${metric}: ${lines.join('; ')}`, spent, done };
  }

  private upgradeOne(t: TowerState, evolve: boolean): { ok: boolean; reason?: string; line: string; spent: number } {
    const g0 = this.w.state.gold;
    const cmd: Command = evolve
      ? { type: 'evolve', uid: t.uid }
      : t.level === 9
        ? { type: 'upgrade', uid: t.uid, branch: DEFAULT_BRANCH[t.id] ?? 'A' }
        : { type: 'upgrade', uid: t.uid };
    const r = this.exec(cmd);
    if (!r.ok) return { ok: false, reason: r.reason ?? 'invalid', line: '', spent: 0 };
    const nt = this.w.state.towers.get(t.uid);
    const spent = Math.round(g0 - this.w.state.gold);
    return {
      ok: true,
      line: `#${t.uid} ${t.id} →${evolve ? `★${nt?.stars ?? '?'}` : `L${nt?.level ?? '?'}${nt?.branch ? nt.branch : ''}`} -${spent}g`,
      spent,
    };
  }

  /** 每条飞行线的对空火力（覆盖 × 威力），最弱的排前面 */
  airLines(): { id: string; power: number }[] {
    this.refresh();
    const ids = [...new Set(this.aS.map((s) => s.sp))];
    return ids
      .map((id) => {
        const line = this.aS.filter((s) => s.sp === id);
        let p = 0;
        for (const t of this.attackers()) {
          if (!TOWERS[t.id].hitsAir) continue;
          const r = this.range(t.id);
          p += sampleCov(t.cx, t.cy, r.r, 0, line) * (POWER[t.id] || 10) * 1.186 ** (t.level - 1);
        }
        return { id, power: Math.round(p) };
      })
      .sort((a, b) => a.power - b.power);
  }

  antiAir(line?: string, count = 1): IntentOutcome {
    const lines = this.airLines();
    const tgt = line ?? lines[0]?.id;
    if (!tgt) return { ok: false, text: 'anti_air: no flight lines', spent: 0, done: 0 };
    const id: TowerId = this.unlocked('swatter') && this.gold() >= this.cost('swatter') ? 'swatter' : 'pencil';
    const r = this.buildNear(id, `airline:${tgt}`, count);
    return { ...r, text: `anti_air ${tgt}: ${r.text}` };
  }

  /** spend：按机器人的买 / 升规则把金币花到 reserve 为止（结果合并成一行：新塔 / 墙 / 升级 / 路线） */
  spend(reserve = 0, focus: 'balanced' | 'towers' | 'upgrades' | 'maze' = 'balanced'): IntentOutcome {
    const s = this.w.state;
    const g0 = this.gold();
    const path0 = this.pathLens();
    const built: string[] = [];
    const ups: string[] = [];
    const aa: string[] = [];
    let walls = 0;
    let wallGold = 0;
    let spent = 0;
    let done = 0;
    let saving = '';
    const wave = s.wave + 1;
    const maxTowers = Math.min(8 + Math.floor(wave * 1.5), 48);
    for (let guard = 0; guard < 40; guard++) {
      const budget = this.gold() - reserve;
      if (budget <= 0) break;
      const atk = this.attackers();
      // 防空：下一波有空军、某条飞行线几乎没有对空
      if (atk.length >= 3 && s.nextWave.tags.includes('air')) {
        const weak = this.airLines().find((l) => l.power < 40);
        if (weak && budget >= this.cost('pencil')) {
          const o = this.antiAir(weak.id, 1);
          if (o.done) {
            spent += o.spent;
            done += o.done;
            aa.push(weak.id);
            continue;
          }
        }
      }
      // 迷宫：墙的投入 ≤ 50% 塔的投入 + 25（maze 优先时不设限）
      const wallInv = this.towers()
        .filter((t) => t.id === 'wall')
        .reduce((x, t) => x + t.invested, 0);
      const towerInv = atk.reduce((x, t) => x + t.invested, 0);
      if (atk.length >= 3 && this.mazeProgress().left > 0 && (focus === 'maze' || wallInv < WALL_SHARE * towerInv + 25)) {
        const cap = focus === 'maze' ? budget : Math.max(this.cost('wall'), Math.min(budget, WALL_SHARE * towerInv + 25 - wallInv));
        const o = this.maze('serpentine', cap, undefined, true);
        if (o.done) {
          spent += o.spent;
          done += o.done;
          walls += o.done;
          wallGold += o.spent;
          continue;
        }
      }
      const id = this.nextRotation();
      const slot =
        id && atk.length < maxTowers && focus !== 'upgrades'
          ? this.bestSlot(id, id === 'eraser' || id === 'glue' ? 'early' : 'route')
          : null;
      const up = atk.length >= Math.min(2 + wave, 6) && focus !== 'towers' ? this.upgradeCandidates('dps')[0] : undefined;
      let buy = !!slot;
      if (slot && up && id && focus === 'balanced') {
        const support = !(POWER[id] > 0);
        buy = support || id === 'glue' || id === 'eraser' || (slot.v * POWER[id]) / this.cost(id) >= up.eff;
      }
      if (focus === 'upgrades' && up) buy = false;
      if (buy && slot && id) {
        if (budget < this.cost(id)) {
          // 危急（下一波有路线"危险"或本局已漏怪）：不攒钱，先买得起的铅笔
          if (id !== 'pencil' && budget >= this.cost('pencil') && this.urgent()) {
            const ps = this.bestSlot('pencil');
            const r = ps ? this.placeAt('pencil', ps.slot) : null;
            if (r?.ok) {
              spent += r.spent;
              done++;
              built.push(r.line.replace(/ -\d+g$/, ''));
              continue;
            }
          }
          saving = `saving for ${id} ${this.cost(id)}g`;
          break;
        }
        const r = this.placeAt(id, slot.slot);
        if (r.ok) {
          spent += r.spent;
          done++;
          built.push(r.line.replace(/ -\d+g$/, ''));
          continue;
        }
        break;
      }
      if (up) {
        if (budget < up.cost) {
          saving = `saving for #${up.t.uid} ${up.evolve ? 'evolve' : 'upgrade'} ${up.cost}g`;
          break;
        }
        const r = this.upgradeOne(up.t, up.evolve);
        if (r.ok) {
          spent += r.spent;
          done++;
          ups.push(r.line.replace(/ -\d+g$/, ''));
          continue;
        }
        break;
      }
      break;
    }
    const left = this.gold();
    const pg = this.mazeProgress();
    const parts: string[] = [];
    if (built.length) parts.push(`+${built.join(' +')}`);
    if (aa.length) parts.push(`anti-air ${aa.join(',')}`);
    if (walls) parts.push(`walls +${walls} (-${wallGold}g)`);
    if (ups.length) parts.push(`up ${ups.join(' ')}`);
    parts.push(`spent ${g0 - left}g, gold ${left}${saving ? ` (${saving})` : ''}`);
    parts.push(`path ${path0.join('/')}→${this.pathLens().join('/')}`);
    parts.push(
      `maze ${pg.built}/${pg.total} (L${Math.round(this.plan.length)} when done${pg.left ? `, ≈${pg.left * this.cost('wall')}g of walls left` : ''})`,
    );
    return { ok: true, text: `spend→${reserve}: ${done ? '' : 'nothing bought; '}${parts.join(' | ')}`, spent, done };
  }

  /** 危急：下一波有地面 / 空中线威胁"危险"，或已经漏过怪 */
  private urgent(): boolean {
    const s = this.w.state;
    if (s.lives < s.maxLives) return true;
    return threatEstimate(this.w).some((t) => t.verdict === '危险');
  }

  /** 下一座要买的塔：按轮换表与已有数量（无状态） */
  nextRotation(): TowerId | null {
    const have = new Map<TowerId, number>();
    for (const t of this.attackers()) have.set(t.id, (have.get(t.id) ?? 0) + 1);
    const want = new Map<TowerId, number>();
    for (const id of ROTATION) {
      want.set(id, (want.get(id) ?? 0) + 1);
      if (!this.unlocked(id)) continue;
      if (id === 'calculator' && this.attackers().length < 8) continue;
      if ((have.get(id) ?? 0) < want.get(id)!) return id;
    }
    // 轮换表用完：继续按比例补铅笔 / 台灯 / 圆规
    for (const id of ['pencil', 'lamp', 'compass', 'stapler'] as TowerId[]) if (this.unlocked(id)) return id;
    return null;
  }

  // ───────────── 用途 / 组合技 / 增益 / 经济 ─────────────

  /** 用途 → 这次该买哪座塔（买得起的里面 覆盖 × 威力 × 适配 ÷ 价格 最高；同类已多的打折，鼓励多样） */
  towerForPurpose(purpose: Purpose, target?: string): { id: TowerId; v: number; why: string } | null {
    const cand = PURPOSE_TOWERS[purpose];
    if (!cand) return null;
    const have = new Map<TowerId, number>();
    for (const t of this.attackers()) have.set(t.id, (have.get(t.id) ?? 0) + 1);
    let best: { id: TowerId; v: number; why: string; score: number } | null = null;
    const skipped: string[] = [];
    for (const [id, fit] of Object.entries(cand) as [TowerId, number][]) {
      if (!this.unlocked(id)) continue;
      if (this.cost(id) > this.gold()) {
        skipped.push(`${id} ${this.cost(id)}g`);
        continue;
      }
      const b = this.bestSlot(id, target ?? PURPOSE_TARGET[purpose] ?? 'route');
      if (!b || b.v < 0.5) continue;
      const score = (b.v * (POWER[id] || 10) * fit) / this.cost(id) / (1 + 0.12 * (have.get(id) ?? 0));
      if (!best || score > best.score + 1e-9) best = { id, v: b.v, score, why: `${id} cov${Math.round(b.v * 10) / 10}` };
    }
    if (!best) return null;
    return { id: best.id, v: best.v, why: best.why + (skipped.length ? ` (afford later: ${skipped.join(',')})` : '') };
  }

  /** build_near 的用途版：按用途挑塔，逐座重新挑（第二座可能换成别的类型） */
  buildPurpose(purpose: Purpose, target = '', count = 1): IntentOutcome {
    const lines: string[] = [];
    let spent = 0;
    let done = 0;
    for (let k = 0; k < Math.min(6, Math.max(1, count)); k++) {
      const pick = this.towerForPurpose(purpose, target || undefined);
      if (!pick) {
        lines.push(`stop: no affordable ${purpose} tower with a useful cell (gold ${this.gold()})`);
        break;
      }
      const o = this.buildNear(pick.id, target || PURPOSE_TARGET[purpose] || 'route', 1);
      spent += o.spent;
      done += o.done;
      lines.push(o.text.replace(/^build_near /, ''));
      if (!o.done) break;
    }
    return { ok: done > 0, text: `build_near purpose=${purpose}: ${lines.join(' / ')}`, spent, done };
  }

  /** 前 k 个可放格（与 bestSlot 同一打分） */
  private rankSlots(id: TowerId, target: string, k: number): { slot: Slot; v: number }[] {
    const near = this.samplesFor(id, target);
    const cur = this.samplesFor(id, target, 'current');
    const far = this.samplesFor(id, target, 'final');
    const out: { slot: Slot; v: number }[] = [];
    for (const sl of this.slots()) {
      const v = sl.plan ? 0.5 * this.slotValue(id, sl, near) + 0.5 * this.slotValue(id, sl, cur) : this.slotValue(id, sl, far);
      if (v <= 0) continue;
      if (!sl.wallUid) {
        const r = this.w.canPlace(id, sl.x, sl.y);
        if (!r.ok && r.code !== 'noGold') continue;
      }
      out.push({ slot: sl, v });
    }
    return out.sort((a, b) => b.v - a.v || a.slot.i - b.slot.i).slice(0, k);
  }

  private neighbors(i: number): number[] {
    const x = i % this.cols;
    const y = (i - x) / this.cols;
    const out: number[] = [];
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < this.cols && ny < this.rows) out.push(ny * this.cols + nx);
    }
    return out;
  }

  /** combo：把一对组合技塔放成上下左右相邻（优先给已有的落单塔配搭档），near = 目标位置（route / early / seg:… 等） */
  combo(pair: string, near = 'route'): IntentOutcome {
    const [pa, pb] = pair.split('+') as TowerId[];
    const cb = COMBOS.find((c) => (c.a === pa && c.b === pb) || (c.a === pb && c.b === pa));
    if (!cb) return { ok: false, text: `combo: unknown pair "${pair}" (${COMBO_PAIRS.join(' | ')})`, spent: 0, done: 0 };
    for (const id of [cb.a, cb.b])
      if (!this.unlocked(id)) return { ok: false, text: `combo ${pair}: ${id} locked or at limit`, spent: 0, done: 0 };
    const slotMap = new Map(this.slots().map((sl) => [sl.i, sl]));
    const value = (id: TowerId, sl: Slot): number => {
      if (!sl.wallUid) {
        const r = this.w.canPlace(id, sl.x, sl.y);
        if (!r.ok && r.code !== 'noGold') return -1;
      }
      const sm = this.samplesFor(id, near, sl.plan ? 'near' : 'final');
      return this.slotValue(id, sl, sm);
    };
    // 搭档格至少要有这种塔最好格 70% 的覆盖（组合技加成 15～30%，换不回明显更差的位置）
    const bestV = new Map<TowerId, number>();
    const floor = (id: TowerId): number => {
      if (!bestV.has(id)) bestV.set(id, this.bestSlot(id, near)?.v ?? 0);
      return id === 'piggy' || id === 'calculator' ? 0 : 0.7 * bestV.get(id)!;
    };
    // 1) 已有的落单塔：在它旁边放搭档
    refreshStats(this.w);
    let anchor: { partner: TowerId; sl: Slot; v: number; uid: number } | null = null;
    for (const t of this.towers()) {
      if ((t.id !== cb.a && t.id !== cb.b) || t.comboWith.length) continue;
      const partner = t.id === cb.a ? cb.b : cb.a;
      for (const ni of this.neighbors(t.cy * this.cols + t.cx)) {
        const sl = slotMap.get(ni);
        if (!sl) continue;
        const v = value(partner, sl);
        if (v > 0 && v >= floor(partner) && (!anchor || v > anchor.v)) anchor = { partner, sl, v, uid: t.uid };
      }
    }
    // 2) 新的一对：A 的前几个好格 × 相邻的 B 格
    let fresh: { first: TowerId; s1: Slot; second: TowerId; s2: Slot; v: number } | null = null;
    if (this.gold() >= this.cost(cb.a) + this.cost(cb.b)) {
      for (const [first, second] of [
        [cb.a, cb.b],
        [cb.b, cb.a],
      ] as [TowerId, TowerId][]) {
        for (const c1 of this.rankSlots(first, near, 8)) {
          if (c1.v < floor(first)) continue;
          for (const ni of this.neighbors(c1.slot.i)) {
            const sl = slotMap.get(ni);
            if (!sl) continue;
            const v2 = value(second, sl);
            if (v2 < 0 || v2 < floor(second)) continue;
            const v = (c1.v + v2) / 2;
            if (!fresh || v > fresh.v) fresh = { first, s1: c1.slot, second, s2: sl, v };
          }
        }
      }
    }
    const lines: string[] = [];
    let spent = 0;
    let done = 0;
    if (anchor && (!fresh || anchor.v >= 0.6 * fresh.v) && this.gold() >= this.cost(anchor.partner)) {
      const r = this.placeAt(anchor.partner, anchor.sl);
      if (r.ok) {
        spent += r.spent;
        done++;
        lines.push(`${r.line} next to #${anchor.uid}`);
      } else lines.push(`skip ${r.line}`);
    } else if (fresh) {
      const r1 = this.placeAt(fresh.first, fresh.s1);
      if (r1.ok) {
        spent += r1.spent;
        done++;
        lines.push(r1.line);
        // 第二座：首选格被拒（放了第一座后会堵路等）就换第一座的其他邻格
        const alts = [
          fresh.s2,
          ...this.neighbors(fresh.s1.i)
            .map((ni) => slotMap.get(ni))
            .filter((x): x is Slot => !!x && x.i !== fresh!.s2.i),
        ];
        let ok2 = false;
        for (const sl of alts) {
          if (this.gold() < this.cost(fresh.second)) {
            lines.push(`stop: 金币不足 for ${fresh.second}`);
            break;
          }
          if (!sl.wallUid && !this.w.canPlace(fresh.second, sl.x, sl.y).ok) continue;
          const r2 = this.placeAt(fresh.second, sl);
          if (r2.ok) {
            spent += r2.spent;
            done++;
            lines.push(r2.line);
            ok2 = true;
            break;
          }
        }
        if (!ok2) lines.push(`${fresh.second}: no adjacent cell left`);
      } else lines.push(`skip ${r1.line}`);
    } else {
      const need = this.cost(cb.a) + this.cost(cb.b);
      return {
        ok: false,
        text: `combo ${cb.a}+${cb.b}: ${this.gold() < need && !anchor ? `金币不足 (pair ${need}g, gold ${this.gold()})` : 'no adjacent pair of good cells (each ≥70% of its best spot)'}`,
        spent: 0,
        done: 0,
      };
    }
    return { ok: done > 0, text: `combo ${cb.a}+${cb.b} (${cb.name}): ${lines.join('; ')}`, spent, done };
  }

  /** support：计算器放在光环（2 格）覆盖输出最多的位置；覆盖太少就不放 */
  support(): IntentOutcome {
    if (!this.unlocked('calculator')) return { ok: false, text: 'support: calculator locked or at limit', spent: 0, done: 0 };
    const b = this.bestSlot('calculator');
    const min = 2.2 * POWER.pencil;
    if (!b || b.v < min)
      return {
        ok: false,
        text: `support: no cell where the aura covers ≥2 strong towers (best ${Math.round(b?.v ?? 0)} < ${Math.round(min)}); build more towers close together first`,
        spent: 0,
        done: 0,
      };
    if (this.gold() < this.cost('calculator'))
      return { ok: false, text: `support: 金币不足 (calculator ${this.cost('calculator')}g, gold ${this.gold()})`, spent: 0, done: 0 };
    const r = this.placeAt('calculator', b.slot);
    return {
      ok: r.ok,
      text: `support: ${r.line} aura covers ≈${Math.round(b.v)} dps-units`,
      spent: r.ok ? r.spent : 0,
      done: r.ok ? 1 : 0,
    };
  }

  /** economy：安全时（满血、下一波没有"危险"、已有 ≥4 座攻击塔）早放存钱罐，挨着计算器更好 */
  economy(count = 1): IntentOutcome {
    const s = this.w.state;
    if (!this.unlocked('piggy')) return { ok: false, text: 'economy: piggy locked or at limit (max 3)', spent: 0, done: 0 };
    // 存钱罐 100g ≈ 5 支铅笔，回本要 ~12 波：只有防线明显有余量时才放（脚本评测：宽松条件下困难难度失守 2 局）
    const th = threatEstimate(this.w);
    const why =
      s.lives < s.maxLives
        ? 'lives lost — defend first'
        : this.attackers().length < 6
          ? 'fewer than 6 attack towers'
          : th.some((t) => t.ratio < 3)
            ? `next wave not comfortably safe (min ×${Math.min(...th.map((t) => t.ratio))} < 3)`
            : s.wave >= 40
              ? 'too late for payback'
              : '';
    if (why) return { ok: false, text: `economy: not safe (${why})`, spent: 0, done: 0 };
    const lines: string[] = [];
    let spent = 0;
    let done = 0;
    for (let k = 0; k < Math.min(3, Math.max(1, count)); k++) {
      if (!this.unlocked('piggy')) break;
      if (this.gold() < this.cost('piggy')) {
        lines.push(`stop: 金币不足 (piggy ${this.cost('piggy')}g)`);
        break;
      }
      const b = this.bestSlot('piggy');
      if (!b) {
        lines.push('stop: no cell');
        break;
      }
      const r = this.placeAt('piggy', b.slot);
      if (!r.ok) {
        lines.push(`skip ${r.line}`);
        break;
      }
      spent += r.spent;
      done++;
      lines.push(r.line);
    }
    return { ok: done > 0, text: `economy: ${lines.join('; ')}`, spent, done };
  }

  // ───────────── 回收 / 重建 ─────────────

  /** replaceWith：塔 id 或用途 → 这次买哪座 */
  private resolveTower(spec: string | undefined, target = 'route'): TowerId | null {
    if (!spec) return null;
    if ((TOWERS as Record<string, unknown>)[spec] && spec !== 'wall') return this.unlocked(spec as TowerId) ? (spec as TowerId) : null;
    if ((PURPOSES as readonly string[]).includes(spec)) return this.towerForPurpose(spec as Purpose, target)?.id ?? null;
    return null;
  }

  /**
   * reclaim：回收没用的墙 / 塔 / 被墙挤占的好格，并可在腾出的格上换成更好的塔。
   *  - useless_walls：拆掉后没有任何路线变短、不在规划里、不是加成墙的墙（每拆一座都用真实流场复核；万一变短立刻补回）；
   *  - idle_towers：最近 2 波 0 伤害或够不着任何路线的攻击塔（卖掉会缩短路线的换成墙）；
   *  - cells：Lv1 墙占着的好格直接换成塔（塔也是墙，路线不变）。
   * dry = 只列出会做什么。墙退款很少（5g 墙退 3g），腾出的好格价值高。
   */
  reclaim(target: 'useless_walls' | 'idle_towers' | 'cells', max = 4, replaceWith?: string, dry = false): IntentOutcome {
    const lines: string[] = [];
    let spent = 0;
    let done = 0;
    const cap = Math.min(12, Math.max(1, max));
    if (target === 'useless_walls') {
      const freed: { x: number; y: number; i: number; cov: number }[] = [];
      if (dry) {
        const list = uselessWalls(this.w, this.plan).slice(0, cap);
        return {
          ok: true,
          text: `reclaim useless_walls (dry): ${list.length ? list.map((x) => `#${x.uid}@${x.x},${x.y} cov${x.cov}`).join(' ') : 'none'}`,
          spent: 0,
          done: 0,
        };
      }
      for (let k = 0; k < cap; k++) {
        const c = uselessWalls(this.w, this.plan).find((x) => !this.reserved.has(x.y * this.cols + x.x));
        if (!c) break;
        const before = this.pathLens();
        const g0 = this.w.state.gold;
        const r = this.exec({ type: 'sell', uid: c.uid });
        if (!r.ok) {
          lines.push(`#${c.uid} ${r.reason}`);
          break;
        }
        const after = this.pathLens();
        if (after.some((l, j) => l < (before[j] ?? 0))) {
          // 复核失败：补回去，停
          this.exec({ type: 'place', tower: 'wall', cx: c.x, cy: c.y });
          lines.push(`#${c.uid}@${c.x},${c.y} shortened the route → restored`);
          break;
        }
        spent -= Math.round(this.w.state.gold - g0);
        done++;
        freed.push({ x: c.x, y: c.y, i: c.y * this.cols + c.x, cov: c.cov });
      }
      if (freed.length) lines.push(`sold ${freed.length} walls ${freed.map((f) => `${f.x},${f.y}`).join(' ')}`);
      else lines.push('no useless walls');
      if (replaceWith && freed.length) {
        const built: string[] = [];
        for (const f of freed.sort((a, b) => b.cov - a.cov)) {
          const id = this.resolveTower(replaceWith);
          if (!id || this.gold() < this.cost(id)) break;
          const sl: Slot = { x: f.x, y: f.y, i: f.i, wallUid: 0, plan: false };
          const v = this.slotValue(id, sl, this.samplesFor(id, 'route', 'current'));
          if (v < 1 || !this.w.canPlace(id, f.x, f.y).ok) continue;
          const r = this.placeAt(id, sl);
          if (r.ok) {
            spent += r.spent;
            done++;
            built.push(r.line);
          }
        }
        if (built.length) lines.push(`rebuilt ${built.join(' ')}`);
      }
      return { ok: done > 0, text: `reclaim useless_walls: ${lines.join('; ')} → path ${this.pathLens().join('/')}`, spent, done };
    }
    if (target === 'idle_towers') {
      const list = idleTowers(this.w, this.state.intel).slice(0, cap);
      if (dry)
        return {
          ok: true,
          text: `reclaim idle_towers (dry): ${list.length ? list.map((u) => `#${u}${this.w.state.towers.get(u)?.id ?? ''}`).join(' ') : 'none'}`,
          spent: 0,
          done: 0,
        };
      let sold = 0;
      for (const uid of list) {
        const t = this.w.state.towers.get(uid);
        if (!t) continue;
        const i = t.cy * this.cols + t.cx;
        const keepWall = shortensRoutes(this.w, [i]);
        const g0 = this.w.state.gold;
        const r = this.exec({ type: 'sell', uid });
        if (!r.ok) {
          lines.push(`#${uid} ${r.reason}`);
          continue;
        }
        if (keepWall) this.exec({ type: 'place', tower: 'wall', cx: t.cx, cy: t.cy });
        const got = Math.round(this.w.state.gold - g0);
        spent -= got;
        sold++;
        done++;
        lines.push(`sold #${uid}${t.id}@${t.cx},${t.cy} +${got}g${keepWall ? ' (wall kept the maze)' : ''}`);
      }
      if (!sold) lines.push('no idle towers');
      if (replaceWith && sold) {
        const id = this.resolveTower(replaceWith);
        if (id) {
          const o = this.buildNear(id, 'route', sold);
          spent += o.spent;
          done += o.done;
          lines.push(o.text);
        }
      }
      return { ok: done > 0, text: `reclaim idle_towers: ${lines.join('; ')}`, spent, done };
    }
    // cells：被挤占的好格换成塔
    const list = crowdedCells(this.w, wallInfo(this.w, this.plan)).slice(0, cap);
    if (dry)
      return {
        ok: true,
        text: `reclaim cells (dry): ${list.length ? list.map((x) => `${x.x},${x.y}:${x.cov}`).join(' ') : 'none'}`,
        spent: 0,
        done: 0,
      };
    for (const c of list) {
      const id = this.resolveTower(replaceWith ?? 'dps');
      if (!id) {
        lines.push('stop: no affordable tower');
        break;
      }
      if (this.gold() + 3 < this.cost(id)) {
        lines.push(`stop: 金币不足 (${id} ${this.cost(id)}g)`);
        break;
      }
      const r = this.placeAt(id, { x: c.x, y: c.y, i: c.y * this.cols + c.x, wallUid: c.uid, plan: true });
      if (r.ok) {
        spent += r.spent;
        done++;
        lines.push(`${r.line} cov${c.cov}`);
      } else lines.push(`skip ${r.line}`);
    }
    if (!list.length) lines.push('no crowded cells');
    return { ok: done > 0, text: `reclaim cells: ${lines.join('; ')}`, spent, done };
  }

  /** rebuild_maze：路线变了（空降点没了 / 入口变了）→ 拆掉不再有用的旧墙，再按规划重建 */
  rebuildMaze(style: 'serpentine' | 'funnel' = 'serpentine', route?: string, budget?: number): IntentOutcome {
    const before = this.pathLens();
    const r1 = this.reclaim('useless_walls', 12);
    const r2 = this.maze(style, budget, route);
    return {
      ok: r1.done + r2.done > 0,
      done: r1.done + r2.done,
      spent: r1.spent + r2.spent,
      text: `rebuild_maze: ${r1.text.replace(/^reclaim useless_walls: /, 'cleared ')} | ${r2.text} | path ${before.join('/')}→${this.pathLens().join('/')}`,
    };
  }

  save(until: number): IntentOutcome {
    this.state.saveUntil = until;
    this.state.saveWave = this.w.state.wave;
    return { ok: true, text: `save: holding gold until ${until} (gold ${this.gold()})`, spent: 0, done: 0 };
  }

  /**
   * 被拒的放置（格子被敌人 / 障碍 / 塔占着、或会堵路）→ 2 格内覆盖最好的可放空格（不在当前 / 规划路线上，不改路线）。
   * 返回 null = 不可自动修正（原因不在可修正之列 / 附近没有合适的格）。
   */
  relocate(id: TowerId, x: number, y: number, code: string): { x: number; y: number } | null {
    if (id === 'wall' || !FIXABLE.has(code)) return null;
    this.refresh();
    const onRoute = new Set<number>();
    for (const p of this.w.currentPaths()) for (const c of p) onRoute.add(c.y * this.cols + c.x);
    const s = this.samplesFor(id, 'route');
    let best: { x: number; y: number; v: number } | null = null;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if ((dx === 0 && dy === 0) || nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
        const i = ny * this.cols + nx;
        if (!this.empty(i) || onRoute.has(i) || this.planned.has(i)) continue;
        if (!this.w.canPlace(id, nx, ny).ok) continue;
        const v = this.slotValue(id, { x: nx, y: ny }, s) - 0.01 * Math.max(Math.abs(dx), Math.abs(dy));
        if (!best || v > best.v) best = { x: nx, y: ny, v };
      }
    return best;
  }
}

/** 每个开放出生点沿流场的路线采样（权重按出生点数平分；f = 沿路线的进度） */
export function routeSamples(w: IWorld, cells: Uint8Array, scratch: Float32Array): RSample[] {
  const g = w.state.grid;
  const d = computeDist(g.cols, g.rows, cells, g.exits, scratch);
  const ents = w.state.spawners.filter((sp) => sp.active);
  const out: RSample[] = [];
  const wt = 1 / Math.max(1, ents.length);
  for (const sp of ents) {
    const c0 = sp.cells[0];
    let start = c0.y * g.cols + c0.x;
    if (sp.kind === 'drop') start = dropStart(w, c0, cells, d);
    if (start < 0 || !(d[start] < Infinity)) continue;
    const p = tracePath(g.cols, g.rows, cells, d, start);
    for (let k = 0; k < p.length; k++) {
      const f = k / Math.max(1, p.length - 1);
      out.push({ x: p[k].x + 0.5, y: p[k].y + 0.5, w: wt * 0.5, f, sp: sp.id });
      if (k + 1 < p.length) out.push({ x: (p[k].x + p[k + 1].x) / 2 + 0.5, y: (p[k].y + p[k + 1].y) / 2 + 0.5, w: wt * 0.5, f, sp: sp.id });
    }
  }
  return out;
}

/** 每个开放出生点的飞行线采样（出生格中心 → 横向最近的出口；与 routes.ts flightLines 同口径） */
export function airLineSamples(w: IWorld): RSample[] {
  const g = w.state.grid;
  const out: RSample[] = [];
  const ents = w.state.spawners.filter((sp) => sp.active);
  const wt = 1 / Math.max(1, ents.length);
  for (const sp of ents) {
    const c = sp.cells[0];
    const x0 = c.x + 0.5;
    const y0 = c.y + 0.5;
    let best = g.exits[0];
    for (const ex of g.exits) if (Math.abs(ex.x + 0.5 - x0) < Math.abs(best.x + 0.5 - x0)) best = ex;
    if (!best) continue;
    const x1 = best.x + 0.5;
    const y1 = best.y + 0.5;
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / 0.5));
    for (let k = 0; k <= n; k++) out.push({ x: x0 + ((x1 - x0) * k) / n, y: y0 + ((y1 - y0) * k) / n, w: wt * 0.5, f: k / n, sp: sp.id });
  }
  return out;
}
