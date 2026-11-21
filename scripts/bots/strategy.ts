/**
 * 可配置的策略机器人。newbie / medium / expert 只是不同的参数组合（见同目录各文件）。
 *
 * 每个决策点（建造阶段每次开波前，以及波次进行中每 decisionTicks 步）依次：
 *   选增益 → 维护迷宫 → 买塔 / 升级 → 放技能 → （高手）安全时提前开波
 */
import {
  CellKind,
  generateWave,
  type Branch,
  type IWorld,
  type PerkCard,
  type SkillId,
  type TowerId,
  type TowerState,
} from '../../src/core';
import { COMBOS, TOWERS } from '../../src/config/towers';
import { rawUpgradeCost } from '../../src/core/scaling';
import { airSamples, coverage, groundSamples, planMaze, spawnerKey, targetCells, type MazePlan, type Sample } from './maze';

export interface BotParams {
  name: string;
  skills: SkillId[];
  /** 有第 4 技能槽（天赋"大书包"）时带的技能 */
  extraSkill?: SkillId;
  /** 迷宫：允许建到第几段（随波数），0 = 不建 */
  mazeSegments: (wave: number) => number;
  /** 每波最多为迷宫花多少比例的现金（墙） */
  wallShare: number;
  /** 买塔轮换（锁定 / 达上限的会跳过） */
  rotation: TowerId[];
  /** 攻击塔数量上限（随波数） */
  maxTowers: (wave: number) => number;
  /** 'rare'：金币大量富余才随便升一座；'value'：按每金币收益比较买塔与升级 */
  upgrade: 'rare' | 'value';
  /** value 模式下升级相对买新塔的偏好（>1 更爱升级） */
  upgradeBias: number;
  /** 保留金币（不花） */
  reserve: (wave: number) => number;
  /** 'rare'：偶尔放；'cooldown'：冷却好且场上有怪就放；'smart'：挑时机 */
  skillUse: 'rare' | 'cooldown' | 'smart';
  /** 增益优先级（越靠前越优先），未列出的排最后 */
  perkPriority: string[];
  /** 传奇分支选择 */
  branches: Partial<Record<TowerId, Branch>>;
  /** 选位时考虑组合技与书本墙加成 */
  combos: boolean;
  /** 升级书本墙（相邻 2 座以上中高级塔时） */
  wallUpgrades: boolean;
  /** 安全时提前开波 */
  earlyStart: boolean;
  /** 随手堵几格（不按规划，只挑能让路线变长的单格）：允许的墙数（随波数） */
  looseWalls?: (wave: number) => number;
  /** 不在迷宫规划内也可以放塔（新手：沿路随手放） */
  offPlan: boolean;
  /** 选位随机扰动（新手不会算最优位置） */
  placeNoise: number;
  decisionTicks: number;
  /** 开局先买的塔（全部买完才进入轮换） */
  opening: TowerId[];
  /** 保留一座只靠经验升级的铅笔（用于经验节奏测量） */
  xpProbe: boolean;
  /** 空降点：金币是拆除费用的多少倍以上才拆（0 = 不拆） */
  demolishAt?: number;
  /** 神话能力：'none' 不用；'ready' 冷却好且场上有怪就用 */
  abilities?: 'none' | 'ready';
  /**
   * 防空补位（文档 09：侧边入口 / 空降点会带来新的飞行路线）：某条开放的飞行路线的对空覆盖
   * 低于最强路线的这个比例时，优先在那条路线上补对空塔，可超出 maxTowers 至多 airExtra 座。0 / 缺省 = 不补
   */
  airGuard?: number;
  airExtra?: number;
  /** 有飞行漏怪后，轮到铅笔时改买苍蝇拍，最多这么多座（随波数）；缺省 = 不换 */
  swatters?: (wave: number) => number;
}

