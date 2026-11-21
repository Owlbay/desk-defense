import { describe, expect, it } from 'vitest';

import { EVOLUTION } from '../../src/config/evolution';
import { MAPS } from '../../src/config/maps';
import {
  ABILITY_META,
  CellKind,
  checkLayout,
  type Command,
  createWorld,
  DT,
  EVO,
  type GameEvent,
  generateLayout,
  type IWorld,
  type MapId,
  RANDOM_EVENT_IDS,
  RANDOM_EVENT_META,
  rawUpgradeCost,
  type RunOptions,
  SKILL_META,
  stateHash,
  type TowerId,
  type World,
} from '../../src/core';

const MAP_IDS: MapId[] = ['ch1', 'ch2', 'ch3'];

const opts = (o: Partial<RunOptions> = {}): RunOptions => ({
  mode: 'endless',
  map: 'ch1',
  difficulty: 'normal',
  seed: 'dyn',
  skills: ['eraser_strike', 'bell', 'seal_tape'],
  fixedLayout: true,
  ...o,
});
const custom = (c: RunOptions['custom'], o: Partial<RunOptions> = {}) => opts({ mode: 'custom', custom: c, ...o });

function run(w: IWorld, n: number, onEv?: (e: GameEvent) => void) {
  for (let i = 0; i < n; i++) {
    w.step();
    const evs = w.drainEvents();
    if (onEv) for (const e of evs) onEv(e);
  }
}

/** 所有边缘入口与开放出生点都能走到出口，地面敌人也没被困住 */
function expectAllReachable(w: IWorld) {
  const g = w.state.grid;
  for (const sp of w.state.spawners) {
    if (sp.kind === 'drop') continue;
    if (sp.kind === 'hidden' && !sp.active) continue;
    for (const c of sp.cells) expect(g.dist[c.y * g.cols + c.x]).toBeLessThan(Infinity);
  }
  for (const p of w.currentPaths()) {
    const last = p[p.length - 1];
    expect(g.exits.some((e) => e.x === last.x && e.y === last.y)).toBe(true);
  }
  for (const e of w.state.enemies) {
    if (e.flying) continue;
    const cx = Math.floor(e.x);
    const cy = Math.floor(e.y);
    const i = cy * g.cols + cx;
    if (g.cells[i] === CellKind.Obstacle || g.cells[i] === CellKind.Tower) continue; // 正在离开被占的格子
    expect(g.dist[i]).toBeLessThan(Infinity);
  }
}

/** 蛇形墙（能放就放） */
function buildSnake(w: IWorld) {
  const { cols } = w.state.grid;
  for (const [y, gap] of [
    [3, cols - 1],
    [6, 0],
    [9, cols - 1],
  ] as [number, number][]) {
    for (let x = 0; x < cols; x++) if (x !== gap) w.command({ type: 'place', tower: 'wall', cx: x, cy: y });
  }
}

