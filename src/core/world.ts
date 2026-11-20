import {
  CellKind, DT, GRID_COLS, GRID_ROWS,
  type Branch, type BuildOption, type Command, type CommandResult, type EnemyId, type GameEvent,
  type IWorld, type PerkCard, type PlaceCheck, type RunOptions, type SkillId, type SkillState,
  type TargetMode, type Tier, type TowerId, type TowerInfo, type WorldState,
  TOWER_IDS, type AffixId,
} from './types';
import { Rng, makeSeed } from './rng';
import {
  armorAt, goldScale, hpScale, rawUpgradeCost, refundRate, resolveParams, speedScale, xpForLevel, xpScale,
} from './scaling';
import { computeDist, isPassableKind, nextCell, tracePath } from './flowfield';
import { generateWave, type SpawnEntry, type WavePlan } from './wavegen';
import {
  C_CALC_PIGGY, C_GLUE_STAPLER, C_LAMP_PEN, C_PENCIL_ERASER, C_RULER_COMPASS,
  F_AOE, F_BEAM, F_CRIT, F_DOT, F_IGNORE_ARMOR, F_SHIELD3, F_SKILL, F_TRUE,
  type Enemy, type Proj, type Tower, type Zone,
} from './entities';
import { COMBOS, GROWTH, PIGGY_MAX, TIER_NAMES, TOWERS, UNDO_SECONDS, WALL_UPGRADE_COST } from '../config/towers';
import { ELITE, ENEMIES } from '../config/enemies';
import { MAPS } from '../config/maps';
import { CAPS } from '../config/difficulty';
import { RELOCATE_CHARGES, RELOCATE_RECOVER_WAVES, SKILLS, SKILL_IDS, SKILL_LEVEL } from '../config/skills';
import { EPIC_LATE_WAVE, EPIC_WEIGHT_LATE, PERKS, PERK_REROLL_COST, RARITY_WEIGHT, type PerkId } from '../config/perks';
import { CAMPAIGN_WAVES } from '../config/campaign';

const MAX_PROJECTILES = 300;
const TAU = Math.PI * 2;

interface ActiveWave {
  plan: WavePlan;
  idx: number;
  t: number;
  alive: number;
  warned: boolean;
}

type DebuffKind = 'glue' | 'eraser' | 'pen';

