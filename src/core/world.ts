import {
  CellKind, DT, GRID_COLS, GRID_ROWS,
  type Branch, type BuildOption, type Command, type CommandResult, type EnemyId, type GameEvent,
  type IWorld, type PerkCard, type PlaceCheck, type RunOptions, type SkillId, type SkillState,
  type TargetMode, type Tier, type TowerId, type TowerInfo, type WorldState,
  TOWER_IDS, type AffixId, type Obstacle, type RandomEventId, type RandomEventState, type SpawnerState,
  RANDOM_EVENT_IDS, type TraitLine,
} from './types';
import { generateLayout } from './layout';
import { RANDOM_EVENTS, EVENT_DIRECTOR, DROP, CRATE_OPTIONS } from '../config/events';
import { ABILITIES, EVO, evoBranch } from '../config/evolution';
import { Rng, makeSeed } from './rng';
import {
  armorAt, goldScale, hpScale, rawUpgradeCost, refundRate, resolveParams, speedScale, xpForLevel, xpScale,
} from './scaling';
import { computeDist, isPassableKind, nextCell, tracePath } from './flowfield';
import { assignSpawners, generateWave, type SpawnEntry, type SpawnSlot, type WavePlan } from './wavegen';
import {
  C_CALC_PIGGY, C_GLUE_STAPLER, C_LAMP_PEN, C_PENCIL_ERASER, C_RULER_COMPASS,
  F_AOE, F_BEAM, F_CRIT, F_DOT, F_IGNORE_ARMOR, F_SHIELD2, F_SHIELD3, F_SKILL, F_TRUE,
  type Enemy, type Proj, type Tower, type Zone,
} from './entities';
import { COMBOS, GROWTH, PIGGY_MAX, TIER_NAMES, TOWERS, UNDO_SECONDS, WALL_UPGRADE_COST } from '../config/towers';
import { ELITE, ENEMIES } from '../config/enemies';
import { MAPS, spawnerOpenWave, type MapDef } from '../config/maps';
import { CAPS } from '../config/difficulty';
import { RELOCATE_CHARGES, RELOCATE_RECOVER_WAVES, SKILLS, SKILL_IDS, SKILL_LEVEL } from '../config/skills';
import { EPIC_LATE_WAVE, EPIC_WEIGHT_LATE, PERKS, PERK_REROLL_COST, RARITY_WEIGHT, type PerkId } from '../config/perks';
import { CAMPAIGN_WAVES } from '../config/campaign';

const MAX_PROJECTILES = 300;
const TAU = Math.PI * 2;
const N8X = [1, -1, 0, 0, 1, 1, -1, -1];
const N8Y = [0, 0, 1, -1, 1, -1, 1, -1];
/** 同时进行的波次上限 */
const MAX_CONCURRENT_WAVES = 3;
/** 激光笔递增倍率上限（★1 +50%） */
const LASER_RAMP_CAP = 5;

/** 事件导演的内部数据（每个事件实例） */
interface EventFx {
  /** 空降 / 暗门：出生点 id */
  spawner?: string;
  /** 书本：三格 + 方向 */
  books?: { x: number; y: number; w: number; h: number };
  /** 桌面整理：被移动的障碍 + 目标 */
  tidy?: { from: Obstacle; to: Obstacle };
  /** 咖啡：区域 */
  area?: { x: number; y: number; w: number; h: number };
}

interface ActiveWave {
  plan: WavePlan;
  idx: number;
  t: number;
  alive: number;
  warned: boolean;
  /** 开波时的击杀数（老师表扬：本波得分 ×2） */
  kills0: number;
}

type DebuffKind = 'glue' | 'eraser' | 'pen';

function tierOf(level: number, isWall: boolean, stars = 0): Tier {
  if (isWall) return Math.max(1, Math.min(3, level)) as Tier;
  if (level >= 10) return stars >= 3 ? 5 : 4;
  if (level >= 7) return 3;
  if (level >= 4) return 2;
  return 1;
}

function fmt(n: number, d = 1): string {
  const v = Math.round(n * Math.pow(10, d)) / Math.pow(10, d);
  return String(v);
}

export class World implements IWorld {
  readonly state: WorldState;
  readonly log: { tick: number; cmd: Command }[] = [];

  private events: GameEvent[] = [];
  private rng: Rng;
  private towerList: Tower[] = [];
  private enemyByUid = new Map<number, Enemy>();
  private nextUid = 1;
  private goldFrac = 0;
  private statsDirty = true;
  private active: ActiveWave[] = [];
  private planCache = new Map<number, WavePlan>();
  private clearedWaves = 0;
  private lastCleared = 0;
  private wavesSinceRecharge = 0;
  private perkOffers = 0;
  private perkRerolls = 0;
  private freeRerolls = 0;
  private skillLevels: Partial<Record<SkillId, number>>;
  private talents: Partial<Record<string, number>>;
  private mapDef: MapDef;
  private campaign: boolean;
  private distScratch: Float32Array;
  private cellScratch: Uint8Array;
  /** 预警中的格子：空降（视为障碍）/ 暗门（只禁止建造） */
  private reserved = new Map<number, 'drop' | 'door'>();
  /** 出生点集合版本（变化后重新分配预告） */
  private spawnerVersion = 0;
  private dropSeq = 0;
  private dropRatio = new Map<string, number>();
  private landmarkKeys: Set<string>;
  // 自动波次
  private lastStarted: ActiveWave | null = null;
  private autoLastSecond = 0;
  // 事件导演
  private evRng: Rng;
  private nextEventWave = 0;
  private pendingEvents: { id: RandomEventId | null; at: number; wave: number }[] = [];
  private eventLastWave = new Map<RandomEventId, number>();
  private eventFx = new Map<number, EventFx>();
  private fanUntil = 0;
  private windUntil = 0;
  private windDir = 1;
  private homeworkUntil = 0;
  private daylightUntil = 0;
  private vaultUntil = 0;
  private praiseWaves = new Set<number>();
  private bonusScore = 0;
  private projPool: Proj[] = [];
  private bucketHead: Int32Array;
  private bucketNext: Int32Array = new Int32Array(512);
  private qA: Enemy[] = [];
  private qB: Enemy[] = [];
  private qC: Enemy[] = [];
  private qD: Enemy[] = [];
  private timeMgmtUntil = 0;
  private xpGlobalMul = 1;

  constructor(opts: RunOptions) {
    const seed = opts.seed && opts.seed.length ? opts.seed : makeSeed();
    const params = resolveParams(opts);
    const pure = !!opts.pure;
    this.talents = pure ? {} : { ...(opts.talents ?? {}) };
    const tl = (id: string) => Math.max(0, this.talents[id] ?? 0);
    this.rng = new Rng(`${seed}|combat`);
    this.evRng = new Rng(`${seed}|events`);
    const map = MAPS[opts.map] ?? MAPS.ch1;
    this.mapDef = map;
    this.campaign = opts.mode === 'campaign';
    const layout = generateLayout(map.id, seed, !!opts.fixedLayout, this.campaign);
    this.landmarkKeys = new Set(map.landmarks.map((o) => `${o.kind}@${o.x},${o.y}`));
    const cols = GRID_COLS;
    const rows = GRID_ROWS;
    const cells = new Uint8Array(cols * rows);
    for (const o of layout.obstacles) {
      for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++) cells[y * cols + x] = CellKind.Obstacle;
    }
    // 所有边缘入口（含后期开放的）都占格；隐藏出生点关闭时是空地
    for (const sp of layout.spawners) if (sp.kind === 'edge') for (const c of sp.cells) cells[c.y * cols + c.x] = CellKind.Spawn;
    const spawns: { x: number; y: number }[] = [];
    for (const sp of layout.spawners) if (sp.active) for (const c of sp.cells) spawns.push({ x: c.x, y: c.y });
    for (const c of layout.exits) cells[c.y * cols + c.x] = CellKind.Exit;
    const dist = new Float32Array(cols * rows);
    computeDist(cols, rows, cells, layout.exits, dist);
    this.distScratch = new Float32Array(cols * rows);
    this.cellScratch = new Uint8Array(cols * rows);
    this.bucketHead = new Int32Array(cols * rows).fill(-1);

    const startGold = Math.round(params.startGold * (1 + 0.05 * tl('wallet')));
    const lives = params.lives + tl('bandaid');
    this.xpGlobalMul = 1 + 0.05 * tl('study');

    const maxSkills = tl('bigbag') > 0 ? 4 : 3;
    const skillIds: SkillId[] = [];
    for (const s of opts.skills ?? []) if (SKILLS[s] && !skillIds.includes(s) && skillIds.length < maxSkills) skillIds.push(s);
    this.skillLevels = { ...(opts.skillLevels ?? {}) };