describe('random layout (doc 09 §5)', () => {
  it('100 seeds per map: all spawners reachable, route 14–30, ≥70% buildable, spacing rules', () => {
    for (const map of MAP_IDS) {
      const def = MAPS[map];
      const special: { x: number; y: number }[] = [...def.exits];
      for (const sp of def.spawners) special.push(...sp.cells);
      for (let i = 0; i < 100; i++) {
        const L = generateLayout(map, `seed-${i}`);
        const c = checkLayout(map, L.obstacles);
        expect(c.reachable).toBe(true);
        for (const r of c.routes) {
          expect(r).toBeGreaterThanOrEqual(14);
          expect(r).toBeLessThanOrEqual(30);
        }
        expect(c.buildable).toBeGreaterThanOrEqual(0.7);
        expect(c.ok).toBe(true);
        // 杂物不压出生点 / 出口，并且离它们至少 1 格；杂物之间至少隔 1 格
        const clutter = L.obstacles.filter((o) => !def.landmarks.some((l) => l.x === o.x && l.y === o.y && l.kind === o.kind));
        for (const o of clutter) {
          for (const s of special) {
            const dx = Math.max(o.x - s.x, 0, s.x - (o.x + o.w - 1));
            const dy = Math.max(o.y - s.y, 0, s.y - (o.y + o.h - 1));
            expect(Math.max(dx, dy)).toBeGreaterThanOrEqual(2);
          }
        }
        for (let a = 0; a < L.obstacles.length; a++)
          for (let b = a + 1; b < L.obstacles.length; b++) {
            const p = L.obstacles[a];
            const q = L.obstacles[b];
            if (!clutter.includes(p) && !clutter.includes(q)) continue;
            const gx = Math.max(p.x - (q.x + q.w), q.x - (p.x + p.w));
            const gy = Math.max(p.y - (q.y + q.h), q.y - (p.y + p.h));
            expect(Math.max(gx, gy)).toBeGreaterThanOrEqual(1);
          }
        // 杂物尺寸 1×1 ～ 2×3
        for (const o of clutter) expect(Math.min(o.w, o.h) <= 2 && Math.max(o.w, o.h) <= 3).toBe(true);
      }
    }
  });

  it('is deterministic per seed, varies across seeds, and fixedLayout returns the hand layout', () => {
    for (const map of MAP_IDS) {
      expect(JSON.stringify(generateLayout(map, 'abc'))).toBe(JSON.stringify(generateLayout(map, 'abc')));
      const set = new Set<string>();
      for (let i = 0; i < 20; i++) set.add(JSON.stringify(generateLayout(map, `v${i}`).obstacles));
      expect(set.size).toBeGreaterThan(10);
      const fixed = generateLayout(map, 'whatever', true);
      expect(fixed.obstacles).toEqual([...MAPS[map].landmarks, ...MAPS[map].defaultClutter]);
      expect(checkLayout(map, fixed.obstacles).reachable).toBe(true);
    }
    // 世界用同一个布局
    const w = createWorld(opts({ seed: 'lay', fixedLayout: false, map: 'ch3' }));
    expect(w.state.grid.obstacles).toEqual(generateLayout('ch3', 'lay').obstacles);
  });

  it('spawners: side entrances open later, preview names a spawner per group', () => {
    const w = createWorld(custom({ lives: 100000, waveGap: 1, waveMax: 3 }, { map: 'ch2' }));
    const ids = w.state.spawners.map((s) => s.id);
    expect(ids).toEqual(['north-1', 'north-2', 'east', 'hidden-1']);
    expect(w.state.spawners.filter((s) => s.active).map((s) => s.id)).toEqual(['north-1', 'north-2']);
    for (const g of w.state.nextWave.groups) expect(['north-1', 'north-2', '*']).toContain(g.spawner);
    // 东入口的格子一开始就不能建造（之后会开放）
    expect(w.canPlace('wall', 11, 3).ok).toBe(false);
    w.command({ type: 'startWave' });
    let guard = 0;
    while (w.state.wave < 30 && guard++ < 60 * 60 * 30) {
      if (w.state.phase === 'perk') w.command({ type: 'choosePerk', id: w.state.perkChoices![0].id });
      w.step();
    }
    expect(w.state.spawners.find((s) => s.id === 'east')!.active).toBe(true);
    expect(w.state.grid.spawns.some((c) => c.x === 11 && c.y === 3)).toBe(true);
  });
});