function tierOf(level: number, isWall: boolean): Tier {
  if (isWall) return Math.max(1, Math.min(3, level)) as Tier;
  if (level >= 10) return 4;
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
  private entrances: { x: number; y: number }[][];
  private distScratch: Float32Array;
  private projPool: Proj[] = [];
  private bucketHead: Int32Array;
  private bucketNext: Int32Array = new Int32Array(512);
  private qA: Enemy[] = [];
  private qB: Enemy[] = [];
  private qC: Enemy[] = [];
  private timeMgmtUntil = 0;
  private xpGlobalMul = 1;

  constructor(opts: RunOptions) {
    const seed = opts.seed && opts.seed.length ? opts.seed : makeSeed();
    const params = resolveParams(opts);
    const pure = !!opts.pure;
    this.talents = pure ? {} : { ...(opts.talents ?? {}) };
    const tl = (id: string) => Math.max(0, this.talents[id] ?? 0);
    this.rng = new Rng(`${seed}|combat`);
    const map = MAPS[opts.map] ?? MAPS.ch1;
    this.entrances = map.entrances;
    const cols = GRID_COLS;
    const rows = GRID_ROWS;
    const cells = new Uint8Array(cols * rows);
    for (const o of map.obstacles) {
      for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++) cells[y * cols + x] = CellKind.Obstacle;
    }
    const spawns: { x: number; y: number }[] = [];
    for (const ent of map.entrances) for (const c of ent) {
      cells[c.y * cols + c.x] = CellKind.Spawn;
      spawns.push({ x: c.x, y: c.y });
    }
    for (const c of map.exits) cells[c.y * cols + c.x] = CellKind.Exit;
    const dist = new Float32Array(cols * rows);
    computeDist(cols, rows, cells, map.exits, dist);
    this.distScratch = new Float32Array(cols * rows);
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
        exits: map.exits.map((e) => ({ x: e.x, y: e.y })),
        obstacles: map.obstacles.map((o) => ({ ...o })),
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
      bossUids: [],
      stats: { kills: 0, leaks: 0, goldEarned: 0, goldSpent: 0, towersBuilt: 0, skillsCast: 0 },
    };
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
    const { cols, rows, cells, exits } = this.state.grid;
    const block = cy * cols + cx;
    const d = computeDist(cols, rows, cells, exits, this.distScratch, block);
    return this.entrances.map((ent) => tracePath(cols, rows, cells, d, ent[0].y * cols + ent[0].x, block));
  }

  currentPaths(): { x: number; y: number }[][] {
    const { cols, rows, cells, dist } = this.state.grid;
    return this.entrances.map((ent) => tracePath(cols, rows, cells, dist, ent[0].y * cols + ent[0].x));
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
    if (s.phase === 'wave') this.tickSkills(DT);
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
    const s = this.state;
    if (s.phase === 'perk') return { ok: false, reason: '请先选择增益' };
    const next = s.wave + 1;
    if (s.totalWaves > 0 && next > s.totalWaves) return { ok: false, reason: '已经是最后一波' };
    if (this.active.length >= 3) return { ok: false, reason: '同时进行的波次太多了' };
    const early = s.phase === 'wave';
    const plan = this.getPlan(next);
    s.wave = next;
    s.phase = 'wave';
    this.active.push({ plan, idx: 0, t: 0, alive: 0, warned: false });
    this.planCache.delete(next);
    if (early) {
      const bonus = this.earlyBonus(next);
      if (bonus > 0) this.addGold(bonus, 'early');
    }
    for (const t of this.towerList) t.colorGold = 0;
    this.emit({ type: 'waveStart', wave: next, tags: plan.tags.slice() });
    if (this.hasPerk('timemgmt')) {
      this.timeMgmtUntil = s.time + 1;
      for (const e of s.enemies as Enemy[]) if (!e.dead && !e.flying) this.applyStun(e, 1, true);
    }
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
        s.grid.cells[from] = CellKind.Empty;
        s.grid.towerAt[from] = 0;
        const to = cmd.cy * s.grid.cols + cmd.cx;
        s.grid.cells[to] = CellKind.Tower;
        s.grid.towerAt[to] = t.uid;
        const ox = t.cx;
        const oy = t.cy;
        t.cx = cmd.cx;
        t.cy = cmd.cy;
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
        if (t.level >= 10) t.mastery += 0.5 * eff * xpForLevel(9);
        else {
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
    for (const e0 of this.state.enemies) {
      const e = e0 as Enemy;
      if (e.dead || e.flying) continue;
      if ((e.ccx === cx && e.ccy === cy) || (e.tcx === cx && e.tcy === cy)) return { ok: false, reason: '有敌人在这里' };
    }
    const d = computeDist(g.cols, g.rows, g.cells, g.exits, this.distScratch, i, unblock);
    for (const sp of g.spawns) if (!(d[sp.y * g.cols + sp.x] < Infinity)) return { ok: false, reason: '会堵死道路' };
    for (const e0 of this.state.enemies) {
      const e = e0 as Enemy;
      if (e.dead || e.flying) continue;
      if (!(d[e.tcy * g.cols + e.tcx] < Infinity)) return { ok: false, reason: '会困住敌人' };
    }
    return { ok: true };
  }

  private terrainChanged(): void {
    const g = this.state.grid;
    computeDist(g.cols, g.rows, g.cells, g.exits, g.dist);
    g.version++;
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
      xp: 0, xpNext: id === 'wall' ? 0 : xpForLevel(1), mastery: 0, invested: cost,
      targetMode: 'first', angle: -Math.PI / 2, lastFire: -999, disabledUntil: 0,
      placedAt: s.time, undoUntil: s.time + UNDO_SECONDS, kills: 0, damage: 0, comboWith: [],
      def, cd: 0, attacked: false,
      dmg: def.damage, dmgFactor: 1, interval: def.interval, range: def.range, inner: def.inner ?? 0, aura: def.aura ?? 0,
      critChance: 0, critMul: 2, atkMul: 1, xpGainMul: 1, calcCovers: [], combo: 0,
      slowPct: 0, slowDur: 0, stunChance: 0, inkMax: 3,
      focusUid: 0, focusStacks: 0, laserUid: 0, laserTime: 0, laserAcc: 0, laserBeamT: 0,
      sweepPhase: 0, colorGold: 0, halfLegend: false, lastTape: -99,
    };
    this.statsDirty = true;
    return t;
  }

  private afterLevelChange(t: Tower): void {
    t.tier = tierOf(t.level, t.id === 'wall');
    if (t.id === 'wall') t.xpNext = 0;
    else t.xpNext = t.level >= 10 ? 0 : xpForLevel(t.level);
    this.statsDirty = true;
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
      const before = Math.floor(t.mastery / 100);
      t.mastery += a;
      if (Math.floor(t.mastery / 100) !== before && t.mastery <= 4100) this.statsDirty = true;
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
      let calcAbacus = false;
      if (d.attacks || t.id === 'piggy') {
        for (const c of calcs) {
          const ar = (c.def.aura ?? 2) + (stack ? 1 : 0);
          const dx = c.cx - t.cx;
          const dy = c.cy - t.cy;
          if (dx * dx + dy * dy > ar * ar + 1e-6) continue;
          t.calcCovers.push(c);
          if (!d.attacks) continue;
          const bonus = 0.1 + 0.01 * (c.level - 1) + (c.level >= 7 ? 0.15 : 0);
          const spd = c.level >= 4 ? 0.08 : 0;
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
          if (c.level >= 10 && c.branch === 'A') calcCrit = true;
          if (c.level >= 10 && c.branch === 'B') calcAbacus = true;
        }
      }
      t.xpGainMul = (calcAbacus ? 1.5 : 1) * (this.hasPerk('notes') ? 1.15 : 1);
      if (!d.attacks) {
        t.dmg = 0;
        t.dmgFactor = 1;
        t.interval = 0;
        t.range = 0;
        t.aura = t.id === 'calculator' ? (d.aura ?? 2) + (stack ? 1 : 0) : 0;
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
      const lvlDmg = Math.pow(GROWTH.damage, L - 1);
      let dmgMul = 1 + calcDmg + (wallLv >= 3 ? 0.05 : 0) + Math.min(0.2, (t.mastery / 100) * 0.005);
      if (t.id === 'pencil' && this.hasPerk('sharpener')) dmgMul += 0.2;
      t.dmg = baseDmg * lvlDmg * dmgMul;
      t.dmgFactor = lvlDmg * dmgMul;
      t.interval = baseIvl * Math.pow(GROWTH.interval, L - 1);
      let range = baseRange + GROWTH.range * (L - 1);
      if (t.id === 'compass' && !A) range = baseRange + GROWTH.range * (L - 1);
      range += calcRange;
      if ((t.combo & C_RULER_COMPASS) !== 0) range += 0.3;
      if ((t.id === 'ruler' || t.id === 'compass') && this.hasPerk('drafting')) range += 0.5;
      if (wallLv >= 2) range *= 1.05;
      t.range = range;
      t.inner = inner;
      t.atkMul = 1 + calcSpd;
      t.critChance = (t.id === 'pencil' && L >= 4 ? 0.15 : 0) + (calcCrit ? 0.1 : 0);
      t.critMul = 2 + (calcCrit ? 0.5 : 0);
      if (t.id === 'glue') {
        let sp = L >= 7 ? 0.55 + 0.02 * (L - 7) : 0.4 + 0.02 * (L - 1);
        let dur = 1.5;
        if (this.hasPerk('quickglue')) { sp += 0.1; dur += 0.5; }
        t.slowPct = Math.min(0.85, sp);
        t.slowDur = dur;
      }
      if (t.id === 'stapler') t.stunChance = (L >= 4 ? 0.1 : 0) + (this.hasPerk('staples') ? 0.1 : 0);
      if (t.id === 'pen') t.inkMax = (L >= 7 ? 5 : 3) + (this.hasPerk('inkplenty') ? 2 : 0);
    }
  }

  // ───────────────────────── 波次 ─────────────────────────

  private getPlan(w: number): WavePlan {
    let p = this.planCache.get(w);
    if (!p) {
      const s = this.state;
      p = generateWave({ seed: s.seed, mode: s.opts.mode, map: s.opts.map, params: s.params, entrances: this.entrances.length }, w);
      this.planCache.set(w, p);
    }
    return p;
  }

  private earlyBonus(w: number): number {
    return (5 + w) * (this.hasPerk('earlybird') ? 2 : 1);
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
      earlyBonus: s.phase === 'wave' ? this.earlyBonus(w) : 0,
    };
  }

  private updatePreviewEarly(): void {
    const s = this.state;
    const want = s.phase === 'wave' && !(s.totalWaves > 0 && s.nextWave.wave > s.totalWaves) ? this.earlyBonus(s.nextWave.wave) : 0;
    if (s.nextWave.wave !== s.wave + 1) this.updatePreview();
    else s.nextWave.earlyBonus = want;
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
    const ent = this.entrances[en.entrance % this.entrances.length];
    const cell = ent[this.rng.int(ent.length)];
    const e = this.createEnemy(en.enemy, aw.plan.wave, aw.plan.effWave, cell.x + 0.5, cell.y + 0.5, cell.x, cell.y, {
      elite: en.elite, affixes: en.affixes, group: en.group, hpMul: en.hpMul,
    });
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
      this.waveCleared(aw.plan.wave);
      if ((s.phase as string) === 'perk') break;
    }
    if (this.active.length === 0 && s.phase === 'wave') s.phase = 'build';
    if (this.active.length === 0 && s.phase === 'build') this.checkWin();
  }

  private waveCleared(w: number): void {
    const s = this.state;
    const D = s.params;
    this.clearedWaves++;
    this.lastCleared = Math.max(this.lastCleared, w);
    const bonus = Math.round((10 + 2 * w) * D.rewardMul);
    // 存钱罐
    let piggyGold = 0;
    let piggyT2 = 0;
    for (const t of this.towerList) {
      if (t.id !== 'piggy') continue;
      let g = 8 + 2 * (t.level - 1);
      if (t.level >= 10 && t.branch === 'A') g *= 2;
      if ((t.combo & C_CALC_PIGGY) !== 0) g *= 1.25;
      piggyGold += Math.round(g);
      if (t.level >= 4) piggyT2++;
      this.gainXp(t, 10);
    }
    this.addGold(bonus, 'wave');
    if (piggyGold > 0) this.addGold(piggyGold, 'piggy');
    const rate = this.hasPerk('compound') ? 0.08 : 0.05;
    const cap = D.interestCap + 5 * Math.min(PIGGY_MAX, piggyT2) + (this.hasPerk('compound') ? 10 : 0);
    const interest = Math.min(cap, Math.floor(s.gold * rate));
    if (interest > 0) this.addGold(interest, 'interest');
    this.emit({ type: 'waveEnd', wave: w, bonus, interest, piggy: piggyGold });
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
        const off = Math.sin(e.flyT * 2.2 + e.flyPhase) * 0.25 * taper;
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
    const safeBox = this.towerList.some((t) => t.id === 'piggy' && t.level >= 10 && t.branch === 'B');
    if (e.id === 'ant') {
      if (!safeBox) {
        stolen = Math.min(s.gold, Math.max(5, Math.floor(s.gold * 0.03)) * Math.min(e.group, 3));
        if (stolen > 0) {
          s.gold -= stolen;
          this.emit({ type: 'gold', amount: -stolen, reason: 'stolen', x: e.x, y: e.y });
        }
      }
    } else {
      s.lives = Math.max(0, s.lives - e.livesCost);
    }
    s.stats.leaks += e.group;
    this.emit({ type: 'leak', enemy: e.id, lives: s.lives, stolenGold: stolen });
    if (safeBox) this.addGold(10, 'refund', e.x, e.y);
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

  private knockback(e: Enemy, dist: number): void {
    if (e.flying || e.dead) return;
    if (e.boss) return;
    if (e.unstoppable) {
      this.emit({ type: 'immune', x: e.x, y: e.y });
      return;
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
      return;
    }
    e.x = cx;
    e.y = cy;
    left -= d;
    const pi = e.pcy * g.cols + e.pcx;
    if ((e.pcx === e.ccx && e.pcy === e.ccy) || !isPassableKind(g.cells[pi]) || !(g.dist[pi] < Infinity)) return;
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
      let revealed = e.revealUntil > t;
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
    if (e.redUntil > now) vul += 0.2;
    if (e.litUntil > now) vul += 0.15;
    a *= vul;
    if ((flags & F_BEAM) !== 0 && e.reflect) a *= 0.5;
    let dealt = 0;
    let hitShield = false;
    if (e.shield > 0) {
      const mul = (flags & F_SHIELD3) !== 0 ? 3 : 1;
      const sd = Math.min(e.shield, a * mul);
      e.shield -= sd;
      if (e.shield < 0.01) e.shield = 0;
      dealt += sd;
      a -= sd / mul;
      hitShield = true;
    }
    if (a > 1e-6) {
      if ((flags & (F_IGNORE_ARMOR | F_DOT | F_TRUE)) === 0) a = Math.max(1, a - e.armor);
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
      if (e.burnUntil <= now && e.inkStacks === 0 && e.bleedStacks === 0) {
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
      if (e.bleedStacks > 0) this.damage(e, e.bleedDps * e.bleedStacks * 0.5, this.towerOf(e.bleedOwner), F_DOT);
    }
  }

  private towerOf(uid: number): Tower | null {
    return uid ? ((this.state.towers.get(uid) as Tower | undefined) ?? null) : null;
  }

  // ───────────────────────── 区域 ─────────────────────────

  private addZone(
    kind: Zone['kind'], shape: 'circle' | 'rect', x: number, y: number,
    o: { r?: number; w?: number; h?: number; angle?: number; until: number; slow?: number; dps?: number; vuln?: number; reveal?: boolean; air?: boolean; towerUid?: number },
  ): Zone {
    const s = this.state;
    const ang = o.angle ?? 0;
    const z: Zone = {
      uid: this.nextUid++, kind, shape, x, y, until: o.until, createdAt: s.time,
      towerUid: o.towerUid ?? 0, slow: o.slow ?? 0, dps: o.dps ?? 0, vuln: o.vuln ?? 0, reveal: !!o.reveal, air: !!o.air,
      tick: 0, cos: Math.cos(ang), sin: Math.sin(ang), cx: x, cy: y, br: o.r ?? 0,
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
      const doDot = z.dps > 0 && z.tick >= 0.5;
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
          this.damage(e, z.dps * 0.5, this.towerOf(z.towerUid), F_DOT | F_AOE);
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
      if (t.cd > 0) t.cd -= DT * t.atkMul * caff;
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

  private aim(t: Tower, e: { x: number; y: number }): void {
    t.angle = Math.atan2(e.y - (t.cy + 0.5), e.x - (t.cx + 0.5));
  }

  private rollCrit(t: Tower): boolean {
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
    for (let k = 0; k < shots; k++) {
      const tgt = k === 0 ? e : second!;
      const crit = this.rollCrit(t);
      const dmg = t.dmg * (crit ? t.critMul : 1);
      const p = this.spawnProj(t, B ? 'color' : 'graphite', tgt, t.def.projSpeed, dmg, crit);
      if (p && B) p.color = (['red', 'blue', 'yellow'] as const)[this.rng.int(3)];
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
      const crit = this.rollCrit(t);
      if (crit) dmg *= t.critMul;
      if (B && e.shred < 5 && e.armor > 0) {
        e.shred++;
        e.armor = Math.max(0, e.armor - 1);
      }
      this.damage(e, dmg, t, F_AOE | (crit ? F_CRIT : 0));
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
      if (A && this.rng.next() < 0.25) this.applyRoot(e, 1);
    }
    this.emit({ type: 'pulse', x, y, r: 0.8, color: 'cyan' });
    if (t && level >= 4) {
      if (B) this.addZone('hotglue', 'circle', x, y, { r: 0.8, until: now + 3, dps: 10 * t.dmgFactor, towerUid: t.uid });
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
      if (B) tg.litUntil = Math.max(tg.litUntil, now + 1.6);
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
    let dps = t.dmg * Math.pow(1.25, t.laserTime) * caff * t.atkMul;
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
      this.damage(tg, amt, t, F_BEAM | F_IGNORE_ARMOR | (crit ? F_CRIT : 0));
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
    const arc = A ? (100 * Math.PI) / 180 : TAU;
    let center = 0;
    if (A) {
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
      if (A) {
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
      if (B && !e.dead) {
        e.bleedStacks = Math.min(10, e.bleedStacks + 1);
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
    if (p && t.level >= 4) p.bounce = 1;
    this.emit({ type: 'fire', uid: t.uid, tower: t.id, x: t.cx + 0.5, y: t.cy + 0.5, tx: e.x, ty: e.y });
    return true;
  }

  private eraserHit(t: Tower | null, e: Enemy, dmg: number, crit: boolean): void {
    const now = this.state.time;
    const level = t ? t.level : 1;
    const B = t && level >= 10 && t.branch === 'B';
    const A = t && level >= 10 && t.branch === 'A';
    if (B && e.shield > 0 && this.rng.next() < 0.1) e.shield = 0;
    this.damage(e, dmg * (crit && t ? t.critMul : 1), t, F_SHIELD3 | (crit ? F_CRIT : 0));
    if (!e.dead) {
      e.armor = Math.max(0, e.armor - (level >= 7 ? 2 : 1));
      this.addDebuffer(e, t, 'eraser');
    }
    if (A && t && now - t.lastTape >= 2 && !e.flying) {
      t.lastTape = now;
      this.addZone('tape', 'rect', e.x, e.y, { w: 3, h: 0.7, angle: e.angle, until: now + 5, vuln: 0.25, towerUid: t.uid });
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
      if (t.level >= 10 && t.branch === 'B') e.redUntil = this.state.time + 3;
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
      const n = this.queryAll(cx, cy, 1.2, this.qB, true);
      const list = this.qC;
      list.length = 0;
      for (let i = 0; i < n; i++) {
        const o = this.qB[i];
        if (!this.targetable(o) && o !== e) continue;
        const dx = o.x - cx;
        const dy = o.y - cy;
        const along = dx * ux + dy * uy;
        const perp = Math.abs(-dx * uy + dy * ux);
        if (Math.abs(along) <= 1 + o.radius && perp <= 0.35 + o.radius) list.push(o);
      }
      if (!list.includes(e)) list.push(e);
      for (const o of list) {
        this.damage(o, p.dmg * mul, t, crit ? F_CRIT : 0);
        this.addInk(t, o, 2);
      }
      this.emit({ type: 'sweep', uid: t ? t.uid : 0, x: cx - ux, y: cy - uy, r0: 0, r1: 2, angle: p.angle, arc: 0 });
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
        vx: 0, vy: 0, travelled: 0, maxDist: 0, hits: [], bounce: 0, dead: false,
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
        tx: e.x, ty: e.y, speed, dmg, crit, vx: 0, vy: 0, travelled: 0, maxDist: 0, hits: [], bounce: 0, dead: false,
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
    for (let i = 0; i < n0; i++) {
      const p = ps[i] as Proj;
      if (p.dead) continue;
      if (p.kind === 'ruler') {
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
        if (e && !e.dead) this.projHit(p, e);
        else if (p.kind === 'glue') this.glueLand(p.tower, p.x, p.y, p.dmg);
      } else {
        p.x += (dx / d) * step;
        p.y += (dy / d) * step;
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
        this.damage(e, p.dmg, t, p.crit ? F_CRIT : 0);
        if (t && (t.combo & C_PENCIL_ERASER) !== 0 && !e.dead) e.armor = Math.max(0, e.armor - 0.5);
        if (p.kind === 'color' && t) {
          const now = this.state.time;
          if (p.color === 'red' && !e.dead) {
            e.burnDps = Math.max(e.burnDps, 4);
            e.burnUntil = now + 3;
            e.burnOwner = t.uid;
          } else if (p.color === 'blue' && !e.dead) {
            this.applySlow(e, 0.2, 1, true);
          } else if (p.color === 'yellow' && t.colorGold < 15) {
            t.colorGold++;
            this.addGold(1, 'color', e.x, e.y);
          }
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
          if (best) this.spawnProj(t, 'eraser', best, p.speed, p.dmg, false, { x: e.x, y: e.y });
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
    const level = t ? t.level : 1;
    const A = t && level >= 10 && t.branch === 'A';
    const B = t && level >= 10 && t.branch === 'B';
    for (const e of list) {
      if (!this.targetable(e) || p.hits.includes(e.uid)) continue;
      p.hits.push(e.uid);
      let dmg = p.dmg;
      if (level >= 4) dmg *= 1 + 0.03 * Math.floor(p.travelled);
      if (p.crit && t) dmg *= t.critMul;
      this.damage(e, dmg, t, p.crit ? F_CRIT : 0);
      if (e.dead) continue;
      if (B && !e.boss && e.hp < e.maxHp * 0.1) {
        this.damage(e, e.hp + e.shield + 1, t, F_TRUE);
        continue;
      }
      if (A && !e.flying) this.knockback(e, 0.5);
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
    const v = (this.lastCleared * 100 + s.stats.kills + s.lives * 50 + s.gold * 0.1) * s.params.scoreMul;
    s.score = Math.round(v);
  }

  private emit(ev: GameEvent): void {
    this.events.push(ev);
  }

  private toast(text: string, tone: 'info' | 'warn' | 'good'): void {
    this.emit({ type: 'toast', text, tone });
  }

  // ───────────────────────── 塔信息 ─────────────────────────

  private buildTowerInfo(t: Tower): TowerInfo {
    const d = t.def;
    const isWall = t.id === 'wall';
    const maxLevel = d.maxLevel;
    const tierName = isWall
      ? [d.name === '书本墙' ? '草稿本' : d.name, d.t2.name, d.t3.name][t.level - 1]
      : t.level >= 10 ? `传奇·${t.branch === 'B' ? d.B.name : d.A.name}` : TIER_NAMES[t.tier - 1];
    const stats: TowerInfo['stats'] = [];
    const A = t.level >= 10 && t.branch === 'A';
    switch (t.id) {
      case 'wall': {
        const b = t.level >= 3 ? '射程 +5%，伤害 +5%' : t.level >= 2 ? '射程 +5%' : '无';
        stats.push({ label: '相邻加成', value: b });
        break;
      }
      case 'calculator': {
        const bonus = 10 + (t.level - 1) + (t.level >= 7 ? 15 : 0);
        stats.push({ label: '光环范围', value: `${fmt(t.aura)} 格` });
        stats.push({ label: '伤害加成', value: `+${bonus}%` });
        if (t.level >= 4) stats.push({ label: '攻速加成', value: '+8%' });
        if (t.level >= 7) stats.push({ label: '射程加成', value: '+0.3 格' });
        stats.push({ label: '经验分成', value: '10%' });
        break;
      }
      case 'piggy': {
        let g = 8 + 2 * (t.level - 1);
        if (A) g *= 2;
        if ((t.combo & C_CALC_PIGGY) !== 0) g *= 1.25;
        stats.push({ label: '每波产出', value: `+${Math.round(g)} 金币` });
        if (t.level >= 4) stats.push({ label: '利息上限', value: '+5' });
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
        if (t.mastery > 0) stats.push({ label: '熟练度', value: `+${fmt(Math.min(20, (t.mastery / 100) * 0.5))}%` });
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
    const info: TowerInfo = {
      uid: t.uid, id: t.id, name: d.name, level: t.level, maxLevel, tier: t.tier, tierName,
      branch: t.branch, xp: Math.floor(t.xp), xpNext: t.xpNext,
      xpCapped: !isWall && (t.level >= 10 || (t.level === 9 && t.xp >= t.xpNext)),
      mastery: Math.floor(t.mastery), stats, traits,
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
  return (h >>> 0).toString(16);
}

export function createWorld(opts: RunOptions): IWorld {
  return new World(opts);
}