/** 每种塔"单位覆盖"的大致价值（秒伤量级），只用于机器人的买/升比较 */
const POWER: Record<TowerId, number> = {
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
/** 下一级的额外收益系数（形态跃迁） */
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

interface Slot {
  cx: number;
  cy: number;
  i: number;
  wallUid: number;
}

export class StrategyBot {
  readonly p: BotParams;
  readonly w: IWorld;
  readonly plan: MazePlan;
  private scratch: Float32Array;
  private rot = 0;
  private samplesKey = '';
  private gSamples: Sample[] = [];
  /** 路线前 40%（破甲塔放这里，后面的塔都受益） */
  private gEarly: Sample[] = [];
  private aSamples: Sample[];
  private probeUid = 0;
  private waveSpawnEnd = 0;
  private recentLeaks: number[] = [];
  private leaksThisWave = 0;
  private rngState = 1;
  private wallSpent = 0;
  private airLeaks = 0;
  private otherSpent = 0;
  /** 被金币升级过的塔（经验节奏测量排除） */
  readonly goldUpgraded = new Set<number>();

  constructor(w: IWorld, p: BotParams) {
    this.w = w;
    this.p = p;
    this.plan = planMaze(w);
    this.scratch = new Float32Array(w.state.grid.cols * w.state.grid.rows);
    this.aSamples = airSamples(w);
    let h = 7;
    for (const c of w.state.seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    this.rngState = h || 1;
  }

  get probe(): number {
    return this.probeUid;
  }

  private rand(): number {
    this.rngState = (Math.imul(this.rngState, 1664525) + 1013904223) >>> 0;
    return this.rngState / 4294967296;
  }

  // ───────────── 事件钩子（由 runner 调用） ─────────────
  onWaveStart(wave: number): void {
    const s = this.w.state;
    const plan = generateWave({ seed: s.seed, mode: s.opts.mode, map: s.opts.map, params: s.params }, wave);
    const last = plan.entries.length ? plan.entries[plan.entries.length - 1].at : 0;
    this.waveSpawnEnd = Math.max(this.waveSpawnEnd, s.time + last);
    this.leaksThisWave = 0;
  }
  onLeak(enemy?: string): void {
    this.leaksThisWave++;
    if (enemy === 'plane' || enemy === 'moth') this.airLeaks++;
  }
  onWaveEnd(): void {
    this.recentLeaks.push(this.leaksThisWave);
    if (this.recentLeaks.length > 3) this.recentLeaks.shift();
  }

  // ───────────── 主决策 ─────────────
  act(phase: 'build' | 'wave'): void {
    const s = this.w.state;
    if (s.phase === 'perk') {
      this.choosePerk();
      return;
    }
    this.spend();
    this.maybeDemolish();
    if (phase === 'wave') {
      this.useSkills();
      this.useAbilities();
      if (this.p.earlyStart) this.maybeEarlyStart();
    } else if (this.p.skillUse !== 'rare') {
      // 开波前就能用的：奖学金、灵感
      this.castEconomy();
    }
    if (this.p.earlyStart && phase === 'build' && s.autoWave.enabled && s.autoWave.started) this.maybeEarlyStart();
  }

  /** 每步调用：捡掉落物、选补给（真人点一下就行，机器人每步都跟得上） */
  tick(): void {
    const s = this.w.state;
    if (s.pickups.length) {
      for (const p of s.pickups.slice()) {
        if (p.kind === 'crate' && s.crateChoice) continue;
        this.w.command({ type: 'collect', uid: p.uid });
      }
    }
    if (s.crateChoice) {
      const pref = ['gold', 'xp', 'lives', 'caffeine', 'cooldown', 'charge'];
      const opts = s.crateChoice.options.slice().sort((a, b) => pref.indexOf(a.id) - pref.indexOf(b.id));
      this.w.command({ type: 'chooseCrate', option: opts[0].id });
    }
  }

  private maybeDemolish(): void {
    const k = this.p.demolishAt ?? 0;
    if (k <= 0) return;
    const s = this.w.state;
    for (const sp of s.spawners) {
      if (sp.kind !== 'drop' || !sp.active) continue;
      const cost = sp.demolishCost ?? 0;
      if (cost > 0 && s.gold >= cost * k) this.w.command({ type: 'demolishSpawner', id: sp.id });
    }
  }

  /** 神话能力：冷却好且场上有怪就放 */
  private useAbilities(): void {
    if ((this.p.abilities ?? 'none') === 'none') return;
    const s = this.w.state;
    const en = s.enemies.filter((e) => !e.hidden);
    if (en.length < 3 && s.bossUids.length === 0) return;
    for (const t of this.towers()) {
      if (t.stars < 3) continue;
      const info = this.w.getTowerInfo(t.uid);
      const ab = info?.ability;
      if (!ab || !ab.ready) continue;
      // 全场瞬发 / 限时的能力：等敌人多一点再放（Boss 在场就直接放）
      if (ab.target === 'none' && s.bossUids.length === 0) {
        const air = en.filter((e) => e.flying).length;
        if (ab.id.startsWith('swatter_') ? air < 3 : en.length < 6) continue;
      }
      const strong = en.reduce((a, b) => (b.hp > a.hp ? b : a), en[0]);
      const dense = this.densest(1.5, false) ?? { x: strong.x, y: strong.y, v: 0, n: 0 };
      switch (ab.target) {
        case 'none':
          this.w.command({ type: 'towerAbility', uid: t.uid });
          break;
        case 'circle':
        case 'rect3':
          this.w.command({ type: 'towerAbility', uid: t.uid, x: dense.x, y: dense.y });
          break;
        case 'direction':
          this.w.command({ type: 'towerAbility', uid: t.uid, angle: Math.atan2(dense.y - (t.cy + 0.5), dense.x - (t.cx + 0.5)) });
          break;
        case 'axis':
          this.w.command({ type: 'towerAbility', uid: t.uid, axis: 'row', index: Math.floor(dense.y) });
          break;
        case 'enemy': {
          const elite = en.find((e) => e.elite && !e.boss && e.affixes.length > 0);
          // 深钻打掉血最多的；精准测量标在敌群里生命最多的
          const hurt = en.reduce((a, b) => (b.maxHp - b.hp > a.maxHp - a.hp ? b : a), en[0]);
          const inDense = en
            .filter((e) => (e.x - dense.x) ** 2 + (e.y - dense.y) ** 2 <= 2.25)
            .reduce((a, b) => (b.hp > a.hp ? b : a), strong);
          const tgt = ab.id === 'eraser_b' ? elite : ab.id === 'compass_b' ? hurt : ab.id === 'ruler_b' ? inDense : strong;
          if (tgt) this.w.command({ type: 'towerAbility', uid: t.uid, targetUid: tgt.uid });
          break;
        }
        case 'tower': {
          const cand = this.towers()
            .filter(
              (o) =>
                o.id !== 'wall' && o.uid !== t.uid && o.level < 9 && (o.cx - t.cx) ** 2 + (o.cy - t.cy) ** 2 <= (info!.auraRange ?? 2) ** 2,
            )
            .sort((a, b) => b.level - a.level)[0];
          if (cand) this.w.command({ type: 'towerAbility', uid: t.uid, targetUid: cand.uid });
          break;
        }
      }
    }
  }

  private towers(): TowerState[] {
    return [...this.w.state.towers.values()];
  }
  private attackers(): TowerState[] {
    return this.towers().filter((t) => TOWERS[t.id].attacks);
  }

  private currentSegments(): number {
    return Math.min(this.plan.segments.length, Math.max(0, this.p.mazeSegments(Math.max(1, this.w.state.wave + 1))));
  }

  /** 已完整建成的段数 + 1（选位/造墙只看近期能建成的部分） */
  private activeSegments(): number {
    const g = this.w.state.grid;
    const max = this.currentSegments();
    let built = 0;
    for (; built < max; built++) {
      if (this.plan.segments[built].some((i) => g.cells[i] === CellKind.Empty && this.wallPlaceable(i))) break;
    }
    return Math.min(max, built + 1);
  }

  /**
   * 规划格还能不能放墙。地形事件（书本倒下、桌面整理、空降点）之后，规划里个别格子可能永久变成
   * "会堵死道路"；不能因为这种格子让后面的段永远不算建成（否则后半段迷宫永远选不到塔位）。
   * 金币不足 / 有敌人站着只是暂时的，仍算可放。
   */
  private wallPlaceable(i: number): boolean {
    const g = this.w.state.grid;
    const r = this.w.canPlace('wall', i % g.cols, Math.floor(i / g.cols));
    return r.ok || r.code === 'noGold' || r.code === 'enemyHere';
  }

  private refreshSamples(): void {
    const g = this.w.state.grid;
    const nSeg = this.activeSegments();
    const sk = spawnerKey(this.w);
    const key = `${g.version}|${nSeg}|${sk}`;
    if (key === this.samplesKey) return;
    if (!this.samplesKey.endsWith(`|${sk}`)) this.aSamples = airSamples(this.w);
    this.samplesKey = key;
    const cells = targetCells(this.w, this.plan, nSeg, this.scratch);
    this.gSamples = groundSamples(this.w, cells, this.scratch);
    this.gEarly = this.gSamples.filter((x) => (x.f ?? 0) <= 0.4);
  }

  private cost(id: TowerId): number {
    return this.w.getBuildOptions().find((o) => o.id === id)!.cost;
  }

  /** 迷宫规划内可用的格子（空格或可替换的墙） */
  private planSlots(): Slot[] {
    const g = this.w.state.grid;
    const nSeg = this.activeSegments();
    const out: Slot[] = [];
    for (let k = 0; k < nSeg; k++) {
      for (const i of this.plan.segments[k]) {
        const cx = i % g.cols;
        const cy = (i - cx) / g.cols;
        if (g.cells[i] === CellKind.Empty) out.push({ cx, cy, i, wallUid: 0 });
        else if (g.cells[i] === CellKind.Tower) {
          const t = this.w.state.towers.get(g.towerAt[i]);
          if (t && t.id === 'wall' && t.level === 1) out.push({ cx, cy, i, wallUid: t.uid });
        }
      }
    }
    return out;
  }

  /** 路边可放的空格（新手） */
  private offPlanSlots(): Slot[] {
    const g = this.w.state.grid;
    const out: Slot[] = [];
    for (let cy = 0; cy < g.rows; cy++)
      for (let cx = 0; cx < g.cols; cx++) {
        const i = cy * g.cols + cx;
        if (g.cells[i] === CellKind.Empty) out.push({ cx, cy, i, wallUid: 0 });
      }
    return out;
  }

  private ranges(id: TowerId): { r: number; inner: number } {
    const d = TOWERS[id];
    return { r: d.range + 0.3, inner: d.inner ?? 0 };
  }

  private slotValue(id: TowerId, sl: Slot): number {
    const d = TOWERS[id];
    const { r, inner } = this.ranges(id);
    if (id === 'calculator') {
      let v = 0;
      for (const t of this.attackers()) {
        const dx = t.cx - sl.cx;
        const dy = t.cy - sl.cy;
        if (dx * dx + dy * dy <= 4 + 1e-6) v += Math.pow(1.19, t.level - 1) * (POWER[t.id] || 10);
      }
      return v;
    }
    if (id === 'piggy') {
      // 放在最没用的格子；高手放在计算器旁边（复利）
      let v = 100 - coverage(sl.cx, sl.cy, 2.5, 0, this.gSamples);
      if (this.p.combos && this.adjacent(sl, 'calculator')) v += 50;
      return v;
    }
    let v = d.hitsGround ? coverage(sl.cx, sl.cy, r, inner, this.gSamples) : 0;
    if (id === 'eraser' && this.p.combos) v = coverage(sl.cx, sl.cy, r, inner, this.gEarly) * 2;
    if (d.hitsAir) v += this.airWeight() * coverage(sl.cx, sl.cy, r, 0, this.aSamples);
    if (this.p.combos) {
      for (const cb of COMBOS) {
        const partner = cb.a === id ? cb.b : cb.b === id ? cb.a : null;
        if (partner && this.adjacent(sl, partner)) v *= 1.15;
      }
    }
    if (this.p.placeNoise > 0) v *= 1 - this.p.placeNoise + 2 * this.p.placeNoise * this.rand();
    return v;
  }

  /** 飞行路线的权重：有过飞行漏怪就加重 */
  private airWeight(): number {
    return this.p.skillUse === 'rare' ? 0.3 : 1 + Math.min(1, this.airLeaks * 0.1);
  }

  private adjacent(sl: { cx: number; cy: number }, id: TowerId): boolean {
    const g = this.w.state.grid;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const x = sl.cx + dx;
      const y = sl.cy + dy;
      if (x < 0 || y < 0 || x >= g.cols || y >= g.rows) continue;
      const t = this.w.state.towers.get(g.towerAt[y * g.cols + x]);
      if (t && t.id === id) return true;
    }
    return false;
  }

  private bestSlot(id: TowerId): { slot: Slot; v: number } | null {
    this.refreshSamples();
    let slots = this.planSlots();
    if (this.p.offPlan) slots = slots.concat(this.offPlanSlots());
    let best: Slot | null = null;
    let bv = -Infinity;
    for (const sl of slots) {
      const v = this.slotValue(id, sl);
      if (v <= bv) continue;
      if (!sl.wallUid && !this.w.canPlace(id, sl.cx, sl.cy).ok) continue;
      best = sl;
      bv = v;
    }
    return best ? { slot: best, v: bv } : null;
  }

  private placeAt(id: TowerId, sl: Slot): boolean {
    const w = this.w;
    if (sl.wallUid) {
      if (w.state.gold + 3 < this.cost(id)) return false;
      w.command({ type: 'sell', uid: sl.wallUid });
    }
    const g0 = w.state.gold;
    const r = w.command({ type: 'place', tower: id, cx: sl.cx, cy: sl.cy });
    if (r.ok) this.otherSpent += g0 - w.state.gold;
    if (!r.ok && sl.wallUid) w.command({ type: 'place', tower: 'wall', cx: sl.cx, cy: sl.cy });
    if (r.ok && id === 'pencil' && this.p.xpProbe && !this.probeUid) this.probeUid = w.state.grid.towerAt[sl.i];
    if (r.ok && id === 'lamp' && this.p.skillUse !== 'rare')
      w.command({ type: 'setTarget', uid: w.state.grid.towerAt[sl.i], mode: 'strong' });
    return r.ok;
  }

  private nextRotation(): TowerId | null {
    const s = this.w.state;
    const atk = this.attackers();
    for (let k = 0; k < this.p.opening.length; k++) {
      const want = this.p.opening.slice(0, k + 1).filter((x) => x === this.p.opening[k]).length;
      if (atk.filter((t) => t.id === this.p.opening[k]).length < want && s.unlockedTowers.includes(this.p.opening[k]))
        return this.p.opening[k];
    }
    for (let k = 0; k < this.p.rotation.length; k++) {
      const id = this.p.rotation[(this.rot + k) % this.p.rotation.length];
      if (!s.unlockedTowers.includes(id)) continue;
      if (id === 'piggy' && this.towers().filter((t) => t.id === 'piggy').length >= 3) continue;
      if (id === 'calculator' && this.attackers().length < 8) continue;
      this.rot = (this.rot + k) % this.p.rotation.length;
      // 飞行敌人漏过：轮到铅笔时改买苍蝇拍（数量随波数放宽）
      if (
        id === 'pencil' &&
        this.p.swatters &&
        s.unlockedTowers.includes('swatter') &&
        this.airLeaks > 0 &&
        this.towers().filter((t) => t.id === 'swatter').length < this.p.swatters(s.wave + 1)
      )
        return 'swatter';
      return id;
    }
    return null;
  }

  // ───────────── 花钱 ─────────────
  private spend(): void {
    const s = this.w.state;
    for (let guard = 0; guard < 60; guard++) {
      const wave = s.wave + 1;
      const budget = s.gold - this.p.reserve(wave);
      if (budget <= 0) return;
      const atk = this.attackers().length;
      const minAtk = Math.min(2 + wave, 6);
      if (atk >= minAtk) {
        const r = this.guardAir(wave, budget, atk);
        if (r === 'wait') return;
        if (r === 'done') continue;
      }
      if (this.p.looseWalls && atk >= 3 && this.looseWall(wave)) continue;
      if (
        atk >= Math.min(minAtk, 3) &&
        this.wallSpent < this.p.wallShare * (this.otherSpent + this.wallSpent) + 25 &&
        this.buildWalls(budget)
      )
        continue;
      const id = this.nextRotation();
      if (!id) return;
      const cost = this.cost(id);
      const slot = atk < this.p.maxTowers(wave) ? this.bestSlot(id) : null;
      const up = atk >= minAtk ? this.bestUpgrade() : null;
      let buy = !!slot;
      if (slot && up) {
        const support = !(POWER[id] > 0);
        const vNew = (slot.v * POWER[id]) / cost;
        buy = support || id === 'glue' || id === 'eraser' || vNew >= up.eff * this.p.upgradeBias;
      }
      if (buy && slot) {
        if (budget < cost) return; // 攒钱
        const inOpening = this.attackers().length < this.p.opening.length;
        if (this.placeAt(id, slot.slot)) {
          if (!inOpening) this.rot = (this.rot + 1) % this.p.rotation.length;
          continue;
        }
        return;
      }
      if (up) {
        if (budget < up.cost) return;
        if (this.doUpgrade(up.t, up.cost)) continue;
        return;
      }
      if (this.p.wallUpgrades && this.upgradeWalls(budget)) continue;
      return;
    }
  }

  /** 每条开放出生点的飞行路线（出生点各格平均 → 最近出口） */
  private airLines(): Sample[][] {
    const s = this.w.state;
    const g = s.grid;
    const out: Sample[][] = [];
    for (const sp of s.spawners) {
      if (!sp.active) continue;
      const x0 = sp.cells.reduce((a, c) => a + c.x, 0) / sp.cells.length + 0.5;
      const y0 = sp.cells.reduce((a, c) => a + c.y, 0) / sp.cells.length + 0.5;
      let best = g.exits[0];
      for (const ex of g.exits) if (Math.abs(ex.x + 0.5 - x0) < Math.abs(best.x + 0.5 - x0)) best = ex;
      const x1 = best.x + 0.5;
      const y1 = best.y + 0.5;
      const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / 0.5));
      const line: Sample[] = [];
      for (let k = 0; k <= n; k++) line.push({ x: x0 + ((x1 - x0) * k) / n, y: y0 + ((y1 - y0) * k) / n, w: 1 });
      out.push(line);
    }
    return out;
  }

  /** 对空火力在一条飞行路线上的覆盖（按等级粗略加权） */
  private airPower(line: Sample[]): number {
    let v = 0;
    for (const t of this.attackers()) {
      if (!TOWERS[t.id].hitsAir) continue;
      const r = this.ranges(t.id);
      v += coverage(t.cx, t.cy, r.r, 0, line) * (POWER[t.id] || 10) * Math.pow(1.186, t.level - 1);
    }
    return v;
  }

  /**
   * 防空补位：有一条飞行路线明显缺对空火力（侧边入口 / 空降点刚开放），就在那条线上补一座对空塔。
   * 真人看到"左边飞来的纸飞机全漏了"也会这么做；只在买得起时出手，否则不影响正常花钱。
   */
  private guardAir(wave: number, budget: number, atk: number): 'none' | 'wait' | 'done' {
    const k = this.p.airGuard ?? 0;
    if (k <= 0 || wave < 6) return 'none';
    if (atk >= this.p.maxTowers(wave) + (this.p.airExtra ?? 0)) return 'none';
    const lines = this.airLines();
    if (lines.length < 2) return 'none';
    const pw = lines.map((l) => this.airPower(l));
    const max = Math.max(...pw);
    let weak = -1;
    for (let i = 0; i < lines.length; i++) if (pw[i] < max * k && (weak < 0 || pw[i] < pw[weak])) weak = i;
    if (weak < 0) return 'none';
    // 有苍蝇拍就补苍蝇拍（专职防空，对空性价比最高），否则补铅笔
    const id: TowerId = this.w.state.unlockedTowers.includes('swatter') ? 'swatter' : 'pencil';
    const cost = this.cost(id);
    this.refreshSamples();
    const { r } = this.ranges(id);
    let best: Slot | null = null;
    let bv = 0;
    for (const sl of this.planSlots()) {
      const v = coverage(sl.cx, sl.cy, r, 0, lines[weak]) + 0.1 * coverage(sl.cx, sl.cy, r, 0, this.gSamples);
      if (v <= bv) continue;
      if (!sl.wallUid && !this.w.canPlace(id, sl.cx, sl.cy).ok) continue;
      best = sl;
      bv = v;
    }
    if (!best || bv < 2) return 'none';
    if (budget < cost + (best.wallUid ? 3 : 0)) return 'wait';
    return this.placeAt(id, best) ? 'done' : 'none';
  }

  private looseWall(wave: number): boolean {
    const s = this.w.state;
    const walls = this.towers().filter((t) => t.id === 'wall').length;
    if (walls >= this.p.looseWalls!(wave) || s.gold < this.cost('wall') + 20) return false;
    const len = (paths: { x: number; y: number }[][] | null) => (paths ? paths.reduce((a, p) => a + p.length, 0) : -1);
    const cur = len(this.w.currentPaths());
    const g = s.grid;
    let best: [number, number] | null = null;
    let bv = cur;
    for (const p of this.w.currentPaths())
      for (const c of p) {
        for (const [dx, dy] of [
          [0, 0],
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const x = c.x + dx;
          const y = c.y + dy;
          if (x < 0 || y < 0 || x >= g.cols || y >= g.rows || g.cells[y * g.cols + x] !== CellKind.Empty) continue;
          const l = len(this.w.previewPath('wall', x, y));
          if (l > bv) {
            bv = l;
            best = [x, y];
          }
        }
      }
    if (!best) return false;
    return this.w.command({ type: 'place', tower: 'wall', cx: best[0], cy: best[1] }).ok;
  }

  private buildWalls(budget: number): boolean {
    const s = this.w.state;
    const g = s.grid;
    const nSeg = this.currentSegments();
    const wallCost = this.cost('wall');
    let spent = 0;
    const cap = Math.max(wallCost, Math.min(budget, this.p.wallShare * (this.otherSpent + this.wallSpent) + 25 - this.wallSpent));
    for (let k = 0; k < nSeg; k++) {
      for (const i of this.plan.segments[k]) {
        if (g.cells[i] !== CellKind.Empty) continue;
        if (spent + wallCost > cap || s.gold < wallCost) return spent > 0;
        const cx = i % g.cols;
        const cy = (i - cx) / g.cols;
        if (this.w.command({ type: 'place', tower: 'wall', cx, cy }).ok) {
          spent += wallCost;
          this.wallSpent += wallCost;
        }
      }
    }
    return spent > 0;
  }

  private upgradeWalls(budget: number): boolean {
    const g = this.w.state.grid;
    for (const t of this.towers()) {
      if (t.id !== 'wall' || t.level >= 3) continue;
      let n = 0;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const x = t.cx + dx;
        const y = t.cy + dy;
        if (x < 0 || y < 0 || x >= g.cols || y >= g.rows) continue;
        const o = this.w.state.towers.get(g.towerAt[y * g.cols + x]);
        if (o && TOWERS[o.id].attacks && o.level >= 6) n++;
      }
      if (n < 2) continue;
      const info = this.w.getTowerInfo(t.uid)!;
      if (info.upgradeCost !== null && info.upgradeCost <= budget) {
        if (this.w.command({ type: 'upgrade', uid: t.uid }).ok) return true;
      }
    }
    return false;
  }

  private bestUpgrade(): { t: TowerState; cost: number; eff: number } | null {
    const s = this.w.state;
    this.refreshSamples();
    let best: { t: TowerState; cost: number; eff: number } | null = null;
    if (this.p.upgrade === 'rare') {
      // 新手：钱很多才升，随便挑一座最低级的
      if (s.gold < 250) return null;
      const list = this.attackers()
        .filter((t) => t.level < 9)
        .sort((a, b) => a.level - b.level);
      const t = list[0];
      if (!t) return null;
      const info = this.w.getTowerInfo(t.uid)!;
      return info.upgradeCost !== null ? { t, cost: info.upgradeCost, eff: 0 } : null;
    }
    for (const t of this.towers()) {
      if (t.id === 'wall' || t.uid === this.probeUid) continue;
      const info = this.w.getTowerInfo(t.uid)!;
      if (t.level >= 10) {
        // 传奇进化：每星 +12% 伤害等；★3 另有主动能力
        if (info.evolveCost === null || this.p.upgrade !== 'value') continue;
        let eff: number;
        if (t.id === 'piggy' || t.id === 'calculator') eff = (0.002 * 10) / info.evolveCost;
        else {
          const r = this.ranges(t.id);
          let cov = TOWERS[t.id].hitsGround ? coverage(t.cx, t.cy, r.r, r.inner, this.gSamples) : 0;
          if (TOWERS[t.id].hitsAir) cov += this.airWeight() * coverage(t.cx, t.cy, r.r, 0, this.aSamples);
          const power = POWER[t.id] * Math.pow(1.186, 9) * 1.5;
          eff = (cov * power * (t.stars === 2 ? 0.35 : 0.16)) / info.evolveCost;
        }
        if (!best || eff > best.eff) best = { t, cost: info.evolveCost, eff };
        continue;
      }
      if (info.upgradeCost === null) continue;
      let eff: number;
      if (t.id === 'piggy') {
        eff = t.level < 9 ? ((0.5 * 2) / info.upgradeCost) * 10 : 0;
      } else if (t.id === 'calculator') {
        eff = ((0.01 * this.slotValue('calculator', t as unknown as Slot)) / info.upgradeCost) * 3;
      } else {
        const r = this.ranges(t.id);
        let cov = TOWERS[t.id].hitsGround ? coverage(t.cx, t.cy, r.r, r.inner, this.gSamples) : 0;
        if (TOWERS[t.id].hitsAir) cov += this.airWeight() * coverage(t.cx, t.cy, r.r, 0, this.aSamples);
        const power = POWER[t.id] * Math.pow(1.186, t.level - 1);
        eff = (cov * power * levelGain(t.id, t.level + 1)) / info.upgradeCost;
      }
      if (!best || eff > best.eff) best = { t, cost: info.upgradeCost, eff };
    }
    return best;
  }

  private doUpgrade(t: TowerState, cost: number): boolean {
    if (this.w.state.gold < cost) return false;
    if (t.level >= 10) {
      const ok = this.w.command({ type: 'evolve', uid: t.uid }).ok;
      if (ok) this.otherSpent += cost;
      return ok;
    }
    const branch = t.level === 9 ? (this.p.branches[t.id] ?? 'A') : undefined;
    const ok = this.w.command({ type: 'upgrade', uid: t.uid, branch }).ok;
    if (ok) this.otherSpent += cost;
    if (ok) this.goldUpgraded.add(t.uid);
    return ok;
  }

  // ───────────── 增益 ─────────────
  private choosePerk(): void {
    const s = this.w.state;
    const cards = s.perkChoices ?? [];
    const rank = (c: PerkCard) => {
      const i = this.p.perkPriority.indexOf(c.id);
      return i < 0 ? 999 : i;
    };
    const sorted = cards.slice().sort((a, b) => rank(a) - rank(b));
    for (const c of sorted) {
      if (c.needsTower) {
        const cand = this.towers()
          .filter((t) => t.id !== 'wall' && t.level >= 7 && t.level < 10)
          .sort((a, b) => b.level - a.level || b.damage - a.damage)[0];
        if (!cand) continue;
        const br = this.p.branches[cand.id] ?? 'A';
        const halfCost = Math.round(rawUpgradeCost(TOWERS[cand.id].cost, 9) * 0.5 * (s.perks.includes('sale') ? 0.9 : 1));
        // 高手（smart）直接选分支进 Lv10；其余只拿 Lv9 + 半价
        const withBranch = this.p.skillUse === 'smart' && s.gold >= halfCost;
        const r = this.w.command({ type: 'choosePerk', id: c.id, uid: cand.uid, branch: withBranch ? br : undefined });
        if (r.ok) {
          this.goldUpgraded.add(cand.uid);
          return;
        }
        continue;
      }
      if (this.w.command({ type: 'choosePerk', id: c.id }).ok) return;
    }
  }

  // ───────────── 技能 ─────────────
  private densest(r: number, air: boolean): { x: number; y: number; v: number; n: number } | null {
    const en = this.w.state.enemies.filter((e) => air || !e.flying);
    let best: { x: number; y: number; v: number; n: number } | null = null;
    for (const a of en) {
      let v = 0;
      let n = 0;
      for (const b of en) {
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        if (dx * dx + dy * dy <= r * r) {
          v += b.hp + b.shield;
          n++;
        }
      }
      if (!best || v > best.v) best = { x: a.x, y: a.y, v, n };
    }
    return best;
  }

  /** 场上生命最多的 Boss */
  private bossTarget(): { x: number; y: number } | null {
    let best: { x: number; y: number; hp: number } | null = null;
    for (const e of this.w.state.enemies) if (e.boss && !e.hidden && (!best || e.hp > best.hp)) best = { x: e.x, y: e.y, hp: e.hp };
    return best;
  }

  private castEconomy(): void {
    const s = this.w.state;
    for (const sk of s.skills) {
      if (!sk.ready) continue;
      if (sk.id === 'scholarship') this.w.command({ type: 'cast', skill: sk.id });
      if (sk.id === 'inspiration') {
        const t = this.attackers()
          .filter((t) => t.level < 9)
          .sort((a, b) => b.level - a.level || b.damage - a.damage)[0];
        if (t) this.w.command({ type: 'cast', skill: sk.id, uid: t.uid });
      }
    }
  }

  private useSkills(): void {
    const s = this.w.state;
    const en = s.enemies;
    if (en.length === 0) return;
    const mode = this.p.skillUse;
    if (mode === 'rare') {
      // 新手：只有怪快到终点、而且很多时才想起来按
      const close = en.filter((e) => e.y > 10).length;
      if (close < 6) return;
    }
    const maxLife = s.maxLives;
    const danger = en.some((e) => !e.flying && e.y > 9.5) || s.lives < maxLife * 0.6;
    const boss = s.bossUids.length > 0;
    const totalHp = en.reduce((a, e) => a + e.hp + e.shield, 0);
    for (const sk of s.skills) {
      if (!sk.ready) continue;
      switch (sk.id) {
        case 'scholarship':
          this.w.command({ type: 'cast', skill: sk.id });
          break;
        case 'inspiration': {
          const t = this.attackers()
            .filter((t) => t.level < 9)
            .sort((a, b) => b.level - a.level || b.damage - a.damage)[0];
          if (t) this.w.command({ type: 'cast', skill: sk.id, uid: t.uid });
          break;
        }
        case 'eraser_strike':
        case 'magnifier': {
          const bossE = this.bossTarget();
          if (bossE && mode !== 'rare') {
            this.w.command({ type: 'cast', skill: sk.id, x: bossE.x, y: bossE.y });
            break;
          }
          const c = this.densest(sk.radius ?? 1.5, true);
          if (!c) break;
          if (mode === 'smart' && !(c.v >= totalHp * 0.3 || danger || boss || c.n >= 6)) break;
          if (mode === 'cooldown' && c.n < 3 && !boss) break;
          this.w.command({ type: 'cast', skill: sk.id, x: c.x, y: c.y });
          break;
        }
        case 'whiteout_zone': {
          const c = this.densest(1.2, false);
          if (!c) break;
          if (mode === 'smart' && !(c.n >= 5 || danger || boss)) break;
          if (mode === 'cooldown' && c.n < 3) break;
          // 放在敌群前方一点
          this.w.command({ type: 'cast', skill: sk.id, x: c.x, y: c.y });
          break;
        }
        case 'bell': {
          const ground = en.filter((e) => !e.flying).length;
          const bossE = this.bossTarget();
          if (bossE && mode !== 'rare' && bossE.y > 6) {
            this.w.command({ type: 'cast', skill: sk.id });
            break;
          }
          if (mode === 'smart' && !(danger && ground >= 4) && !(boss && ground >= 6)) break;
          if (mode !== 'smart' && ground < 8) break;
          this.w.command({ type: 'cast', skill: sk.id });
          break;
        }
        case 'caffeine': {
          if (mode === 'smart' && !(en.length >= 12 || boss || danger)) break;
          if (mode !== 'smart' && en.length < 8) break;
          this.w.command({ type: 'cast', skill: sk.id });
          break;
        }
        case 'ruler_sweep': {
          // 选敌人生命最多的一行
          const rows = new Map<number, number>();
          for (const e of en) rows.set(Math.floor(e.y), (rows.get(Math.floor(e.y)) ?? 0) + e.hp);
          let br = -1;
          let bv = 0;
          for (const [r, v] of rows)
            if (v > bv) {
              bv = v;
              br = r;
            }
          if (br < 0) break;
          if (mode === 'smart' && bv < totalHp * 0.25 && !danger) break;
          this.w.command({ type: 'cast', skill: sk.id, cy: br, axis: 'row' });
          break;
        }
        default:
          break;
      }
    }
  }

  private maybeEarlyStart(): void {
    const s = this.w.state;
    const auto = s.autoWave.enabled && s.autoWave.started;
    if (s.phase !== 'wave' && !(auto && s.phase === 'build')) return;
    // 自动波次：倒计时快结束了，提前开没什么奖励
    if (auto && s.nextWave.earlyBonus < 5) return;
    if (s.time < this.waveSpawnEnd + 1.5) return;
    if (s.bossUids.length > 0) return;
    if (s.nextWave.tags.includes('boss')) return;
    if (s.lives < s.maxLives) return;
    if (this.recentLeaks.some((n) => n > 0) || this.leaksThisWave > 0) return;
    if (s.enemies.length > 2) return;
    // 剩下的怪都已经快死了 / 离终点还远
    if (s.enemies.some((e) => e.y > 9)) return;
    this.w.command({ type: 'startWave' });
  }
}