describe('auto waves (doc 09 §4)', () => {
  it('first wave manual; next wave waveGap seconds after the last spawn; 3/2/1 ticks; not logged', () => {
    const w = createWorld(opts({ seed: 'auto1' }));
    expect(w.state.autoWave.enabled).toBe(true);
    run(w, 600);
    expect(w.state.wave).toBe(0);
    expect(w.state.autoWave.started).toBe(false);
    w.command({ type: 'startWave' });
    expect(w.state.autoWave.started).toBe(true);
    expect(w.state.autoWave.deadline).toBeCloseTo(w.state.time + 60, 6);
    let setAt = -1;
    let nextAt = -1;
    const secs: number[] = [];
    let startAt = -1;
    for (let i = 0; i < 60 * 80 && startAt < 0; i++) {
      w.step();
      if (setAt < 0 && w.state.autoWave.nextAt !== null) {
        setAt = w.state.time;
        nextAt = w.state.autoWave.nextAt;
      }
      for (const e of w.drainEvents()) {
        if (e.type === 'autoWave') secs.push(e.secondsLeft);
        if (e.type === 'waveStart' && e.wave === 2) startAt = w.state.time;
      }
    }
    expect(nextAt - setAt).toBeCloseTo(20, 5);
    expect(startAt).toBeGreaterThan(0);
    expect(Math.abs(startAt - nextAt)).toBeLessThanOrEqual(DT + 1e-6);
    expect(secs).toEqual([3, 2, 1]);
    expect(w.log.filter((l) => l.cmd.type === 'startWave').length).toBe(1);
  });

  it('waveMax forces the next wave; boss gap ×1.5; easy defaults to manual', () => {
    const w = createWorld(custom({ lives: 100000, waveGap: 1000, waveMax: 20 }, { seed: 'auto2' }));
    w.command({ type: 'startWave' });
    const t0 = w.state.time;
    while (w.state.wave < 2) w.step();
    expect(w.state.time - t0).toBeCloseTo(20, 1);

    const b = createWorld(custom({ lives: 100000, waveGap: 10, waveMax: 1000 }, { seed: 'auto3' }));
    b.command({ type: 'startWave' });
    let gapBeforeBoss = 0;
    for (let i = 0; i < 60 * 60 * 20 && b.state.wave < 10; i++) {
      if (b.state.phase === 'perk') b.command({ type: 'choosePerk', id: b.state.perkChoices![0].id });
      const before = b.state.autoWave.nextAt;
      b.step();
      if (b.state.wave === 9 && before === null && b.state.autoWave.nextAt !== null) gapBeforeBoss = b.state.autoWave.nextAt - b.state.time;
    }
    expect(b.state.nextWave.tags.length >= 0).toBe(true);
    expect(gapBeforeBoss).toBeCloseTo(15, 5);

    const e = createWorld(opts({ difficulty: 'easy' }));
    expect(e.state.autoWave.enabled).toBe(false);
    e.command({ type: 'startWave' });
    run(e, 60 * 90);
    expect(e.state.wave).toBe(1);
    expect(createWorld(opts({ difficulty: 'easy', autoWave: true })).state.autoWave.enabled).toBe(true);
    expect(createWorld(opts({ autoWave: false })).state.autoWave.enabled).toBe(false);
  });

  it('blocks at 3 concurrent waves, early start pays remaining × (1 + w/10), perk phase freezes the countdown', () => {
    const w = createWorld(custom({ lives: 1e7, hpMul: 1e5, waveGap: 0.2, waveMax: 0.5 }, { seed: 'auto4' }));
    w.command({ type: 'startWave' });
    run(w, 60 * 3);
    expect(w.state.wave).toBe(3);
    expect(w.state.autoWave.blocked).toBe(true);
    expect(w.command({ type: 'startWave' }).reason).toBe('同时进行的波次太多了');

    const e = createWorld(custom({ lives: 1e7, waveGap: 30, waveMax: 1000 }, { seed: 'auto5' }));
    e.command({ type: 'startWave' });
    while (e.state.autoWave.nextAt === null) e.step();
    run(e, 120);
    const rem = e.state.autoWave.nextAt! - e.state.time;
    const want = Math.floor(rem * (1 + 2 / 10));
    expect(e.state.nextWave.earlyBonus).toBe(want);
    const g0 = e.state.gold;
    expect(e.command({ type: 'startWave' }).ok).toBe(true);
    expect(e.state.gold - g0).toBe(want);
    expect(e.state.wave).toBe(2);

    const p = createWorld(opts({ seed: 'auto6' }));
    p.command({ type: 'startWave' });
    while (p.state.autoWave.nextAt === null) p.step();
    const t = p.state.time;
    const at = p.state.autoWave.nextAt;
    p.state.phase = 'perk';
    run(p, 600);
    expect(p.state.time).toBe(t);
    expect(p.state.autoWave.nextAt).toBe(at);
  });
});

