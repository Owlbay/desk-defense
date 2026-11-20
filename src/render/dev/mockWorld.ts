/**
 * ⚠️ 仅供渲染层开发调试（render-dev.html），不进入正式构建。
 * 一个极简的假 World：实现 IWorld 的接口形状，用来驱动棋盘渲染与输入。
 * 数值、规则都不准确，只追求"各种画面状态都能出现"。
 */
import {
  CellKind,
  DT,
  GRID_COLS,
  GRID_ROWS,
  type AffixId,
  type BuildOption,
  type Command,
  type CommandResult,
  type EnemyId,
  type EnemyState,
  type GameEvent,
  type IWorld,
  type PickupState,
  type PlaceCheck,
  type RandomEventId,
  type RandomEventState,
  type SpawnerState,
  type ProjectileKind,
  type ProjectileState,
  type SkillState,
  type TowerId,
  type TowerInfo,
  type TowerState,
  type WorldState,
} from '../../core/types';

const RANGE: Record<TowerId, number> = {
  wall: 0, pencil: 2.5, stapler: 1.6, glue: 2.2, lamp: 3.5, compass: 1.8,
  eraser: 2, ruler: 4.5, pen: 2.8, calculator: 0, piggy: 0, swatter: 3,
};
const INTERVAL: Record<TowerId, number> = {
  wall: 0, pencil: 0.5, stapler: 1, glue: 0.8, lamp: 1.5, compass: 0.25,
  eraser: 1, ruler: 2, pen: 1, calculator: 0, piggy: 0, swatter: 1.2,
};
const PROJ: Partial<Record<TowerId, ProjectileKind>> = { pencil: 'graphite', glue: 'glue', pen: 'ink', ruler: 'ruler', eraser: 'eraser' };
const COST: Record<TowerId, number> = {
  wall: 5, pencil: 20, stapler: 45, glue: 35, lamp: 80, compass: 60, eraser: 40, ruler: 70, pen: 55, calculator: 90, piggy: 100, swatter: 50,
};

interface Proj extends ProjectileState {
  target: number;
  speed: number;
  dmg: number;
  life: number;
}

export interface MockDev {
  triggerEvent(id: RandomEventId): void;
  dropSpawner(): boolean;
  /** 选中塔直接变成 Lv10（★2），再进化一次即成神话 */
  makeLegend(uid: number, branch: 'A' | 'B'): void;
  /** 一群飞行敌人（演示苍蝇拍） */
  spawnFlyers(n: number): void;
}