    this.state = {
      opts: { ...opts, seed },
      params,
      seed,
      tick: 0,
      time: 0,
      phase: 'build',
      wave: 0,
      totalWaves: opts.mode === 'campaign' ? CAMPAIGN_WAVES : 0,
      gold: startGold,
      lives,
      maxLives: lives,
      score: 0,
      grid: {
        cols, rows, cells,
        towerAt: new Int32Array(cols * rows),
        spawns,
        exits: layout.exits,
        obstacles: layout.obstacles,
        dist,
        version: 1,
      },
      towers: new Map(),
      enemies: [],
      projectiles: [],
      zones: [],
      skills: [],
      perks: [],
      perkChoices: null,
      perkRerollCost: PERK_REROLL_COST,
      nextWave: { wave: 1, tags: [], groups: [], earlyBonus: 0 },
      unlockedTowers: [],
      caffeineUntil: 0,
      spawners: layout.spawners,
      events: [],
      eventLog: [],
      pickups: [],
      crateChoice: null,
      autoWave: {
        enabled: opts.autoWave ?? opts.difficulty !== 'easy',
        started: false, nextAt: null, deadline: null, blocked: false,
      },
      bossUids: [],
      stats: { kills: 0, leaks: 0, goldEarned: 0, goldSpent: 0, towersBuilt: 0, skillsCast: 0 },
    };
    this.nextEventWave = this.rollEventGap(0);
    for (const id of skillIds) this.state.skills.push(this.makeSkill(id));
    this.updateUnlocks(false);
    this.updatePreview();
    this.updateScore();
  }

  // ───────────────────────── 公共接口 ─────────────────────────

  drainEvents(): GameEvent[] {
    if (this.events.length === 0) return [];
    const e = this.events;
    this.events = [];
    return e;
  }

  enemyName(id: EnemyId): string {
    return ENEMIES[id]?.name ?? id;
  }

  baseRange(tower: TowerId): { range: number; inner?: number; aura?: number } {
    const d = TOWERS[tower];
    const out: { range: number; inner?: number; aura?: number } = { range: d.range };
    if (d.inner !== undefined) out.inner = d.inner;
    if (d.aura !== undefined) out.aura = d.aura + (this.hasPerk('scholaraura') ? 1 : 0);
    if (tower === 'ruler' || tower === 'compass') out.range += this.hasPerk('drafting') ? 0.5 : 0;
    return out;
  }

  command(cmd: Command): CommandResult {
    const r = this.exec(cmd);
    if (r.ok) this.log.push({ tick: this.state.tick, cmd: JSON.parse(JSON.stringify(cmd)) as Command });
    this.updatePreview();
    this.updateScore();
    return r;
  }

  canPlace(tower: TowerId, cx: number, cy: number): PlaceCheck {
    const def = TOWERS[tower];
    if (!def) return { ok: false, reason: '未知的塔' };
    if (!this.state.unlockedTowers.includes(tower)) return { ok: false, reason: '尚未解锁' };
    if (tower === 'piggy' && this.countTowers('piggy') >= PIGGY_MAX) return { ok: false, reason: `存钱罐最多 ${PIGGY_MAX} 个` };
    const g = this.placeGeom(cx, cy, -1);
    if (!g.ok) return g;
    if (this.state.gold < this.towerCost(tower)) return { ok: false, reason: '金币不足' };
    return { ok: true };
  }

  previewPath(tower: TowerId | null, cx: number, cy: number): { x: number; y: number }[][] | null {
    if (tower === null) return this.currentPaths();
    const g = this.placeGeom(cx, cy, -1);
    if (!g.ok) return null;
    const { cols } = this.state.grid;
    const tmp = this.tempCells(cy * cols + cx, -1);
    const d = computeDist(cols, this.state.grid.rows, tmp, this.state.grid.exits, this.distScratch);
    return this.tracePaths(tmp, d);
  }

  currentPaths(): { x: number; y: number }[][] {
    const g = this.state.grid;
    return this.tracePaths(g.cells, g.dist);
  }

  /** 从每个开放出生点（空降点从相邻格出发）沿流场走到出口 */
  private tracePaths(cells: Uint8Array, d: Float32Array): { x: number; y: number }[][] {
    const g = this.state.grid;
    const out: { x: number; y: number }[][] = [];
    for (const sp of this.state.spawners) {
      if (!sp.active) continue;
      const c = sp.cells[0];
      const i = c.y * g.cols + c.x;
      if (sp.kind === 'drop') {
        const n = this.exitStep(i, cells, d);
        if (n < 0) continue;
        out.push([{ x: c.x, y: c.y }, ...tracePath(g.cols, g.rows, cells, d, n)]);
      } else out.push(tracePath(g.cols, g.rows, cells, d, i));
    }
    return out;
  }

  getBuildOptions(): BuildOption[] {
    return TOWER_IDS.map((id) => {
      const d = TOWERS[id];
      const cost = this.towerCost(id);
      const o: BuildOption = {
        id, name: d.name, cost,
        affordable: this.state.gold >= cost,
        unlocked: this.state.unlockedTowers.includes(id),
        hitsAir: d.hitsAir, hitsGround: d.hitsGround,
        role: d.role, desc: d.desc,
      };
      if (id === 'piggy') o.limitReached = this.countTowers('piggy') >= PIGGY_MAX;
      return o;
    });
  }

  getTowerInfo(uid: number): TowerInfo | null {
    const t = this.state.towers.get(uid) as Tower | undefined;
    if (!t) return null;
    this.ensureStats();
    return this.buildTowerInfo(t);
  }

  // ───────────────────────── 主循环 ─────────────────────────

  step(): void {
    const s = this.state;
    if (s.phase === 'perk' || s.phase === 'won' || s.phase === 'lost') return;
    s.tick++;
    s.time += DT;
    this.ensureStats();
    if (s.phase === 'wave') {
      this.tickSkills(DT);
      this.tickAbilities(DT);
    }
    this.tickEvents();
    this.processSpawns();
    this.moveEnemies();
    if ((s.phase as string) === 'lost') return;
    this.rebuildBuckets();
    this.preEnemyPass();
    this.processZones();
    this.updateStealth();
    this.enemyAbilities();
    this.processDots();
    this.ensureStats();
    this.towersAct();
    this.moveProjectiles();
    this.cleanup();
    // 指令可能在两步之间查询敌人，保证分桶与压缩后的数组一致
    this.rebuildBuckets();
    this.checkWaves();
    this.tickAutoWave();
    this.updatePreviewEarly();
    this.updateScore();
  }

  // ───────────────────────── 指令 ─────────────────────────

  private exec(cmd: Command): CommandResult {
    const s = this.state;
    if (s.phase === 'won' || s.phase === 'lost') return { ok: false, reason: '本局已结束' };
    switch (cmd.type) {
      case 'place': return this.cmdPlace(cmd.tower, cmd.cx, cmd.cy);
      case 'upgrade': return this.cmdUpgrade(cmd.uid, cmd.branch);
      case 'sell': return this.cmdSell(cmd.uid);
      case 'setTarget': {
        const t = s.towers.get(cmd.uid) as Tower | undefined;
        if (!t) return { ok: false, reason: '塔不存在' };
        if (!this.targetModes(t).includes(cmd.mode)) return { ok: false, reason: '不支持该目标策略' };
        t.targetMode = cmd.mode;
        return { ok: true };
      }
      case 'startWave': return this.cmdStartWave();
      case 'cast': return this.cmdCast(cmd);
      case 'choosePerk': return this.cmdChoosePerk(cmd.id, cmd.uid, cmd.branch);
      case 'rerollPerks': return this.cmdReroll();
      case 'collect': return this.cmdCollect(cmd.uid);
      case 'chooseCrate': return this.cmdChooseCrate(cmd.option);
      case 'demolishSpawner': return this.cmdDemolish(cmd.id);
      case 'evolve': return this.cmdEvolve(cmd.uid);
      case 'towerAbility': return this.cmdTowerAbility(cmd);
    }
    return { ok: false, reason: '未知指令' };
  }

  private cmdPlace(tower: TowerId, cx: number, cy: number): CommandResult {
    const s = this.state;
    if (s.phase === 'perk') return { ok: false, reason: '请先选择增益' };
    const chk = this.canPlace(tower, cx, cy);
    if (!chk.ok) {
      if (chk.reason === '会堵死道路' || chk.reason === '会困住敌人') this.toast(chk.reason, 'warn');
      return chk;
    }
    const cost = this.towerCost(tower);
    this.spendGold(cost);
    const t = this.makeTower(tower, cx, cy, cost);
    s.towers.set(t.uid, t);
    this.towerList.push(t);
    const i = cy * s.grid.cols + cx;
    s.grid.cells[i] = CellKind.Tower;
    s.grid.towerAt[i] = t.uid;
    this.terrainChanged();
    s.stats.towersBuilt++;
    this.emit({ type: 'place', uid: t.uid, tower, cx, cy });
    return { ok: true };
  }

  private cmdUpgrade(uid: number, branch?: Branch): CommandResult {
    const s = this.state;
    const t = s.towers.get(uid) as Tower | undefined;
    if (!t) return { ok: false, reason: '塔不存在' };
    if (s.phase === 'perk') return { ok: false, reason: '请先选择增益' };
    const cost = this.upgradeCost(t);
    if (cost === null) return { ok: false, reason: '已满级' };
    if (t.id !== 'wall' && t.level === 9) {
      if (branch !== 'A' && branch !== 'B') return { ok: false, reason: '请选择传奇分支' };
    }
    if (s.gold < cost) return { ok: false, reason: '金币不足' };
    this.spendGold(cost);
    t.invested += cost;
    const oldTier = t.tier;
    t.level++;
    if (t.level === 10 && t.id !== 'wall') {
      t.branch = branch ?? 'A';
      t.xp = 0;
      t.halfLegend = false;
      t.stars = 0;
      t.evoXp = 0;
    }
    this.afterLevelChange(t);
    this.emit({ type: 'levelUp', uid: t.uid, level: t.level, tier: t.tier, tierChanged: t.tier !== oldTier, byXp: false });
    if (t.id !== 'wall') this.processXpLevels(t);
    return { ok: true };
  }

  private cmdSell(uid: number): CommandResult {
    const s = this.state;
    const t = s.towers.get(uid) as Tower | undefined;
    if (!t) return { ok: false, reason: '塔不存在' };
    if (s.phase === 'perk') return { ok: false, reason: '请先选择增益' };
    const refund = this.sellValue(t);
    this.removeTower(t);
    if (refund > 0) this.addGold(refund, 'refund', t.cx + 0.5, t.cy + 0.5, false);
    this.emit({ type: 'sell', uid: t.uid, tower: t.id, cx: t.cx, cy: t.cy, refund });
    return { ok: true };
  }

  private cmdStartWave(): CommandResult {
    return this.startWave(false);
  }

  /** 开波；auto = 自动波次（不经过指令记录） */
  private startWave(auto: boolean): CommandResult {
    const s = this.state;
    if (s.phase === 'perk') return { ok: false, reason: '请先选择增益' };
    const next = s.wave + 1;
    if (s.totalWaves > 0 && next > s.totalWaves) return { ok: false, reason: '已经是最后一波' };
    if (this.active.length >= MAX_CONCURRENT_WAVES) return { ok: false, reason: '同时进行的波次太多了' };
    const au = s.autoWave;
    const early = !auto && (s.phase === 'wave' || (au.enabled && au.started));
    const bonus = early ? this.earlyBonus(next) : 0;
    this.openSpawnersFor(next);
    const plan = this.getPlan(next);
    s.wave = next;
    s.phase = 'wave';
    const aw: ActiveWave = { plan, idx: 0, t: 0, alive: 0, warned: false, kills0: s.stats.kills };
    this.active.push(aw);
    this.lastStarted = aw;
    this.planCache.delete(next);
    if (bonus > 0) this.addGold(bonus, 'early');
    for (const t of this.towerList) t.colorGold = 0;
    for (const sp of s.spawners) if (sp.kind === 'drop') sp.demolishCost = this.demolishCost();
    this.emit({ type: 'waveStart', wave: next, tags: plan.tags.slice() });
    if (this.hasPerk('timemgmt')) {
      this.timeMgmtUntil = s.time + 1;
      for (const e of s.enemies as Enemy[]) if (!e.dead && !e.flying) this.applyStun(e, 1, true);
    }
    if (au.enabled) {
      au.started = true;
      au.nextAt = null;
      au.deadline = s.time + s.params.waveMax;
      au.blocked = false;
      this.autoLastSecond = 99;
    }
    this.scheduleEvents(next);
    this.updateUnlocks(true);
    return { ok: true };
  }

  private cmdCast(cmd: Extract<Command, { type: 'cast' }>): CommandResult {
    const s = this.state;
    if (s.phase === 'perk') return { ok: false, reason: '请先选择增益' };
    const sk = s.skills.find((k) => k.id === cmd.skill);
    if (!sk) return { ok: false, reason: '没有携带这个技能' };
    if (sk.id === 'relocate') {
      if ((sk.charges ?? 0) <= 0) return { ok: false, reason: '没有充能' };
    } else if (sk.cd > 0) return { ok: false, reason: '技能冷却中' };
    const eff = 1 + SKILL_LEVEL.effectPerLevel * (sk.level - 1);
    const scale = hpScale(s.params, this.currentEffWave());
    const ev: GameEvent = { type: 'skill', skill: sk.id };
    switch (sk.id) {
      case 'eraser_strike': {
        if (cmd.x === undefined || cmd.y === undefined) return { ok: false, reason: '请选择位置' };
        const r = 1.5;
        const dmg = 120 * scale * eff;
        const n = this.queryAll(cmd.x, cmd.y, r, this.qC, true);
        for (let i = 0; i < n; i++) {
          const e = this.qC[i];
          e.revealUntil = Math.max(e.revealUntil, s.time + 3);
          this.damage(e, dmg, null, F_SKILL | F_TRUE);
        }
        Object.assign(ev, { x: cmd.x, y: cmd.y, r });
        this.emit({ type: 'pulse', x: cmd.x, y: cmd.y, r, color: 'magenta' });
        break;
      }
      case 'bell': {
        const dur = 2.5 * eff;
        for (const e0 of s.enemies) {
          const e = e0 as Enemy;
          if (e.dead || e.flying) continue;
          if (e.boss || e.unstoppable) this.forceSlow(e, 0.5, dur);
          else this.applyStun(e, dur, true);
        }
        this.emit({ type: 'pulse', x: 6, y: 7, r: 9, color: 'cyan' });
        break;
      }
      case 'whiteout_zone': {
        let x0: number;
        let y0: number;
        if (cmd.cx !== undefined && cmd.cy !== undefined) {
          x0 = cmd.cx;
          y0 = cmd.cy;
        } else if (cmd.x !== undefined && cmd.y !== undefined) {
          x0 = Math.floor(cmd.x - 0.5);
          y0 = Math.floor(cmd.y - 0.5);
        } else return { ok: false, reason: '请选择位置' };
        x0 = Math.max(0, Math.min(s.grid.cols - 2, x0));
        y0 = Math.max(0, Math.min(s.grid.rows - 2, y0));
        this.addZone('whiteout', 'rect', x0, y0, { w: 2, h: 2, until: s.time + 8 * eff, slow: 0.6, reveal: true });
        Object.assign(ev, { cx: x0, cy: y0, x: x0 + 1, y: y0 + 1 });
        break;
      }
      case 'caffeine':
        s.caffeineUntil = s.time + 8 * eff;
        break;
      case 'ruler_sweep': {
        const axis = cmd.axis ?? 'row';
        let line: number;
        if (axis === 'row') line = cmd.cy ?? (cmd.y !== undefined ? Math.floor(cmd.y) : -1);
        else line = cmd.cx ?? (cmd.x !== undefined ? Math.floor(cmd.x) : -1);
        if (line < 0) return { ok: false, reason: '请选择一行或一列' };
        const dmg = 80 * scale * eff;
        const list: Enemy[] = [];
        for (const e0 of s.enemies) {
          const e = e0 as Enemy;
          if (e.dead) continue;
          const v = axis === 'row' ? e.y : e.x;
          if (v >= line - e.radius && v <= line + 1 + e.radius) list.push(e);
        }
        for (const e of list) {
          this.damage(e, dmg, null, F_SKILL);
          if (!e.dead && !e.flying) this.knockback(e, 1);
        }
        Object.assign(ev, axis === 'row' ? { cy: line, axis } : { cx: line, axis });
        break;
      }
      case 'scholarship': {
        const g = Math.round((30 + 5 * Math.max(1, s.wave)) * eff);
        this.addGold(g, 'skill');
        break;
      }
      case 'relocate': {
        const t = cmd.uid !== undefined ? (s.towers.get(cmd.uid) as Tower | undefined) : undefined;
        if (!t) return { ok: false, reason: '请选择要搬的塔' };
        if (cmd.cx === undefined || cmd.cy === undefined) return { ok: false, reason: '请选择目标格' };
        const from = t.cy * s.grid.cols + t.cx;
        const chk = this.placeGeom(cmd.cx, cmd.cy, from);
        if (!chk.ok) return chk;
        const ox = t.cx;
        const oy = t.cy;
        this.moveTowerTo(t, cmd.cx, cmd.cy);
        t.undoUntil = 0;
        this.terrainChanged();
        sk.charges = (sk.charges ?? 1) - 1;
        Object.assign(ev, { uid: t.uid, cx: cmd.cx, cy: cmd.cy, x: ox + 0.5, y: oy + 0.5 });
        break;
      }
      case 'inspiration': {
        const t = cmd.uid !== undefined ? (s.towers.get(cmd.uid) as Tower | undefined) : undefined;
        if (!t) return { ok: false, reason: '请选择一座塔' };
        if (t.id === 'wall') return { ok: false, reason: '书本墙无法获得经验' };
        if (t.level >= 10) {
          if (t.stars >= 3 || (t.stars === 2 && t.evoXp >= t.evoXpNext)) return { ok: false, reason: '经验已满' };
          t.evoXp += 0.5 * eff * xpForLevel(9);
          this.processEvoXp(t);
        } else {
          if (t.level === 9 && t.xp >= t.xpNext) return { ok: false, reason: '经验已满' };
          t.xp += 0.5 * eff * t.xpNext;
          this.processXpLevels(t);
        }
        Object.assign(ev, { uid: t.uid, x: t.cx + 0.5, y: t.cy + 0.5 });
        break;
      }
      case 'magnifier': {
        if (cmd.x === undefined || cmd.y === undefined) return { ok: false, reason: '请选择位置' };
        this.addZone('magnifier', 'circle', cmd.x, cmd.y, { r: 2, until: s.time + 6 * eff, vuln: 0.25, reveal: true, air: true });
        Object.assign(ev, { x: cmd.x, y: cmd.y, r: 2 });
        break;
      }
      case 'seal_tape': {
        let sp = cmd.spawner ? s.spawners.find((k) => k.id === cmd.spawner) : undefined;
        if (!sp && cmd.x !== undefined && cmd.y !== undefined) {
          let bd = 2.25;
          for (const k of s.spawners) {
            if (k.kind !== 'drop') continue;
            const dx = k.cells[0].x + 0.5 - cmd.x;
            const dy = k.cells[0].y + 0.5 - cmd.y;
            if (dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; sp = k; }
          }
        }
        if (!sp || sp.kind !== 'drop') return { ok: false, reason: '请选择一个空降出生点' };
        const c = sp.cells[0];
        this.closeDrop(sp, 'demolish');
        Object.assign(ev, { x: c.x + 0.5, y: c.y + 0.5, cx: c.x, cy: c.y });
        this.toast('空降点已被封箱胶带封住', 'good');
        break;
      }
    }
    if (sk.id !== 'relocate') {
      sk.cd = sk.cdMax;
      sk.ready = false;
    } else sk.ready = (sk.charges ?? 0) > 0;
    s.stats.skillsCast++;
    this.emit(ev);
    return { ok: true };
  }

  private cmdChoosePerk(id: string, uid?: number, branch?: Branch): CommandResult {
    const s = this.state;
    if (s.phase !== 'perk' || !s.perkChoices) return { ok: false, reason: '现在不能选择增益' };
    const card = s.perkChoices.find((c) => c.id === id);
    if (!card) return { ok: false, reason: '没有这个选项' };
    const pid = id as PerkId;
    if (pid === 'legend') {
      const t = uid !== undefined ? (s.towers.get(uid) as Tower | undefined) : undefined;
      if (!t || t.id === 'wall' || t.level < 7 || t.level >= 10) return { ok: false, reason: '请选择一座 Lv7–9 的塔' };
      if (branch !== undefined) {
        if (branch !== 'A' && branch !== 'B') return { ok: false, reason: '请选择传奇分支' };
        if (s.gold < this.legendPerkCost(t)) return { ok: false, reason: '金币不足' };
      }
    }
    this.applyPerk(pid, uid, branch);
    s.perks.push(id);
    s.perkChoices = null;
    s.phase = this.active.length > 0 ? 'wave' : 'build';
    this.statsDirty = true;
    this.emit({ type: 'perkChosen', id });
    this.checkWin();
    return { ok: true };
  }

  private cmdReroll(): CommandResult {
    const s = this.state;
    if (s.phase !== 'perk' || !s.perkChoices) return { ok: false, reason: '现在不能刷新' };
    const cost = s.perkRerollCost;
    if (s.gold < cost) return { ok: false, reason: '金币不足' };
    if (cost > 0) this.spendGold(cost);
    else this.freeRerolls = Math.max(0, this.freeRerolls - 1);
    this.perkRerolls++;
    s.perkRerollCost = this.freeRerolls > 0 ? 0 : PERK_REROLL_COST;
    s.perkChoices = this.rollPerks();
    this.emit({ type: 'perkOffer', cards: s.perkChoices.map((c) => ({ ...c })) });
    return { ok: true };
  }

  // ───────────────────────── 放置 / 地形 ─────────────────────────

  private placeGeom(cx: number, cy: number, unblock: number): PlaceCheck {
    const g = this.state.grid;
    if (!Number.isInteger(cx) || !Number.isInteger(cy) || cx < 0 || cy < 0 || cx >= g.cols || cy >= g.rows) return { ok: false, reason: '超出棋盘' };
    const i = cy * g.cols + cx;
    if (i === unblock) return { ok: false, reason: '已经在这里了' };
    const k = g.cells[i];
    if (k === CellKind.Tower) return { ok: false, reason: '已经有塔了' };
    if (k !== CellKind.Empty) return { ok: false, reason: '这里不能建造' };
    if (this.reserved.has(i)) return { ok: false, reason: '出生点即将出现在这里' };
    for (const e0 of this.state.enemies) {
      const e = e0 as Enemy;
      if (e.dead || e.flying) continue;
      if ((e.ccx === cx && e.ccy === cy) || (e.tcx === cx && e.tcy === cy)) return { ok: false, reason: '有敌人在这里' };
    }
    const r = this.validate(this.tempCells(i, unblock), this.distScratch);
    if (r === 1) return { ok: false, reason: '会堵死道路' };
    if (r === 2) return { ok: false, reason: '会困住敌人' };
    return { ok: true };
  }

  /** 当前格子的副本：block 设为塔、unblock 设为空地，预警中的空降格视为障碍 */
  private tempCells(block: number, unblock: number): Uint8Array {
    const tmp = this.cellScratch;
    tmp.set(this.state.grid.cells);
    if (unblock >= 0) tmp[unblock] = CellKind.Empty;
    if (block >= 0) tmp[block] = CellKind.Tower;
    for (const [ri, kind] of this.reserved) if (kind === 'drop') tmp[ri] = CellKind.Obstacle;
    return tmp;
  }

  /**
   * 校验一组格子：所有边缘入口、开放的隐藏出生点、空降点（含预警中的）都能走到出口，
   * 地面敌人也不会被困住。0 = 通过，1 = 堵死出生点，2 = 困住敌人。out 写入流场。
   */
  private validate(cells: Uint8Array, out: Float32Array): number {
    const g = this.state.grid;
    const d = computeDist(g.cols, g.rows, cells, g.exits, out);
    const ok = (i: number) => d[i] < Infinity || (!isPassableKind(cells[i]) && this.exitStep(i, cells, d) >= 0);
    for (const sp of this.state.spawners) {
      const need = sp.kind === 'edge' || sp.active || (sp.kind === 'drop' && sp.warnUntil !== undefined);
      if (!need) continue;
      for (const c of sp.cells) if (!ok(c.y * g.cols + c.x)) return 1;
    }
    for (const e0 of this.state.enemies) {
      const e = e0 as Enemy;
      if (e.dead || e.flying) continue;
      if (!ok(e.tcy * g.cols + e.tcx) && !ok(e.ccy * g.cols + e.ccx)) return 2;
    }
    return 0;
  }

  /** 从一个（不可通行的）格子迈出的第一步：相邻可通行格中离出口最近的；-1 = 无 */
  private exitStep(i: number, cells: Uint8Array, d: Float32Array): number {
    const g = this.state.grid;
    const x = i % g.cols;
    const y = (i - x) / g.cols;
    let best = -1;
    let bv = Infinity;
    for (let k = 0; k < 8; k++) {
      const nx = x + N8X[k];
      const ny = y + N8Y[k];
      if (nx < 0 || ny < 0 || nx >= g.cols || ny >= g.rows) continue;
      const ni = ny * g.cols + nx;
      if (!isPassableKind(cells[ni]) || !(d[ni] < Infinity)) continue;
      if (k >= 4 && (!isPassableKind(cells[y * g.cols + nx]) || !isPassableKind(cells[ny * g.cols + x]))) continue;
      const v = d[ni] + (k >= 4 ? 1.414 : 1);
      if (v < bv - 1e-4) { bv = v; best = ni; }
    }
    return best;
  }

  private terrainChanged(): void {
    const g = this.state.grid;
    computeDist(g.cols, g.rows, g.cells, g.exits, g.dist);
    g.version++;
    this.statsDirty = true;
  }

  /** 地形被事件改变后：被压住 / 目标格变成障碍的地面敌人挪到最近的可走格，并重新寻路 */
  private fixEnemies(): void {
    const g = this.state.grid;
    for (const e0 of this.state.enemies) {
      const e = e0 as Enemy;
      if (e.dead || e.flying) continue;
      const ci = e.ccy * g.cols + e.ccx;
      const ti = e.tcy * g.cols + e.tcx;
      const okC = isPassableKind(g.cells[ci]) && g.dist[ci] < Infinity;
      const okT = isPassableKind(g.cells[ti]) && g.dist[ti] < Infinity;
      if (okT && (okC || ti !== ci)) {
        if (okC && !(g.dist[ti] < g.dist[ci]) && ti !== ci) {
          // 目标不再是下坡：回到当前格中心重新走
          e.tcx = e.ccx;
          e.tcy = e.ccy;
        }
        this.updateRemaining(e);
        continue;
      }
      if (okC) {
        e.tcx = e.ccx;
        e.tcy = e.ccy;
        this.updateRemaining(e);
        continue;
      }
      // 当前格与目标格都被压住：找最近的可走格
      let best = -1;
      let bd = Infinity;
      for (let i = 0; i < g.cells.length; i++) {
        if (!isPassableKind(g.cells[i]) || !(g.dist[i] < Infinity)) continue;
        const x = i % g.cols;
        const y = (i - x) / g.cols;
        const dx = x + 0.5 - e.x;
        const dy = y + 0.5 - e.y;
        const dd = dx * dx + dy * dy;
        if (dd < bd - 1e-9) { bd = dd; best = i; }
      }
      if (best < 0) continue;
      const bx = best % g.cols;
      const by = (best - bx) / g.cols;
      e.x = bx + 0.5;
      e.y = by + 0.5;
      e.ccx = e.tcx = e.pcx = bx;
      e.ccy = e.tcy = e.pcy = by;
      this.updateRemaining(e);
    }
  }

  private moveTowerTo(t: Tower, cx: number, cy: number): void {
    const g = this.state.grid;
    const from = t.cy * g.cols + t.cx;
    if (g.towerAt[from] === t.uid) {
      g.cells[from] = CellKind.Empty;
      g.towerAt[from] = 0;
    }
    const to = cy * g.cols + cx;
    g.cells[to] = CellKind.Tower;
    g.towerAt[to] = t.uid;
    t.cx = cx;
    t.cy = cy;
    this.statsDirty = true;
  }

  private removeTower(t: Tower): void {
    const s = this.state;
    const i = t.cy * s.grid.cols + t.cx;
    s.grid.cells[i] = CellKind.Empty;
    s.grid.towerAt[i] = 0;
    s.towers.delete(t.uid);
    const k = this.towerList.indexOf(t);
    if (k >= 0) this.towerList.splice(k, 1);
    for (const p of s.projectiles) if ((p as Proj).tower === t) (p as Proj).tower = null;
    this.terrainChanged();
  }

  private countTowers(id: TowerId): number {
    let n = 0;
    for (const t of this.towerList) if (t.id === id) n++;
    return n;
  }

  towerCost(id: TowerId): number {
    let c = TOWERS[id].cost;
    if (id === 'wall' && this.hasPerk('thickcover')) c = 3;
    if (this.hasPerk('sale')) c = Math.round(c * 0.9);
    return c;
  }

  // ───────────────────────── 塔 ─────────────────────────

  private makeTower(id: TowerId, cx: number, cy: number, cost: number): Tower {
    const def = TOWERS[id];
    const s = this.state;
    const t: Tower = {
      uid: this.nextUid++, id, cx, cy, level: 1, tier: 1, branch: null,
      xp: 0, xpNext: id === 'wall' ? 0 : xpForLevel(1), stars: 0, evoXp: 0, evoXpNext: 0, abilityCd: 0, invested: cost,
      targetMode: 'first', angle: -Math.PI / 2, lastFire: -999, disabledUntil: 0,
      placedAt: s.time, undoUntil: s.time + UNDO_SECONDS, kills: 0, damage: 0, comboWith: [],
      def, cd: 0, attacked: false,
      dmg: def.damage, dmgFactor: 1, interval: def.interval, range: def.range, inner: def.inner ?? 0, aura: def.aura ?? 0,
      critChance: 0, critMul: 2, atkMul: 1, xpGainMul: 1, calcCovers: [], combo: 0,
      slowPct: 0, slowDur: 0, stunChance: 0, inkMax: 3,
      focusUid: 0, focusStacks: 0, laserUid: 0, laserTime: 0, laserAcc: 0, laserBeamT: 0,
      sweepPhase: 0, colorGold: 0, halfLegend: false, lastTape: -99,
      pierce: 0, abilityUntil: 0, atkCount: 0, piggyMute: 0, piggyCharge: 0, safeLives: false, calcCritUntil: 0, abacusDiscount: false,
    };
    this.statsDirty = true;
    return t;
  }

  private afterLevelChange(t: Tower): void {
    t.tier = tierOf(t.level, t.id === 'wall', t.stars);
    if (t.id === 'wall') t.xpNext = 0;
    else t.xpNext = t.level >= 10 ? 0 : xpForLevel(t.level);
    t.evoXpNext = this.canEvolveKind(t) && t.stars < 3 ? EVO.xp[t.stars] : 0;
    this.statsDirty = true;
  }

  /** 这座塔（已到 Lv10 且有分支）是否参与进化 */
  private canEvolveKind(t: Tower): boolean {
    return t.id !== 'wall' && t.level >= 10 && !!evoBranch(t.id, t.branch);
  }

  /** 进化星级判定：分支 + 至少 n 星 */
  private evo(t: Tower, branch: Branch, n: number): boolean {
    return t.level >= 10 && t.branch === branch && t.stars >= n;
  }

  /** 进化经验升星（经验只能升到 ★2，★3 必须花金币） */
  private processEvoXp(t: Tower): void {
    if (!this.canEvolveKind(t)) return;
    while (t.stars < 2 && t.evoXpNext > 0 && t.evoXp >= t.evoXpNext) {
      t.evoXp -= t.evoXpNext;
      this.starUp(t, true);
    }
    if (t.stars === 2 && t.evoXp > t.evoXpNext) t.evoXp = t.evoXpNext;
    if (t.stars >= 3) t.evoXp = 0;
  }

  private starUp(t: Tower, byXp: boolean): void {
    const s = this.state;
    t.stars = Math.min(3, t.stars + 1) as Tower['stars'];
    this.afterLevelChange(t);
    const br = evoBranch(t.id, t.branch);
    if (t.stars === 3) {
      t.abilityCd = 0;
      if (br?.ability.chargeWaves) {
        t.abilityCharges = 1;
        t.piggyCharge = 0;
      }
    }
    if (t.id === 'piggy' && this.evo(t, 'B', 2) && !t.safeLives) {
      t.safeLives = true;
      s.lives += 3;
      s.maxLives += 3;
    }
    this.emit({ type: 'evolve', uid: t.uid, stars: t.stars, mythic: t.stars === 3 });
    if (br) {
      const text = t.stars === 3 ? `${t.def.name} 进化为神话·${br.ability.form}！` : `${t.def.name} 进化 ★${t.stars}：${t.stars === 1 ? br.s1.name : br.s2.name}`;
      this.toast(text + (byXp ? '' : ''), 'good');
    }
  }

  /** 金币进化费用（文档 11 §1.1）；null = 不能进化 */
  evolveCost(t: Tower): number | null {
    if (!this.canEvolveKind(t) || t.stars >= 3) return null;
    let c = rawUpgradeCost(t.def.cost, 9) * EVO.costMul[t.stars] * (1 - this.evoDiscount(t));
    if (this.hasPerk('sale')) c *= 0.9;
    return Math.max(1, Math.round(c));
  }

  private evoDiscount(t: Tower): number {
    if (!this.canEvolveKind(t) || t.stars >= 3 || t.evoXpNext <= 0) return 0;
    return 0.5 * Math.min(1, t.evoXp / t.evoXpNext);
  }

  private cmdEvolve(uid: number): CommandResult {
    const s = this.state;
    const t = s.towers.get(uid) as Tower | undefined;
    if (!t) return { ok: false, reason: '塔不存在' };
    if (s.phase === 'perk') return { ok: false, reason: '请先选择增益' };
    if (t.id === 'wall') return { ok: false, reason: '书本墙不能进化' };
    if (t.level < 10) return { ok: false, reason: '升到传奇（Lv10）后才能进化' };
    if (t.stars >= 3) return { ok: false, reason: '已经是神话' };
    const cost = this.evolveCost(t);
    if (cost === null) return { ok: false, reason: '不能进化' };
    if (s.gold < cost) return { ok: false, reason: '金币不足' };
    this.spendGold(cost);
    t.invested += cost;
    this.starUp(t, false);
    this.processEvoXp(t);
    return { ok: true };
  }

  /** 经验升级（最多到 Lv9） */
  private processXpLevels(t: Tower): void {
    if (t.id === 'wall') return;
    while (t.level < 9 && t.xpNext > 0 && t.xp >= t.xpNext) {
      t.xp -= t.xpNext;
      const oldTier = t.tier;
      t.level++;
      this.afterLevelChange(t);
      this.emit({ type: 'levelUp', uid: t.uid, level: t.level, tier: t.tier, tierChanged: t.tier !== oldTier, byXp: true });
    }
    if (t.level === 9 && t.xp > t.xpNext) t.xp = t.xpNext;
  }

  private gainXp(t: Tower, amount: number, share = true): void {
    if (t.id === 'wall' || amount <= 0) return;
    const a = amount * t.xpGainMul * this.xpGlobalMul;
    if (t.level >= 10) {
      if (t.stars < 3 && this.canEvolveKind(t)) {
        t.evoXp += a;
        if (t.evoXp >= t.evoXpNext) this.processEvoXp(t);
      }
    } else if (t.level === 9) t.xp = Math.min(t.xpNext, t.xp + a);
    else {
      t.xp += a;
      this.processXpLevels(t);
    }
    if (share) for (const c of t.calcCovers) this.gainXp(c, amount * 0.1, false);
  }

  upgradeCost(t: Tower): number | null {
    let c: number;
    if (t.id === 'wall') {
      if (t.level >= 3) return null;
      c = WALL_UPGRADE_COST[t.level];
      if (this.hasPerk('thickcover')) c *= 0.7;
    } else {
      if (t.level >= 10) return null;
      c = rawUpgradeCost(t.def.cost, t.level) * (1 - this.xpDiscount(t));
      if (t.level === 9 && t.halfLegend) c *= 0.5;
      if (t.abacusDiscount) c *= 0.9;
    }
    if (this.hasPerk('sale')) c *= 0.9;
    return Math.max(1, Math.round(c));
  }

  private xpDiscount(t: Tower): number {
    if (t.id === 'wall' || t.level >= 10 || t.xpNext <= 0) return 0;
    return 0.5 * Math.min(1, t.xp / t.xpNext);
  }

  private refundRateFor(t: Tower): number {
    if (this.hasPerk('tradein')) return 0.7;
    return Math.min(1, refundRate(t.level) + 0.02 * (this.talents.secondhand ?? 0));
  }

  private canUndo(t: Tower): boolean {
    return !t.attacked && this.state.time < t.undoUntil;
  }

  private sellValue(t: Tower): number {
    if (this.canUndo(t)) return t.invested;
    return Math.floor(t.invested * this.refundRateFor(t));
  }

  private targetModes(t: Tower): TargetMode[] {
    if (!t.def.attacks || t.id === 'stapler' || t.id === 'compass') return [];
    const m: TargetMode[] = ['first', 'last', 'strong', 'weak', 'close'];
    if (t.def.hitsAir) m.push('air');
    return m;
  }

  private ensureStats(): void {
    if (!this.statsDirty) return;
    this.statsDirty = false;
    this.recomputeStats();
  }

  /** 重算所有塔的派生数值：等级、分支、相邻加成、组合技、计算器光环、增益 */
  private recomputeStats(): void {
    const s = this.state;
    const g = s.grid;
    const stack = this.hasPerk('scholaraura');
    const calcs = this.towerList.filter((t) => t.id === 'calculator');
    for (const t of this.towerList) {
      t.comboWith.length = 0;
      t.combo = 0;
      t.calcCovers = [];
    }
    // 组合技与墙加成（上下左右相邻）
    for (const t of this.towerList) {
      const ns = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (const [dx, dy] of ns) {
        const nx = t.cx + dx;
        const ny = t.cy + dy;
        if (nx < 0 || ny < 0 || nx >= g.cols || ny >= g.rows) continue;
        const ou = g.towerAt[ny * g.cols + nx];
        if (!ou) continue;
        const o = s.towers.get(ou) as Tower | undefined;
        if (!o) continue;
        for (let ci = 0; ci < COMBOS.length; ci++) {
          const cb = COMBOS[ci];
          if ((t.id === cb.a && o.id === cb.b) || (t.id === cb.b && o.id === cb.a)) {
            t.combo |= 1 << ci;
            if (!t.comboWith.includes(o.uid)) t.comboWith.push(o.uid);
          }
        }
      }
    }
    for (const t of this.towerList) {
      const d = t.def;
      const L = t.level;
      if (t.id === 'wall') continue;
      // 墙加成
      let wallLv = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = t.cx + dx;
        const ny = t.cy + dy;
        if (nx < 0 || ny < 0 || nx >= g.cols || ny >= g.rows) continue;
        const ou = g.towerAt[ny * g.cols + nx];
        const o = ou ? (s.towers.get(ou) as Tower | undefined) : undefined;
        if (o && o.id === 'wall') wallLv = Math.max(wallLv, o.level);
      }
      // 计算器光环
      let calcDmg = 0;
      let calcSpd = 0;
      let calcRange = 0;
      let calcCrit = false;
      let calcCritMul = 0;
      let calcAbacus = 0;
      t.abacusDiscount = false;
      t.calcCritUntil = 0;
      if (d.attacks || t.id === 'piggy') {
        for (const c of calcs) {
          const ar = this.calcAura(c, stack);
          const dx = c.cx - t.cx;
          const dy = c.cy - t.cy;
          if (dx * dx + dy * dy > ar * ar + 1e-6) continue;
          t.calcCovers.push(c);
          if (this.evo(c, 'B', 2)) t.abacusDiscount = true;
          if (!d.attacks) continue;
          const sup = 1 + EVO.support * c.stars;
          const bonus = (0.1 + 0.01 * (c.level - 1) + (c.level >= 7 ? 0.15 : 0)) * sup;
          const spd = (c.level >= 4 ? 0.08 : 0) * sup;
          const rg = c.level >= 7 ? 0.3 : 0;
          if (stack) {
            calcDmg += bonus;
            calcSpd += spd;
            calcRange += rg;
          } else {
            calcDmg = Math.max(calcDmg, bonus);
            calcSpd = Math.max(calcSpd, spd);
            calcRange = Math.max(calcRange, rg);
          }
          if (c.level >= 10 && c.branch === 'A') {
            calcCrit = true;
            calcCritMul = Math.max(calcCritMul, this.evo(c, 'A', 1) ? 0.75 : 0.5);
            if (c.stars >= 3) t.calcCritUntil = Math.max(t.calcCritUntil, c.abilityUntil);
          }
          if (c.level >= 10 && c.branch === 'B') calcAbacus = Math.max(calcAbacus, this.evo(c, 'B', 1) ? 0.75 : 0.5);
        }
      }
      t.xpGainMul = (1 + calcAbacus) * (this.hasPerk('notes') ? 1.15 : 1);
      t.pierce = 0;
      if (!d.attacks) {
        t.dmg = 0;
        t.dmgFactor = 1;
        t.interval = 0;
        t.range = 0;
        t.aura = t.id === 'calculator' ? this.calcAura(t, stack) : 0;
        continue;
      }
      let baseDmg = d.damage;
      let baseIvl = d.interval;
      let baseRange = d.range;
      let inner = d.inner ?? 0;
      const A = L >= 10 && t.branch === 'A';
      const B = L >= 10 && t.branch === 'B';
      switch (t.id) {
        case 'pencil':
          if (A) { baseIvl *= 0.5; baseDmg *= 0.7; }
          break;
        case 'stapler':
          if (L >= 7) baseRange += 0.3;
          if (A) { baseIvl = 0.4; baseDmg *= 0.6; }
          break;
        case 'lamp':
          if (A) baseDmg = 20;
          if (this.hasPerk('bulb')) baseIvl *= 0.8;
          break;
        case 'compass':
          if (L >= 4) baseIvl = 0.2;
          if (L >= 7) inner = 0;
          if (A) { baseRange = 2.5; baseDmg *= 1.5; inner = 0; }
          break;
        case 'eraser':
          if (B) baseIvl = 0.35;
          break;
      }
      const lvlDmg = Math.pow(GROWTH.damage, L - 1) * Math.pow(EVO.dmg, t.stars);
      let dmgMul = 1 + calcDmg + (wallLv >= 3 ? 0.05 : 0);
      if (t.id === 'pencil' && this.hasPerk('sharpener')) dmgMul += 0.2;
      t.dmg = baseDmg * lvlDmg * dmgMul;
      t.dmgFactor = lvlDmg * dmgMul;
      t.interval = baseIvl * Math.pow(GROWTH.interval, L - 1) * Math.pow(EVO.interval, t.stars);
      let range = baseRange + GROWTH.range * (L - 1) + EVO.range * t.stars;
      if (t.id === 'compass' && !A) range = baseRange + GROWTH.range * (L - 1);
      range += calcRange;
      if ((t.combo & C_RULER_COMPASS) !== 0) range += 0.3;
      if ((t.id === 'ruler' || t.id === 'compass') && this.hasPerk('drafting')) range += 0.5;
      if (wallLv >= 2) range *= 1.05;
      t.range = range;
      t.inner = inner;
      t.atkMul = 1 + calcSpd;
      t.critChance = (t.id === 'pencil' && L >= 4 ? 0.15 : 0) + (calcCrit ? 0.1 : 0);
      t.critMul = 2 + calcCritMul;
      if (t.id === 'pencil' && this.evo(t, 'A', 2)) t.pierce = 2;
      if (t.id === 'glue') {
        let sp = L >= 7 ? 0.55 + 0.02 * (L - 7) : 0.4 + 0.02 * (L - 1);
        let dur = 1.5;
        if (this.hasPerk('quickglue')) { sp += 0.1; dur += 0.5; }
        t.slowPct = Math.min(0.85, sp);
        t.slowDur = dur;
      }
      if (t.id === 'stapler') t.stunChance = (L >= 4 ? 0.1 : 0) + (this.hasPerk('staples') ? 0.1 : 0) + (this.evo(t, 'A', 1) ? 0.1 : 0);
      if (t.id === 'pen') t.inkMax = (L >= 7 ? 5 : 3) + (this.hasPerk('inkplenty') ? 2 : 0);
    }
    // 护眼灯 ★2：光照范围内的友方攻击塔射程 +0.3（不叠加）
    const lights = this.towerList.filter((l) => l.id === 'lamp' && this.evo(l, 'B', 2));
    if (lights.length) {
      for (const t of this.towerList) {
        if (!t.def.attacks) continue;
        for (const l of lights) {
          if (l === t) continue;
          const dx = l.cx - t.cx;
          const dy = l.cy - t.cy;
          if (dx * dx + dy * dy <= l.range * l.range) {
            t.range += 0.3;
            break;
          }
        }
      }
    }
  }

  private calcAura(c: Tower, stack: boolean): number {
    return (c.def.aura ?? 2) + (stack ? 1 : 0) + (this.evo(c, 'A', 2) ? 0.5 : 0);
  }

  // ───────────────────────── 波次 ─────────────────────────

  private getPlan(w: number): WavePlan {
    let p = this.planCache.get(w);
    if (!p) {
      const s = this.state;
      p = generateWave({ seed: s.seed, mode: s.opts.mode, map: s.opts.map, params: s.params }, w);
      this.planCache.set(w, p);
    }
    this.ensureAssigned(p);
    return p;
  }

  /** 第 w 波可用的出生点：空降点 + 开放的隐藏出生点 + 已开放的边缘入口（受 maxActiveSpawners 限制） */
  private spawnSlots(w: number): { open: SpawnSlot[]; drops: SpawnSlot[] } {
    const s = this.state;
    const drops: SpawnSlot[] = [];
    const hidden: SpawnSlot[] = [];
    const edges: SpawnSlot[] = [];
    for (const sp of s.spawners) {
      if (sp.kind === 'drop') {
        if (sp.active) drops.push({ id: sp.id, weight: 1, dropRatio: this.dropRatio.get(sp.id) ?? 0.4 });
      } else if (sp.kind === 'hidden') {
        if (sp.active) hidden.push({ id: sp.id, weight: this.defWeight(sp.id) });
      } else {
        const d = this.mapDef.spawners.find((x) => x.id === sp.id);
        const ow = d ? spawnerOpenWave(d, this.campaign) : 1;
        if (sp.active || (ow > 0 && ow <= w)) edges.push({ id: sp.id, weight: d?.weight ?? 1 });
      }
    }
    const cap = Math.max(1, Math.floor(s.params.maxActiveSpawners) - drops.length);
    const open = [...hidden, ...edges];
    // 至少保留一个边缘入口
    let list = open.slice(0, cap);
    if (!list.some((x) => edges.includes(x)) && edges.length) list = [...list.slice(0, Math.max(0, cap - 1)), edges[0]];
    return { open: list, drops };
  }

  private defWeight(id: string): number {
    return this.mapDef.spawners.find((x) => x.id === id)?.weight ?? 1;
  }

  /** 按当前出生点集合给计划分配出生点（集合变化后重新分配；已开始的波不再变） */
  private ensureAssigned(p: WavePlan): void {
    const { open, drops } = this.spawnSlots(p.wave);
    const key = open.map((o) => o.id).join(',') + '|' + drops.map((d) => `${d.id}:${d.dropRatio}`).join(',');
    if (p.assignKey === key) return;
    assignSpawners(p, open, drops, this.state.params.spawnMode, new Rng(`${this.state.seed}|assign|${p.wave}|${key}`));
    p.assignKey = key;
  }

  /** 到第 w 波时开放的边缘入口 */
  private openSpawnersFor(w: number): void {
    const s = this.state;
    let changed = false;
    for (const sp of s.spawners) {
      if (sp.kind !== 'edge' || sp.active) continue;
      const d = this.mapDef.spawners.find((x) => x.id === sp.id);
      const ow = d ? spawnerOpenWave(d, this.campaign) : 1;
      if (ow > 0 && ow <= w) {
        sp.active = true;
        changed = true;
        this.toast(`新的入口开放了：${sp.name ?? sp.id}`, 'warn');
      }
    }
    if (changed) this.spawnersChanged();
  }

  /** 出生点集合变化：刷新 grid.spawns 与预告 */
  private spawnersChanged(): void {
    const s = this.state;
    const spawns: { x: number; y: number }[] = [];
    for (const sp of s.spawners) if (sp.active) for (const c of sp.cells) spawns.push({ x: c.x, y: c.y });
    s.grid.spawns = spawns;
    this.spawnerVersion++;
  }

  private earlyBonus(w: number): number {
    const au = this.state.autoWave;
    const mul = this.hasPerk('earlybird') ? 2 : 1;
    if (au.enabled && au.started) return Math.floor(this.autoRemaining() * (1 + w / 10)) * mul;
    return (5 + w) * mul;
  }

  /** 自动波次：距下一波自动开始的剩余秒数（还在刷怪时按"刷完 + 倒计时"估算，不超过上限时间） */
  private autoRemaining(): number {
    const s = this.state;
    const au = s.autoWave;
    if (au.nextAt !== null) return Math.max(0, au.nextAt - s.time);
    const aw = this.lastStarted;
    if (!aw) return 0;
    const ents = aw.plan.entries;
    const left = ents.length && aw.idx < ents.length ? Math.max(0, ents[ents.length - 1].at - aw.t) : 0;
    let est = left + this.autoGap(s.wave + 1);
    if (au.deadline !== null) est = Math.min(est, au.deadline - s.time);
    return Math.max(0, est);
  }

  private autoGap(next: number): number {
    const s = this.state;
    let gap = s.params.waveGap;
    if (!(s.totalWaves > 0 && next > s.totalWaves) && this.getPlan(next).tags.includes('boss')) gap *= 1.5;
    return gap;
  }

  private earlyAllowed(): boolean {
    const s = this.state;
    const au = s.autoWave;
    if (s.totalWaves > 0 && s.wave + 1 > s.totalWaves) return false;
    return s.phase === 'wave' || (au.enabled && au.started && s.phase === 'build');
  }

  private updatePreview(): void {
    const s = this.state;
    const w = s.wave + 1;
    if (s.totalWaves > 0 && w > s.totalWaves) {
      s.nextWave = { wave: w, tags: [], groups: [], earlyBonus: 0 };
      return;
    }
    const p = this.getPlan(w);
    s.nextWave = {
      wave: w,
      tags: p.tags.slice(),
      groups: p.groups.map((g) => ({ ...g, affixes: g.affixes.slice() })),
      earlyBonus: this.earlyAllowed() ? this.earlyBonus(w) : 0,
    };
    this.previewVersion = this.spawnerVersion;
  }

  private previewVersion = -1;

  private updatePreviewEarly(): void {
    const s = this.state;
    if (s.nextWave.wave !== s.wave + 1 || this.previewVersion !== this.spawnerVersion) this.updatePreview();
    else s.nextWave.earlyBonus = this.earlyAllowed() ? this.earlyBonus(s.nextWave.wave) : 0;
  }

  private currentEffWave(): number {
    const s = this.state;
    const w = Math.max(1, s.wave);
    if (this.active.length) return this.active[this.active.length - 1].plan.effWave;
    if (s.opts.mode === 'campaign') {
      const p = this.getPlan(Math.min(CAMPAIGN_WAVES, w));
      return p.effWave;
    }
    return w;
  }

  private processSpawns(): void {
    const s = this.state;
    for (const aw of this.active) {
      const entries = aw.plan.entries;
      if (aw.idx >= entries.length) continue;
      if (!aw.warned) {
        for (let j = aw.idx; j < entries.length; j++) {
          const en = entries[j];
          if (ENEMIES[en.enemy].boss) {
            if (en.at - aw.t <= 3) {
              aw.warned = true;
              this.toast(`Boss 来袭：${ENEMIES[en.enemy].name}！`, 'warn');
            }
            break;
          }
        }
      }
      if (s.enemies.length >= CAPS.maxOnField) continue;
      aw.t += DT;
      while (aw.idx < entries.length && entries[aw.idx].at <= aw.t && s.enemies.length < CAPS.maxOnField) {
        this.spawnFromEntry(aw, entries[aw.idx]);
        aw.idx++;
      }
    }
  }

  private spawnFromEntry(aw: ActiveWave, en: SpawnEntry): void {
    const s = this.state;
    let sp = en.spawner ? s.spawners.find((k) => k.id === en.spawner && k.active) : undefined;
    if (!sp) sp = s.spawners.find((k) => k.kind === 'edge' && k.active) ?? s.spawners[0];
    const cell = sp.cells[sp.kind === 'drop' ? 0 : this.rng.int(sp.cells.length)];
    const e = this.createEnemy(en.enemy, aw.plan.wave, aw.plan.effWave, cell.x + 0.5, cell.y + 0.5, cell.x, cell.y, {
      elite: en.elite, affixes: en.affixes, group: en.group, hpMul: en.hpMul,
    });
    if (sp.kind === 'drop' && !e.flying) {
      const g = s.grid;
      const ni = this.exitStep(cell.y * g.cols + cell.x, g.cells, g.dist);
      if (ni >= 0) {
        e.tcx = ni % g.cols;
        e.tcy = (ni - e.tcx) / g.cols;
        this.updateRemaining(e);
      }
    }
    if (e && this.timeMgmtUntil > this.state.time && !e.flying) this.applyStun(e, 1, true);
  }

  private createEnemy(
    id: EnemyId, wave: number, effWave: number, x: number, y: number, ccx: number, ccy: number,
    o: { elite?: boolean; affixes?: AffixId[]; group?: number; hpMul?: number; hpAbs?: number; noSplit?: boolean },
  ): Enemy {
    const s = this.state;
    const D = s.params;
    const def = ENEMIES[id];
    const k = Math.max(1, o.group ?? 1);
    const affixes = (o.affixes ?? []).filter((a) => !(o.noSplit && a === 'split'));
    const elite = !!o.elite && affixes.length > 0;
    const crumbHp = ENEMIES.crumb.hp * hpScale(D, effWave);
    let hp = o.hpAbs ?? def.hp * hpScale(D, effWave) * (def.boss ? D.bossHpMul : 1) * (o.hpMul ?? 1);
    if (o.hpAbs === undefined) {
      if (elite) hp *= ELITE.hp;
      if (k > 1) hp *= k * 0.9;
    }
    hp = Math.max(1, hp);
    let armor = armorAt(D, def.armor, effWave);
    if (affixes.includes('hard')) armor += 3;
    let speed = def.speed * speedScale(D, effWave);
    if (affixes.includes('swift')) speed *= 1.35;
    let bounty = def.bounty * goldScale(D, effWave) * k * (elite ? ELITE.bounty : 1);
    let xp = def.xp * xpScale(D, effWave) * k * (elite ? ELITE.xp : 1);
    if (id === 'crumbmini' || id === 'boss_coffee_small') {
      bounty = def.bounty * goldScale(D, effWave) * k;
      xp = def.xp * xpScale(D, effWave) * k;
    }
    let shield = 0;
    if (def.shieldRatio) shield += hp * def.shieldRatio;
    if (affixes.includes('shield')) shield += hp * 0.3;
    const scale = (elite ? ELITE.scale : 1) * (1 + 0.1 * Math.log2(k)) * (id === 'boss_coffee_small' ? 0.75 : 1);
    const radius = def.radius * scale;
    const unstoppable = !!def.unstoppable || affixes.includes('unstoppable');
    const permStealth = !!def.stealthy || affixes.includes('stealth');
    const e: Enemy = {
      uid: this.nextUid++, id, x, y, angle: Math.PI / 2,
      hp, maxHp: hp, shield, maxShield: shield, armor, speed, radius, scale,
      flying: def.flying, boss: def.boss, elite, affixes: affixes.slice(), group: k,
      hidden: permStealth, stealthy: permStealth,
      slowPct: 0, slowUntil: 0, stunUntil: 0, rootUntil: 0, inkStacks: 0, bleedStacks: 0, burnUntil: 0, markedUntil: 0,
      jumping: false, lastHit: -99, spawnedAt: s.time,
      dead: false, wave, effWave, bounty, xpVal: xp, livesCost: def.lives * Math.min(k, 3), baseSpeed: speed,
      ccx, ccy, tcx: ccx, tcy: ccy, pcx: ccx, pcy: ccy, remaining: 99,
      fx0: x, fy0: y, fx1: x, fy1: y, flyLen: 1, flyT: 0, flyPhase: 0,
      jumpTimer: 0, jumpEnd: 0, abilityT: 0, revealUntil: 0, litUntil: 0, redUntil: 0, shred: 0, stapleReady: 0,
      burnDps: 0, burnOwner: 0, inkDps: 0, inkUntil: 0, inkOwner: 0, bleedDps: 0, bleedUntil: 0, bleedOwner: 0,
      debuffers: [], dotT: 0, unstoppable, dodge: def.dodge ?? 0, aoeRadius: radius * (id === 'tape' ? 1.3 : 1),
      rallied: false, ringUntil: 0, splitDone: false, cloudDone: false, cloudUntil: 0, zoneVuln: 0,
      permStealth, reflect: affixes.includes('reflect'), crumbHp,
      poisonDps: 0, poisonUntil: 0, poisonOwner: 0, purpleUntil: 0, measuredUntil: 0,
      redVuln: 0.2, litVuln: 0.15, rootVulnUntil: 0, redGold: false,
    };
    if (e.flying) {
      const exits = s.grid.exits;
      let best = exits[0];
      let bd = Infinity;
      for (const ex of exits) {
        const d = Math.abs(ex.x + 0.5 - x);
        if (d < bd) { bd = d; best = ex; }
      }
      e.fx0 = x;
      e.fy0 = y;
      e.fx1 = best.x + 0.5;
      e.fy1 = best.y + 0.5;
      e.flyLen = Math.max(0.1, Math.hypot(e.fx1 - x, e.fy1 - y));
      e.flyPhase = this.rng.next() * TAU;
      e.angle = Math.atan2(e.fy1 - y, e.fx1 - x);
    } else {
      const g = s.grid;
      const ni = nextCell(g.cols, g.rows, g.cells, g.dist, ccy * g.cols + ccx);
      if (ni >= 0) {
        e.tcx = ni % g.cols;
        e.tcy = (ni - e.tcx) / g.cols;
      }
    }
    s.enemies.push(e);
    this.enemyByUid.set(e.uid, e);
    const aw = this.active.find((a) => a.plan.wave === wave);
    if (aw) aw.alive++;
    if (e.boss) s.bossUids.push(e.uid);
    this.emit({ type: 'spawn', enemyUid: e.uid, enemy: id, boss: e.boss });
    return e;
  }

  private checkWaves(): void {
    const s = this.state;
    if (s.phase === 'lost' || s.phase === 'won') return;
    for (let i = 0; i < this.active.length; i++) {
      const aw = this.active[i];
      if (aw.idx < aw.plan.entries.length || aw.alive > 0) continue;
      this.active.splice(i, 1);
      i--;
      this.waveCleared(aw.plan.wave, aw);
      if ((s.phase as string) === 'perk') break;
    }
    if (this.active.length === 0 && s.phase === 'wave') s.phase = 'build';
    if (this.active.length === 0 && s.phase === 'build') this.checkWin();
  }

  /** 存钱罐每波产出（不含静默） */
  private piggyOutput(t: Tower): number {
    let g = 8 + 2 * (t.level - 1);
    if (t.level >= 10 && t.branch === 'A') g *= 2;
    if (this.evo(t, 'A', 2)) g *= 1.5;
    if ((t.combo & C_CALC_PIGGY) !== 0) g *= 1.25;
    g *= 1 + EVO.support * t.stars;
    return Math.round(g);
  }

  private waveCleared(w: number, aw?: ActiveWave): void {
    const s = this.state;
    const D = s.params;
    this.clearedWaves++;
    this.lastCleared = Math.max(this.lastCleared, w);
    const bonus = Math.round((10 + 2 * w) * D.rewardMul);
    // 老师表扬：本波得分 ×2
    if (this.praiseWaves.has(w)) {
      this.praiseWaves.delete(w);
      this.bonusScore += 100 + Math.max(0, s.stats.kills - (aw?.kills0 ?? s.stats.kills));
    }
    // 存钱罐
    let piggyGold = 0;
    let piggyT2 = 0;
    let piggyCap = 0;
    for (const t of this.towerList) {
      if (t.id !== 'piggy') continue;
      if (t.piggyMute > 0) t.piggyMute--;
      else piggyGold += this.piggyOutput(t);
      if (t.level >= 4) piggyT2++;
      if (this.evo(t, 'A', 1)) piggyCap += 10;
      if (t.stars >= 3 && t.branch === 'A' && (t.abilityCharges ?? 0) < 1) {
        t.piggyCharge++;
        const cw = ABILITIES.piggy_a.chargeWaves ?? 5;
        if (t.piggyCharge >= cw) {
          t.piggyCharge = 0;
          t.abilityCharges = 1;
        }
      }
      this.gainXp(t, 10);
    }
    this.addGold(bonus, 'wave');
    if (piggyGold > 0) this.addGold(piggyGold, 'piggy');
    const rate = this.hasPerk('compound') ? 0.08 : 0.05;
    const cap = D.interestCap + 5 * Math.min(PIGGY_MAX, piggyT2) + (this.hasPerk('compound') ? 10 : 0) + piggyCap;
    const interest = Math.min(cap, Math.floor(s.gold * rate));
    if (interest > 0) this.addGold(interest, 'interest');
    this.emit({ type: 'waveEnd', wave: w, bonus, interest, piggy: piggyGold });
    // 空降点 / 暗门到期
    for (const sp of s.spawners.slice()) {
      if (sp.expiresAfterWave === undefined || sp.expiresAfterWave > w) continue;
      if (sp.kind === 'drop' && sp.active) this.closeDrop(sp, 'close');
      else if (sp.kind === 'hidden' && sp.active) this.closeHidden(sp);
    }
    // 搬家充能
    this.wavesSinceRecharge++;
    if (this.wavesSinceRecharge >= RELOCATE_RECOVER_WAVES) {
      this.wavesSinceRecharge = 0;
      for (const sk of s.skills) {
        if (sk.id === 'relocate' && (sk.charges ?? 0) < (sk.maxCharges ?? 2)) {
          sk.charges = (sk.charges ?? 0) + 1;
          sk.ready = true;
        }
      }
    }
    // 增益
    const offer = s.opts.mode === 'campaign' ? w === 10 : w % 10 === 0;
    if (offer && s.lives > 0) this.offerPerks();
  }

  private checkWin(): void {
    const s = this.state;
    if (s.phase === 'won' || s.phase === 'lost' || s.phase === 'perk') return;
    if (s.opts.mode === 'campaign' && this.active.length === 0 && s.wave >= CAMPAIGN_WAVES && this.lastCleared >= CAMPAIGN_WAVES) {
      s.phase = 'won';
      this.updateScore();
      this.emit({ type: 'gameOver', won: true, wave: s.wave, score: s.score });
    }
  }

  private updateUnlocks(announce: boolean): void {
    const s = this.state;
    const prev = s.unlockedTowers.slice();
    if (s.opts.mode !== 'campaign') {
      s.unlockedTowers = TOWER_IDS.slice();
    } else {
      const ch = MAPS[s.opts.map]?.chapter ?? 1;
      const w = Math.min(CAMPAIGN_WAVES, s.wave + 1);
      s.unlockedTowers = TOWER_IDS.filter((id) => {
        const [c, ww] = TOWERS[id].unlock.split('-').map(Number);
        return c < ch || (c === ch && ww <= w);
      });
    }
    if (announce) {
      for (const id of s.unlockedTowers) if (!prev.includes(id)) this.toast(`新塔解锁：${TOWERS[id].name}`, 'good');
    }
  }

  // ───────────────────────── 增益 ─────────────────────────

  private hasPerk(id: PerkId): boolean {
    return this.state.perks.includes(id);
  }

  private offerPerks(): void {
    const s = this.state;
    this.perkOffers++;
    this.freeRerolls = (this.talents.luckydraw ?? 0) > 0 ? 1 : 0;
    s.perkRerollCost = this.freeRerolls > 0 ? 0 : PERK_REROLL_COST;
    const cards = this.rollPerks();
    if (cards.length === 0) return;
    s.perkChoices = cards;
    s.phase = 'perk';
    this.emit({ type: 'perkOffer', cards: cards.map((c) => ({ ...c })) });
  }

  private rollPerks(): PerkCard[] {
    const s = this.state;
    const rng = new Rng(`${s.seed}|perk|${this.perkOffers}|${this.perkRerolls}`);
    const n = (this.talents.collector ?? 0) > 0 ? 4 : 3;
    const carried = new Set(s.skills.map((k) => k.id));
    const cands = PERKS.filter((p) => {
      if (!p.repeatable && s.perks.includes(p.id)) return false;
      if (p.id === 'legend') return this.towerList.some((t) => t.id !== 'wall' && t.level >= 7 && t.level < 10);
      if (p.id === 'pocket') return SKILL_IDS.some((k) => !carried.has(k));
      return true;
    });
    const epicW = s.wave > EPIC_LATE_WAVE ? EPIC_WEIGHT_LATE : RARITY_WEIGHT.epic;
    const out: PerkCard[] = [];
    while (out.length < n && cands.length) {
      const ws = cands.map((p) => (p.rarity === 'epic' ? epicW : RARITY_WEIGHT[p.rarity]));
      const i = rng.weighted(ws);
      const p = cands[i];
      cands.splice(i, 1);
      const card: PerkCard = { id: p.id, name: p.name, desc: p.desc, rarity: p.rarity };
      if (p.needsTower) card.needsTower = true;
      out.push(card);
    }
    return out;
  }

  /** 传奇在望直接进入 Lv10 时收取的费用：Lv9→10 传奇费用（无经验折扣）的一半 */
  private legendPerkCost(t: Tower): number {
    let c = rawUpgradeCost(t.def.cost, 9) * 0.5;
    if (this.hasPerk('sale')) c *= 0.9;
    return Math.max(1, Math.round(c));
  }

  private applyPerk(id: PerkId, uid?: number, branch?: Branch): void {
    const s = this.state;
    switch (id) {
      case 'pocketmoney':
        this.addGold(50 + 5 * Math.max(1, s.wave), 'perk');
        break;
      case 'safe':
        s.lives += 5;
        s.maxLives += 5;
        break;
      case 'quickreview':
        // 在 applyPerk 之后 perks 才包含该 id，这里先手动刷新
        for (const sk of s.skills) {
          if (sk.id === 'relocate') continue;
          sk.cdMax = Math.round(sk.cdMax * 0.85 * 10) / 10;
          sk.cd = Math.min(sk.cd, sk.cdMax) * 0.85;
        }
        break;
      case 'promotion':
        for (const t of this.towerList) {
          const cap = t.id === 'wall' ? 3 : 9;
          if (t.level >= cap) continue;
          const oldTier = t.tier;
          t.level++;
          this.afterLevelChange(t);
          if (t.id !== 'wall') t.xp = Math.min(t.xp, t.xpNext);
          this.emit({ type: 'levelUp', uid: t.uid, level: t.level, tier: t.tier, tierChanged: t.tier !== oldTier, byXp: false });
        }
        break;
      case 'pocket': {
        const carried = new Set(s.skills.map((k) => k.id));
        const pool = SKILL_IDS.filter((k) => !carried.has(k));
        if (pool.length) {
          const rng = new Rng(`${s.seed}|pocket|${this.perkOffers}`);
          const pick = pool[rng.int(pool.length)];
          s.skills.push(this.makeSkill(pick));
          this.toast(`获得新技能：${SKILLS[pick].name}`, 'good');
        }
        break;
      }
      case 'legend': {
        const t = uid !== undefined ? (s.towers.get(uid) as Tower | undefined) : undefined;
        if (t) {
          const oldTier = t.tier;
          if (t.level < 9) {
            t.level = 9;
            this.afterLevelChange(t);
            t.xp = 0;
            this.emit({ type: 'levelUp', uid: t.uid, level: t.level, tier: t.tier, tierChanged: t.tier !== oldTier, byXp: false });
          }
          t.halfLegend = true;
          if (branch === 'A' || branch === 'B') {
            const cost = this.legendPerkCost(t);
            this.spendGold(cost);
            t.invested += cost;
            const tier9 = t.tier;
            t.level = 10;
            t.branch = branch;
            t.xp = 0;
            t.halfLegend = false;
            this.afterLevelChange(t);
            this.emit({ type: 'levelUp', uid: t.uid, level: 10, tier: t.tier, tierChanged: t.tier !== tier9, byXp: false });
            this.toast(`${t.def.name} 晋升传奇·${branch === 'A' ? t.def.A.name : t.def.B.name}`, 'good');
          } else this.toast(`${t.def.name} 传奇升级费用减半`, 'good');
        }
        break;
      }
      default:
        break;
    }
    this.statsDirty = true;
  }

  // ───────────────────────── 技能 ─────────────────────────

  private makeSkill(id: SkillId): SkillState {
    const def = SKILLS[id];
    const lvl = Math.max(1, Math.min(SKILL_LEVEL.maxLevel, Math.floor(this.skillLevels[id] ?? 1)));
    const sk: SkillState = { id, level: lvl, cd: 0, cdMax: 0, target: def.target, ready: true };
    if (def.radius !== undefined) sk.radius = def.radius;
    if (id === 'relocate') {
      sk.maxCharges = RELOCATE_CHARGES[lvl - 1];
      sk.charges = sk.maxCharges;
    } else {
      let cd = def.cd * this.state.params.skillCdMul * (1 - SKILL_LEVEL.cdPerLevel * (lvl - 1)) * (1 - 0.03 * (this.talents.alarm ?? 0));
      if (this.hasPerk('quickreview')) cd *= 0.85;
      sk.cdMax = Math.round(cd * 10) / 10;
    }
    return sk;
  }

  private tickSkills(dt: number): void {
    for (const sk of this.state.skills) {
      if (sk.id === 'relocate') {
        sk.ready = (sk.charges ?? 0) > 0;
        continue;
      }
      if (sk.cd > 0) {
        sk.cd = Math.max(0, sk.cd - dt);
        sk.ready = sk.cd <= 0;
      }
    }
  }

  // ───────────────────────── 空间分桶 ─────────────────────────

  private rebuildBuckets(): void {
    const s = this.state;
    const cols = s.grid.cols;
    const rows = s.grid.rows;
    this.bucketHead.fill(-1);
    const n = s.enemies.length;
    if (this.bucketNext.length < n) this.bucketNext = new Int32Array(Math.max(n, this.bucketNext.length * 2));
    for (let i = 0; i < n; i++) {
      const e = s.enemies[i];
      let bx = Math.floor(e.x);
      let by = Math.floor(e.y);
      if (bx < 0) bx = 0; else if (bx >= cols) bx = cols - 1;
      if (by < 0) by = 0; else if (by >= rows) by = rows - 1;
      const b = by * cols + bx;
      this.bucketNext[i] = this.bucketHead[b];
      this.bucketHead[b] = i;
    }
  }

  /** 查询 (x,y) 半径 r 内的存活敌人（pad：是否把敌人半径计入）。结果写入 out，返回数量 */
  private queryAll(x: number, y: number, r: number, out: Enemy[], pad: boolean): number {
    const s = this.state;
    const cols = s.grid.cols;
    const rows = s.grid.rows;
    const ext = r + 0.7;
    const x0 = Math.max(0, Math.floor(x - ext));
    const x1 = Math.min(cols - 1, Math.floor(x + ext));
    const y0 = Math.max(0, Math.floor(y - ext));
    const y1 = Math.min(rows - 1, Math.floor(y + ext));
    let n = 0;
    const en = s.enemies;
    for (let by = y0; by <= y1; by++) {
      for (let bx = x0; bx <= x1; bx++) {
        let i = this.bucketHead[by * cols + bx];
        while (i >= 0) {
          const e = en[i] as Enemy;
          if (!e.dead) {
            const dx = e.x - x;
            const dy = e.y - y;
            const rr = pad ? r + e.aoeRadius : r;
            if (dx * dx + dy * dy <= rr * rr) out[n++] = e;
          }
          i = this.bucketNext[i];
        }
      }
    }
    out.length = n;
    return n;
  }

  // ───────────────────────── 敌人 ─────────────────────────

  private preEnemyPass(): void {
    const s = this.state;
    const en = s.enemies;
    for (let i = 0; i < en.length; i++) {
      const e = en[i] as Enemy;
      e.rallied = false;
      e.zoneVuln = 0;
    }
    for (let i = 0; i < en.length; i++) {
      const e = en[i] as Enemy;
      if (e.dead || !e.affixes.includes('rally')) continue;
      const n = this.queryAll(e.x, e.y, 1.5, this.qB, false);
      for (let j = 0; j < n; j++) if (this.qB[j] !== e) this.qB[j].rallied = true;
    }
  }

  private moveEnemies(): void {
    const s = this.state;
    const g = s.grid;
    const t = s.time;
    const en = s.enemies;
    for (let i = 0; i < en.length; i++) {
      const e = en[i] as Enemy;
      if (e.dead) continue;
      // 当前基础速度（未计减速）
      let spd = e.baseSpeed;
      if (e.rallied) spd *= 1.2;
      if (e.ringUntil > t) spd *= 1.5;
      e.speed = spd;
      const stunned = e.stunUntil > t || e.rootUntil > t;
      if (e.jumping && t >= e.jumpEnd) e.jumping = false;
      if (e.id === 'rubberband' && !e.jumping) {
        if (stunned) e.jumpTimer = 0;
        else {
          e.jumpTimer += DT;
          if (e.jumpTimer >= 4) {
            e.jumpTimer = 0;
            e.jumping = true;
            e.jumpEnd = t + 0.3;
          }
        }
      }
      if (stunned && !e.jumping) {
        this.updateRemaining(e);
        continue;
      }
      let v = spd;
      if (e.jumping) v = 2 / 0.3;
      else if (e.slowUntil > t) v *= 1 - e.slowPct;
      if (e.flying && this.fanUntil > t) v *= 1.4;
      let step = v * DT;
      if (e.flying) {
        e.flyT += step;
        if (e.flyT >= e.flyLen) {
          this.leak(e);
          continue;
        }
        const f = e.flyT / e.flyLen;
        const bx = e.fx0 + (e.fx1 - e.fx0) * f;
        const by = e.fy0 + (e.fy1 - e.fy0) * f;
        const px = -(e.fy1 - e.fy0) / e.flyLen;
        const py = (e.fx1 - e.fx0) / e.flyLen;
        const taper = Math.min(1, e.flyT, e.flyLen - e.flyT);
        const amp = this.fanUntil > t ? 0.7 : 0.25;
        const off = Math.sin(e.flyT * 2.2 + e.flyPhase) * amp * taper;
        const nx = bx + px * off;
        const ny = by + py * off;
        e.angle = Math.atan2(ny - e.y, nx - e.x);
        e.x = nx;
        e.y = ny;
        e.remaining = e.flyLen - e.flyT;
        continue;
      }
      let guard = 0;
      while (step > 1e-9 && guard++ < 6) {
        const tx = e.tcx + 0.5;
        const ty = e.tcy + 0.5;
        const dx = tx - e.x;
        const dy = ty - e.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d <= step) {
          e.x = tx;
          e.y = ty;
          step -= d;
          if (e.tcx !== e.ccx || e.tcy !== e.ccy) {
            e.pcx = e.ccx;
            e.pcy = e.ccy;
          }
          e.ccx = e.tcx;
          e.ccy = e.tcy;
          const ci = e.ccy * g.cols + e.ccx;
          if (g.cells[ci] === CellKind.Exit) {
            this.leak(e);
            break;
          }
          const ni = nextCell(g.cols, g.rows, g.cells, g.dist, ci);
          if (ni < 0) {
            // 理论上不会发生（放置校验保证可达）；兜底避免卡死整波
            this.leak(e);
            break;
          }
          e.tcx = ni % g.cols;
          e.tcy = (ni - e.tcx) / g.cols;
        } else {
          e.x += (dx / d) * step;
          e.y += (dy / d) * step;
          e.angle = Math.atan2(dy, dx);
          step = 0;
        }
      }
      if (!e.dead) this.updateRemaining(e);
      if ((s.phase as string) === 'lost') return;
    }
  }

  private updateRemaining(e: Enemy): void {
    if (e.flying) {
      e.remaining = e.flyLen - e.flyT;
      return;
    }
    const g = this.state.grid;
    const dt = g.dist[e.tcy * g.cols + e.tcx];
    const dx = e.tcx + 0.5 - e.x;
    const dy = e.tcy + 0.5 - e.y;
    e.remaining = (dt < Infinity ? dt : 999) + Math.sqrt(dx * dx + dy * dy);
  }

  private leak(e: Enemy): void {
    const s = this.state;
    e.dead = true;
    this.onEnemyGone(e);
    let stolen = 0;
    let safeBox = false;
    let refund = 10;
    for (const t of this.towerList) {
      if (t.id === 'piggy' && t.level >= 10 && t.branch === 'B') {
        safeBox = true;
        if (this.evo(t, 'B', 1)) refund = 15;
      }
    }
    if (e.id === 'ant') {
      if (!safeBox) {
        stolen = Math.min(s.gold, Math.max(5, Math.floor(s.gold * 0.03)) * Math.min(e.group, 3));
        if (stolen > 0) {
          s.gold -= stolen;
          this.emit({ type: 'gold', amount: -stolen, reason: 'stolen', x: e.x, y: e.y });
        }
      }
    } else if (this.vaultUntil <= s.time) {
      s.lives = Math.max(0, s.lives - e.livesCost);
    }
    s.stats.leaks += e.group;
    this.emit({ type: 'leak', enemy: e.id, lives: s.lives, stolenGold: stolen });
    if (safeBox) this.addGold(refund, 'refund', e.x, e.y);
    if (s.lives <= 0 && s.phase !== 'lost') {
      s.phase = 'lost';
      s.perkChoices = null;
      this.updateScore();
      this.emit({ type: 'gameOver', won: false, wave: s.wave, score: s.score });
    }
  }

  private onEnemyGone(e: Enemy): void {
    const aw = this.active.find((a) => a.plan.wave === e.wave);
    if (aw) aw.alive--;
  }

  /** 地面击退；返回被墙 / 塔挡住而没走完的距离 */
  private knockback(e: Enemy, dist: number): number {
    if (e.flying || e.dead) return 0;
    if (e.boss) return 0;
    if (e.unstoppable) {
      this.emit({ type: 'immune', x: e.x, y: e.y });
      return 0;
    }
    const g = this.state.grid;
    let left = dist;
    const cx = e.ccx + 0.5;
    const cy = e.ccy + 0.5;
    let dx = cx - e.x;
    let dy = cy - e.y;
    let d = Math.sqrt(dx * dx + dy * dy);
    if (d >= left) {
      if (d > 0) {
        e.x += (dx / d) * left;
        e.y += (dy / d) * left;
      }
      return 0;
    }
    e.x = cx;
    e.y = cy;
    left -= d;
    const pi = e.pcy * g.cols + e.pcx;
    if ((e.pcx === e.ccx && e.pcy === e.ccy) || !isPassableKind(g.cells[pi]) || !(g.dist[pi] < Infinity)) return left;
    dx = e.pcx + 0.5 - cx;
    dy = e.pcy + 0.5 - cy;
    d = Math.sqrt(dx * dx + dy * dy);
    const m = Math.min(left, d * 0.95);
    e.x += (dx / d) * m;
    e.y += (dy / d) * m;
    e.tcx = e.ccx;
    e.tcy = e.ccy;
    e.ccx = e.pcx;
    e.ccy = e.pcy;
    this.updateRemaining(e);
    return left - m;
  }

  private updateStealth(): void {
    const s = this.state;
    const t = s.time;
    for (const e0 of s.enemies) {
      const e = e0 as Enemy;
      if (e.dead) continue;
      const stealth = e.permStealth || e.cloudUntil > t;
      e.stealthy = stealth;
      if (!stealth) {
        e.hidden = false;
        continue;
      }
      let revealed = e.revealUntil > t || this.daylightUntil > t;
      if (!revealed) {
        for (const tw of this.towerList) {
          const dx = tw.cx + 0.5 - e.x;
          const dy = tw.cy + 0.5 - e.y;
          const d2 = dx * dx + dy * dy;
          let r = 1.2;
          if (tw.id === 'lamp') r = tw.level >= 10 && tw.branch === 'B' ? Math.max(1.5, tw.range) : 1.5;
          if (d2 <= r * r) {
            revealed = true;
            break;
          }
        }
      }
      e.hidden = !revealed;
    }
  }

  private enemyAbilities(): void {
    const s = this.state;
    const t = s.time;
    const en = s.enemies;
    const n0 = en.length;
    for (let i = 0; i < n0; i++) {
      const e = en[i] as Enemy;
      if (e.dead) continue;
      // 渲染用：被标记
      let mk = Math.max(e.redUntil, e.litUntil);
      if (e.zoneVuln > 0) mk = Math.max(mk, t + 0.1);
      e.markedUntil = mk;
      if (e.affixes.includes('regen') && e.hp < e.maxHp) {
        e.hp = Math.min(e.maxHp, e.hp + e.maxHp * 0.02 * DT * (e.inkStacks > 0 ? 0.5 : 1));
      }
      if (e.id === 'sticky' && e.maxShield > 0 && e.shield < e.maxShield && t - e.lastHit >= 4) {
        e.shield = Math.min(e.maxShield, e.shield + e.maxShield * 0.25 * DT);
      }
      switch (e.id) {
        case 'whiteout': {
          e.abilityT += DT;
          if (e.abilityT >= 1) {
            e.abilityT -= 1;
            const n = this.queryAll(e.x, e.y, 1.5, this.qB, false);
            for (let j = 0; j < n; j++) {
              const o = this.qB[j];
              if (o === e || o.hp >= o.maxHp) continue;
              const amt = o.maxHp * 0.04 * (o.inkStacks > 0 ? 0.5 : 1);
              const real = Math.min(amt, o.maxHp - o.hp);
              o.hp += real;
              if (real > 0) this.emit({ type: 'heal', x: o.x, y: o.y, amount: Math.round(real) });
            }
          }
          break;
        }
        case 'boss_coffee':
        case 'boss_coffee_small': {
          e.abilityT += DT;
          if (e.abilityT >= 8) {
            e.abilityT -= 8;
            this.emit({ type: 'bossSkill', enemyUid: e.uid, skill: 'spill', x: e.x, y: e.y, r: 1.5 });
            for (const tw of this.towerList) {
              const dx = tw.cx + 0.5 - e.x;
              const dy = tw.cy + 0.5 - e.y;
              if (dx * dx + dy * dy <= 1.5 * 1.5) {
                tw.disabledUntil = Math.max(tw.disabledUntil, t + 2);
                this.emit({ type: 'towerDisabled', uid: tw.uid, until: tw.disabledUntil });
              }
            }
          }
          break;
        }
        case 'boss_shredder': {
          e.abilityT += DT;
          if (e.abilityT >= 5) {
            e.abilityT -= 5;
            this.emit({ type: 'bossSkill', enemyUid: e.uid, skill: 'shred', x: e.x, y: e.y, r: 0.6 });
            for (let k = 0; k < 2; k++) this.spawnChild('crumb', e, {});
          }
          break;
        }
        case 'boss_inkbottle': {
          e.abilityT += DT;
          if (e.abilityT >= 10) {
            e.abilityT -= 10;
            this.emit({ type: 'bossSkill', enemyUid: e.uid, skill: 'inkShield', x: e.x, y: e.y, r: 2.5 });
            const n = this.queryAll(e.x, e.y, 2.5, this.qB, false);
            const amt = e.maxHp * 0.15;
            for (let j = 0; j < n; j++) {
              const o = this.qB[j];
              if (o === e) continue;
              o.shield += amt;
              o.maxShield = Math.max(o.maxShield, o.shield);
            }
          }
          break;
        }
        case 'boss_alarm': {
          e.abilityT += DT;
          if (e.abilityT >= 12) {
            e.abilityT -= 12;
            this.emit({ type: 'bossSkill', enemyUid: e.uid, skill: 'ring', x: e.x, y: e.y, r: 14 });
            for (const o of en) (o as Enemy).ringUntil = t + 3;
          }
          break;
        }
      }
    }
  }

  /** 生成子单位（碎纸机吐纸屑、纸团分裂、分裂词缀） */
  private spawnChild(id: EnemyId, parent: Enemy, o: { hpAbs?: number; affixes?: AffixId[]; elite?: boolean; group?: number }): Enemy {
    const e = this.createEnemy(id, parent.wave, parent.effWave, parent.x, parent.y, parent.ccx, parent.ccy, {
      hpAbs: o.hpAbs, affixes: o.affixes, elite: o.elite, group: o.group ?? 1, noSplit: true,
    });
    const jx = (this.rng.next() - 0.5) * 0.3;
    const jy = (this.rng.next() - 0.5) * 0.3;
    if (parent.flying) {
      e.flying = true;
      e.fx0 = parent.fx0; e.fy0 = parent.fy0; e.fx1 = parent.fx1; e.fy1 = parent.fy1;
      e.flyLen = parent.flyLen; e.flyT = parent.flyT; e.flyPhase = parent.flyPhase + jx;
    } else {
      e.tcx = parent.tcx;
      e.tcy = parent.tcy;
      e.pcx = parent.pcx;
      e.pcy = parent.pcy;
      e.x += jx;
      e.y += jy;
      this.updateRemaining(e);
    }
    return e;
  }

  // ───────────────────────── 控制效果 ─────────────────────────

  private applySlow(e: Enemy, pct: number, dur: number, quiet = false): boolean {
    if (e.unstoppable) {
      if (!quiet) this.emit({ type: 'immune', x: e.x, y: e.y });
      return false;
    }
    if (e.boss) pct *= 0.5;
    this.forceSlow(e, pct, dur);
    return true;
  }

  private forceSlow(e: Enemy, pct: number, dur: number): void {
    const t = this.state.time;
    if (e.slowUntil <= t || pct > e.slowPct + 1e-6) {
      e.slowPct = pct;
      e.slowUntil = t + dur;
    } else if (Math.abs(pct - e.slowPct) < 1e-6) {
      e.slowUntil = Math.max(e.slowUntil, t + dur);
    }
  }

  private applyStun(e: Enemy, dur: number, quiet = false): boolean {
    if (e.unstoppable || e.id === 'boss_alarm') {
      if (!quiet || e.boss) this.emit({ type: 'immune', x: e.x, y: e.y });
      return false;
    }
    if (e.boss) dur = Math.min(dur, 0.3);
    e.stunUntil = Math.max(e.stunUntil, this.state.time + dur);
    e.jumpTimer = 0;
    return true;
  }

  private applyRoot(e: Enemy, dur: number): boolean {
    if (e.unstoppable) {
      this.emit({ type: 'immune', x: e.x, y: e.y });
      return false;
    }
    if (e.boss) dur = Math.min(dur, 0.3);
    e.rootUntil = Math.max(e.rootUntil, this.state.time + dur);
    return true;
  }

  private addDebuffer(e: Enemy, t: Tower | null, _kind: DebuffKind): void {
    if (!t) return;
    if (!e.debuffers.includes(t.uid)) e.debuffers.push(t.uid);
  }

  // ───────────────────────── 伤害 ─────────────────────────

  /** 结算一次伤害，返回实际造成的伤害（含护盾） */
  private damage(e: Enemy, amount: number, t: Tower | null, flags: number): number {
    if (e.dead || amount <= 0) return 0;
    const s = this.state;
    const now = s.time;
    let a = amount;
    let vul = 1 + e.zoneVuln;
    if (e.redUntil > now) vul += e.redVuln;
    if (e.litUntil > now) vul += e.litVuln;
    if (e.purpleUntil > now) vul += 0.1;
    if (e.measuredUntil > now) vul += 0.4;
    if (e.rootVulnUntil > now && e.rootUntil > now) vul += 0.2;
    if (this.daylightUntil > now) vul += 0.2;
    a *= vul;
    if ((flags & F_BEAM) !== 0 && e.reflect) a *= 0.5;
    let dealt = 0;
    let hitShield = false;
    if (e.shield > 0) {
      const mul = (flags & F_SHIELD3) !== 0 ? 3 : (flags & F_SHIELD2) !== 0 ? 2 : 1;
      const sd = Math.min(e.shield, a * mul);
      e.shield -= sd;
      if (e.shield < 0.01) e.shield = 0;
      dealt += sd;
      a -= sd / mul;
      hitShield = true;
    }
    if (a > 1e-6) {
      if ((flags & (F_IGNORE_ARMOR | F_DOT | F_TRUE)) === 0) {
        let armor = e.armor + (this.homeworkUntil > now ? 3 : 0) - (t ? t.pierce : 0);
        if (armor < 0) armor = 0;
        a = Math.max(1, a - armor);
      }
      const hd = Math.min(e.hp, a);
      e.hp -= a;
      dealt += hd;
    }
    e.lastHit = now;
    if ((flags & F_AOE) !== 0 && e.stealthy) e.revealUntil = Math.max(e.revealUntil, now + 2);
    const kind = (flags & F_DOT) !== 0 ? 'dot' : hitShield ? 'shield' : (flags & (F_IGNORE_ARMOR | F_TRUE)) !== 0 ? 'true' : 'normal';
    this.emit({ type: 'hit', enemyUid: e.uid, x: e.x, y: e.y, amount: Math.round(dealt * 10) / 10, crit: (flags & F_CRIT) !== 0, kind });
    if (t) {
      t.damage += dealt;
      const pool = e.maxHp + e.maxShield;
      if (pool > 0) this.gainXp(t, (dealt / pool) * e.xpVal);
    }
    if (e.hp <= 0) {
      this.kill(e, t);
      return dealt;
    }
    if (e.id === 'boss_coffee' && !e.splitDone && e.hp <= e.maxHp * 0.5) this.splitCoffee(e);
    else if (e.id === 'boss_inkbottle' && !e.cloudDone && e.hp <= e.maxHp * 0.3) {
      e.cloudDone = true;
      e.cloudUntil = now + 5;
      e.stealthy = true;
      e.hidden = true;
      this.emit({ type: 'bossSkill', enemyUid: e.uid, skill: 'inkCloud', x: e.x, y: e.y, r: 1 });
    }
    return dealt;
  }

  private splitCoffee(e: Enemy): void {
    e.splitDone = true;
    e.dead = true;
    this.onEnemyGone(e);
    this.emit({ type: 'split', x: e.x, y: e.y, enemy: e.id });
    for (let k = 0; k < 2; k++) {
      const c = this.spawnChild('boss_coffee_small', e, { hpAbs: e.hp * 0.5 });
      c.armor = e.armor;
      c.maxHp = e.maxHp * 0.5;
      c.abilityT = e.abilityT;
    }
  }

  private kill(e: Enemy, t: Tower | null): void {
    const s = this.state;
    e.dead = true;
    e.hp = 0;
    this.onEnemyGone(e);
    let gold = e.bounty;
    if (e.redGold && e.redUntil > s.time) gold += 1;
    // 钻头 ★2：带流血的敌人死亡时爆开，把一半层数传给 1 格内的敌人
    if (e.bleedStacks >= 2) {
      const ow = this.towerOf(e.bleedOwner);
      if (ow && ow.id === 'compass' && this.evo(ow, 'B', 2)) {
        const half = Math.floor(e.bleedStacks / 2);
        const cap = this.evo(ow, 'B', 1) ? 15 : 10;
        const n = this.queryAll(e.x, e.y, 1, this.qD, true);
        for (let j = 0; j < n; j++) {
          const o = this.qD[j];
          if (o === e || o.dead || o.flying) continue;
          o.bleedStacks = Math.min(cap, o.bleedStacks + half);
          o.bleedDps = Math.max(o.bleedDps, e.bleedDps);
          o.bleedUntil = s.time + 3;
          o.bleedOwner = ow.uid;
        }
        this.emit({ type: 'pulse', x: e.x, y: e.y, r: 1, color: 'magenta' });
      }
    }
    // 镀金存钱罐：周围 2.5 格 +1
    for (const p of this.towerList) {
      if (p.id !== 'piggy' || p.level < 7) continue;
      const dx = p.cx + 0.5 - e.x;
      const dy = p.cy + 0.5 - e.y;
      if (dx * dx + dy * dy <= 2.5 * 2.5) {
        gold += 1;
        break;
      }
    }
    const got = this.addGold(gold, 'kill', e.x, e.y, false);
    s.stats.kills += e.group;
    if (t) {
      t.kills += e.group;
      this.gainXp(t, e.xpVal * 0.25);
    }
    if (e.debuffers.length) {
      const share = (e.xpVal * 0.4) / e.debuffers.length;
      for (const u of e.debuffers) {
        const d = s.towers.get(u) as Tower | undefined;
        if (d) this.gainXp(d, share);
      }
    }
    this.emit({ type: 'death', enemyUid: e.uid, enemy: e.id, x: e.x, y: e.y, gold: got, boss: e.boss, elite: e.elite });
    // 分裂
    if (e.id === 'paperball') {
      this.emit({ type: 'split', x: e.x, y: e.y, enemy: 'crumbmini' });
      for (let k = 0; k < 3; k++) {
        const aff = e.affixes.filter((a) => a !== 'split');
        this.spawnChild('crumbmini', e, {
          hpAbs: e.crumbHp * 0.3 * (e.group > 1 ? e.group * 0.9 : 1), affixes: aff, elite: e.elite && aff.length > 0, group: e.group,
        });
      }
    }
    if (e.affixes.includes('split')) {
      this.emit({ type: 'split', x: e.x, y: e.y, enemy: e.id });
      for (let k = 0; k < 2; k++) this.spawnChild(e.id, e, { hpAbs: e.maxHp * 0.3, group: e.group });
    }
  }

  private processDots(): void {
    const s = this.state;
    const now = s.time;
    const en = s.enemies;
    const n0 = en.length;
    for (let i = 0; i < n0; i++) {
      const e = en[i] as Enemy;
      if (e.dead) continue;
      if (e.inkStacks > 0 && e.inkUntil <= now) e.inkStacks = 0;
      if (e.bleedStacks > 0 && e.bleedUntil <= now) e.bleedStacks = 0;
      if (e.burnUntil <= now && e.inkStacks === 0 && e.bleedStacks === 0 && e.poisonUntil <= now) {
        e.dotT = 0;
        continue;
      }
      e.dotT += DT;
      if (e.dotT < 0.5) continue;
      e.dotT -= 0.5;
      if (e.burnUntil > now && e.burnDps > 0) {
        this.damage(e, e.burnDps * 0.5, this.towerOf(e.burnOwner), F_DOT);
        if (e.dead) continue;
      }
      if (e.inkStacks > 0) {
        this.damage(e, e.inkDps * e.inkStacks * 0.5, this.towerOf(e.inkOwner), F_DOT);
        if (e.dead) continue;
      }
      if (e.poisonUntil > now && e.poisonDps > 0) {
        this.damage(e, e.poisonDps * 0.5, this.towerOf(e.poisonOwner), F_DOT);
        if (e.dead) continue;
      }
      if (e.bleedStacks > 0) this.damage(e, e.bleedDps * e.bleedStacks * 0.5, this.towerOf(e.bleedOwner), F_DOT);
    }
  }

  private towerOf(uid: number): Tower | null {
    return uid ? ((this.state.towers.get(uid) as Tower | undefined) ?? null) : null;
  }

  // ───────────────────────── 区域 ─────────────────────────

  private addZone(
    kind: Zone['kind'], shape: 'circle' | 'rect', x: number, y: number,
    o: { r?: number; w?: number; h?: number; angle?: number; until: number; slow?: number; dps?: number; vuln?: number; reveal?: boolean; air?: boolean; towerUid?: number; ink?: number },
  ): Zone {
    const s = this.state;
    const ang = o.angle ?? 0;
    const z: Zone = {
      uid: this.nextUid++, kind, shape, x, y, until: o.until, createdAt: s.time,
      towerUid: o.towerUid ?? 0, slow: o.slow ?? 0, dps: o.dps ?? 0, vuln: o.vuln ?? 0, reveal: !!o.reveal, air: !!o.air,
      tick: 0, ink: o.ink ?? 0, cos: Math.cos(ang), sin: Math.sin(ang), cx: x, cy: y, br: o.r ?? 0,
    };
    if (shape === 'circle') z.r = o.r ?? 1;
    else {
      z.w = o.w ?? 1;
      z.h = o.h ?? 1;
      if (o.angle !== undefined) {
        z.angle = ang;
        // 旋转矩形：x,y 为中心
        z.cx = x;
        z.cy = y;
        z.x = x - (z.cos * z.w) / 2 + (z.sin * z.h) / 2;
        z.y = y - (z.sin * z.w) / 2 - (z.cos * z.h) / 2;
      } else {
        z.cx = x + z.w / 2;
        z.cy = y + z.h / 2;
      }
      z.br = Math.hypot(z.w, z.h) / 2;
    }
    s.zones.push(z);
    return z;
  }

  private inZone(z: Zone, e: Enemy): boolean {
    if (z.shape === 'circle') {
      const dx = e.x - z.cx;
      const dy = e.y - z.cy;
      const r = (z.r ?? 1) + e.radius * 0.5;
      return dx * dx + dy * dy <= r * r;
    }
    const dx = e.x - z.cx;
    const dy = e.y - z.cy;
    // 转到矩形局部坐标
    const lx = dx * z.cos + dy * z.sin;
    const ly = -dx * z.sin + dy * z.cos;
    return Math.abs(lx) <= (z.w ?? 1) / 2 + e.radius * 0.5 && Math.abs(ly) <= (z.h ?? 1) / 2 + e.radius * 0.5;
  }

  private processZones(): void {
    const s = this.state;
    const now = s.time;
    const zs = s.zones;
    let w = 0;
    for (let i = 0; i < zs.length; i++) {
      const z = zs[i] as Zone;
      if (z.until <= now) continue;
      zs[w++] = z;
      z.tick += DT;
      const doDot = (z.dps > 0 || z.ink > 0) && z.tick >= 0.5;
      if (doDot) z.tick -= 0.5;
      const n = this.queryAll(z.cx, z.cy, z.br, this.qA, true);
      for (let j = 0; j < n; j++) {
        const e = this.qA[j];
        if (e.dead) continue;
        if (e.flying && !z.air) continue;
        if (!this.inZone(z, e)) continue;
        if (z.reveal && e.stealthy) e.revealUntil = Math.max(e.revealUntil, now + 0.1);
        if (z.vuln > 0) e.zoneVuln += z.vuln;
        if (z.slow > 0) this.applySlow(e, z.slow, 0.2, true);
        if (doDot) {
          if (z.dps > 0) this.damage(e, z.dps * 0.5, this.towerOf(z.towerUid), F_DOT | F_AOE);
          if (z.ink > 0 && !e.dead) this.addInk(this.towerOf(z.towerUid), e, z.ink);
        }
      }
    }
    zs.length = w;
  }

  // ───────────────────────── 塔的攻击 ─────────────────────────

  private targetable(e: Enemy): boolean {
    return !e.dead && !e.hidden && !e.jumping;
  }

  private canHit(t: Tower, e: Enemy): boolean {
    return e.flying ? t.def.hitsAir : t.def.hitsGround;
  }

  /** 选目标；exclude 为要排除的 uid */
  private findTarget(t: Tower, range: number, exclude = 0): Enemy | null {
    const x = t.cx + 0.5;
    const y = t.cy + 0.5;
    const n = this.queryAll(x, y, range, this.qA, false);
    if (n === 0) return null;
    const mode = t.targetMode;
    let best: Enemy | null = null;
    let bv = 0;
    let bestAir: Enemy | null = null;
    let bvAir = 0;
    for (let i = 0; i < n; i++) {
      const e = this.qA[i];
      if (e.uid === exclude || !this.targetable(e) || !this.canHit(t, e)) continue;
      let v: number;
      switch (mode) {
        case 'last': v = e.remaining; break;
        case 'strong': v = e.hp + e.shield; break;
        case 'weak': v = -(e.hp + e.shield); break;
        case 'close': {
          const dx = e.x - x;
          const dy = e.y - y;
          v = -(dx * dx + dy * dy);
          break;
        }
        default: v = -e.remaining;
      }
      if (best === null || v > bv) {
        best = e;
        bv = v;
      }
      if (mode === 'air' && e.flying) {
        const va = -e.remaining;
        if (bestAir === null || va > bvAir) {
          bestAir = e;
          bvAir = va;
        }
      }
    }
    if (mode === 'air' && bestAir) return bestAir;
    return best;
  }

  private towersAct(): void {
    const s = this.state;
    const now = s.time;
    const caff = now < s.caffeineUntil ? 1.6 : 1;
    for (let i = 0; i < this.towerList.length; i++) {
      const t = this.towerList[i];
      if (!t.def.attacks) continue;
      if (t.disabledUntil > now) continue;
      if (t.id === 'lamp' && t.level >= 10 && t.branch === 'A') {
        this.laserTick(t, caff);
        continue;
      }
      if (t.cd > 0) t.cd -= DT * t.atkMul * caff * this.speedBoost(t, now);
      if (t.cd > 0) continue;
      let fired = false;
      switch (t.id) {
        case 'pencil': fired = this.atkPencil(t); break;
        case 'stapler': fired = this.atkStapler(t); break;
        case 'glue': fired = this.atkGlue(t); break;
        case 'lamp': fired = this.atkLamp(t); break;
        case 'compass': fired = this.atkCompass(t); break;
        case 'eraser': fired = this.atkEraser(t); break;
        case 'ruler': fired = this.atkRuler(t); break;
        case 'pen': fired = this.atkPen(t); break;
      }
      if (fired) {
        t.cd += t.interval;
        if (t.cd < 0) t.cd = 0;
        t.lastFire = now;
        if (!t.attacked) {
          t.attacked = true;
          t.undoUntil = 0;
        }
      } else t.cd = 0;
    }
  }

  /** 进化带来的额外攻速：铅笔 A ★1 连射、★3 弹幕 */
  private speedBoost(t: Tower, now: number): number {
    if (t.id !== 'pencil' || t.level < 10 || t.branch !== 'A') return 1;
    let m = 1;
    if (t.stars >= 1) m += 0.05 * t.focusStacks;
    if (t.stars >= 3 && t.abilityUntil > now) m *= 3;
    return m;
  }

  private aim(t: Tower, e: { x: number; y: number }): void {
    t.angle = Math.atan2(e.y - (t.cy + 0.5), e.x - (t.cx + 0.5));
  }

  private rollCrit(t: Tower): boolean {
    if (t.calcCritUntil > this.state.time) return true;
    return t.critChance > 0 && this.rng.next() < t.critChance;
  }

  private atkPencil(t: Tower): boolean {
    const e = this.findTarget(t, t.range);
    if (!e) return false;
    const shots = t.level >= 7 ? 2 : 1;
    let second: Enemy | null = e;
    if (shots === 2) second = this.findTarget(t, t.range, e.uid) ?? e;
    this.aim(t, e);
    const B = t.level >= 10 && t.branch === 'B';
    if (this.evo(t, 'A', 1)) {
      if (t.focusUid === e.uid) t.focusStacks = Math.min(8, t.focusStacks + 1);
      else {
        t.focusUid = e.uid;
        t.focusStacks = 0;
      }
    }
    const barrage = this.evo(t, 'A', 3) && t.abilityUntil > this.state.time;
    const nColors = this.evo(t, 'B', 2) ? 5 : 3;
    for (let k = 0; k < shots; k++) {
      const tgt = k === 0 ? e : second!;
      const crit = this.rollCrit(t);
      const dmg = t.dmg * (crit ? t.critMul : 1);
      const p = this.spawnProj(t, B ? 'color' : 'graphite', tgt, t.def.projSpeed, dmg, crit);
      if (p && B) p.color = (['red', 'blue', 'yellow', 'green', 'purple'] as const)[this.rng.int(nColors)];
      if (p && barrage) p.pierce = 1;
      this.emit({ type: 'fire', uid: t.uid, tower: t.id, x: t.cx + 0.5, y: t.cy + 0.5, tx: tgt.x, ty: tgt.y });
    }
    return true;
  }

  private atkStapler(t: Tower): boolean {
    const x = t.cx + 0.5;
    const y = t.cy + 0.5;
    const n = this.queryAll(x, y, t.range, this.qA, true);
    let any = false;
    for (let i = 0; i < n; i++) {
      const e = this.qA[i];
      if (!e.flying && !e.jumping) { any = true; break; }
    }
    if (!any) return false;
    const now = this.state.time;
    const T3 = t.level >= 7;
    const B = t.level >= 10 && t.branch === 'B';
    const combo = (t.combo & C_GLUE_STAPLER) !== 0;
    t.atkCount++;
    const heavy = this.evo(t, 'A', 2) && t.atkCount % 5 === 0;
    const shredCap = this.evo(t, 'B', 1) ? 8 : 5;
    const shieldFlag = this.evo(t, 'B', 2) ? F_SHIELD2 : 0;
    // 复制列表，避免伤害结算中嵌套查询覆盖
    const list = this.qC;
    list.length = 0;
    for (let i = 0; i < n; i++) list.push(this.qA[i]);
    for (const e of list) {
      if (e.dead || e.flying || e.jumping) continue;
      let dmg = t.dmg;
      if (T3 && e.armor > 0) dmg += 4;
      if (B && e.armor <= 0) dmg *= 1.3;
      if (combo && e.slowUntil > now && e.slowPct > 0) dmg *= 1.25;
      if (heavy) dmg *= 3;
      const crit = this.rollCrit(t);
      if (crit) dmg *= t.critMul;
      if (B && e.shred < shredCap && e.armor > 0) {
        e.shred++;
        e.armor = Math.max(0, e.armor - 1);
      }
      this.damage(e, dmg, t, F_AOE | shieldFlag | (crit ? F_CRIT : 0));
      if (!e.dead && t.stunChance > 0 && e.stapleReady <= now && this.rng.next() < t.stunChance) {
        if (this.applyStun(e, 0.5)) e.stapleReady = now + 3;
      }
    }
    this.emit({ type: 'pulse', x, y, r: t.range, color: 'steel' });
    this.emit({ type: 'fire', uid: t.uid, tower: t.id, x, y, tx: x, ty: y });
    return true;
  }

  private atkGlue(t: Tower): boolean {
    const e = this.findTarget(t, t.range);
    if (!e) return false;
    this.aim(t, e);
    this.spawnProj(t, 'glue', e, t.def.projSpeed, t.dmg, false);
    this.emit({ type: 'fire', uid: t.uid, tower: t.id, x: t.cx + 0.5, y: t.cy + 0.5, tx: e.x, ty: e.y });
    return true;
  }

  private glueLand(t: Tower | null, x: number, y: number, dmg: number): void {
    const now = this.state.time;
    const level = t ? t.level : 1;
    const A = t && level >= 10 && t.branch === 'A';
    const B = t && level >= 10 && t.branch === 'B';
    const slow = t ? t.slowPct : 0.4;
    const dur = t ? t.slowDur : 1.5;
    const n = this.queryAll(x, y, 0.8, this.qB, true);
    const list = this.qC;
    list.length = 0;
    for (let i = 0; i < n; i++) list.push(this.qB[i]);
    for (const e of list) {
      if (e.dead || e.flying) continue;
      this.damage(e, dmg, t, F_AOE);
      if (e.dead) continue;
      if (this.applySlow(e, slow, dur)) this.addDebuffer(e, t, 'glue');
      if (A && this.rng.next() < 0.25) {
        if (this.applyRoot(e, this.evo(t!, 'A', 1) ? 1.5 : 1) && this.evo(t!, 'A', 2)) e.rootVulnUntil = e.rootUntil;
      }
    }
    this.emit({ type: 'pulse', x, y, r: 0.8, color: 'cyan' });
    if (t && level >= 4) {
      const big = this.evo(t, 'B', 2);
      const zr = 0.8 + (big ? 0.3 : 0);
      const zd = 3 + (big ? 2 : 0);
      if (B) this.addZone('hotglue', 'circle', x, y, { r: zr, until: now + zd, dps: 10 * t.dmgFactor * (this.evo(t, 'B', 1) ? 1.5 : 1), towerUid: t.uid });
      else this.addZone('glue', 'circle', x, y, { r: 0.8, until: now + 3, slow, towerUid: t.uid });
    }
  }

  private atkLamp(t: Tower): boolean {
    const e = this.findTarget(t, t.range);
    if (!e) return false;
    const targets: Enemy[] = [e];
    if (t.level >= 7) {
      const e2 = this.findTarget(t, t.range, e.uid);
      if (e2) targets.push(e2);
    }
    this.aim(t, e);
    const T2 = t.level >= 4;
    const B = t.level >= 10 && t.branch === 'B';
    const now = this.state.time;
    for (let k = 0; k < targets.length; k++) {
      const tg = targets[k];
      let dmg = t.dmg;
      if (T2 && k === 0) {
        if (t.focusUid === tg.uid) t.focusStacks = Math.min(3, t.focusStacks + 1);
        else {
          t.focusUid = tg.uid;
          t.focusStacks = 0;
        }
        dmg *= 1 + 0.2 * t.focusStacks;
      }
      if (tg.id === 'moth') dmg *= 2;
      const crit = this.rollCrit(t);
      if (crit) dmg *= t.critMul;
      if (B) {
        tg.litUntil = Math.max(tg.litUntil, now + 1.6);
        tg.litVuln = Math.max(tg.litVuln, this.evo(t, 'B', 1) ? 0.25 : 0.15);
      }
      this.emit({ type: 'beam', uid: t.uid, x: t.cx + 0.5, y: t.cy + 0.5, tx: tg.x, ty: tg.y, color: B ? 'cyan' : 'warm', width: 0.12 + 0.03 * t.focusStacks });
      this.damage(tg, dmg, t, F_BEAM | F_IGNORE_ARMOR | (crit ? F_CRIT : 0));
    }
    return true;
  }

  private laserTick(t: Tower, caff: number): void {
    let tg = t.laserUid ? this.enemyByUid.get(t.laserUid) : undefined;
    const x = t.cx + 0.5;
    const y = t.cy + 0.5;
    if (tg) {
      const dx = tg.x - x;
      const dy = tg.y - y;
      if (!this.targetable(tg) || dx * dx + dy * dy > t.range * t.range) tg = undefined;
    }
    if (!tg) {
      const n = this.findTarget(t, t.range);
      t.laserUid = n ? n.uid : 0;
      t.laserTime = 0;
      t.laserAcc = 0;
      if (!n) return;
      tg = n;
    }
    this.aim(t, tg);
    t.laserTime += DT;
    const cap = LASER_RAMP_CAP * (this.evo(t, 'A', 1) ? 1.5 : 1);
    let dps = t.dmg * Math.min(cap, Math.pow(1.25, t.laserTime)) * caff * t.atkMul;
    if (tg.id === 'moth') dps *= 2;
    t.laserAcc += dps * DT;
    t.laserBeamT += DT;
    t.lastFire = this.state.time;
    if (!t.attacked) {
      t.attacked = true;
      t.undoUntil = 0;
    }
    if (t.laserBeamT >= 0.1) {
      t.laserBeamT = 0;
      this.emit({ type: 'beam', uid: t.uid, x, y, tx: tg.x, ty: tg.y, color: 'magenta', width: Math.min(0.4, 0.1 + 0.03 * t.laserTime) });
      const crit = this.rollCrit(t);
      const amt = t.laserAcc * (crit ? t.critMul : 1);
      t.laserAcc = 0;
      const extra: Enemy[] = [];
      // ★3 过载：光束分裂为 4 道
      if (t.stars >= 3 && t.abilityUntil > this.state.time) {
        let ex = tg.uid;
        for (let k = 0; k < 3; k++) {
          const o = this.findTarget(t, t.range, ex);
          if (!o || o === tg || extra.includes(o)) break;
          extra.push(o);
          ex = o.uid;
        }
      }
      // ★2 折射：第二个目标 50%
      let refract: Enemy | null = null;
      if (this.evo(t, 'A', 2)) {
        const n = this.queryAll(tg.x, tg.y, 1.5, this.qB, false);
        let bd = Infinity;
        for (let j = 0; j < n; j++) {
          const o = this.qB[j];
          if (o === tg || !this.targetable(o) || extra.includes(o)) continue;
          const dx = o.x - tg.x;
          const dy = o.y - tg.y;
          if (dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; refract = o; }
        }
      }
      const tx0 = tg.x;
      const ty0 = tg.y;
      this.damage(tg, amt, t, F_BEAM | F_IGNORE_ARMOR | (crit ? F_CRIT : 0));
      for (const o of extra) {
        if (o.dead) continue;
        this.emit({ type: 'beam', uid: t.uid, x, y, tx: o.x, ty: o.y, color: 'magenta', width: 0.15 });
        this.damage(o, amt, t, F_BEAM | F_IGNORE_ARMOR);
      }
      if (refract && !refract.dead) {
        this.emit({ type: 'beam', uid: t.uid, x: tx0, y: ty0, tx: refract.x, ty: refract.y, color: 'magenta', width: 0.08 });
        this.damage(refract, amt * 0.5, t, F_BEAM | F_IGNORE_ARMOR);
      }
    }
  }

  private atkCompass(t: Tower): boolean {
    const x = t.cx + 0.5;
    const y = t.cy + 0.5;
    const A = t.level >= 10 && t.branch === 'A';
    const B = t.level >= 10 && t.branch === 'B';
    const n = this.queryAll(x, y, t.range, this.qA, true);
    const list = this.qC;
    list.length = 0;
    const full = A && t.stars >= 3 && t.abilityUntil > this.state.time;
    const arc = A && !full ? ((this.evo(t, 'A', 1) ? 130 : 100) * Math.PI) / 180 : TAU;
    let center = 0;
    if (A && !full) {
      t.sweepPhase += t.interval * 1.6;
      center = Math.sin(t.sweepPhase) * Math.PI;
      t.angle = center;
    } else {
      t.angle = (t.angle + 0.9) % TAU;
    }
    for (let i = 0; i < n; i++) {
      const e = this.qA[i];
      if (e.flying || e.jumping) continue;
      const dx = e.x - x;
      const dy = e.y - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d + e.aoeRadius < t.inner) continue;
      if (A && !full) {
        let da = Math.atan2(dy, dx) - center;
        while (da > Math.PI) da -= TAU;
        while (da < -Math.PI) da += TAU;
        if (Math.abs(da) > arc / 2 && d > 0.4) continue;
      }
      list.push(e);
    }
    if (list.length === 0) return false;
    for (const e of list) {
      if (e.dead) continue;
      const crit = this.rollCrit(t);
      this.damage(e, t.dmg * (crit ? t.critMul : 1), t, F_AOE | (crit ? F_CRIT : 0));
      if (A && !e.dead && this.evo(t, 'A', 2)) this.applySlow(e, 0.15, 1, true);
      if (B && !e.dead) {
        e.bleedStacks = Math.min(this.evo(t, 'B', 1) ? 15 : 10, e.bleedStacks + 1);
        e.bleedDps = Math.max(e.bleedDps, 2 * t.dmgFactor);
        e.bleedUntil = this.state.time + 3;
        e.bleedOwner = t.uid;
      }
    }
    this.emit({ type: 'sweep', uid: t.uid, x, y, r0: t.inner, r1: t.range, angle: t.angle, arc });
    return true;
  }

  private atkEraser(t: Tower): boolean {
    const e = this.findTarget(t, t.range);
    if (!e) return false;
    this.aim(t, e);
    const p = this.spawnProj(t, 'eraser', e, t.def.projSpeed, t.dmg, this.rollCrit(t));
    if (p && t.level >= 4) p.bounce = this.evo(t, 'B', 2) ? 3 : 1;
    this.emit({ type: 'fire', uid: t.uid, tower: t.id, x: t.cx + 0.5, y: t.cy + 0.5, tx: e.x, ty: e.y });
    return true;
  }

  private eraserHit(t: Tower | null, e: Enemy, dmg: number, crit: boolean): void {
    const now = this.state.time;
    const level = t ? t.level : 1;
    const B = t && level >= 10 && t.branch === 'B';
    const A = t && level >= 10 && t.branch === 'A';
    if (B && e.shield > 0 && this.rng.next() < (this.evo(t!, 'B', 1) ? 0.2 : 0.1)) e.shield = 0;
    this.damage(e, dmg * (crit && t ? t.critMul : 1), t, F_SHIELD3 | (crit ? F_CRIT : 0));
    if (!e.dead) {
      e.armor = Math.max(0, e.armor - (level >= 7 ? 2 : 1));
      this.addDebuffer(e, t, 'eraser');
    }
    if (A && t && now - t.lastTape >= 2 && !e.flying) {
      t.lastTape = now;
      this.addZone('tape', 'rect', e.x, e.y, {
        w: this.evo(t, 'A', 1) ? 5 : 3, h: 0.7, angle: e.angle, until: now + 5, vuln: 0.25, towerUid: t.uid,
        slow: this.evo(t, 'A', 2) ? 0.2 : 0,
      });
    }
  }

  private atkRuler(t: Tower): boolean {
    const e = this.findTarget(t, t.range);
    if (!e) return false;
    this.aim(t, e);
    const n = t.level >= 7 ? 3 : 1;
    const spread = (15 * Math.PI) / 180;
    for (let k = 0; k < n; k++) {
      const ang = t.angle + (n === 3 ? (k - 1) * spread : 0);
      const crit = this.rollCrit(t);
      const p = this.allocProj(t, 'ruler', t.cx + 0.5, t.cy + 0.5);
      if (!p) break;
      p.angle = ang;
      p.vx = Math.cos(ang);
      p.vy = Math.sin(ang);
      p.speed = t.def.projSpeed;
      p.dmg = t.dmg;
      p.crit = crit;
      p.maxDist = t.range + 0.5;
      p.targetUid = 0;
    }
    this.emit({ type: 'fire', uid: t.uid, tower: t.id, x: t.cx + 0.5, y: t.cy + 0.5, tx: e.x, ty: e.y });
    return true;
  }

  private atkPen(t: Tower): boolean {
    const e = this.findTarget(t, t.range);
    if (!e) return false;
    this.aim(t, e);
    const A = t.level >= 10 && t.branch === 'A';
    this.spawnProj(t, A ? 'brush' : 'ink', e, t.def.projSpeed, t.dmg, this.rollCrit(t));
    this.emit({ type: 'fire', uid: t.uid, tower: t.id, x: t.cx + 0.5, y: t.cy + 0.5, tx: e.x, ty: e.y });
    return true;
  }

  private addInk(t: Tower | null, e: Enemy, stacks: number): void {
    if (e.dead) return;
    const max = t ? t.inkMax : 3;
    let dps = 6 * (t ? t.dmgFactor : 1);
    if (t && (t.combo & C_LAMP_PEN) !== 0) dps *= 1.3;
    e.inkStacks = Math.min(max, e.inkStacks + stacks);
    e.inkDps = Math.max(e.inkDps, dps);
    e.inkUntil = this.state.time + 3;
    if (t) {
      e.inkOwner = t.uid;
      this.addDebuffer(e, t, 'pen');
      if (t.level >= 10 && t.branch === 'B') {
        e.redUntil = this.state.time + 3;
        e.redVuln = Math.max(e.redVuln, this.evo(t, 'B', 1) ? 0.3 : 0.2);
        if (this.evo(t, 'B', 2)) e.redGold = true;
      }
    }
  }

  private penHit(t: Tower | null, e: Enemy, p: Proj): void {
    const crit = p.crit;
    const mul = crit && t ? t.critMul : 1;
    if (p.kind === 'brush') {
      // 一道 2 格长的笔画，沿弹道方向，以目标为中心
      const cx = e.x;
      const cy = e.y;
      const ux = Math.cos(p.angle);
      const uy = Math.sin(p.angle);
      const half = t && this.evo(t, 'A', 1) ? 1.5 : 1;
      const stacks = t && this.evo(t, 'A', 2) ? 3 : 2;
      const n = this.queryAll(cx, cy, half + 0.2, this.qB, true);
      const list = this.qC;
      list.length = 0;
      for (let i = 0; i < n; i++) {
        const o = this.qB[i];
        if (!this.targetable(o) && o !== e) continue;
        const dx = o.x - cx;
        const dy = o.y - cy;
        const along = dx * ux + dy * uy;
        const perp = Math.abs(-dx * uy + dy * ux);
        if (Math.abs(along) <= half + o.radius && perp <= 0.35 + o.radius) list.push(o);
      }
      if (!list.includes(e)) list.push(e);
      for (const o of list) {
        this.damage(o, p.dmg * mul, t, crit ? F_CRIT : 0);
        this.addInk(t, o, stacks);
      }
      this.emit({ type: 'sweep', uid: t ? t.uid : 0, x: cx - ux * half, y: cy - uy * half, r0: 0, r1: half * 2, angle: p.angle, arc: 0 });
      return;
    }
    this.damage(e, p.dmg * mul, t, crit ? F_CRIT : 0);
    this.addInk(t, e, 1);
    if (t && t.level >= 4) {
      const n = this.queryAll(e.x, e.y, 0.6, this.qB, true);
      for (let i = 0; i < n; i++) {
        const o = this.qB[i];
        if (o !== e && !o.dead) this.addInk(t, o, 1);
      }
      this.emit({ type: 'pulse', x: e.x, y: e.y, r: 0.6, color: 'ink' });
    }
  }

  // ───────────────────────── 弹道 ─────────────────────────

  private allocProj(t: Tower | null, kind: Proj['kind'], x: number, y: number): Proj | null {
    const s = this.state;
    if (s.projectiles.length >= MAX_PROJECTILES) return null;
    let p = this.projPool.pop();
    if (!p) {
      p = {
        uid: 0, kind, x, y, angle: 0, towerUid: 0, tower: null, targetUid: 0, tx: x, ty: y, speed: 0, dmg: 0, crit: false,
        vx: 0, vy: 0, travelled: 0, maxDist: 0, hits: [], bounce: 0, dead: false, pierce: 0,
      };
    }
    p.uid = this.nextUid++;
    p.kind = kind;
    p.x = x;
    p.y = y;
    p.angle = 0;
    p.towerUid = t ? t.uid : 0;
    p.tower = t;
    p.targetUid = 0;
    p.tx = x;
    p.ty = y;
    p.speed = 0;
    p.dmg = 0;
    p.crit = false;
    p.vx = 0;
    p.vy = 0;
    p.travelled = 0;
    p.maxDist = 0;
    p.hits.length = 0;
    p.bounce = 0;
    p.pierce = 0;
    p.dead = false;
    delete p.color;
    s.projectiles.push(p);
    return p;
  }

  /** 追踪弹；弹道已满时立即结算 */
  private spawnProj(t: Tower, kind: Proj['kind'], e: Enemy, speed: number, dmg: number, crit: boolean, from?: { x: number; y: number }): Proj | null {
    const x = from ? from.x : t.cx + 0.5;
    const y = from ? from.y : t.cy + 0.5;
    const p = this.allocProj(t, kind, x, y);
    if (!p) {
      // 立即结算
      const tmp: Proj = {
        uid: 0, kind, x: e.x, y: e.y, angle: Math.atan2(e.y - y, e.x - x), towerUid: t.uid, tower: t, targetUid: e.uid,
        tx: e.x, ty: e.y, speed, dmg, crit, vx: 0, vy: 0, travelled: 0, maxDist: 0, hits: [], bounce: 0, dead: false, pierce: 0,
      };
      this.projHit(tmp, e);
      return null;
    }
    p.targetUid = e.uid;
    p.tx = e.x;
    p.ty = e.y;
    p.speed = speed;
    p.dmg = dmg;
    p.crit = crit;
    p.angle = Math.atan2(e.y - y, e.x - x);
    return p;
  }

  private moveProjectiles(): void {
    const s = this.state;
    const ps = s.projectiles;
    const n0 = ps.length;
    const windy = this.windUntil > s.time;
    for (let i = 0; i < n0; i++) {
      const p = ps[i] as Proj;
      if (p.dead) continue;
      if (p.kind === 'ruler' || p.kind === 'nail') {
        this.moveRuler(p);
        continue;
      }
      const e = p.targetUid ? this.enemyByUid.get(p.targetUid) : undefined;
      if (e && !e.dead) {
        p.tx = e.x;
        p.ty = e.y;
      }
      const dx = p.tx - p.x;
      const dy = p.ty - p.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const step = p.speed * DT;
      if (d <= step + (e && !e.dead ? e.radius * 0.5 : 0.05)) {
        p.x = p.tx;
        p.y = p.ty;
        p.dead = true;
        if (e && !e.dead) {
          // 窗外起风：弹道偏移，30% 落空（胶团落在偏一点的位置）
          if (windy && this.rng.next() < 0.3) {
            if (p.kind === 'glue') this.glueLand(p.tower, p.x + this.windDir * 0.7, p.y, p.dmg);
            else this.emit({ type: 'dodge', x: e.x, y: e.y });
          } else this.projHit(p, e);
        } else if (p.kind === 'glue') this.glueLand(p.tower, p.x, p.y, p.dmg);
      } else {
        p.x += (dx / d) * step;
        p.y += (dy / d) * step;
        if (windy) p.x += this.windDir * 0.8 * DT;
        p.angle = Math.atan2(dy, dx);
      }
    }
    // 移除
    let w = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i] as Proj;
      if (p.dead) {
        p.tower = null;
        this.projPool.push(p);
      } else ps[w++] = p;
    }
    ps.length = w;
  }

  private projHit(p: Proj, e: Enemy): void {
    const t = p.tower;
    // 飞蛾闪避弹道（铅笔、胶水、钢笔）
    if (e.dodge > 0 && (p.kind === 'graphite' || p.kind === 'color' || p.kind === 'glue' || p.kind === 'ink' || p.kind === 'brush')) {
      if (this.rng.next() < e.dodge) {
        this.emit({ type: 'dodge', x: e.x, y: e.y });
        return;
      }
    }
    switch (p.kind) {
      case 'graphite':
      case 'color': {
        const ex = e.x;
        const ey = e.y;
        this.damage(e, p.dmg, t, p.crit ? F_CRIT : 0);
        if (t && (t.combo & C_PENCIL_ERASER) !== 0 && !e.dead) e.armor = Math.max(0, e.armor - 0.5);
        if (p.kind === 'color' && t) {
          const now = this.state.time;
          const mul = this.evo(t, 'B', 1) ? 1.5 : 1;
          const all = t.stars >= 3 && t.branch === 'B' && t.abilityUntil > now;
          const colors = all ? (['red', 'blue', 'yellow', 'green', 'purple'] as const) : [p.color ?? 'red'];
          for (const c of colors) {
            if (c === 'yellow') {
              if (t.colorGold < 15) {
                t.colorGold++;
                this.addGold(mul, 'color', ex, ey);
              }
              continue;
            }
            if (e.dead) continue;
            if (c === 'red') {
              e.burnDps = Math.max(e.burnDps, 4 * mul);
              e.burnUntil = now + 3;
              e.burnOwner = t.uid;
            } else if (c === 'blue') this.applySlow(e, 0.2 * mul, 1, true);
            else if (c === 'green') {
              e.poisonDps = Math.max(e.poisonDps, 6 * mul);
              e.poisonUntil = now + 4;
              e.poisonOwner = t.uid;
            } else if (c === 'purple') e.purpleUntil = now + 3;
          }
        }
        // 弹幕：穿透 1 个目标
        if (p.pierce > 0 && t) {
          const n = this.queryAll(ex, ey, 1.2, this.qB, false);
          let best: Enemy | null = null;
          let bd = Infinity;
          for (let i = 0; i < n; i++) {
            const o = this.qB[i];
            if (o === e || !this.targetable(o) || !this.canHit(t, o)) continue;
            const dx = o.x - ex;
            const dy = o.y - ey;
            if (dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; best = o; }
          }
          if (best) this.damage(best, p.dmg, t, 0);
        }
        break;
      }
      case 'glue':
        this.glueLand(t, e.x, e.y, p.dmg);
        break;
      case 'eraser': {
        this.eraserHit(t, e, p.dmg, p.crit);
        if (p.bounce > 0 && t) {
          const n = this.queryAll(e.x, e.y, 1.5, this.qB, false);
          let best: Enemy | null = null;
          let bd = Infinity;
          for (let i = 0; i < n; i++) {
            const o = this.qB[i];
            if (o === e || !this.targetable(o) || o.flying) continue;
            const dx = o.x - e.x;
            const dy = o.y - e.y;
            const d = dx * dx + dy * dy;
            if (d < bd) { bd = d; best = o; }
          }
          if (best) {
            const np = this.spawnProj(t, 'eraser', best, p.speed, p.dmg, false, { x: e.x, y: e.y });
            if (np) np.bounce = p.bounce - 1;
          }
        }
        break;
      }
      case 'ink':
      case 'brush':
        this.penHit(t, e, p);
        break;
      default:
        this.damage(e, p.dmg, t, 0);
    }
  }

  private moveRuler(p: Proj): void {
    const step = p.speed * DT;
    if (this.windUntil > this.state.time) {
      p.vx += this.windDir * 0.3 * DT;
      const l = Math.hypot(p.vx, p.vy) || 1;
      p.vx /= l;
      p.vy /= l;
      p.angle = Math.atan2(p.vy, p.vx);
    }
    p.x += p.vx * step;
    p.y += p.vy * step;
    p.travelled += step;
    const s = this.state;
    if (p.travelled >= p.maxDist || p.x < -1 || p.y < -1 || p.x > s.grid.cols + 1 || p.y > s.grid.rows + 1) {
      p.dead = true;
      return;
    }
    const t = p.tower;
    const n = this.queryAll(p.x, p.y, 0.3, this.qB, true);
    if (n === 0) return;
    const list = this.qC;
    list.length = 0;
    for (let i = 0; i < n; i++) list.push(this.qB[i]);
    if (p.kind === 'nail') {
      for (const e of list) {
        if (!this.targetable(e) || e.flying || p.hits.includes(e.uid)) continue;
        p.hits.push(e.uid);
        this.damage(e, p.dmg, t, F_AOE);
      }
      return;
    }
    const level = t ? t.level : 1;
    const A = t && level >= 10 && t.branch === 'A';
    const B = t && level >= 10 && t.branch === 'B';
    const execLine = t && this.evo(t, 'B', 1) ? 0.15 : 0.1;
    for (const e of list) {
      if (!this.targetable(e) || p.hits.includes(e.uid)) continue;
      p.hits.push(e.uid);
      let dmg = p.dmg;
      if (level >= 4) dmg *= 1 + 0.03 * Math.floor(p.travelled);
      if (p.crit && t) dmg *= t.critMul;
      this.damage(e, dmg, t, p.crit ? F_CRIT : 0);
      if (e.dead) continue;
      if (B && !e.boss && e.hp < e.maxHp * execLine) {
        const ex = e.x;
        const ey = e.y;
        this.damage(e, e.hp + e.shield + 1, t, F_TRUE);
        if (e.dead && this.evo(t!, 'B', 2)) this.addGold(2, 'kill', ex, ey);
        continue;
      }
      if (A && !e.flying) {
        const left = this.knockback(e, this.evo(t!, 'A', 1) ? 0.8 : 0.5);
        // 钢尺 ★2：撞到墙或塔额外受到 50% 伤害
        if (left > 0.05 && this.evo(t!, 'A', 2) && !e.dead) this.damage(e, dmg * 0.5, t, 0);
      }
    }
  }

  // ───────────────────────── 杂项 ─────────────────────────

  private cleanup(): void {
    const s = this.state;
    const en = s.enemies;
    let w = 0;
    let bossChanged = false;
    for (let i = 0; i < en.length; i++) {
      const e = en[i] as Enemy;
      if (e.dead) {
        this.enemyByUid.delete(e.uid);
        if (e.boss) bossChanged = true;
      } else en[w++] = e;
    }
    en.length = w;
    if (bossChanged) s.bossUids = s.bossUids.filter((u) => this.enemyByUid.has(u));
  }

  private addGold(amount: number, reason: Extract<GameEvent, { type: 'gold' }>['reason'], x?: number, y?: number, emit = true): number {
    const s = this.state;
    this.goldFrac += amount;
    const whole = Math.floor(this.goldFrac + 1e-9);
    this.goldFrac -= whole;
    if (whole <= 0) return 0;
    s.gold += whole;
    s.stats.goldEarned += whole;
    if (emit) {
      const ev: GameEvent = { type: 'gold', amount: whole, reason };
      if (x !== undefined) ev.x = x;
      if (y !== undefined) ev.y = y;
      this.emit(ev);
    }
    return whole;
  }

  private spendGold(n: number): void {
    this.state.gold -= n;
    this.state.stats.goldSpent += n;
  }

  private updateScore(): void {
    const s = this.state;
    const v = (this.lastCleared * 100 + s.stats.kills + s.lives * 50 + s.gold * 0.1 + this.bonusScore) * s.params.scoreMul;
    s.score = Math.round(v);
  }

  private emit(ev: GameEvent): void {
    this.events.push(ev);
  }

  private toast(text: string, tone: 'info' | 'warn' | 'good'): void {
    this.emit({ type: 'toast', text, tone });
  }

  // ───────────────────────── 神话能力（文档 11 §1.4） ─────────────────────────

  /** 冷却只在战斗阶段计时 */
  private tickAbilities(dt: number): void {
    for (const t of this.towerList) if (t.stars >= 3 && t.abilityCd > 0) t.abilityCd = Math.max(0, t.abilityCd - dt);
  }

  /** 能力的敌人目标：targetUid，或离 (x,y) 最近的可选中敌人 */
  private pickEnemy(cmd: { x?: number; y?: number; targetUid?: number }, ok: (e: Enemy) => boolean): Enemy | null {
    if (cmd.targetUid !== undefined) {
      const e = this.enemyByUid.get(cmd.targetUid);
      return e && !e.dead && !e.hidden && ok(e) ? e : null;
    }
    if (cmd.x === undefined || cmd.y === undefined) return null;
    let best: Enemy | null = null;
    let bd = 1.5 * 1.5;
    for (const e0 of this.state.enemies) {
      const e = e0 as Enemy;
      if (e.dead || e.hidden || !ok(e)) continue;
      const dx = e.x - cmd.x;
      const dy = e.y - cmd.y;
      const d = dx * dx + dy * dy;
      if (d <= bd) { bd = d; best = e; }
    }
    return best;
  }

  private cmdTowerAbility(cmd: Extract<Command, { type: 'towerAbility' }>): CommandResult {
    const s = this.state;
    if (s.phase === 'perk') return { ok: false, reason: '请先选择增益' };
    const t = s.towers.get(cmd.uid) as Tower | undefined;
    if (!t) return { ok: false, reason: '塔不存在' };
    const br = evoBranch(t.id, t.branch);
    if (!br || t.stars < 3 || t.level < 10) return { ok: false, reason: '进化到神话（★3）后才有主动能力' };
    const a = br.ability;
    if (a.chargeWaves) {
      if ((t.abilityCharges ?? 0) <= 0) return { ok: false, reason: '没有充能' };
    } else if (t.abilityCd > 0) return { ok: false, reason: '能力冷却中' };
    const now = s.time;
    const tx = t.cx + 0.5;
    const ty = t.cy + 0.5;
    const ev: Extract<GameEvent, { type: 'towerAbility' }> = { type: 'towerAbility', uid: t.uid, ability: a.id };
    switch (a.id) {
      case 'pencil_a':
      case 'pencil_b':
      case 'lamp_a':
      case 'compass_a':
        t.abilityUntil = now + a.duration;
        Object.assign(ev, { x: tx, y: ty });
        break;
      case 'calculator_a':
        t.abilityUntil = now + a.duration;
        this.statsDirty = true;
        Object.assign(ev, { x: tx, y: ty, r: t.aura });
        break;
      case 'stapler_a': {
        let ang = cmd.angle;
        if (ang === undefined && cmd.x !== undefined && cmd.y !== undefined) ang = Math.atan2(cmd.y - ty, cmd.x - tx);
        if (ang === undefined || !Number.isFinite(ang)) return { ok: false, reason: '请选择方向' };
        for (let k = 0; k < 12; k++) {
          const p = this.allocProj(t, 'nail', tx, ty);
          if (!p) break;
          const aa = ang + ((k % 6) - 2.5) * 0.07;
          p.angle = aa;
          p.vx = Math.cos(aa);
          p.vy = Math.sin(aa);
          // 两轮：第二轮从稍后的位置出发，看起来像连发
          p.x -= p.vx * 0.6 * Math.floor(k / 6);
          p.y -= p.vy * 0.6 * Math.floor(k / 6);
          p.speed = 11;
          p.dmg = t.dmg * 2.5;
          p.maxDist = 7.5;
        }
        t.angle = ang;
        Object.assign(ev, { x: tx, y: ty, angle: ang });
        break;
      }
      case 'stapler_b': {
        const n = this.queryAll(tx, ty, 2, this.qC, true);
        for (let i = 0; i < n; i++) {
          const e = this.qC[i];
          if (e.dead) continue;
          e.armor = 0;
          e.shield = 0;
          e.shred = 99;
        }
        this.emit({ type: 'pulse', x: tx, y: ty, r: 2, color: 'steel' });
        Object.assign(ev, { x: tx, y: ty, r: 2 });
        break;
      }
      case 'glue_a': {
        for (const e0 of s.enemies) {
          const e = e0 as Enemy;
          if (e.dead || e.flying) continue;
          if (e.unstoppable) {
            this.emit({ type: 'immune', x: e.x, y: e.y });
            continue;
          }
          e.rootUntil = Math.max(e.rootUntil, now + (e.boss ? 0.5 : 2));
          e.rootVulnUntil = e.rootUntil;
        }
        this.emit({ type: 'pulse', x: s.grid.cols / 2, y: s.grid.rows / 2, r: 9, color: 'cyan' });
        Object.assign(ev, { x: tx, y: ty });
        break;
      }
      case 'glue_b': {
        if (cmd.x === undefined || cmd.y === undefined) return { ok: false, reason: '请选择位置' };
        const x0 = Math.max(0, Math.min(s.grid.cols - 3, Math.floor(cmd.x) - 1));
        const y0 = Math.max(0, Math.min(s.grid.rows - 3, Math.floor(cmd.y) - 1));
        this.addZone('lava', 'rect', x0, y0, { w: 3, h: 3, until: now + a.duration, dps: 30 * t.dmgFactor, slow: 0.5, towerUid: t.uid });
        Object.assign(ev, { x: x0 + 1.5, y: y0 + 1.5, r: 1.5 });
        break;
      }
      case 'lamp_b':
        this.daylightUntil = Math.max(this.daylightUntil, now + a.duration);
        this.emit({ type: 'pulse', x: tx, y: ty, r: 12, color: 'gold' });
        Object.assign(ev, { x: tx, y: ty });
        break;
      case 'compass_b': {
        const e = this.pickEnemy(cmd, () => true);
        if (!e) return { ok: false, reason: '请选择一个敌人' };
        const lost = Math.max(0, e.maxHp - e.hp);
        this.emit({ type: 'beam', uid: t.uid, x: tx, y: ty, tx: e.x, ty: e.y, color: 'magenta', width: 0.3 });
        Object.assign(ev, { x: e.x, y: e.y, targetUid: e.uid });
        this.damage(e, Math.max(1, lost * (e.boss ? 0.05 : 0.2)), t, F_TRUE);
        break;
      }
      case 'eraser_a': {
        const seen = new Set<number>();
        for (const path of this.currentPaths()) {
          for (const c of path) {
            const i = c.y * s.grid.cols + c.x;
            if (seen.has(i)) continue;
            seen.add(i);
            this.addZone('fullcorrect', 'rect', c.x, c.y, { w: 1, h: 1, until: now + a.duration, vuln: 0.25, slow: 0.2, towerUid: t.uid });
          }
        }
        Object.assign(ev, { x: tx, y: ty });
        break;
      }
      case 'eraser_b': {
        const e = this.pickEnemy(cmd, (o) => o.elite && !o.boss && o.affixes.length > 0);
        if (!e) return { ok: false, reason: '请选择一个精英敌人' };
        this.stripAffixes(e);
        Object.assign(ev, { x: e.x, y: e.y, targetUid: e.uid });
        break;
      }
      case 'ruler_a': {
        let axis = cmd.axis;
        let line = cmd.index;
        if (line === undefined && cmd.x !== undefined && cmd.y !== undefined) {
          axis = axis ?? 'row';
          line = axis === 'row' ? Math.floor(cmd.y) : Math.floor(cmd.x);
        }
        if (axis !== 'row' && axis !== 'col') axis = 'row';
        if (line === undefined || !Number.isFinite(line)) return { ok: false, reason: '请选择一行或一列' };
        const list: Enemy[] = [];
        for (const e0 of s.enemies) {
          const e = e0 as Enemy;
          if (e.dead || e.flying) continue;
          const v = axis === 'row' ? e.y : e.x;
          if (v >= line - e.radius && v <= line + 1 + e.radius) list.push(e);
        }
        for (const e of list) this.knockback(e, 2);
        Object.assign(ev, { axis, index: line });
        break;
      }
      case 'ruler_b': {
        const e = this.pickEnemy(cmd, () => true);
        if (!e) return { ok: false, reason: '请选择一个敌人' };
        e.measuredUntil = now + a.duration;
        Object.assign(ev, { x: e.x, y: e.y, targetUid: e.uid });
        break;
      }
      case 'pen_a': {
        if (cmd.x === undefined || cmd.y === undefined) return { ok: false, reason: '请选择位置' };
        const cx = Math.max(1, Math.min(s.grid.cols - 2, Math.floor(cmd.x)));
        const cy = Math.max(1, Math.min(s.grid.rows - 2, Math.floor(cmd.y)));
        this.addZone('inkcross', 'rect', cx - 1, cy, { w: 3, h: 1, until: now + a.duration, ink: 1, towerUid: t.uid, air: true });
        this.addZone('inkcross', 'rect', cx, cy - 1, { w: 1, h: 3, until: now + a.duration, ink: 1, towerUid: t.uid, air: true });
        Object.assign(ev, { x: cx + 0.5, y: cy + 0.5, r: 1.5 });
        break;
      }
      case 'pen_b': {
        const list = (s.enemies as Enemy[]).filter((e) => !e.dead && e.redUntil > now);
        for (const e of list) {
          if (e.dead) continue;
          this.damage(e, e.maxHp * 0.1, t, F_TRUE);
        }
        Object.assign(ev, { x: tx, y: ty });
        break;
      }
      case 'calculator_b': {
        const o = cmd.targetUid !== undefined ? (s.towers.get(cmd.targetUid) as Tower | undefined) : undefined;
        if (!o || o.id === 'wall') return { ok: false, reason: '请选择光环里的一座塔' };
        const dx = o.cx - t.cx;
        const dy = o.cy - t.cy;
        if (o !== t && dx * dx + dy * dy > t.aura * t.aura + 1e-6) return { ok: false, reason: '这座塔不在光环里' };
        if (o.level >= 10) {
          if (!this.canEvolveKind(o) || o.stars >= 3) return { ok: false, reason: '这座塔已经满星' };
          if (o.stars === 2 && o.evoXp >= o.evoXpNext) return { ok: false, reason: '进化经验已满' };
          o.evoXp += 0.5 * o.evoXpNext;
          this.processEvoXp(o);
        } else {
          if (o.level >= 9) return { ok: false, reason: '速算最多升到 Lv9' };
          const oldTier = o.tier;
          o.level++;
          this.afterLevelChange(o);
          o.xp = Math.min(o.xp, o.xpNext);
          this.emit({ type: 'levelUp', uid: o.uid, level: o.level, tier: o.tier, tierChanged: o.tier !== oldTier, byXp: false });
        }
        Object.assign(ev, { x: o.cx + 0.5, y: o.cy + 0.5, targetUid: o.uid });
        break;
      }
      case 'piggy_a': {
        const g = this.piggyOutput(t) * 3;
        this.addGold(g, 'piggy', tx, ty);
        t.piggyMute = 2;
        t.abilityCharges = 0;
        t.piggyCharge = 0;
        Object.assign(ev, { x: tx, y: ty });
        break;
      }
      case 'piggy_b':
        this.vaultUntil = Math.max(this.vaultUntil, now + a.duration);
        Object.assign(ev, { x: tx, y: ty });
        break;
      default:
        return { ok: false, reason: '未知能力' };
    }
    if (!a.chargeWaves) t.abilityCd = a.cd;
    if (!t.attacked) {
      t.attacked = true;
      t.undoUntil = 0;
    }
    this.emit(ev);
    return { ok: true };
  }

  /** 橡皮旋风「擦除」：抹掉全部词缀并撤销其数值影响 */
  private stripAffixes(e: Enemy): void {
    const def = ENEMIES[e.id];
    if (e.affixes.includes('hard')) e.armor = Math.max(0, e.armor - 3);
    if (e.affixes.includes('swift')) e.baseSpeed /= 1.35;
    if (e.affixes.includes('shield')) e.shield = Math.min(e.shield, def.shieldRatio ? e.maxShield : 0);
    e.affixes = [];
    e.elite = false;
    e.unstoppable = !!def.unstoppable;
    e.permStealth = !!def.stealthy;
    e.reflect = false;
    this.emit({ type: 'pulse', x: e.x, y: e.y, r: 0.6, color: 'magenta' });
  }

  // ───────────────────────── 自动波次（文档 09 §4） ─────────────────────────

  private tickAutoWave(): void {
    const s = this.state;
    const au = s.autoWave;
    if (!au.enabled || !au.started) return;
    if (s.phase !== 'build' && s.phase !== 'wave') return;
    const next = s.wave + 1;
    if (s.totalWaves > 0 && next > s.totalWaves) {
      au.nextAt = null;
      au.deadline = null;
      au.blocked = false;
      return;
    }
    if (au.nextAt === null) {
      const aw = this.lastStarted;
      const spawned = !aw || aw.idx >= aw.plan.entries.length;
      if (spawned) au.nextAt = s.time + this.autoGap(next);
      if (au.deadline !== null) {
        if (au.nextAt !== null) au.nextAt = Math.min(au.nextAt, au.deadline);
        else if (s.time >= au.deadline) au.nextAt = s.time;
      }
      if (au.nextAt === null) return;
    }
    const left = au.nextAt - s.time;
    for (const k of [3, 2, 1]) {
      if (left <= k + 1e-9 && this.autoLastSecond > k && left > k - 1) {
        this.autoLastSecond = k;
        this.emit({ type: 'autoWave', secondsLeft: k });
      }
    }
    if (left > 1e-9) return;
    if (this.active.length >= MAX_CONCURRENT_WAVES) {
      au.blocked = true;
      return;
    }
    au.blocked = false;
    if (this.startWave(true).ok) this.updatePreview();
  }

  // ───────────────────────── 事件导演（文档 09 §3） ─────────────────────────

  private rollEventGap(w: number): number {
    const r = this.state.params.eventRate;
    if (!(r > 0)) return Infinity;
    const g = EVENT_DIRECTOR.gapMin + this.evRng.next() * (EVENT_DIRECTOR.gapMax - EVENT_DIRECTOR.gapMin);
    return w + Math.max(1, Math.round(g / r));
  }

  private eventEnabled(id: RandomEventId): boolean {
    return this.state.opts.events?.[id] !== false;
  }

  /** 开波时：到了时间表上的波次就安排一个事件（开波后若干秒触发） */
  private scheduleEvents(w: number): void {
    if (w < this.nextEventWave) return;
    this.nextEventWave = this.rollEventGap(w);
    const at = this.state.time + EVENT_DIRECTOR.offsetMin + this.evRng.next() * (EVENT_DIRECTOR.offsetMax - EVENT_DIRECTOR.offsetMin);
    this.pendingEvents.push({ id: null, at, wave: w });
  }

  private tickEvents(): void {
    const s = this.state;
    const now = s.time;
    if (this.pendingEvents.length) {
      for (let i = 0; i < this.pendingEvents.length; i++) {
        const pe = this.pendingEvents[i];
        if (pe.at > now) continue;
        this.pendingEvents.splice(i, 1);
        i--;
        this.triggerEvent(pe.wave, pe.id);
      }
    }
    if (s.events.length) {
      for (const ev of s.events) {
        if (ev.phase === 'warn' && now >= ev.startsAt) this.startEvent(ev);
        if (ev.phase === 'active' && now >= ev.endsAt) this.endEvent(ev);
      }
      if (s.events.some((e) => e.phase === 'done' && now - e.endsAt > EVENT_DIRECTOR.keepDone)) {
        s.events = s.events.filter((e) => !(e.phase === 'done' && now - e.endsAt > EVENT_DIRECTOR.keepDone));
      }
    }
    if (s.pickups.length) {
      let w = 0;
      for (let i = 0; i < s.pickups.length; i++) {
        const p = s.pickups[i];
        if (p.until <= now) this.emit({ type: 'pickup', uid: p.uid, kind: p.kind, x: p.x, y: p.y, phase: 'expire' });
        else s.pickups[w++] = p;
      }
      s.pickups.length = w;
    }
  }

  /** 选一个事件并进入预警；forced 用于测试 / 调试 */
  private triggerEvent(w: number, forced: RandomEventId | null = null): void {
    const s = this.state;
    const busy = new Set<string>();
    for (const ev of s.events) if (ev.phase !== 'done') for (const tag of RANDOM_EVENTS[ev.id].tags) busy.add(tag);
    const cands = RANDOM_EVENT_IDS.filter((id) => {
      const d = RANDOM_EVENTS[id];
      if (forced) return id === forced;
      if (!this.eventEnabled(id) || d.minWave > w) return false;
      const last = this.eventLastWave.get(id);
      if (last !== undefined && w - last < d.cooldown) return false;
      return !d.tags.some((tag) => busy.has(tag));
    });
    if (!cands.length) return;
    const r = this.evRng.next();
    const want = r < s.params.eventHostile ? 'bad' : this.evRng.next() < EVENT_DIRECTOR.goodShare ? 'good' : 'neutral';
    let pool = cands.filter((id) => RANDOM_EVENTS[id].tone === want);
    if (!pool.length) pool = cands.slice();
    while (pool.length) {
      const i = this.evRng.weighted(pool.map((id) => RANDOM_EVENTS[id].weight));
      const id = pool[i];
      if (this.beginEvent(id, w)) return;
      pool.splice(i, 1);
    }
  }

  /** 调试 / 测试：立即安排一个事件（不写入指令记录，不影响回放之外的状态） */
  forceEvent(id: RandomEventId): boolean {
    const n = this.state.events.length;
    this.triggerEvent(Math.max(1, this.state.wave), id);
    return this.state.events.length > n;
  }

  private beginEvent(id: RandomEventId, w: number): boolean {
    const s = this.state;
    const d = RANDOM_EVENTS[id];
    const now = s.time;
    const warn = d.warn === 'drop' ? s.params.dropWarn : d.warn;
    const fx: EventFx = {};
    let area: RandomEventState['area'];
    const inWave = s.phase === 'wave' && this.lastStarted !== null && this.active.includes(this.lastStarted);
    switch (id) {
      case 'drop_box': {
        const drops = s.spawners.filter((k) => k.kind === 'drop').length;
        if (drops >= s.params.maxDrops) return false;
        const i = this.findDropCell();
        if (i < 0) return false;
        const cx = i % s.grid.cols;
        const cy = (i - cx) / s.grid.cols;
        const sp: SpawnerState = {
          id: `drop-${++this.dropSeq}`, name: `空降点 ${this.dropSeq}`, kind: 'drop', cells: [{ x: cx, y: cy }],
          active: false, warnUntil: now + warn, demolishCost: this.demolishCost(), icon: this.dropIcon(),
        };
        s.spawners.push(sp);
        this.reserved.set(i, 'drop');
        fx.spawner = sp.id;
        area = { x: cx, y: cy, w: 1, h: 1 };
        this.emit({ type: 'spawnerDrop', id: sp.id, x: cx, y: cy, phase: 'warn' });
        break;
      }
      case 'lamp_outage':
        if (!this.towerList.some((t) => t.id === 'lamp')) return false;
        break;
      case 'books_fall': {
        const b = this.findBooks();
        if (!b) return false;
        fx.books = b;
        area = { ...b };
        break;
      }
      case 'homework_check':
      case 'nap':
      case 'reinforce':
      case 'praise':
        if (!inWave) return false;
        break;
      case 'coffee_spill': {
        const atk = this.towerList.filter((t) => t.def.attacks);
        if (!atk.length) return false;
        const t = atk[this.evRng.int(atk.length)];
        area = {
          x: Math.max(0, Math.min(s.grid.cols - 3, t.cx - 1)),
          y: Math.max(0, Math.min(s.grid.rows - 3, t.cy - 1)), w: 3, h: 3,
        };
        fx.area = area;
        break;
      }
      case 'inspiration':
        if (!this.towerList.some((t) => this.canGainHalf(t))) return false;
        break;
      case 'supply_crate':
        if (s.pickups.some((p) => p.kind === 'crate') || s.crateChoice) return false;
        break;
      case 'tidy': {
        const td = this.findTidy();
        if (!td) return false;
        fx.tidy = td;
        area = { x: td.from.x, y: td.from.y, w: td.from.w, h: td.from.h };
        break;
      }
      case 'secret_door': {
        const g = s.grid;
        const cands = s.spawners.filter((k) => k.kind === 'hidden' && !k.active && k.cells.every((c) => {
          const i = c.y * g.cols + c.x;
          return g.cells[i] === CellKind.Empty && !this.reserved.has(i) && g.dist[i] < Infinity;
        }));
        if (!cands.length) return false;
        const sp = cands[this.evRng.int(cands.length)];
        for (const c of sp.cells) this.reserved.set(c.y * g.cols + c.x, 'door');
        fx.spawner = sp.id;
        const xs = sp.cells.map((c) => c.x);
        const ys = sp.cells.map((c) => c.y);
        area = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs) + 1, h: Math.max(...ys) - Math.min(...ys) + 1 };
        break;
      }
      default:
        break;
    }
    const ev: RandomEventState = {
      uid: this.nextUid++, id, name: d.name, desc: d.desc, tone: d.tone,
      phase: 'warn', startsAt: now + warn, endsAt: now + warn + d.duration,
    };
    if (area) ev.area = area;
    s.events.push(ev);
    this.eventFx.set(ev.uid, fx);
    this.eventLastWave.set(id, w);
    if (warn > 0) this.emitRandomEvent(ev, 'warn');
    else this.startEvent(ev);
    return true;
  }

  private emitRandomEvent(ev: RandomEventState, phase: 'warn' | 'start' | 'end'): void {
    const out: GameEvent = { type: 'randomEvent', uid: ev.uid, id: ev.id, phase, name: ev.name, desc: ev.desc, tone: ev.tone };
    if (ev.area) out.area = { ...ev.area };
    this.emit(out);
  }

  private startEvent(ev: RandomEventState): void {
    const s = this.state;
    if (ev.phase !== 'warn') return;
    ev.phase = 'active';
    const now = s.time;
    const fx = this.eventFx.get(ev.uid) ?? {};
    s.eventLog.push({ wave: s.wave, id: ev.id, name: ev.name });
    this.emitRandomEvent(ev, 'start');
    switch (ev.id) {
      case 'drop_box': {
        const sp = s.spawners.find((k) => k.id === fx.spawner);
        if (sp && !sp.active) this.landDrop(sp);
        break;
      }
      case 'lamp_outage':
        for (const t of this.towerList) {
          if (t.id !== 'lamp') continue;
          t.disabledUntil = Math.max(t.disabledUntil, ev.endsAt);
          this.emit({ type: 'towerDisabled', uid: t.uid, until: t.disabledUntil });
        }
        break;
      case 'fan':
        this.fanUntil = Math.max(this.fanUntil, ev.endsAt);
        break;
      case 'books_fall': {
        let b = fx.books && this.booksPlan(fx.books, true) ? fx.books : null;
        if (!b) {
          const alt = this.findBooks();
          if (alt && this.booksPlan(alt, true)) b = alt;
        }
        if (b) ev.area = { ...b };
        break;
      }
      case 'homework_check':
        this.homeworkUntil = Math.max(this.homeworkUntil, ev.endsAt);
        break;
      case 'coffee_spill': {
        const a = fx.area ?? ev.area;
        if (!a) break;
        for (const t of this.towerList) {
          if (t.cx < a.x || t.cy < a.y || t.cx >= a.x + a.w || t.cy >= a.y + a.h) continue;
          t.disabledUntil = Math.max(t.disabledUntil, ev.endsAt);
          this.emit({ type: 'towerDisabled', uid: t.uid, until: t.disabledUntil });
        }
        this.addZone('coffee', 'rect', a.x, a.y, { w: a.w, h: a.h, until: ev.endsAt });
        break;
      }
      case 'reinforce':
        this.addReinforce();
        break;
      case 'coins': {
        const n = 3 + this.evRng.int(3);
        const v = Math.round(3 + 0.4 * Math.max(1, s.wave));
        for (let k = 0; k < n; k++) this.spawnPickup('coin', v, ev.endsAt);
        break;
      }
      case 'inspiration': {
        const cands = this.towerList.filter((t) => this.canGainHalf(t));
        if (cands.length) {
          const t = cands[this.evRng.int(cands.length)];
          this.grantHalfLevel(t);
          this.toast(`灵感闪现：${t.def.name} 获得半级经验`, 'good');
        }
        break;
      }
      case 'nap':
        for (const e0 of s.enemies) {
          const e = e0 as Enemy;
          if (e.dead || e.flying) continue;
          if (e.boss || e.unstoppable) this.forceSlow(e, 0.5, 4);
          else this.applyStun(e, 4, true);
        }
        this.emit({ type: 'pulse', x: s.grid.cols / 2, y: s.grid.rows / 2, r: 9, color: 'cyan' });
        break;
      case 'praise':
        if (this.lastStarted) this.praiseWaves.add(this.lastStarted.plan.wave);
        break;
      case 'supply_crate':
        this.spawnPickup('crate', 0, ev.endsAt);
        break;
      case 'tidy': {
        let td = fx.tidy && this.tidyOk(fx.tidy) ? fx.tidy : null;
        if (!td) td = this.findTidy();
        if (td) {
          this.applyTidy(td);
          ev.area = { x: td.to.x, y: td.to.y, w: td.to.w, h: td.to.h };
        }
        break;
      }
      case 'wind':
        this.windUntil = Math.max(this.windUntil, ev.endsAt);
        this.windDir = this.evRng.next() < 0.5 ? -1 : 1;
        break;
      case 'secret_door': {
        const sp = s.spawners.find((k) => k.id === fx.spawner);
        if (sp) this.openHidden(sp);
        break;
      }
    }
    void now;
  }

  private endEvent(ev: RandomEventState): void {
    if (ev.phase === 'done') return;
    ev.phase = 'done';
    this.eventFx.delete(ev.uid);
    this.emitRandomEvent(ev, 'end');
  }

  private canGainHalf(t: Tower): boolean {
    if (t.id === 'wall') return false;
    if (t.level >= 10) return this.canEvolveKind(t) && t.stars < 3 && !(t.stars === 2 && t.evoXp >= t.evoXpNext);
    return !(t.level === 9 && t.xp >= t.xpNext);
  }

  /** 半级经验（灵感闪现事件） */
  private grantHalfLevel(t: Tower): void {
    if (t.level >= 10) {
      t.evoXp += 0.5 * xpForLevel(9);
      this.processEvoXp(t);
    } else if (t.level === 9) t.xp = Math.min(t.xpNext, t.xp + 0.5 * t.xpNext);
    else {
      t.xp += 0.5 * t.xpNext;
      this.processXpLevels(t);
    }
  }

  /** 敌军增援：给最近开始的一波追加一组敌人，从随机出生点出来 */
  private addReinforce(): void {
    const aw = this.lastStarted;
    if (!aw || !this.active.includes(aw)) return;
    const counts = new Map<EnemyId, number>();
    let total = 0;
    let tmpl: SpawnEntry | null = null;
    for (const e of aw.plan.entries) {
      if (e.gi < 0) continue;
      counts.set(e.enemy, (counts.get(e.enemy) ?? 0) + 1);
      total++;
    }
    let enemy: EnemyId = 'crumb';
    let best = -1;
    for (const [k, v] of counts) if (v > best) { best = v; enemy = k; }
    for (const e of aw.plan.entries) if (e.enemy === enemy && e.gi >= 0) { tmpl = e; break; }
    const n = Math.max(3, Math.min(30, Math.round(total * 0.3)));
    const { open, drops } = this.spawnSlots(aw.plan.wave);
    const slots = [...open, ...drops];
    const from = slots.length ? slots[this.evRng.weighted(slots.map((x) => x.weight))].id : undefined;
    const gi = aw.plan.groupSpawn.length;
    aw.plan.groupSpawn.push({ mode: 'fixed', from });
    const ivl = ENEMIES[enemy].interval * 0.8;
    const add: SpawnEntry[] = [];
    for (let j = 0; j < n; j++) {
      const at = aw.t + 0.5 + j * ivl;
      add.push({
        at, at0: at, enemy, entrance: 0, elite: false, affixes: [], group: tmpl?.group ?? 1, hpMul: tmpl?.hpMul ?? 1, gi, spawner: from,
      });
    }
    const tail = aw.plan.entries.splice(aw.idx).concat(add).sort((a, b) => a.at - b.at);
    aw.plan.entries.push(...tail);
    this.toast(`敌军增援：${ENEMIES[enemy].name} ×${n}`, 'warn');
  }

  // ───────────────────────── 掉落物 ─────────────────────────

  private spawnPickup(kind: 'coin' | 'crate', value: number, until: number): void {
    const s = this.state;
    const g = s.grid;
    const cands: number[] = [];
    for (let i = 0; i < g.cells.length; i++) if (g.cells[i] === CellKind.Empty || g.cells[i] === CellKind.Tower) cands.push(i);
    if (!cands.length) return;
    const i = cands[this.evRng.int(cands.length)];
    const x = (i % g.cols) + 0.5 + (this.evRng.next() - 0.5) * 0.3;
    const y = Math.floor(i / g.cols) + 0.5 + (this.evRng.next() - 0.5) * 0.3;
    const p = { uid: this.nextUid++, kind, x, y, until, value };
    s.pickups.push(p);
    this.emit({ type: 'pickup', uid: p.uid, kind, x, y, phase: 'spawn', value });
  }

  private cmdCollect(uid: number): CommandResult {
    const s = this.state;
    const i = s.pickups.findIndex((p) => p.uid === uid);
    if (i < 0) return { ok: false, reason: '已经消失了' };
    const p = s.pickups[i];
    if (p.kind === 'crate' && s.crateChoice) return { ok: false, reason: '先选择上一个补给箱里的奖励' };
    s.pickups.splice(i, 1);
    if (p.kind === 'coin') {
      const got = this.addGold(p.value, 'pickup', p.x, p.y);
      this.emit({ type: 'pickup', uid, kind: 'coin', x: p.x, y: p.y, phase: 'collect', value: got });
    } else {
      const rng = new Rng(`${s.seed}|crate|${uid}`);
      const pool = CRATE_OPTIONS.slice();
      const options: { id: string; name: string; desc: string }[] = [];
      while (options.length < 3 && pool.length) options.push({ ...pool.splice(rng.int(pool.length), 1)[0] });
      s.crateChoice = { uid, options };
      this.emit({ type: 'pickup', uid, kind: 'crate', x: p.x, y: p.y, phase: 'collect' });
    }
    return { ok: true };
  }

  private cmdChooseCrate(option: string): CommandResult {
    const s = this.state;
    const cc = s.crateChoice;
    if (!cc) return { ok: false, reason: '没有待选择的补给' };
    const opt = cc.options.find((o) => o.id === option);
    if (!opt) return { ok: false, reason: '没有这个选项' };
    switch (opt.id) {
      case 'gold':
        this.addGold(40 + 4 * Math.max(1, s.wave), 'pickup');
        break;
      case 'lives':
        s.lives += 2;
        s.maxLives = Math.max(s.maxLives, s.lives);
        break;
      case 'cooldown':
        for (const sk of s.skills) {
          if (sk.id === 'relocate') continue;
          sk.cd = 0;
          sk.ready = true;
        }
        break;
      case 'xp':
        for (const t of this.towerList) {
          if (t.id === 'wall') continue;
          if (t.level >= 10) {
            if (t.stars < 3 && t.evoXpNext > 0) {
              t.evoXp += 0.2 * t.evoXpNext;
              this.processEvoXp(t);
            }
          } else if (t.level === 9) t.xp = Math.min(t.xpNext, t.xp + 0.2 * t.xpNext);
          else {
            t.xp += 0.2 * t.xpNext;
            this.processXpLevels(t);
          }
        }
        break;
      case 'caffeine':
        s.caffeineUntil = Math.max(s.caffeineUntil, s.time + 10);
        break;
      case 'charge': {
        const sk = s.skills.find((k) => k.id === 'relocate');
        if (sk) {
          sk.charges = Math.min((sk.maxCharges ?? 2) + 1, (sk.charges ?? 0) + 1);
          sk.ready = true;
        } else this.addGold(30, 'pickup');
        break;
      }
    }
    s.crateChoice = null;
    this.toast(`补给：${opt.name}`, 'good');
    return { ok: true };
  }

  // ───────────────────────── 空降出生点（文档 09 §2） ─────────────────────────

  private demolishCost(): number {
    return DROP.demolishBase + DROP.demolishPerWave * Math.max(1, this.state.wave);
  }

  private dropIcon(): EnemyId {
    const groups = this.state.nextWave.groups.filter((g) => !ENEMIES[g.enemy].boss);
    if (!groups.length) return 'crumb';
    return groups[this.evRng.int(groups.length)].enemy;
  }

  private isHiddenCell(i: number): boolean {
    const g = this.state.grid;
    const x = i % g.cols;
    const y = (i - x) / g.cols;
    for (const sp of this.state.spawners) if (sp.kind === 'hidden' && sp.cells.some((c) => c.x === x && c.y === y)) return true;
    return false;
  }

  /** 空降点候选：空地、离出口 ≥ 5 格、周围 1 格内没有塔、落地后所有出生点与敌人仍可达 */
  private findDropCell(exclude = -1): number {
    const s = this.state;
    const g = s.grid;
    const cands: number[] = [];
    for (let i = 0; i < g.cells.length; i++) {
      if (i === exclude || g.cells[i] !== CellKind.Empty || this.reserved.has(i) || !(g.dist[i] < Infinity) || this.isHiddenCell(i)) continue;
      const x = i % g.cols;
      const y = (i - x) / g.cols;
      let near = false;
      for (const ex of g.exits) if (Math.hypot(ex.x - x, ex.y - y) < DROP.minExitDist) near = true;
      if (near) continue;
      for (let k = 0; k < 8 && !near; k++) {
        const nx = x + N8X[k];
        const ny = y + N8Y[k];
        if (nx < 0 || ny < 0 || nx >= g.cols || ny >= g.rows) continue;
        if (g.towerAt[ny * g.cols + nx]) near = true;
      }
      if (near) continue;
      cands.push(i);
    }
    for (let k = cands.length - 1; k > 0; k--) {
      const j = this.evRng.int(k + 1);
      const t = cands[k];
      cands[k] = cands[j];
      cands[j] = t;
    }
    for (let k = 0; k < Math.min(40, cands.length); k++) {
      const i = cands[k];
      const tmp = this.tempCells(-1, -1);
      tmp[i] = CellKind.Obstacle;
      if (this.validate(tmp, this.distScratch) !== 0) continue;
      if (this.exitStep(i, tmp, this.distScratch) < 0) continue;
      return i;
    }
    return -1;
  }

  /** 落地：占格、推开 3×3 内的敌人、重算流场、开始出怪 */
  private landDrop(sp: SpawnerState): void {
    const s = this.state;
    const g = s.grid;
    let c = sp.cells[0];
    let i = c.y * g.cols + c.x;
    this.reserved.delete(i);
    const tmp = this.tempCells(-1, -1);
    tmp[i] = CellKind.Obstacle;
    const ok = g.cells[i] === CellKind.Empty && this.validate(tmp, this.distScratch) === 0 && this.exitStep(i, tmp, this.distScratch) >= 0;
    if (!ok) {
      // 原落点不再可行（极少见）：换一个候选点
      const alt = this.findDropCell(i);
      if (alt < 0) {
        this.closeDrop(sp, 'close');
        return;
      }
      i = alt;
      c = { x: i % g.cols, y: Math.floor(i / g.cols) };
      sp.cells = [c];
    }
    g.cells[i] = CellKind.Obstacle;
    sp.active = true;
    const waves = DROP.minWaves + this.evRng.int(DROP.maxWaves - DROP.minWaves + 1);
    sp.expiresAfterWave = s.wave + waves;
    sp.demolishCost = this.demolishCost();
    this.dropRatio.set(sp.id, Math.round((DROP.ratioMin + this.evRng.next() * (DROP.ratioMax - DROP.ratioMin)) * 100) / 100);
    this.pushEnemies(c.x + 0.5, c.y + 0.5);
    this.terrainChanged();
    this.fixEnemies();
    this.spawnersChanged();
    this.emit({ type: 'spawnerDrop', id: sp.id, x: c.x, y: c.y, phase: 'land' });
    this.emit({ type: 'terrainChanged', reason: 'drop' });
  }

  /** 落地冲击：3×3 内的地面敌人向外推开（不越过当前路段） */
  private pushEnemies(x: number, y: number): void {
    for (const e0 of this.state.enemies) {
      const e = e0 as Enemy;
      if (e.dead || e.flying) continue;
      const dx = e.x - x;
      const dy = e.y - y;
      if (Math.abs(dx) > 1.5 || Math.abs(dy) > 1.5) continue;
      const d = Math.hypot(dx, dy) || 1;
      const x0 = Math.min(e.ccx, e.tcx) + 0.1;
      const x1 = Math.max(e.ccx, e.tcx) + 0.9;
      const y0 = Math.min(e.ccy, e.tcy) + 0.1;
      const y1 = Math.max(e.ccy, e.tcy) + 0.9;
      e.x = Math.max(x0, Math.min(x1, e.x + (dx / d) * 0.35));
      e.y = Math.max(y0, Math.min(y1, e.y + (dy / d) * 0.35));
    }
  }

  private closeDrop(sp: SpawnerState, reason: 'close' | 'demolish'): void {
    const s = this.state;
    const g = s.grid;
    const c = sp.cells[0];
    const i = c.y * g.cols + c.x;
    if (this.reserved.get(i) === 'drop') this.reserved.delete(i);
    const landed = sp.active;
    const k = s.spawners.indexOf(sp);
    if (k >= 0) s.spawners.splice(k, 1);
    this.dropRatio.delete(sp.id);
    if (landed && g.cells[i] === CellKind.Obstacle) {
      g.cells[i] = CellKind.Empty;
      this.terrainChanged();
    }
    this.spawnersChanged();
    this.emit({ type: 'spawnerDrop', id: sp.id, x: c.x, y: c.y, phase: reason });
    if (landed) this.emit({ type: 'terrainChanged', reason: 'drop' });
    // 还在预警的空降事件随之结束
    for (const ev of s.events) {
      if (ev.phase === 'warn' && this.eventFx.get(ev.uid)?.spawner === sp.id) {
        ev.endsAt = s.time;
        this.endEvent(ev);
      }
    }
  }

  private cmdDemolish(id: string): CommandResult {
    const s = this.state;
    if (s.phase === 'perk') return { ok: false, reason: '请先选择增益' };
    const sp = s.spawners.find((k) => k.id === id);
    if (!sp || sp.kind !== 'drop') return { ok: false, reason: '只能拆除空降出生点' };
    if (!sp.active) return { ok: false, reason: '纸箱还没落地' };
    const cost = this.demolishCost();
    if (s.gold < cost) return { ok: false, reason: '金币不足' };
    this.spendGold(cost);
    this.closeDrop(sp, 'demolish');
    return { ok: true };
  }

  // ───────────────────────── 暗门（隐藏出生点） ─────────────────────────

  private openHidden(sp: SpawnerState): void {
    const s = this.state;
    const g = s.grid;
    for (const c of sp.cells) this.reserved.delete(c.y * g.cols + c.x);
    if (sp.cells.some((c) => g.cells[c.y * g.cols + c.x] !== CellKind.Empty)) return;
    for (const c of sp.cells) g.cells[c.y * g.cols + c.x] = CellKind.Spawn;
    sp.active = true;
    sp.expiresAfterWave = s.wave + 3;
    this.terrainChanged();
    this.spawnersChanged();
    this.emit({ type: 'terrainChanged', reason: 'event' });
    this.toast(`暗门开启：${sp.name ?? sp.id}`, 'warn');
  }

  private closeHidden(sp: SpawnerState): void {
    const g = this.state.grid;
    for (const c of sp.cells) {
      const i = c.y * g.cols + c.x;
      if (g.cells[i] === CellKind.Spawn) g.cells[i] = CellKind.Empty;
    }
    sp.active = false;
    delete sp.expiresAfterWave;
    this.terrainChanged();
    this.spawnersChanged();
    this.emit({ type: 'terrainChanged', reason: 'event' });
  }

  // ───────────────────────── 书本倒下 / 桌面整理 ─────────────────────────

  private enemyOnCell(i: number): boolean {
    const g = this.state.grid;
    for (const e0 of this.state.enemies) {
      const e = e0 as Enemy;
      if (e.dead || e.flying) continue;
      if (e.ccy * g.cols + e.ccx === i || e.tcy * g.cols + e.tcx === i) return true;
    }
    return false;
  }

  private findBooks(): { x: number; y: number; w: number; h: number } | null {
    const g = this.state.grid;
    for (let tries = 0; tries < 60; tries++) {
      const horiz = this.evRng.next() < 0.5;
      const w = horiz ? 3 : 1;
      const h = horiz ? 1 : 3;
      const x0 = this.evRng.int(g.cols - w + 1);
      const y0 = this.evRng.int(g.rows - h + 1);
      const rect = { x: x0, y: y0, w, h };
      let ok = true;
      for (let y = y0; y < y0 + h && ok; y++) for (let x = x0; x < x0 + w; x++) {
        const i = y * g.cols + x;
        const k = g.cells[i];
        if ((k !== CellKind.Empty && k !== CellKind.Tower) || this.reserved.has(i) || this.isHiddenCell(i)) { ok = false; break; }
      }
      if (ok && this.booksPlan(rect, false)) return rect;
    }
    return null;
  }

  /**
   * 书本落下的可行性（commit = true 时执行）：三格变成障碍；压到的塔推到最近的空格（等级保留），
   * 任何时候都不能堵死出生点或困住敌人。
   */
  private booksPlan(rect: { x: number; y: number; w: number; h: number }, commit: boolean): boolean {
    const s = this.state;
    const g = s.grid;
    const tmp = new Uint8Array(this.tempCells(-1, -1));
    const hit: Tower[] = [];
    for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) {
      const i = y * g.cols + x;
      const k = g.cells[i];
      if ((k !== CellKind.Empty && k !== CellKind.Tower) || this.reserved.has(i)) return false;
      if (k === CellKind.Tower) {
        const t = s.towers.get(g.towerAt[i]) as Tower | undefined;
        if (t) hit.push(t);
      }
      tmp[i] = CellKind.Obstacle;
    }
    const d = new Float32Array(g.cells.length);
    if (this.validate(tmp, d) !== 0) return false;
    const moves: { t: Tower; x: number; y: number }[] = [];
    for (const t of hit) {
      const order: number[] = [];
      for (let i = 0; i < tmp.length; i++) if (tmp[i] === CellKind.Empty && !this.reserved.has(i)) order.push(i);
      const dd = (i: number) => {
        const x = i % g.cols;
        const y = (i - x) / g.cols;
        return (x - t.cx) * (x - t.cx) + (y - t.cy) * (y - t.cy);
      };
      order.sort((a, b) => dd(a) - dd(b) || a - b);
      let placed = -1;
      for (const i of order) {
        if (this.enemyOnCell(i)) continue;
        tmp[i] = CellKind.Tower;
        if (this.validate(tmp, d) === 0) { placed = i; break; }
        tmp[i] = CellKind.Empty;
      }
      if (placed < 0) return false;
      moves.push({ t, x: placed % g.cols, y: Math.floor(placed / g.cols) });
    }
    if (!commit) return true;
    for (const m of moves) {
      const fx = m.t.cx;
      const fy = m.t.cy;
      this.moveTowerTo(m.t, m.x, m.y);
      this.emit({ type: 'towerMoved', uid: m.t.uid, fromX: fx, fromY: fy, cx: m.x, cy: m.y });
    }
    for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) {
      const i = y * g.cols + x;
      g.cells[i] = CellKind.Obstacle;
      g.towerAt[i] = 0;
    }
    g.obstacles.push({ kind: 'books', x: rect.x, y: rect.y, w: rect.w, h: rect.h });
    this.terrainChanged();
    this.fixEnemies();
    this.emit({ type: 'terrainChanged', reason: 'event' });
    return true;
  }

  private findTidy(): { from: Obstacle; to: Obstacle } | null {
    const g = this.state.grid;
    const pieces = g.obstacles.filter((o) => !this.landmarkKeys.has(`${o.kind}@${o.x},${o.y}`));
    if (!pieces.length) return null;
    const from = pieces[this.evRng.int(pieces.length)];
    for (let tries = 0; tries < 60; tries++) {
      const rot = from.w !== from.h && this.evRng.next() < 0.5;
      const w = rot ? from.h : from.w;
      const h = rot ? from.w : from.h;
      const to: Obstacle = { kind: from.kind, x: this.evRng.int(g.cols - w + 1), y: this.evRng.int(g.rows - h + 1), w, h };
      if (to.x === from.x && to.y === from.y) continue;
      const td = { from, to };
      if (this.tidyOk(td)) return td;
    }
    return null;
  }

  private inRect(o: { x: number; y: number; w: number; h: number }, x: number, y: number): boolean {
    return x >= o.x && y >= o.y && x < o.x + o.w && y < o.y + o.h;
  }

  /** 整理后的位置：空地（或原位置）、离出生点 / 出口至少 1 格、通过可达性校验 */
  private tidyOk(td: { from: Obstacle; to: Obstacle }): boolean {
    const s = this.state;
    const g = s.grid;
    if (!g.obstacles.includes(td.from)) return false;
    const special: { x: number; y: number }[] = [...g.exits];
    for (const sp of s.spawners) special.push(...sp.cells);
    const { to } = td;
    for (let y = to.y; y < to.y + to.h; y++) for (let x = to.x; x < to.x + to.w; x++) {
      const i = y * g.cols + x;
      const own = this.inRect(td.from, x, y);
      if (!own && (g.cells[i] !== CellKind.Empty || this.reserved.has(i) || this.isHiddenCell(i) || this.enemyOnCell(i))) return false;
      for (const c of special) if (Math.abs(c.x - x) <= 1 && Math.abs(c.y - y) <= 1) return false;
    }
    const tmp = new Uint8Array(this.tempCells(-1, -1));
    for (let y = td.from.y; y < td.from.y + td.from.h; y++) for (let x = td.from.x; x < td.from.x + td.from.w; x++) tmp[y * g.cols + x] = CellKind.Empty;
    for (let y = to.y; y < to.y + to.h; y++) for (let x = to.x; x < to.x + to.w; x++) tmp[y * g.cols + x] = CellKind.Obstacle;
    return this.validate(tmp, this.distScratch) === 0;
  }

  private applyTidy(td: { from: Obstacle; to: Obstacle }): void {
    const g = this.state.grid;
    const { from, to } = td;
    for (let y = from.y; y < from.y + from.h; y++) for (let x = from.x; x < from.x + from.w; x++) g.cells[y * g.cols + x] = CellKind.Empty;
    for (let y = to.y; y < to.y + to.h; y++) for (let x = to.x; x < to.x + to.w; x++) g.cells[y * g.cols + x] = CellKind.Obstacle;
    const k = g.obstacles.indexOf(from);
    if (k >= 0) g.obstacles[k] = { ...to };
    this.terrainChanged();
    this.fixEnemies();
    this.emit({ type: 'terrainChanged', reason: 'tidy' });
  }

  // ───────────────────────── 塔信息 ─────────────────────────

  private buildTowerInfo(t: Tower): TowerInfo {
    const d = t.def;
    const isWall = t.id === 'wall';
    const maxLevel = d.maxLevel;
    const evb = evoBranch(t.id, t.branch);
    const tierName = isWall
      ? [d.name === '书本墙' ? '草稿本' : d.name, d.t2.name, d.t3.name][t.level - 1]
      : t.level >= 10
        ? t.stars >= 3 && evb ? `神话·${evb.ability.form}` : `传奇·${t.branch === 'B' ? d.B.name : d.A.name}${t.stars > 0 ? ` ★${t.stars}` : ''}`
        : TIER_NAMES[t.tier - 1];
    const stats: TowerInfo['stats'] = [];
    const A = t.level >= 10 && t.branch === 'A';
    switch (t.id) {
      case 'wall': {
        const b = t.level >= 3 ? '射程 +5%，伤害 +5%' : t.level >= 2 ? '射程 +5%' : '无';
        stats.push({ label: '相邻加成', value: b });
        break;
      }
      case 'calculator': {
        const sup = 1 + EVO.support * t.stars;
        const bonus = Math.round((10 + (t.level - 1) + (t.level >= 7 ? 15 : 0)) * sup);
        stats.push({ label: '光环范围', value: `${fmt(t.aura)} 格` });
        stats.push({ label: '伤害加成', value: `+${bonus}%` });
        if (t.level >= 4) stats.push({ label: '攻速加成', value: `+${fmt(8 * sup)}%` });
        if (t.level >= 7) stats.push({ label: '射程加成', value: '+0.3 格' });
        stats.push({ label: '经验分成', value: '10%' });
        break;
      }
      case 'piggy': {
        stats.push({ label: '每波产出', value: `+${this.piggyOutput(t)} 金币${t.piggyMute > 0 ? `（停产 ${t.piggyMute} 波）` : ''}` });
        if (t.level >= 4) stats.push({ label: '利息上限', value: this.evo(t, 'A', 1) ? '+15' : '+5' });
        break;
      }
      default: {
        if (t.id === 'lamp' && A) stats.push({ label: '持续伤害', value: `${fmt(t.dmg)}/秒（递增 25%/秒）` });
        else if (t.id === 'pen') stats.push({ label: '伤害', value: `${fmt(t.dmg)} + 墨迹 ${fmt(6 * t.dmgFactor * ((t.combo & C_LAMP_PEN) ? 1.3 : 1))}/秒` });
        else stats.push({ label: '伤害', value: fmt(t.dmg) });
        if (!(t.id === 'lamp' && A)) stats.push({ label: '攻击间隔', value: `${fmt(t.interval, 2)} 秒` });
        if (t.id === 'compass') stats.push({ label: '范围', value: `${fmt(t.inner)}–${fmt(t.range)} 格` });
        else stats.push({ label: '射程', value: `${fmt(t.range)} 格` });
        if (!(t.id === 'lamp' && A)) {
          let dps = t.dmg / Math.max(0.05, t.interval / t.atkMul);
          if (t.id === 'pencil' && t.level >= 7) dps *= 2;
          if (t.id === 'lamp' && t.level >= 7) dps *= 2;
          if (t.id === 'ruler' && t.level >= 7) dps *= 3;
          stats.push({ label: '秒伤', value: fmt(dps) + (t.id === 'stapler' || t.id === 'compass' || t.id === 'ruler' ? ' ×N' : '') });
        }
        if (t.critChance > 0) stats.push({ label: '暴击', value: `${Math.round(t.critChance * 100)}% ×${fmt(t.critMul)}` });
        if (t.id === 'glue') stats.push({ label: '减速', value: `${Math.round(t.slowPct * 100)}% / ${fmt(t.slowDur)} 秒` });
        if (t.id === 'stapler' && t.stunChance > 0) stats.push({ label: '眩晕概率', value: `${Math.round(t.stunChance * 100)}%` });
        if (t.id === 'pen') stats.push({ label: '墨迹层数', value: `最多 ${t.inkMax} 层` });
        if (t.id === 'eraser') stats.push({ label: '破甲', value: `每次 −${t.level >= 7 ? 2 : 1}` });
        if (t.pierce > 0) stats.push({ label: '穿甲', value: `无视 ${t.pierce} 点护甲` });
      }
    }
    const traits: TowerInfo['traits'] = [];
    if (isWall) {
      traits.push({ name: d.t2.name, desc: d.t2.desc, unlockLevel: 2, unlocked: t.level >= 2 });
      traits.push({ name: d.t3.name, desc: d.t3.desc, unlockLevel: 3, unlocked: t.level >= 3 });
    } else {
      traits.push({ name: d.t2.name, desc: d.t2.desc, unlockLevel: 4, unlocked: t.level >= 4 });
      traits.push({ name: d.t3.name, desc: d.t3.desc, unlockLevel: 7, unlocked: t.level >= 7 });
      if (t.level >= 10 && t.branch) {
        const br = t.branch === 'A' ? d.A : d.B;
        traits.push({ name: `传奇·${br.name}`, desc: br.desc, unlockLevel: 10, unlocked: true });
      }
    }
    for (let ci = 0; ci < COMBOS.length; ci++) {
      const cb = COMBOS[ci];
      if (cb.a !== t.id && cb.b !== t.id) continue;
      traits.push({ name: `组合·${cb.name}`, desc: cb.desc, unlockLevel: 1, unlocked: (t.combo & (1 << ci)) !== 0 });
    }
    const cost = this.upgradeCost(t);
    const modes = this.targetModes(t);
    const evoCost = this.evolveCost(t);
    const evoTraits: TraitLine[] = [];
    if (evb) {
      evoTraits.push({ name: `★1 ${evb.s1.name}`, desc: evb.s1.desc, unlockLevel: 11, unlocked: t.stars >= 1 });
      evoTraits.push({ name: `★2 ${evb.s2.name}`, desc: evb.s2.desc, unlockLevel: 12, unlocked: t.stars >= 2 });
    }
    const info: TowerInfo = {
      uid: t.uid, id: t.id, name: d.name, level: t.level, maxLevel, tier: t.tier, tierName,
      branch: t.branch, xp: Math.floor(t.xp), xpNext: t.xpNext,
      xpCapped: !isWall && ((t.level === 9 && t.xp >= t.xpNext) || (t.level >= 10 && (!evb || t.stars >= 3 || (t.stars === 2 && t.evoXp >= t.evoXpNext)))),
      stars: t.stars, evoXp: Math.floor(t.evoXp), evoXpNext: t.evoXpNext,
      evolveCost: evoCost, evolveDiscount: this.evoDiscount(t),
      canAffordEvolve: evoCost !== null && this.state.gold >= evoCost,
      evoTraits,
      stats, traits,
      range: d.attacks ? t.range : 0,
      upgradeCost: cost,
      upgradeDiscount: this.xpDiscount(t),
      needsBranch: !isWall && t.level === 9,
      canAffordUpgrade: cost !== null && this.state.gold >= cost,
      sellValue: this.sellValue(t),
      refundRate: this.canUndo(t) ? 1 : this.refundRateFor(t),
      canUndo: this.canUndo(t),
      undoRemaining: this.canUndo(t) ? Math.max(0, t.undoUntil - this.state.time) : 0,
      targetMode: modes.length ? t.targetMode : null,
      targetModes: modes,
      kills: t.kills,
      damage: Math.round(t.damage),
    };
    if (t.id === 'compass') info.innerRange = t.inner;
    if (t.id === 'calculator') info.auraRange = t.aura;
    if (t.id === 'piggy' && t.level >= 7) info.auraRange = 2.5;
    if (!isWall && d.maxLevel >= 10) info.branches = { A: { ...d.A }, B: { ...d.B } };
    if (evb) {
      const a = evb.ability;
      const ready = t.stars >= 3 && (a.chargeWaves ? (t.abilityCharges ?? 0) > 0 : t.abilityCd <= 0);
      info.ability = {
        id: a.id, name: a.name, desc: a.desc,
        cd: t.stars >= 3 ? Math.max(0, t.abilityCd) : a.cd, cdMax: a.cd, ready,
        target: a.target,
      };
      if (a.radius !== undefined) info.ability.radius = a.radius;
      if (a.chargeWaves) {
        info.ability.charges = t.stars >= 3 ? (t.abilityCharges ?? 0) : 0;
        info.ability.maxCharges = 1;
      }
    }
    return info;
  }
}