describe('replay determinism with auto waves and events', () => {
  function play(seed: string): World {
    const w = createWorld(
      custom(
        { lives: 100000, startGold: 3000, eventRate: 3, eventHostile: 0.5 },
        {
          seed,
          map: 'ch2',
          fixedLayout: false,
          skills: ['eraser_strike', 'seal_tape', 'relocate'],
        },
      ),
    ) as World;
    const spots: [number, number][] = [
      [3, 3],
      [6, 3],
      [8, 4],
      [4, 9],
      [7, 9],
      [9, 11],
      [2, 11],
    ];
    for (const [x, y] of spots) w.command({ type: 'place', tower: 'pencil', cx: x, cy: y });
    w.command({ type: 'startWave' });
    for (let tick = 0; tick < 60 * 60 * 12; tick++) {
      const s = w.state;
      if (s.phase === 'perk') w.command({ type: 'choosePerk', id: s.perkChoices![0].id });
      if (s.pickups.length && tick % 7 === 0) w.command({ type: 'collect', uid: s.pickups[0].uid });
      if (s.crateChoice) w.command({ type: 'chooseCrate', option: s.crateChoice.options[tick % s.crateChoice.options.length].id });
      if (tick % 300 === 0) {
        const drop = s.spawners.find((k) => k.kind === 'drop');
        if (drop) {
          if (s.skills.find((k) => k.id === 'seal_tape')!.ready) w.command({ type: 'cast', skill: 'seal_tape', spawner: drop.id });
          else if (drop.active) w.command({ type: 'demolishSpawner', id: drop.id });
        }
      }
      w.step();
      w.drainEvents();
    }
    return w;
  }

  it('same seed + command log reproduces state, events and spawners', () => {
    const a = play('replay-x');
    expect(a.state.wave).toBeGreaterThan(15);
    expect(a.state.eventLog.length).toBeGreaterThan(5);
    const b = createWorld({ ...a.state.opts }) as World;
    let li = 0;
    while (b.state.tick < a.state.tick) {
      while (li < a.log.length && a.log[li].tick === b.state.tick) b.command(a.log[li++].cmd);
      b.step();
    }
    expect(stateHash(b)).toBe(stateHash(a));
    expect(JSON.stringify(b.state.eventLog)).toBe(JSON.stringify(a.state.eventLog));
    expect(JSON.stringify(b.state.spawners)).toBe(JSON.stringify(a.state.spawners));
    expect(JSON.stringify(b.state.grid.obstacles)).toBe(JSON.stringify(a.state.grid.obstacles));
    // 自动开波不写入指令记录
    expect(a.log.filter((l) => l.cmd.type === 'startWave').length).toBe(1);
  });

  it('every random event can run (forced) without throwing; toggles disable events', () => {
    for (const id of RANDOM_EVENT_IDS) {
      expect(RANDOM_EVENT_META[id].name.length).toBeGreaterThan(0);
      const w = createWorld(
        custom({ lives: 100000, startGold: 5000, eventRate: 0 }, { seed: `ev-${id}`, map: 'ch3', fixedLayout: false }),
      ) as World;
      for (const [x, y] of [
        [3, 3],
        [6, 3],
        [8, 5],
        [4, 9],
        [7, 9],
        [9, 11],
      ] as [number, number][])
        w.command({ type: 'place', tower: 'lamp', cx: x, cy: y });
      w.command({ type: 'startWave' });
      run(w, 60 * 5);
      const started = w.forceEvent(id);
      if (id !== 'secret_door' && id !== 'tidy') expect(started).toBe(true);
      run(w, 60 * 25, (e) => {
        if (e.type === 'pickup' && e.phase === 'spawn') w.command({ type: 'collect', uid: e.uid });
      });
      if (w.state.crateChoice) expect(w.command({ type: 'chooseCrate', option: w.state.crateChoice.options[0].id }).ok).toBe(true);
      expectAllReachable(w);
      if (started) expect(w.state.eventLog.some((l) => l.id === id)).toBe(true);
    }
    // 关闭全部事件后（即使频率很高）不会发生事件
    const off = Object.fromEntries(RANDOM_EVENT_IDS.map((k) => [k, false]));
    const w = createWorld(custom({ lives: 100000, eventRate: 5 }, { seed: 'off', events: off }));
    w.command({ type: 'startWave' });
    run(w, 60 * 60 * 6);
    expect(w.state.eventLog.length).toBe(0);
  });
});