export function createMockWorld(): IWorld & { dev: MockDev } {
  const cols = GRID_COLS,
    rows = GRID_ROWS;
  const cells = new Uint8Array(cols * rows);
  const towerAt = new Int32Array(cols * rows);
  const dist = new Float32Array(cols * rows);
  // 出生点：上边入口、左侧入口（侧边）、一个隐藏暗门
  const spawners: SpawnerState[] = [
    { id: 'north', kind: 'edge', cells: [{ x: 5, y: 0 }, { x: 6, y: 0 }], active: true },
    { id: 'west', kind: 'edge', cells: [{ x: 0, y: 5 }, { x: 0, y: 6 }], active: true },
    { id: 'east', kind: 'edge', cells: [{ x: 11, y: 9 }], active: false },
    { id: 'hidden-1', kind: 'hidden', cells: [{ x: 8, y: 8 }], active: false },
  ];
  const spawns: { x: number; y: number }[] = [];
  const refreshSpawns = () => {
    spawns.length = 0;
    for (const sp of spawners) if (sp.active) for (const c of sp.cells) spawns.push({ x: c.x, y: c.y });
  };
  refreshSpawns();
  const exits = [{ x: 5, y: 13 }, { x: 6, y: 13 }];
  const obstacles: WorldState['grid']['obstacles'] = [
    { kind: 'cup', x: 1, y: 2, w: 2, h: 2 },
    { kind: 'books', x: 9, y: 4, w: 2, h: 3 },
    { kind: 'keyboard', x: 0, y: 8, w: 3, h: 1 },
    { kind: 'mouse', x: 10, y: 10, w: 1, h: 2 },
    { kind: 'palette', x: 8, y: 0, w: 3, h: 2 },
    { kind: 'paint', x: 3, y: 11, w: 2, h: 1 },
    // 随机杂物（文档 09 §5）
    { kind: 'eraser', x: 3, y: 4, w: 2, h: 1 },
    { kind: 'pencilcup', x: 7, y: 10, w: 1, h: 1 },
    { kind: 'sticky', x: 2, y: 6, w: 1, h: 1 },
    { kind: 'phone', x: 7, y: 5, w: 1, h: 2 },
    { kind: 'ruler', x: 7, y: 12, w: 3, h: 1 },
    { kind: 'tape', x: 11, y: 6, w: 1, h: 1 },
    { kind: 'stapler', x: 0, y: 12, w: 2, h: 1 },
    { kind: 'clip', x: 11, y: 3, w: 1, h: 1 },
  ];
  for (const o of obstacles) for (let x = o.x; x < o.x + o.w; x++) for (let y = o.y; y < o.y + o.h; y++) cells[y * cols + x] = CellKind.Obstacle;
  for (const sp of spawners) for (const c of sp.cells) cells[c.y * cols + c.x] = CellKind.Spawn;
  for (const e of exits) cells[e.y * cols + e.x] = CellKind.Exit;

  const skills: SkillState[] = [
    { id: 'eraser_strike', level: 1, cd: 0, cdMax: 5, target: 'circle', radius: 1.5, ready: true },
    { id: 'whiteout_zone', level: 1, cd: 0, cdMax: 5, target: 'rect2', ready: true },
    { id: 'ruler_sweep', level: 1, cd: 0, cdMax: 5, target: 'line', ready: true },
    { id: 'relocate', level: 1, cd: 0, cdMax: 0, charges: 2, maxCharges: 2, target: 'tower+cell', ready: true },
    { id: 'bell', level: 1, cd: 0, cdMax: 5, target: 'none', ready: true },
    { id: 'caffeine', level: 1, cd: 0, cdMax: 5, target: 'none', ready: true },
    { id: 'inspiration', level: 1, cd: 0, cdMax: 5, target: 'tower', ready: true },
    { id: 'magnifier', level: 1, cd: 0, cdMax: 5, target: 'circle', radius: 2, ready: true },
    { id: 'scholarship', level: 1, cd: 0, cdMax: 5, target: 'none', ready: true },
    { id: 'seal_tape', level: 1, cd: 0, cdMax: 5, target: 'spawner', ready: true },
  ];

  const state: WorldState = {
    opts: { mode: 'endless', map: 'ch1', difficulty: 'normal', skills: skills.map((s) => s.id) },
    params: {} as WorldState['params'],
    seed: 'dev',
    tick: 0,
    time: 0,
    phase: 'build',
    wave: 0,
    totalWaves: 0,
    gold: 5000,
    lives: 20,
    maxLives: 20,
    score: 0,
    grid: { cols, rows, cells, towerAt, spawns, exits, obstacles, dist, version: 0 },
    towers: new Map(),
    enemies: [],
    projectiles: [],
    zones: [],
    skills,
    perks: [],
    perkChoices: null,
    perkRerollCost: 0,
    nextWave: { wave: 1, tags: [], groups: [], earlyBonus: 0 },  // 由 makePreview() 填充
    unlockedTowers: ['wall', 'pencil', 'stapler', 'glue', 'lamp', 'compass', 'eraser', 'ruler', 'pen', 'calculator', 'piggy', 'swatter'],
    caffeineUntil: 0,
    spawners,
    events: [],
    eventLog: [],
    pickups: [],
    crateChoice: null,
    autoWave: { enabled: false, started: false, nextAt: null, deadline: null, blocked: false },
    bossUids: [],
    stats: { kills: 0, leaks: 0, goldEarned: 0, goldSpent: 0, towersBuilt: 0, skillsCast: 0, cleared: 0, bonus: 0 },
  };

  let events: GameEvent[] = [];
  let uid = 1;
  const projs: Proj[] = [];
  const cool = new Map<number, number>();
  const spawnQueue: { id: EnemyId; at: number; elite?: boolean; affixes?: AffixId[]; group?: number; spawner?: string }[] = [];
  const target = new Map<number, { x: number; y: number }>();

  const blocked = (k: number, extra = -1) => k === extra || cells[k] === CellKind.Obstacle || cells[k] === CellKind.Tower;

  function flow(extra = -1, out: Float32Array = dist): boolean {
    out.fill(Infinity);
    const q: number[] = [];
    for (const e of exits) {
      out[e.y * cols + e.x] = 0;
      q.push(e.y * cols + e.x);
    }
    // 简易 Dijkstra（数组扫描足够）
    const done = new Uint8Array(cols * rows);
    while (true) {
      let best = -1,
        bd = Infinity;
      for (let i = 0; i < out.length; i++) if (!done[i] && out[i] < bd) ((bd = out[i]), (best = i));
      if (best < 0) break;
      done[best] = 1;
      const bx = best % cols,
        by = (best / cols) | 0;
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++) {
          if (!dx && !dy) continue;
          const nx = bx + dx,
            ny = by + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const nk = ny * cols + nx;
          if (blocked(nk, extra)) continue;
          if (dx && dy && (blocked(by * cols + nx, extra) || blocked(ny * cols + bx, extra))) continue;
          const nd = bd + (dx && dy ? 1.414 : 1);
          if (nd < out[nk]) out[nk] = nd;
        }
    }
    return spawns.every((s) => out[s.y * cols + s.x] < Infinity);
  }
  flow();

  function nextCell(x: number, y: number, d: ArrayLike<number> = dist): { x: number; y: number } | null {
    let best: { x: number; y: number } | null = null,
      bd = d[y * cols + x];
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const nx = x + dx,
          ny = y + dy;
        if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        if (dx && dy && (d[y * cols + nx] === Infinity || d[ny * cols + x] === Infinity)) continue;
        const v = d[ny * cols + nx];
        if (v < bd) ((bd = v), (best = { x: nx, y: ny }));
      }
    return best;
  }

  function pathsWith(d: ArrayLike<number>): { x: number; y: number }[][] {
    const out: { x: number; y: number }[][] = [];
    const seen = new Set<string>();
    for (const s of spawns) {
      const p = [{ x: s.x, y: s.y }];
      let c: { x: number; y: number } | null = s;
      let n = 0;
      while (c && d[c.y * cols + c.x] > 0 && n++ < 200) {
        c = nextCell(c.x, c.y, d);
        if (c) p.push(c);
      }
      const k = JSON.stringify(p);
      if (!seen.has(k)) (seen.add(k), out.push(p));
    }
    return out;
  }

  function canPlace(tower: TowerId, cx: number, cy: number): PlaceCheck {
    if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return { ok: false, reason: '超出棋盘' };
    const k = cy * cols + cx;
    if (cells[k] !== CellKind.Empty) return { ok: false, reason: cells[k] === CellKind.Tower ? '这里已经有塔了' : '这里不能建造' };
    for (const e of state.enemies) if (!e.flying && Math.floor(e.x) === cx && Math.floor(e.y) === cy) return { ok: false, reason: '有敌人在这里' };
    if (state.gold < COST[tower]) return { ok: false, reason: '金币不够' };
    const tmp = new Float32Array(cols * rows);
    if (!flow(k, tmp)) return { ok: false, reason: '会堵死道路' };
    return { ok: true };
  }

  function tierOf(level: number): 1 | 2 | 3 | 4 | 5 {
    return level >= 10 ? 4 : level >= 7 ? 3 : level >= 4 ? 2 : 1;
  }

  function spawnEnemy(id: EnemyId, opt: { elite?: boolean; affixes?: AffixId[]; group?: number; x?: number; y?: number; spawner?: string } = {}): EnemyState {
    const from = spawners.find((q) => q.id === opt.spawner && q.active) ?? spawners.filter((q) => q.active)[Math.floor(Math.random() * spawners.filter((q) => q.active).length)];
    const s = from ? from.cells[Math.floor(Math.random() * from.cells.length)] : { x: 5, y: 0 };
    const boss = id.startsWith('boss');
    const flying = id === 'plane' || id === 'moth';
    const hp = boss ? 800 : 30 * (opt.elite ? 2.5 : 1) * (opt.group ?? 1);
    const scale = (opt.elite ? 1.2 : 1) * (opt.group && opt.group > 1 ? 1.3 : 1) * (id === 'boss_coffee_small' ? 1 : 1);
    const e: EnemyState = {
      uid: uid++,
      id,
      x: opt.x ?? s.x + 0.5,
      y: opt.y ?? s.y + 0.5,
      angle: Math.PI / 2,
      hp,
      maxHp: hp,
      shield: id === 'sticky' || opt.affixes?.includes('shield') ? hp * 0.5 : 0,
      maxShield: id === 'sticky' ? hp * 0.5 : 0,
      armor: 0,
      speed: boss ? 0.8 : id === 'inkdot' || id === 'ant' ? 2.6 : 1.5,
      radius: boss ? 0.7 : id === 'crumbmini' ? 0.16 : 0.27,
      scale,
      flying,
      boss,
      elite: !!opt.elite,
      affixes: opt.affixes ?? [],
      group: opt.group ?? 1,
      hidden: id === 'invisink',
      stealthy: id === 'invisink' || !!opt.affixes?.includes('stealth'),
      slowPct: 0,
      slowUntil: 0,
      stunUntil: 0,
      rootUntil: 0,
      inkStacks: 0,
      bleedStacks: 0,
      burnUntil: 0,
      markedUntil: 0,
      netUntil: 0,
      jumping: false,
      lastHit: -1,
      spawnedAt: state.time,
    };
    state.enemies.push(e);
    events.push({ type: 'spawn', enemyUid: e.uid, enemy: id, boss });
    if (boss) state.bossUids.push(e.uid);
    return e;
  }

  function damage(e: EnemyState, amt: number, crit = false, kind: 'normal' | 'shield' | 'true' | 'dot' = 'normal'): void {
    if (e.shield > 0 && kind !== 'dot') {
      const s = Math.min(e.shield, amt);
      e.shield -= s;
      amt -= s;
      events.push({ type: 'hit', enemyUid: e.uid, x: e.x, y: e.y, amount: s, crit: false, kind: 'shield' });
    }
    if (amt > 0) {
      e.hp -= amt;
      events.push({ type: 'hit', enemyUid: e.uid, x: e.x, y: e.y, amount: amt, crit, kind });
    }
    e.lastHit = state.time;
  }

  function startWave(): void {
    state.phase = 'wave';
    state.wave++;
    events.push({ type: 'waveStart', wave: state.wave, tags: [] });
    const roster: EnemyId[] = ['crumb', 'inkdot', 'paperclip', 'plane', 'paperball', 'sticky', 'rubberband', 'whiteout', 'ant', 'invisink', 'tape', 'moth', 'crumbmini'];
    let t = state.time + 0.3;
    const n = 14 + state.wave * 4;
    for (let i = 0; i < n; i++) {
      const id = roster[(i + state.wave) % roster.length];
      const elite = i % 7 === 3;
      const act = spawners.filter((q) => q.active && !(q.warnUntil !== undefined && q.warnUntil > state.time));
      spawnQueue.push({
        id,
        at: t,
        spawner: act.length ? act[i % act.length].id : undefined,
        elite,
        affixes: elite ? (['hard', 'swift', 'regen', 'shield', 'rally'] as AffixId[]).slice(0, 1 + (i % 3)) : [],
        group: i % 11 === 5 ? 4 : 1,
      });
      t += 0.35;
    }
    const bosses: EnemyId[] = ['boss_coffee', 'boss_shredder', 'boss_inkbottle', 'boss_alarm'];
    spawnQueue.push({ id: bosses[(state.wave - 1) % 4], at: t + 1 });
    makePreview();
  }

  /** 下一波预告：每个开放出生点一两组 */
  function makePreview(): void {
    const roster: EnemyId[] = ['crumb', 'inkdot', 'plane', 'ant', 'sticky', 'moth', 'paperclip'];
    const groups: WorldState['nextWave']['groups'] = [];
    let k = state.wave;
    for (const sp of spawners) {
      if (!sp.active && sp.kind !== 'drop') continue;
      const n = sp.kind === 'drop' ? 1 : 2;
      for (let i = 0; i < n; i++) {
        const enemy = sp.kind === 'drop' && sp.icon ? sp.icon : roster[k++ % roster.length];
        groups.push({ enemy, count: 3 + ((k * 3) % 7), elite: i === 1 ? 1 : 0, affixes: [], spawner: sp.id });
      }
    }
    state.nextWave = { wave: state.wave + 1, tags: [], groups, earlyBonus: 10 };
  }

  // ───────── 文档 09：空降出生点 / 随机事件 / 掉落物 / 自动波次 ─────────

  let dropN = 0;
  function emptyCell(minDistExit = 5): { x: number; y: number } | null {
    for (let tries = 0; tries < 200; tries++) {
      const x = 1 + Math.floor(Math.random() * (cols - 2)),
        y = 2 + Math.floor(Math.random() * (rows - 5));
      const k = y * cols + x;
      if (cells[k] !== CellKind.Empty) continue;
      if (exits.some((e) => Math.abs(e.x - x) + Math.abs(e.y - y) < minDistExit)) continue;
      let nearTower = false;
      for (const t of state.towers.values()) if (Math.abs(t.cx - x) <= 1 && Math.abs(t.cy - y) <= 1) nearTower = true;
      if (nearTower) continue;
      const tmp = new Float32Array(cols * rows);
      if (!flow(k, tmp)) continue;
      return { x, y };
    }
    return null;
  }

  function dropSpawner(): boolean {
    const c = emptyCell();
    if (!c) return false;
    const icons: EnemyId[] = ['ant', 'crumb', 'inkdot', 'sticky', 'paperclip'];
    const sp: SpawnerState = {
      id: `drop-${++dropN}`,
      kind: 'drop',
      cells: [c],
      active: false,
      warnUntil: state.time + 5,
      expiresAfterWave: state.wave + 2,
      demolishCost: 40 + 5 * state.wave,
      icon: icons[dropN % icons.length],
    };
    spawners.push(sp);
    cells[c.y * cols + c.x] = CellKind.Spawn;
    state.grid.version++;
    events.push({ type: 'spawnerDrop', id: sp.id, x: c.x, y: c.y, phase: 'warn' });
    return true;
  }

  function closeSpawner(id: string, phase: 'close' | 'demolish'): boolean {
    const i = spawners.findIndex((q) => q.id === id && q.kind === 'drop');
    if (i < 0) return false;
    const sp = spawners[i];
    spawners.splice(i, 1);
    for (const c of sp.cells) cells[c.y * cols + c.x] = CellKind.Empty;
    refreshSpawns();
    state.grid.version++;
    flow();
    events.push({ type: 'spawnerDrop', id: sp.id, x: sp.cells[0].x, y: sp.cells[0].y, phase });
    makePreview();
    return true;
  }

  const EVENT_INFO: Record<RandomEventId, { name: string; tone: RandomEventState['tone']; warn: number; dur: number }> = {
    drop_box: { name: '空降纸箱', tone: 'bad', warn: 0, dur: 0 },
    lamp_outage: { name: '台灯跳闸', tone: 'bad', warn: 3, dur: 8 },
    fan: { name: '风扇转起来', tone: 'bad', warn: 3, dur: 12 },
    books_fall: { name: '书本倒下', tone: 'bad', warn: 4, dur: 0 },
    homework_check: { name: '作业检查', tone: 'bad', warn: 0, dur: 20 },
    coffee_spill: { name: '咖啡打翻', tone: 'bad', warn: 3, dur: 6 },
    reinforce: { name: '敌军增援', tone: 'bad', warn: 0, dur: 0 },
    coins: { name: '掉落零花钱', tone: 'good', warn: 0, dur: 0 },
    inspiration: { name: '灵感闪现', tone: 'good', warn: 0, dur: 0 },
    nap: { name: '午休铃', tone: 'good', warn: 0, dur: 4 },
    praise: { name: '老师表扬', tone: 'good', warn: 0, dur: 15 },
    supply_crate: { name: '补给箱', tone: 'good', warn: 0, dur: 0 },
    tidy: { name: '桌面整理', tone: 'neutral', warn: 0, dur: 0 },
    wind: { name: '窗外起风', tone: 'neutral', warn: 0, dur: 15 },
    secret_door: { name: '暗门', tone: 'neutral', warn: 0, dur: 0 },
  };
  let evUid = 1;

  function triggerEvent(id: RandomEventId): void {
    if (id === 'drop_box') {
      dropSpawner();
      return;
    }
    const info = EVENT_INFO[id];
    const now = state.time;
    let area: RandomEventState['area'];
    if (id === 'books_fall') {
      for (let tries = 0; tries < 100 && !area; tries++) {
        const x = 1 + Math.floor(Math.random() * (cols - 4)),
          y = 2 + Math.floor(Math.random() * (rows - 5));
        let ok = true;
        for (let i = 0; i < 3; i++) if (cells[y * cols + x + i] !== CellKind.Empty && cells[y * cols + x + i] !== CellKind.Tower) ok = false;
        if (ok) area = { x, y, w: 3, h: 1 };
      }
    } else if (id === 'coffee_spill') {
      area = { x: 1 + Math.floor(Math.random() * (cols - 4)), y: 2 + Math.floor(Math.random() * (rows - 6)), w: 3, h: 3 };
    } else if (id === 'inspiration') {
      const ts = [...state.towers.values()].filter((t) => t.id !== 'wall');
      const t = ts[Math.floor(Math.random() * ts.length)];
      if (t) area = { x: t.cx, y: t.cy, w: 1, h: 1 };
    }
    const e: RandomEventState = {
      uid: evUid++,
      id,
      name: info.name,
      desc: id === 'wind' ? '风向左吹，弹道偏移' : info.name,
      tone: info.tone,
      phase: info.warn > 0 ? 'warn' : 'active',
      startsAt: now + info.warn,
      endsAt: now + info.warn + info.dur,
      area,
    };
    state.events.push(e);
    events.push({ type: 'randomEvent', uid: e.uid, id, phase: info.warn > 0 ? 'warn' : 'start', name: e.name, desc: e.desc, tone: e.tone, area });
    if (info.warn <= 0) startEvent(e);
  }

  function startEvent(e: RandomEventState): void {
    const now = state.time;
    if (e.phase === 'warn') {
      e.phase = 'active';
      events.push({ type: 'randomEvent', uid: e.uid, id: e.id, phase: 'start', name: e.name, desc: e.desc, tone: e.tone, area: e.area });
    }
    state.eventLog.push({ wave: state.wave, id: e.id, name: e.name });
    switch (e.id) {
      case 'books_fall': {
        const a = e.area;
        if (!a) break;
        obstacles.push({ kind: 'books', x: a.x, y: a.y, w: 3, h: 1 });
        for (let i = 0; i < 3; i++) {
          const k = a.y * cols + a.x + i;
          const tu = towerAt[k];
          cells[k] = CellKind.Obstacle;
          towerAt[k] = 0;
          if (tu) {
            const t = state.towers.get(tu)!;
            let dest: { x: number; y: number } | null = null;
            for (let r = 1; r < 4 && !dest; r++)
              for (let dy = -r; dy <= r && !dest; dy++)
                for (let dx = -r; dx <= r && !dest; dx++) {
                  const nx = t.cx + dx,
                    ny = t.cy + dy;
                  if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
                  if (cells[ny * cols + nx] === CellKind.Empty) dest = { x: nx, y: ny };
                }
            if (dest) {
              const fx0 = t.cx,
                fy0 = t.cy;
              t.cx = dest.x;
              t.cy = dest.y;
              cells[dest.y * cols + dest.x] = CellKind.Tower;
              towerAt[dest.y * cols + dest.x] = t.uid;
              events.push({ type: 'towerMoved', uid: t.uid, fromX: fx0, fromY: fy0, cx: t.cx, cy: t.cy });
            } else state.towers.delete(tu);
          }
        }
        state.grid.version++;
        flow();
        updateCombos();
        events.push({ type: 'terrainChanged', reason: 'event' });
        break;
      }
      case 'coffee_spill': {
        const a = e.area!;
        state.zones.push({ uid: uid++, kind: 'coffee', shape: 'rect', x: a.x, y: a.y, w: a.w, h: a.h, until: now + 6, createdAt: now });
        for (const t of state.towers.values())
          if (t.cx >= a.x && t.cx < a.x + a.w && t.cy >= a.y && t.cy < a.y + a.h) {
            t.disabledUntil = now + 6;
            events.push({ type: 'towerDisabled', uid: t.uid, until: t.disabledUntil });
          }
        break;
      }
      case 'nap':
        for (const en of state.enemies) if (!en.flying) en.stunUntil = now + 4;
        break;
      case 'homework_check':
        for (const en of state.enemies) en.armor += 3;
        break;
      case 'coins':
        for (let i = 0; i < 4; i++) {
          const c = emptyCell(2);
          if (!c) continue;
          const p: PickupState = { uid: uid++, kind: 'coin', x: c.x + 0.5, y: c.y + 0.5, until: now + 12, value: 8 };
          state.pickups.push(p);
          events.push({ type: 'pickup', uid: p.uid, kind: 'coin', x: p.x, y: p.y, phase: 'spawn', value: p.value });
        }
        break;
      case 'supply_crate': {
        const c = emptyCell(2);
        if (!c) break;
        const p: PickupState = { uid: uid++, kind: 'crate', x: c.x + 0.5, y: c.y + 0.5, until: now + 15, value: 0 };
        state.pickups.push(p);
        events.push({ type: 'pickup', uid: p.uid, kind: 'crate', x: p.x, y: p.y, phase: 'spawn' });
        break;
      }
      case 'inspiration': {
        const a = e.area;
        const t = a ? state.towers.get(towerAt[a.y * cols + a.x]) : undefined;
        if (t && t.level < 9) levelUp(t, true);
        break;
      }
      case 'tidy': {
        const movable = obstacles.filter((o) => o.w * o.h === 1);
        const o = movable[Math.floor(Math.random() * movable.length)];
        if (!o) break;
        cells[o.y * cols + o.x] = CellKind.Empty;
        const c = emptyCell(2);
        if (!c) {
          cells[o.y * cols + o.x] = CellKind.Obstacle;
          break;
        }
        o.x = c.x;
        o.y = c.y;
        cells[c.y * cols + c.x] = CellKind.Obstacle;
        state.grid.version++;
        flow();
        events.push({ type: 'terrainChanged', reason: 'tidy' });
        break;
      }
      case 'secret_door': {
        const h = spawners.find((q) => q.kind === 'hidden');
        if (!h) break;
        h.active = true;
        h.expiresAfterWave = state.wave + 3;
        refreshSpawns();
        state.grid.version++;
        makePreview();
        break;
      }
      case 'reinforce':
        for (let i = 0; i < 6; i++) spawnQueue.push({ id: 'crumb', at: now + i * 0.3 });
        break;
      default:
        break;
    }
    if (e.endsAt <= now) endEvent(e);
  }

  function endEvent(e: RandomEventState): void {
    if (e.phase === 'done') return;
    e.phase = 'done';
    events.push({ type: 'randomEvent', uid: e.uid, id: e.id, phase: 'end', name: e.name, desc: e.desc, tone: e.tone, area: e.area });
    if (e.id === 'homework_check') for (const en of state.enemies) en.armor = Math.max(0, en.armor - 3);
  }

  function tickDynamic(): void {
    const now = state.time;
    // 空降落地
    for (const sp of spawners) {
      if (sp.kind !== 'drop' || sp.active || sp.warnUntil === undefined || sp.warnUntil > now) continue;
      sp.active = true;
      refreshSpawns();
      state.grid.version++;
      flow();
      events.push({ type: 'spawnerDrop', id: sp.id, x: sp.cells[0].x, y: sp.cells[0].y, phase: 'land' });
      events.push({ type: 'terrainChanged', reason: 'drop' });
      // 推开附近敌人
      for (const en of state.enemies) {
        const dx = en.x - (sp.cells[0].x + 0.5),
          dy = en.y - (sp.cells[0].y + 0.5);
        const d = Math.hypot(dx, dy);
        if (d < 1.5 && d > 0.01) {
          en.x += (dx / d) * 0.8;
          en.y += (dy / d) * 0.8;
        }
      }
      makePreview();
    }
    // 事件阶段
    for (const e of state.events) {
      if (e.phase === 'warn' && e.startsAt <= now) startEvent(e);
      else if (e.phase === 'active' && e.endsAt <= now) endEvent(e);
    }
    state.events = state.events.filter((e) => e.phase !== 'done' || now - e.endsAt < 30);
    // 掉落物过期
    for (let i = state.pickups.length - 1; i >= 0; i--) {
      const p = state.pickups[i];
      if (p.until > now) continue;
      state.pickups.splice(i, 1);
      events.push({ type: 'pickup', uid: p.uid, kind: p.kind, x: p.x, y: p.y, phase: 'expire' });
    }
    // 自动波次
    const aw = state.autoWave;
    if (aw.enabled && aw.started && state.phase === 'build') {
      if (aw.nextAt === null) aw.nextAt = now + 6;
      const left = aw.nextAt - now;
      for (const s of [3, 2, 1]) if (left <= s && left + DT > s) events.push({ type: 'autoWave', secondsLeft: s });
      if (left <= 0) {
        aw.nextAt = null;
        startWave();
      }
    }
    // 能力冷却
    for (const t of state.towers.values()) if (t.abilityCd > 0) t.abilityCd = Math.max(0, t.abilityCd - DT);
  }

  // ───────── 文档 11：进化 / 主动能力 ─────────

  type AbTarget = NonNullable<TowerInfo['ability']>['target'];
  const AB_TARGET: Record<string, AbTarget> = {
    pencil_A: 'none', pencil_B: 'none', stapler_A: 'direction', stapler_B: 'none', glue_A: 'none', glue_B: 'rect3',
    lamp_A: 'none', lamp_B: 'none', compass_A: 'none', compass_B: 'enemy', eraser_A: 'none', eraser_B: 'enemy',
    ruler_A: 'axis', ruler_B: 'enemy', pen_A: 'circle', pen_B: 'none', calculator_A: 'none', calculator_B: 'tower',
    piggy_A: 'none', piggy_B: 'none', swatter_A: 'none', swatter_B: 'none',
  };

  function evolve(t: TowerState): CommandResult {
    if (t.id === 'wall') return { ok: false, reason: '书本墙不能进化' };
    if (t.level < 10) return { ok: false, reason: '需要先升到 Lv10' };
    if (t.stars >= 3) return { ok: false, reason: '已满星' };
    t.stars = (t.stars + 1) as 0 | 1 | 2 | 3;
    const mythic = t.stars === 3;
    if (mythic) t.tier = 5;
    t.evoXp = 0;
    t.evoXpNext = t.stars >= 3 ? 0 : [2000, 4000, 7000][t.stars];
    events.push({ type: 'evolve', uid: t.uid, stars: t.stars, mythic });
    return { ok: true };
  }

  function towerAbility(cmd: Extract<Command, { type: 'towerAbility' }>): CommandResult {
    const t = state.towers.get(cmd.uid);
    if (!t || t.stars < 3) return { ok: false, reason: '只有神话塔有主动能力' };
    if (t.abilityCd > 0) return { ok: false, reason: '能力冷却中' };
    const key = `${t.id}_${t.branch ?? 'A'}`;
    const now = state.time;
    t.abilityCd = 8;
    const x = cmd.x,
      y = cmd.y;
    switch (key) {
      case 'glue_B':
        state.zones.push({ uid: uid++, kind: 'lava', shape: 'rect', x: (x ?? 0) - 1.5, y: (y ?? 0) - 1.5, w: 3, h: 3, until: now + 8, createdAt: now });
        break;
      case 'pen_A':
        state.zones.push({ uid: uid++, kind: 'inkcross', shape: 'circle', x: x ?? 0, y: y ?? 0, r: 1.5, until: now + 6, createdAt: now });
        break;
      case 'eraser_A': {
        const p = pathsWith(dist)[0] ?? [];
        for (const c of p) state.zones.push({ uid: uid++, kind: 'fullcorrect', shape: 'rect', x: c.x + 0.1, y: c.y + 0.1, w: 0.8, h: 0.8, until: now + 6, createdAt: now });
        break;
      }
      case 'compass_B':
      case 'eraser_B':
      case 'ruler_B': {
        const e = state.enemies.find((q) => q.uid === cmd.targetUid);
        if (!e) return { ok: false, reason: '目标不见了' };
        if (key === 'compass_B') damage(e, (e.maxHp - e.hp) * 0.2 + 10, false, 'true');
        if (key === 'eraser_B') e.affixes = [];
        if (key === 'ruler_B') e.markedUntil = now + 10;
        break;
      }
      case 'ruler_A':
        for (const e of state.enemies)
          if (!e.flying && (cmd.axis === 'row' ? Math.floor(e.y) === cmd.index : Math.floor(e.x) === cmd.index)) e.y = Math.max(0.5, e.y - 2);
        break;
      case 'pen_B':
        for (const e of state.enemies) if (e.markedUntil > now) damage(e, e.maxHp * 0.1, false, 'true');
        break;
      case 'glue_A':
        for (const e of state.enemies) if (!e.flying) e.rootUntil = now + 2;
        break;
      case 'calculator_B': {
        const o = state.towers.get(cmd.targetUid ?? -1);
        if (!o) return { ok: false, reason: '请选择一座塔' };
        if (o.level < 9) levelUp(o, false);
        break;
      }
      case 'swatter_B':
        for (const e of state.enemies) if (e.flying) netEnemy(e, e.boss ? 1.5 : 5);
        break;
      case 'piggy_A':
        state.gold += 60;
        events.push({ type: 'gold', amount: 60, x: t.cx + 0.5, y: t.cy + 0.5, reason: 'piggy' });
        break;
      default:
        break;
    }
    events.push({ type: 'towerAbility', uid: t.uid, ability: key, x, y, r: key === 'stapler_B' ? 2 : 1.5, angle: cmd.angle, axis: cmd.axis, index: cmd.index, targetUid: cmd.targetUid });
    return { ok: true };
  }

  makePreview();

  /** 苍蝇拍·捕虫网（mock）：飞行敌人落地 */
  const netted = new Set<number>();
  function netEnemy(e: EnemyState, dur: number): void {
    if (e.boss) return;
    e.netUntil = state.time + dur;
    e.flying = false;
    netted.add(e.uid);
  }
  const swatCount = new Map<number, number>();

  function step(): void {
    state.tick++;
    state.time += DT;
    const now = state.time;
    tickDynamic();
    // 生成
    for (let i = spawnQueue.length - 1; i >= 0; i--) {
      if (spawnQueue[i].at <= now) {
        const q = spawnQueue.splice(i, 1)[0];
        spawnEnemy(q.id, q);
      }
    }
    // 网到期：飞回空中
    for (const e of state.enemies) {
      if (netted.has(e.uid) && e.netUntil <= now) {
        netted.delete(e.uid);
        e.netUntil = 0;
        e.flying = true;
      }
    }
    // 敌人移动
    for (const e of state.enemies) {
      if (e.stunUntil > now || e.rootUntil > now) continue;
      const sp = e.speed * (e.slowUntil > now ? 1 - e.slowPct : 1) * DT;
      let tx: number, ty: number;
      if (e.flying) {
        tx = 6;
        ty = 13.5;
      } else {
        let t = target.get(e.uid);
        const cx = Math.floor(e.x),
          cy = Math.floor(e.y);
        if (!t || (Math.abs(e.x - t.x) < 0.05 && Math.abs(e.y - t.y) < 0.05)) {
          const n = nextCell(cx, cy);
          t = n ? { x: n.x + 0.5, y: n.y + 0.5 } : { x: 6, y: 13.5 };
          target.set(e.uid, t);
        }
        tx = t.x;
        ty = t.y;
      }
      const dx = tx - e.x,
        dy = ty - e.y;
      const d = Math.hypot(dx, dy);
      if (d > 1e-4) {
        e.angle = Math.atan2(dy, dx);
        const m = Math.min(d, sp);
        e.x += (dx / d) * m;
        e.y += (dy / d) * m;
      }
      if (e.id === 'rubberband') e.jumping = (now - e.spawnedAt) % 4 < 0.3;
      if (e.id === 'invisink') {
        let near = false;
        for (const t of state.towers.values()) if (Math.hypot(t.cx + 0.5 - e.x, t.cy + 0.5 - e.y) < 1.5) near = true;
        e.hidden = !near;
      }
      if (e.burnUntil > now && state.tick % 30 === 0) damage(e, 2, false, 'dot');
    }
    // 漏怪
    for (let i = state.enemies.length - 1; i >= 0; i--) {
      const e = state.enemies[i];
      if (e.y >= 13.4 && Math.abs(e.x - 6) < 1.2) {
        state.enemies.splice(i, 1);
        state.lives = Math.max(0, state.lives - (e.boss ? 5 : 1));
        events.push({ type: 'leak', enemy: e.id, lives: e.id === 'ant' ? 0 : e.boss ? 5 : 1, stolenGold: e.id === 'ant' ? 5 : 0 });
        if (e.id === 'ant') events.push({ type: 'gold', amount: -5, x: e.x, y: e.y, reason: 'stolen' });
      }
    }
    // 塔
    for (const t of state.towers.values()) {
      const r = RANGE[t.id];
      if (!r || t.disabledUntil > now) continue;
      const x = t.cx + 0.5,
        y = t.cy + 0.5;
      let best: EnemyState | null = null,
        bd = Infinity;
      for (const e of state.enemies) {
        if (e.hidden) continue;
        if (t.id === 'swatter' && !e.flying) continue;
        const d = Math.hypot(e.x - x, e.y - y);
        if (d <= r && d < bd) ((bd = d), (best = e));
      }
      if (!best) continue;
      t.angle = Math.atan2(best.y - y, best.x - x);
      const c = (cool.get(t.uid) ?? 0) - DT;
      if (c > 0) {
        cool.set(t.uid, c);
        continue;
      }
      cool.set(t.uid, INTERVAL[t.id]);
      t.lastFire = now;
      events.push({ type: 'fire', uid: t.uid, tower: t.id, x, y, tx: best.x, ty: best.y });
      const dmg = 6 + t.level * 2;
      if (t.id === 'lamp') {
        events.push({ type: 'beam', uid: t.uid, x, y, tx: best.x, ty: best.y, color: t.tier === 4 ? (t.branch === 'B' ? 'magenta' : 'cyan') : 'warm', width: 4 });
        damage(best, dmg * 2, false, 'true');
        best.burnUntil = now + 1;
      } else if (t.id === 'stapler') {
        events.push({ type: 'pulse', x, y, r, color: 'steel' });
        for (const e of state.enemies) if (!e.flying && Math.hypot(e.x - x, e.y - y) <= r) {
          damage(e, dmg);
          if (Math.random() < 0.2) e.stunUntil = now + 0.8;
        }
      } else if (t.id === 'swatter') {
        const n = (swatCount.get(t.uid) ?? 0) + 1;
        swatCount.set(t.uid, n);
        if (t.tier >= 4 && t.branch === 'B' && n % 3 === 0) {
          projs.push({ uid: uid++, kind: 'net', x, y, angle: t.angle, towerUid: t.uid, target: best.uid, speed: 7, dmg: 0, life: 2 });
          continue;
        }
        const sr = t.tier >= 3 ? 0.8 : 0.6;
        events.push({ type: 'swat', uid: t.uid, x: best.x, y: best.y, r: sr });
        const hitList = state.enemies.filter((e) => e.flying && Math.hypot(e.x - best!.x, e.y - best!.y) <= sr);
        for (const e of hitList) damage(e, dmg * 1.5);
        if (t.tier >= 4 && t.branch !== 'B') {
          const pts = [{ x: best.x, y: best.y }];
          let cur = best;
          const used = new Set([best.uid]);
          for (let j = 0; j < 3; j++) {
            let nx: EnemyState | null = null,
              nd = 2.5;
            for (const e of state.enemies) {
              if (!e.flying || used.has(e.uid)) continue;
              const d = Math.hypot(e.x - cur.x, e.y - cur.y);
              if (d < nd) ((nd = d), (nx = e));
            }
            if (!nx) break;
            used.add(nx.uid);
            pts.push({ x: nx.x, y: nx.y });
            damage(nx, dmg * 0.7);
            nx.stunUntil = now + 0.3;
            cur = nx;
          }
          if (pts.length > 1) events.push({ type: 'chain', uid: t.uid, points: pts });
        }
      } else if (t.id === 'compass') {
        events.push({ type: 'sweep', uid: t.uid, x, y, r0: 0.8, r1: 1.8, angle: (now * 6) % (Math.PI * 2), arc: 0.8 });
        for (const e of state.enemies) {
          const d = Math.hypot(e.x - x, e.y - y);
          if (!e.flying && d >= 0.8 && d <= 1.8) damage(e, 1, false, 'normal');
        }
      } else {
        const kind = PROJ[t.id];
        if (!kind) continue;
        const p: Proj = {
          uid: uid++,
          kind: t.id === 'pencil' && t.tier === 4 && t.branch === 'B' ? 'color' : t.id === 'pen' && t.tier === 4 && t.branch === 'A' ? 'brush' : kind,
          color: (['red', 'blue', 'yellow'] as const)[Math.floor(Math.random() * 3)],
          x,
          y,
          angle: t.angle,
          towerUid: t.uid,
          target: best.uid,
          speed: kind === 'ruler' ? 8 : 10,
          dmg,
          life: 2,
        };
        projs.push(p);
      }
    }
    // 投射物
    for (let i = projs.length - 1; i >= 0; i--) {
      const p = projs[i];
      p.life -= DT;
      const e = state.enemies.find((q) => q.uid === p.target);
      if (!e || p.life <= 0) {
        projs.splice(i, 1);
        continue;
      }
      const dx = e.x - p.x,
        dy = e.y - p.y;
      const d = Math.hypot(dx, dy);
      p.angle = Math.atan2(dy, dx);
      if (d < p.speed * DT + 0.1) {
        projs.splice(i, 1);
        if (e.id === 'moth' && Math.random() < 0.25) {
          events.push({ type: 'dodge', x: e.x, y: e.y });
          continue;
        }
        damage(e, p.dmg, Math.random() < 0.15);
        if (p.kind === 'glue') {
          if (e.id === 'tape') events.push({ type: 'immune', x: e.x, y: e.y });
          else {
            e.slowPct = 0.4;
            e.slowUntil = now + 1.5;
            state.zones.push({ uid: uid++, kind: Math.random() < 0.5 ? 'glue' : 'hotglue', shape: 'circle', x: e.x, y: e.y, r: 0.6, until: now + 3, createdAt: now });
          }
        }
        if (p.kind === 'ink' || p.kind === 'brush') e.inkStacks = Math.min(5, e.inkStacks + 1);
        if (p.kind === 'eraser') e.markedUntil = now + 2;
        if (p.kind === 'net' && e.flying) netEnemy(e, 4);
        continue;
      }
      p.x += (dx / d) * p.speed * DT;
      p.y += (dy / d) * p.speed * DT;
    }
    state.projectiles = projs;
    // 治疗
    if (state.tick % 60 === 0) for (const e of state.enemies) if (e.id === 'whiteout') events.push({ type: 'heal', x: e.x, y: e.y, amount: 3 });
    // Boss 技能
    if (state.tick % 300 === 0)
      for (const e of state.enemies) {
        if (!e.boss) continue;
        const skill = e.id === 'boss_coffee' ? 'spill' : e.id === 'boss_inkbottle' ? 'inkShield' : e.id === 'boss_alarm' ? 'ring' : 'shred';
        events.push({ type: 'bossSkill', enemyUid: e.uid, skill, x: e.x, y: e.y, r: 1.5 });
        if (skill === 'spill')
          for (const t of state.towers.values())
            if (Math.hypot(t.cx + 0.5 - e.x, t.cy + 0.5 - e.y) < 1.5) {
              t.disabledUntil = now + 2;
              events.push({ type: 'towerDisabled', uid: t.uid, until: t.disabledUntil });
            }
      }
    // 死亡
    for (let i = state.enemies.length - 1; i >= 0; i--) {
      const e = state.enemies[i];
      if (e.hp > 0) continue;
      state.enemies.splice(i, 1);
      target.delete(e.uid);
      state.bossUids = state.bossUids.filter((u) => u !== e.uid);
      const gold = e.boss ? 50 : 3;
      state.gold += gold;
      state.stats.kills++;
      events.push({ type: 'death', enemyUid: e.uid, enemy: e.id, x: e.x, y: e.y, gold, boss: e.boss, elite: e.elite });
      events.push({ type: 'gold', amount: gold, x: e.x, y: e.y, reason: 'kill' });
      if (e.id === 'paperball') {
        events.push({ type: 'split', x: e.x, y: e.y, enemy: 'crumbmini' });
        for (let k = 0; k < 3; k++) spawnEnemy('crumbmini', { x: e.x + (k - 1) * 0.2, y: e.y });
      }
      if (e.id === 'boss_coffee') for (let k = 0; k < 2; k++) spawnEnemy('boss_coffee_small', { x: e.x + (k - 0.5) * 0.6, y: e.y });
      // 经验
      for (const t of state.towers.values()) {
        if (t.id === 'wall' || Math.hypot(t.cx + 0.5 - e.x, t.cy + 0.5 - e.y) > RANGE[t.id] + 0.5) continue;
        t.xp += 10;
        if (t.xp >= t.xpNext && t.level < 9) levelUp(t, true);
      }
    }
    state.zones = state.zones.filter((z) => z.until > now);
    for (const s of skills) {
      s.cd = Math.max(0, s.cd - DT);
      s.ready = s.cd <= 0;
    }
    if (state.phase === 'wave' && spawnQueue.length === 0 && state.enemies.length === 0) {
      state.phase = 'build';
      events.push({ type: 'waveEnd', wave: state.wave, bonus: 10, interest: 0, piggy: 0 });
      for (const sp of [...spawners]) if (sp.kind === 'drop' && sp.expiresAfterWave !== undefined && sp.expiresAfterWave <= state.wave) closeSpawner(sp.id, 'close');
    }
  }

  function levelUp(t: TowerState, byXp: boolean): void {
    t.level++;
    t.xp = 0;
    t.xpNext = 30 * t.level;
    const tier = tierOf(t.level);
    const changed = tier !== t.tier;
    t.tier = tier;
    events.push({ type: 'levelUp', uid: t.uid, level: t.level, tier, tierChanged: changed, byXp });
  }

  function command(cmd: Command): CommandResult {
    const now = state.time;
    switch (cmd.type) {
      case 'place': {
        const chk = canPlace(cmd.tower, cmd.cx, cmd.cy);
        if (!chk.ok) return chk;
        const k = cmd.cy * cols + cmd.cx;
        const t: TowerState = {
          uid: uid++, id: cmd.tower, cx: cmd.cx, cy: cmd.cy, level: 1, tier: 1, branch: null, xp: 0, xpNext: 30, stars: 0, evoXp: 0, evoXpNext: 0, abilityCd: 0,
          invested: COST[cmd.tower], targetMode: 'first', angle: -Math.PI / 2, lastFire: -1, disabledUntil: 0, placedAt: now,
          undoUntil: now + 5, kills: 0, damage: 0, comboWith: [],
        };
        state.towers.set(t.uid, t);
        cells[k] = CellKind.Tower;
        towerAt[k] = t.uid;
        state.gold -= COST[cmd.tower];
        state.grid.version++;
        flow();
        updateCombos();
        events.push({ type: 'place', uid: t.uid, tower: t.id, cx: t.cx, cy: t.cy });
        return { ok: true };
      }
      case 'upgrade': {
        const t = state.towers.get(cmd.uid);
        if (!t) return { ok: false, reason: '没有这座塔' };
        if (t.id === 'wall' ? t.level >= 3 : t.level >= 10) return { ok: false, reason: '已满级' };
        if (t.level === 9) t.branch = cmd.branch ?? (Math.random() < 0.5 ? 'A' : 'B');
        levelUp(t, false);
        return { ok: true };
      }
      case 'sell': {
        const t = state.towers.get(cmd.uid);
        if (!t) return { ok: false, reason: '没有这座塔' };
        state.towers.delete(t.uid);
        const k = t.cy * cols + t.cx;
        cells[k] = CellKind.Empty;
        towerAt[k] = 0;
        state.grid.version++;
        flow();
        updateCombos();
        events.push({ type: 'sell', uid: t.uid, tower: t.id, cx: t.cx, cy: t.cy, refund: 10 });
        events.push({ type: 'gold', amount: 10, x: t.cx + 0.5, y: t.cy + 0.5, reason: 'refund' });
        return { ok: true };
      }
      case 'startWave':
        if (state.autoWave.enabled) {
          state.autoWave.started = true;
          state.autoWave.nextAt = null;
        }
        startWave();
        return { ok: true };
      case 'collect': {
        const i = state.pickups.findIndex((p) => p.uid === cmd.uid);
        if (i < 0) return { ok: false, reason: '已经不见了' };
        const p = state.pickups.splice(i, 1)[0];
        if (p.kind === 'coin') {
          state.gold += p.value;
          events.push({ type: 'gold', amount: p.value, reason: 'perk' });
        } else state.crateChoice = { uid: p.uid, options: [{ id: 'gold', name: '金币', desc: '+50' }] };
        events.push({ type: 'pickup', uid: p.uid, kind: p.kind, x: p.x, y: p.y, phase: 'collect', value: p.value });
        return { ok: true };
      }
      case 'demolishSpawner': {
        const sp = spawners.find((q) => q.id === cmd.id);
        if (!sp || sp.kind !== 'drop') return { ok: false, reason: '只能拆除空降纸箱' };
        const cost = sp.demolishCost ?? 0;
        if (state.gold < cost) return { ok: false, reason: '金币不够' };
        state.gold -= cost;
        closeSpawner(sp.id, 'demolish');
        return { ok: true };
      }
      case 'evolve': {
        const t = state.towers.get(cmd.uid);
        return t ? evolve(t) : { ok: false, reason: '没有这座塔' };
      }
      case 'towerAbility':
        return towerAbility(cmd);
      case 'cast': {
        const s = skills.find((q) => q.id === cmd.skill);
        if (!s) return { ok: false, reason: '没有这个技能' };
        if (s.cd > 0) return { ok: false, reason: '技能冷却中' };
        s.cd = s.cdMax;
        const ev: GameEvent = { type: 'skill', skill: cmd.skill, x: cmd.x, y: cmd.y, cx: cmd.cx, cy: cmd.cy, axis: cmd.axis, uid: cmd.uid, r: s.radius };
        if (cmd.skill === 'eraser_strike')
          for (const e of state.enemies) if (Math.hypot(e.x - (cmd.x ?? 0), e.y - (cmd.y ?? 0)) < 1.5) damage(e, 60);
        if (cmd.skill === 'bell') for (const e of state.enemies) if (!e.flying) e.stunUntil = now + 2.5;
        if (cmd.skill === 'caffeine') state.caffeineUntil = now + 8;
        if (cmd.skill === 'whiteout_zone')
          state.zones.push({ uid: uid++, kind: 'whiteout', shape: 'rect', x: cmd.cx ?? 0, y: cmd.cy ?? 0, w: 2, h: 2, until: now + 8, createdAt: now });
        if (cmd.skill === 'magnifier') state.zones.push({ uid: uid++, kind: 'magnifier', shape: 'circle', x: cmd.x ?? 0, y: cmd.y ?? 0, r: 2, until: now + 6, createdAt: now });
        if (cmd.skill === 'ruler_sweep')
          for (const e of state.enemies) if (cmd.axis === 'row' ? Math.floor(e.y) === cmd.cy : Math.floor(e.x) === cmd.cx) damage(e, 40);
        if (cmd.skill === 'seal_tape') {
          if (!cmd.spawner || !closeSpawner(cmd.spawner, 'close')) {
            s.cd = 0;
            return { ok: false, reason: '请选择一个空降纸箱' };
          }
        }
        if (cmd.skill === 'scholarship') {
          state.gold += 50;
          events.push({ type: 'gold', amount: 50, x: 6, y: 7, reason: 'skill' });
        }
        if (cmd.skill === 'inspiration') {
          const t = state.towers.get(cmd.uid ?? -1);
          if (!t) return { ok: false, reason: '请选择一座塔' };
          if (t.level < 9) levelUp(t, true);
        }
        if (cmd.skill === 'relocate') {
          const t = state.towers.get(cmd.uid ?? -1);
          if (!t || cmd.cx === undefined || cmd.cy === undefined) return { ok: false, reason: '请选择塔与目标格' };
          const ok = canPlace(t.id, cmd.cx, cmd.cy);
          if (!ok.ok) return ok;
          const k0 = t.cy * cols + t.cx,
            k1 = cmd.cy * cols + cmd.cx;
          cells[k0] = CellKind.Empty;
          towerAt[k0] = 0;
          cells[k1] = CellKind.Tower;
          towerAt[k1] = t.uid;
          t.cx = cmd.cx;
          t.cy = cmd.cy;
          state.grid.version++;
          flow();
          updateCombos();
        }
        events.push(ev);
        return { ok: true };
      }
      default:
        return { ok: true };
    }
  }

  function updateCombos(): void {
    const pairs: [TowerId, TowerId][] = [
      ['pencil', 'eraser'], ['glue', 'stapler'], ['lamp', 'pen'], ['ruler', 'compass'], ['calculator', 'piggy'],
    ];
    for (const t of state.towers.values()) t.comboWith = [];
    for (const a of state.towers.values())
      for (const b of state.towers.values()) {
        if (Math.abs(a.cx - b.cx) + Math.abs(a.cy - b.cy) !== 1) continue;
        if (pairs.some(([p, q]) => (a.id === p && b.id === q) || (a.id === q && b.id === p))) a.comboWith.push(b.uid);
      }
  }

  function makeLegend(id: number, branch: 'A' | 'B'): void {
    const t = state.towers.get(id);
    if (!t || t.id === 'wall') return;
    t.level = 10;
    t.branch = branch;
    t.tier = 4;
    t.stars = 2;
    events.push({ type: 'levelUp', uid: t.uid, level: 10, tier: 4, tierChanged: true, byXp: false });
  }

  return {
    state,
    log: [],
    step,
    command,
    drainEvents() {
      const e = events;
      events = [];
      return e;
    },
    canPlace,
    previewPath(tower, cx, cy) {
      if (tower && !canPlace(tower, cx, cy).ok) return null;
      const tmp = new Float32Array(cols * rows);
      flow(cy * cols + cx, tmp);
      return pathsWith(tmp);
    },
    currentPaths() {
      return pathsWith(dist);
    },
    getBuildOptions(): BuildOption[] {
      return [];
    },
    getTowerInfo(id): TowerInfo | null {
      const t = state.towers.get(id);
      if (!t) return null;
      return {
        uid: t.uid, id: t.id, name: t.id, level: t.level, maxLevel: 10, tier: t.tier, tierName: '', branch: t.branch,
        xp: t.xp, xpNext: t.xpNext, xpCapped: false, stats: [], traits: [],
        stars: t.stars, evoXp: t.evoXp, evoXpNext: t.evoXpNext, evolveCost: t.level >= 10 && t.stars < 3 && t.id !== 'wall' ? 200 : null,
        evolveDiscount: 0, canAffordEvolve: true, evoTraits: [],
        ability:
          t.stars >= 3
            ? {
                id: `${t.id}_${t.branch}`, name: '能力', desc: '', cd: t.abilityCd, cdMax: 8, ready: t.abilityCd <= 0,
                target: AB_TARGET[`${t.id}_${t.branch ?? 'A'}`] ?? 'none', radius: 1.5,
              }
            : undefined,
        range: RANGE[t.id] + t.level * 0.06, innerRange: t.id === 'compass' ? 0.8 : undefined, auraRange: t.id === 'calculator' ? 2 : undefined,
        upgradeCost: 10, upgradeDiscount: 0, needsBranch: t.level === 9, canAffordUpgrade: true, sellValue: 10, refundRate: 0.7,
        canUndo: false, undoRemaining: 0, targetMode: 'first', targetModes: ['first'], kills: 0, damage: 0,
      };
    },
    baseRange(tower) {
      return { range: RANGE[tower], inner: tower === 'compass' ? 0.8 : undefined, aura: tower === 'calculator' ? 2 : undefined };
    },
    enemyName(id) {
      return id;
    },
    dev: {
      triggerEvent,
      dropSpawner,
      makeLegend,
      spawnFlyers(n: number) {
        for (let i = 0; i < n; i++) spawnEnemy(i % 2 ? 'moth' : 'plane', { x: 3 + Math.random() * 6, y: 0.5 + Math.random() * 1.5 });
      },
    },
  };
}