/** 状态摘要哈希（回放校验 / 测试） */
export function stateHash(w: IWorld): string {
  const s = w.state;
  let h = 2166136261 >>> 0;
  const mix = (v: number) => {
    const x = Math.round(v * 1000) | 0;
    h ^= x;
    h = Math.imul(h, 16777619) >>> 0;
  };
  mix(s.tick); mix(s.gold); mix(s.lives); mix(s.wave); mix(s.score);
  mix(s.enemies.length); mix(s.projectiles.length); mix(s.zones.length);
  for (const e of s.enemies) { mix(e.uid); mix(e.x); mix(e.y); mix(e.hp); mix(e.shield); mix(e.armor); }
  for (const t of s.towers.values()) { mix(t.uid); mix(t.cx); mix(t.cy); mix(t.level); mix(t.xp); mix(t.damage); }
  for (const p of s.projectiles) { mix(p.x); mix(p.y); }
  for (const k of s.skills) { mix(k.cd); mix(k.charges ?? 0); }
  for (const t of s.towers.values()) { mix(t.stars); mix(t.evoXp); mix(t.abilityCd); }
  for (const sp of s.spawners) { mix(sp.active ? 1 : 0); mix(sp.cells[0].x); mix(sp.cells[0].y); }
  for (const ev of s.events) { mix(ev.uid); mix(ev.startsAt); }
  for (const p of s.pickups) { mix(p.uid); mix(p.x); mix(p.y); }
  mix(s.grid.version); mix(s.autoWave.nextAt ?? -1);
  return (h >>> 0).toString(16);
}

export function createWorld(opts: RunOptions): IWorld {
  return new World(opts);
}