describe('drop spawners (doc 09 §2)', () => {
  it('never block any path; warning cells cannot be built on; land / demolish / seal', () => {
    let landed = 0;
    for (let k = 0; k < 12; k++) {
      const w = createWorld(
        custom(
          { lives: 1e6, startGold: 1e5, maxDrops: 3, eventRate: 0 },
          { seed: `drop-${k}`, map: MAP_IDS[k % 3], fixedLayout: k % 2 === 0 },
        ),
      ) as World;
      buildSnake(w);
      w.command({ type: 'startWave' });
      run(w, 120);
      for (let d = 0; d < 3; d++) {
        if (!w.forceEvent('drop_box')) {
          // 只有在确实没有合格落点时才会放弃（周围 1 格有塔 / 会堵路）
          expect((w as unknown as { findDropCell(): number }).findDropCell()).toBe(-1);
          break;
        }
        landed++;
        const sp = w.state.spawners.filter((s) => s.kind === 'drop').pop()!;
        expect(sp.active).toBe(false);
        const c = sp.cells[0];
        expect(w.canPlace('wall', c.x, c.y).reason).toBe('出生点即将出现在这里');
        // 预警期间把落点四周都堵上：任何放置都必须保留空降点的出路
        const { cols, rows } = w.state.grid;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) w.command({ type: 'place', tower: 'wall', cx: c.x + dx, cy: c.y + dy });
        for (let y = 0; y < rows; y++)
          for (let x = 0; x < cols; x++) if ((x * 2 + y + d) % 9 === 0) w.command({ type: 'place', tower: 'wall', cx: x, cy: y });
        run(w, 60 * 6);
        expect(sp.active).toBe(true);
        expect(w.state.grid.cells[c.y * cols + c.x]).toBe(CellKind.Obstacle);
        expectAllReachable(w);
        expect(w.currentPaths().some((p) => p[0].x === sp.cells[0].x && p[0].y === sp.cells[0].y)).toBe(true);
      }
      run(w, 60 * 20);
      expectAllReachable(w);
      // 拆除 / 封箱胶带
      const drops = w.state.spawners.filter((s) => s.kind === 'drop' && s.active);
      expect(drops.length).toBeGreaterThan(0);
      const g0 = w.state.gold;
      const cost = 40 + 5 * w.state.wave;
      expect(w.command({ type: 'demolishSpawner', id: drops[0].id }).ok).toBe(true);
      expect(g0 - w.state.gold).toBe(cost);
      if (drops[1]) {
        expect(w.command({ type: 'cast', skill: 'seal_tape', spawner: drops[1].id }).ok).toBe(true);
        expect(w.state.spawners.some((s) => s.id === drops[1].id)).toBe(false);
      }
      expectAllReachable(w);
    }
    expect(landed).toBeGreaterThanOrEqual(24);
  });

  it('enemies come out of a landed drop, and it closes after 2–4 waves', () => {
    const w = createWorld(custom({ lives: 1e6, eventRate: 0, waveGap: 2, waveMax: 20 }, { seed: 'drop-life' })) as World;
    w.command({ type: 'startWave' });
    run(w, 60);
    w.forceEvent('drop_box');
    const sp = w.state.spawners.find((s) => s.kind === 'drop')!;
    run(w, 60 * 6);
    expect(sp.active).toBe(true);
    const until = sp.expiresAfterWave!;
    expect(until - w.state.wave).toBeGreaterThanOrEqual(2);
    expect(until - w.state.wave).toBeLessThanOrEqual(4);
    // 下一波预告里有从空降点出来的敌人
    expect(w.state.nextWave.groups.some((g) => g.spawner === sp.id)).toBe(true);
    let fromDrop = 0;
    let guard = 0;
    while (w.state.spawners.includes(sp) && guard++ < 60 * 60 * 10) {
      if (w.state.phase === 'perk') w.command({ type: 'choosePerk', id: w.state.perkChoices![0].id });
      w.step();
      for (const e of w.drainEvents()) {
        if (e.type === 'spawn') {
          const en = w.state.enemies.find((x) => x.uid === e.enemyUid);
          if (en && Math.floor(en.x) === sp.cells[0].x && Math.floor(en.y) === sp.cells[0].y) fromDrop++;
        }
      }
    }
    expect(fromDrop).toBeGreaterThan(0);
    expect(w.state.spawners.includes(sp)).toBe(false);
    expect(w.state.grid.cells[sp.cells[0].y * 12 + sp.cells[0].x]).toBe(CellKind.Empty);
    expect(SKILL_META.seal_tape.target).toBe('spawner');
    expect(SKILL_META.seal_tape.unlock).toBe('2-1');
  });
});

describe('books fall (doc 09 §3.2)', () => {
  it('never blocks paths and pushes towers to the nearest free cell keeping their level', () => {
    for (let k = 0; k < 15; k++) {
      const w = createWorld(
        custom({ lives: 1e6, startGold: 1e5, eventRate: 0 }, { seed: `books-${k}`, map: MAP_IDS[k % 3], fixedLayout: false }),
      ) as World;
      buildSnake(w);
      // 再随手放一些升过级的攻击塔
      const { cols, rows } = w.state.grid;
      for (let y = 1; y < rows - 1; y++)
        for (let x = 0; x < cols; x++) {
          if ((x * 7 + y * 3 + k) % 5 !== 0) continue;
          if (w.command({ type: 'place', tower: 'pencil', cx: x, cy: y }).ok) {
            const uid = w.state.grid.towerAt[y * cols + x];
            w.command({ type: 'upgrade', uid });
            w.command({ type: 'upgrade', uid });
          }
        }
      w.command({ type: 'startWave' });
      run(w, 200);
      for (let n = 0; n < 4; n++) {
        const before = new Map([...w.state.towers.values()].map((t) => [t.uid, t.level]));
        const moved: number[] = [];
        if (!w.forceEvent('books_fall')) continue;
        run(w, 60 * 5, (e) => {
          if (e.type === 'towerMoved') moved.push(e.uid);
        });
        expectAllReachable(w);
        expect(w.state.towers.size).toBe(before.size);
        for (const t of w.state.towers.values()) {
          expect(t.level).toBe(before.get(t.uid));
          expect(w.state.grid.towerAt[t.cy * cols + t.cx]).toBe(t.uid);
          expect(w.state.grid.cells[t.cy * cols + t.cx]).toBe(CellKind.Tower);
        }
        for (const uid of moved) expect(w.state.towers.has(uid)).toBe(true);
      }
    }
  });

  it('a book landing on a row of towers moves them all', () => {
    const w = createWorld(custom({ lives: 1e6, startGold: 1e5, eventRate: 0 })) as World;
    for (const x of [3, 4, 5]) w.command({ type: 'place', tower: 'pencil', cx: x, cy: 6 });
    const uids = [3, 4, 5].map((x) => w.state.grid.towerAt[6 * 12 + x]);
    w.command({ type: 'upgrade', uid: uids[1] });
    w.drainEvents();
    const ok = (w as unknown as { booksPlan(r: object, c: boolean): boolean }).booksPlan({ x: 3, y: 6, w: 3, h: 1 }, true);
    expect(ok).toBe(true);
    const moved = w.drainEvents().filter((e) => e.type === 'towerMoved');
    expect(moved.length).toBe(3);
    expect(w.state.towers.get(uids[1])!.level).toBe(2);
    for (const x of [3, 4, 5]) expect(w.state.grid.cells[6 * 12 + x]).toBe(CellKind.Obstacle);
    expect(w.state.grid.obstacles.some((o) => o.kind === 'books' && o.x === 3 && o.y === 6 && o.w === 3)).toBe(true);
    expectAllReachable(w);
  });
});

describe('legend evolution (doc 11)', () => {
  function legend(id: TowerId, branch: 'A' | 'B', o: Partial<RunOptions> = {}) {
    const w = createWorld(
      custom(
        { startGold: 1e7, lives: 1e6, eventRate: 0, eliteStart: 1, eliteRate: 1, eliteCap: 1, maxAffix: 2, hpMul: 30 },
        { seed: `evo-${id}-${branch}`, ...o },
      ),
    );
    expect(w.command({ type: 'place', tower: id, cx: 5, cy: 6 }).ok).toBe(true);
    const uid = w.state.grid.towerAt[6 * 12 + 5];
    for (let L = 1; L <= 9; L++) expect(w.command({ type: 'upgrade', uid, branch }).ok).toBe(true);
    return { w, uid };
  }

  it('thresholds, gold costs with xp discount, ★3 gold only, tier 5, refund 25%', () => {
    const { w, uid } = legend('pencil', 'A');
    const t = w.state.towers.get(uid)!;
    expect(t.level).toBe(10);
    expect([t.stars, t.evoXp, t.evoXpNext]).toEqual([0, 0, EVO.xp[0]]);
    const legendCost = rawUpgradeCost(20, 9);
    let info = w.getTowerInfo(uid)!;
    expect(info.evolveCost).toBe(Math.round(legendCost * 0.8));
    expect(info.evoTraits.map((x) => x.unlockLevel)).toEqual([11, 12]);
    expect(info.ability?.id).toBe('pencil_a');
    expect(info.ability?.ready).toBe(false);
    // 经验折扣：进化经验到 50% 时便宜 25%
    t.evoXp = EVO.xp[0] / 2;
    expect(w.getTowerInfo(uid)!.evolveCost).toBe(Math.round(legendCost * 0.8 * 0.75));
    t.evoXp = 0;
    const inv0 = t.invested;
    expect(w.command({ type: 'evolve', uid }).ok).toBe(true);
    expect([t.stars, t.evoXpNext, t.tier]).toEqual([1, EVO.xp[1], 4]);
    expect(t.invested - inv0).toBe(Math.round(legendCost * 0.8));
    // 经验升到 ★2；★2 → ★3 只能花金币：经验到上限后封顶
    t.evoXp = EVO.xp[1];
    (w as unknown as { processEvoXp(t: unknown): void }).processEvoXp(t);
    expect(t.stars).toBe(2);
    expect(t.evoXpNext).toBe(EVO.xp[2]);
    t.evoXp = 99999;
    (w as unknown as { processEvoXp(t: unknown): void }).processEvoXp(t);
    expect(t.stars).toBe(2);
    expect(t.evoXp).toBe(EVO.xp[2]);
    info = w.getTowerInfo(uid)!;
    expect(info.xpCapped).toBe(true);
    expect(info.evolveDiscount).toBeCloseTo(0.5, 6);
    expect(info.evolveCost).toBe(Math.round(legendCost * 1.3 * 0.5));
    expect(w.command({ type: 'evolve', uid }).ok).toBe(true);
    expect([t.stars, t.tier, t.evoXpNext]).toEqual([3, 5, 0]);
    info = w.getTowerInfo(uid)!;
    expect(info.tierName).toContain('神话');
    expect(info.evolveCost).toBeNull();
    expect(info.ability?.ready).toBe(true);
    expect(w.command({ type: 'evolve', uid }).ok).toBe(false);
    run(w, 60 * 6); // 过了撤销时间
    info = w.getTowerInfo(uid)!;
    expect(info.refundRate).toBe(0.25);
    expect(info.sellValue).toBe(Math.floor(t.invested * 0.25));
    // 每颗星 伤害 ×1.12、射程 +0.1、攻击间隔 ×0.97
    const lv10 = legend('pencil', 'A', { seed: 'evo-cmp' });
    const base = lv10.w.getTowerInfo(lv10.uid)!;
    expect(info.range - base.range).toBeCloseTo(3 * EVO.range, 6);
    const dmg = (i: typeof info) => Number(i.stats.find((x) => x.label === '伤害')!.value);
    expect(dmg(info) / dmg(base)).toBeCloseTo(Math.pow(EVO.dmg, 3), 1);
  });

  it('evolution xp comes from combat after Lv10 and gold evolve needs Lv10', () => {
    const w = createWorld(custom({ startGold: 1e7, lives: 1e6, eventRate: 0 }, { seed: 'evo-xp' }));
    w.command({ type: 'place', tower: 'pencil', cx: 5, cy: 2 });
    const uid = w.state.grid.towerAt[2 * 12 + 5];
    expect(w.command({ type: 'evolve', uid }).reason).toBe('升到传奇（Lv10）后才能进化');
    for (let L = 1; L <= 9; L++) w.command({ type: 'upgrade', uid, branch: 'B' });
    w.command({ type: 'startWave' });
    run(w, 60 * 60);
    const t = w.state.towers.get(uid)!;
    expect(t.xp).toBe(0);
    expect(t.evoXp + t.stars * 1).toBeGreaterThan(0);
    const wall = createWorld(custom({ startGold: 1e7 }));
    wall.command({ type: 'place', tower: 'wall', cx: 0, cy: 5 });
    expect(wall.getTowerInfo(wall.state.grid.towerAt[5 * 12])!.evolveCost).toBeNull();
  });

  it('every ★3 ability is castable without throwing and goes on cooldown', () => {
    const ids = Object.keys(EVOLUTION) as TowerId[];
    expect(Object.keys(ABILITY_META).length).toBe(22);
    for (const id of ids) {
      for (const branch of ['A', 'B'] as const) {
        const { w, uid } = legend(id, branch);
        for (let k = 0; k < 3; k++) expect(w.command({ type: 'evolve', uid }).ok).toBe(true);
        w.command({ type: 'place', tower: 'pencil', cx: 6, cy: 6 });
        w.command({ type: 'place', tower: 'pen', cx: 4, cy: 6 });
        const helper = w.state.grid.towerAt[6 * 12 + 6];
        w.command({ type: 'startWave' });
        let guard = 0;
        while (w.state.enemies.filter((e) => e.y > 1.5 && !e.flying).length < 2 && guard++ < 60 * 30) w.step();
        const info = w.getTowerInfo(uid)!;
        const ab = info.ability!;
        expect(ab.ready).toBe(true);
        expect(ABILITY_META[ab.id].name).toBe(ab.name);
        const tgt = w.state.enemies.find((e) => e.elite && !e.boss && !e.hidden) ?? w.state.enemies.find((e) => !e.hidden)!;
        const cmd: Command = {
          type: 'towerAbility',
          uid,
          x: tgt.x,
          y: tgt.y,
          angle: 1,
          axis: 'row',
          index: Math.floor(tgt.y),
          targetUid: ab.target === 'tower' ? helper : tgt.uid,
        };
        let r: { ok: boolean; reason?: string } = { ok: false };
        expect(() => {
          r = w.command(cmd);
        }).not.toThrow();
        if (ab.id !== 'eraser_b' || tgt.elite) expect({ id: ab.id, ...r }).toEqual({ id: ab.id, ok: true });
        if (r.ok) {
          const again = w.command(cmd);
          expect(again.ok).toBe(false);
          const t = w.state.towers.get(uid)!;
          if (ab.id === 'piggy_a') expect(t.abilityCharges).toBe(0);
          else expect(t.abilityCd).toBeCloseTo(ab.cdMax, 6);
        }
        expect(() => run(w, 60 * 12)).not.toThrow();
        // 冷却只在战斗阶段计时
        const t = w.state.towers.get(uid)!;
        if (ab.id !== 'piggy_a' && r.ok) expect(t.abilityCd).toBeLessThan(ab.cdMax);
      }
    }
  });
});
