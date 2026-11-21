import { describe, expect, it } from 'vitest';

import { ABILITY_FX } from '../../src/config/evolution';
import { SWATTER, TOWERS } from '../../src/config/towers';
import {
  CellKind,
  createWorld,
  type EnemyId,
  type EnemyState,
  type GameEvent,
  type IWorld,
  type RunOptions,
  stateHash,
} from '../../src/core';

// 苍蝇拍（文档 02 §2.12、文档 11 苍蝇拍分支）
const opts = (o: Partial<RunOptions> = {}): RunOptions => ({
  mode: 'custom',
  map: 'ch1',
  difficulty: 'normal',
  seed: 'swat',
  skills: [],
  fixedLayout: true,
  custom: { startGold: 1e7, lives: 1e6, eventRate: 0 },
  autoWave: false,
  ...o,
});

type Priv = {
  createEnemy(
    id: EnemyId,
    wave: number,
    eff: number,
    x: number,
    y: number,
    cx: number,
    cy: number,
    o: object,
  ): EnemyState & Record<string, number>;
  netEnemy(e: EnemyState, dur: number, t: unknown): boolean;
  rebuildBuckets(): void;
};
const priv = (w: IWorld) => w as unknown as Priv;

/** 在 (x,y) 放一个敌人；hold = 定住不动（眩晕） */
function spawn(w: IWorld, id: EnemyId, x: number, y: number, hold = true) {
  const e = priv(w).createEnemy(id, 1, 30, x, y, Math.floor(x), Math.floor(y), {});
  if (hold) e.stunUntil = 1e9;
  priv(w).rebuildBuckets();
  return e;
}

function place(w: IWorld, id: 'swatter' | 'stapler' | 'pencil' | 'wall', cx: number, cy: number, levels = 1, branch?: 'A' | 'B') {
  expect(w.command({ type: 'place', tower: id, cx, cy }).ok).toBe(true);
  const uid = w.state.grid.towerAt[cy * w.state.grid.cols + cx];
  for (let l = 1; l < levels; l++) expect(w.command({ type: 'upgrade', uid, branch }).ok).toBe(true);
  return uid;
}

function run(w: IWorld, n: number, on?: (e: GameEvent) => void) {
  for (let i = 0; i < n; i++) {
    w.step();
    for (const e of w.drainEvents()) on?.(e);
  }
}

describe('swatter (doc 02 §2.12)', () => {
  it('config matches the spec and is unlocked at 1-5', () => {
    const d = TOWERS.swatter;
    expect([d.cost, d.damage, d.interval, d.range, d.hitsAir, d.hitsGround, d.unlock]).toEqual([50, 26, 1.2, 3, true, false, '1-5']);
    const camp = createWorld(opts({ mode: 'campaign' }));
    expect(camp.state.unlockedTowers).not.toContain('swatter');
  });

  it('hits only air, splashes 0.6 cells among flyers, moths cannot dodge', () => {
    const w = createWorld(opts());
    place(w, 'swatter', 5, 6);
    const a = spawn(w, 'plane', 5.5, 4.5);
    const b = spawn(w, 'moth', 5.9, 4.6); // 0.4 格内：被溅到
    const far = spawn(w, 'plane', 7.5, 4.5); // 2 格外：第一拍打不到
    const g = spawn(w, 'crumb', 5.5, 5.5); // 地面：完全打不到
    const hp = [a.hp, b.hp, far.hp, g.hp];
    const swats: GameEvent[] = [];
    let dodges = 0;
    for (let i = 0; i < 200 && swats.length === 0; i++)
      run(w, 1, (e) => {
        if (e.type === 'swat') swats.push(e);
        if (e.type === 'dodge') dodges++;
      });
    expect(swats.length).toBe(1);
    const sw = swats[0] as Extract<GameEvent, { type: 'swat' }>;
    expect(sw.r).toBeCloseTo(SWATTER.splash, 6);
    expect(a.hp).toBeLessThan(hp[0]);
    expect(b.hp).toBeLessThan(hp[1]);
    expect(far.hp).toBe(hp[2]);
    expect(g.hp).toBe(hp[3]);
    // 多拍几次：地面敌人始终没掉血，飞蛾从不闪避
    run(w, 60 * 10, (e) => {
      if (e.type === 'dodge') dodges++;
    });
    expect(g.hp).toBe(hp[3]);
    expect(dodges).toBe(0);
  });

  it('T2 slows hit flyers; T3 swats two different targets', () => {
    const w = createWorld(opts());
    place(w, 'swatter', 5, 6, 7);
    const a = spawn(w, 'plane', 5.5, 4.5);
    const b = spawn(w, 'plane', 3.5, 6.5);
    a.hp = b.hp = a.maxHp = b.maxHp = 1e6;
    const swats: Extract<GameEvent, { type: 'swat' }>[] = [];
    for (let i = 0; i < 200 && swats.length === 0; i++)
      run(w, 1, (e) => {
        if (e.type === 'swat') swats.push(e);
      });
    expect(swats.length).toBe(2);
    expect(swats[0].r).toBeCloseTo(SWATTER.splash + SWATTER.splashT3, 6);
    expect(a.hp).toBeLessThan(1e6);
    expect(b.hp).toBeLessThan(1e6);
    expect(a.slowPct).toBeCloseTo(SWATTER.airSlow, 6);
    expect(a.slowUntil).toBeGreaterThan(w.state.time);
  });

  it('legend A: chain lightning bounces between flyers (★1 +2), stuns, ★2 reaches ground', () => {
    const chainLen = (stars: number, ground: boolean) => {
      const w = createWorld(opts({ seed: `chain-${stars}` }));
      const uid = place(w, 'swatter', 5, 7, 10, 'A');
      for (let k = 0; k < stars; k++) expect(w.command({ type: 'evolve', uid }).ok).toBe(true);
      // 一串飞行敌人，每隔 1.2 格一个（连锁距离 2 格内，拍击范围外）
      // 一圈飞行敌人（半径 1 格，两两都在连锁距离内）
      const flyers = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => spawn(w, 'plane', 5.5 + Math.cos(k * 0.785), 4.5 + Math.sin(k * 0.785)));
      for (const f of flyers) f.hp = f.maxHp = 1e6;
      if (ground) for (const f of flyers.slice(1)) f.dead = true as never;
      const crumbs = ground ? [spawn(w, 'crumb', 6.0, 3.3), spawn(w, 'crumb', 7.3, 3.6)] : [];
      for (const c of crumbs) c.hp = c.maxHp = 1e6;
      priv(w).rebuildBuckets();
      const chains: Extract<GameEvent, { type: 'chain' }>[] = [];
      for (let i = 0; i < 200 && chains.length === 0; i++)
        run(w, 1, (e) => {
          if (e.type === 'chain') chains.push(e);
        });
      return { chains, crumbs, w };
    };
    const c0 = chainLen(0, false);
    expect(c0.chains[0].points.length).toBe(1 + SWATTER.chain);
    const c1 = chainLen(1, false);
    expect(c1.chains[0].points.length).toBe(1 + SWATTER.chain + SWATTER.chainS1);
    const c2 = chainLen(2, true);
    expect(c2.crumbs.some((c) => c.hp < 1e6)).toBe(true);
  });

  it('legend B: every 3rd attack nets a flyer to the ground; it walks the maze, takes ground hits +15%, then flies on', () => {
    const w = createWorld(opts());
    const uid = place(w, 'swatter', 6, 9, 10, 'B');
    const e = spawn(w, 'plane', 6.5, 6.5, false);
    e.hp = e.maxHp = 1e6;
    e.speed = e.baseSpeed = 0.01; // 几乎不动，方便网到
    const t = w.state.towers.get(uid)!;
    (t as unknown as { atkCount: number }).atkCount = SWATTER.netEvery - 1;
    let fired = false;
    for (let i = 0; i < 120 && e.flying; i++)
      run(w, 1, (ev) => {
        if (ev.type === 'fire') fired = true;
      });
    expect(fired).toBe(true);
    expect(e.flying).toBe(false);
    const g = w.state.grid;
    expect(e.netUntil).toBeCloseTo(w.state.time + SWATTER.netDur, 0);
    const cell = Math.floor(e.y) * g.cols + Math.floor(e.x);
    expect(g.cells[cell] === CellKind.Empty || g.cells[cell] === CellKind.Exit || g.cells[cell] === CellKind.Spawn).toBe(true);
    // 地面塔能打它（订书机只打地面），伤害 +15%
    e.speed = e.baseSpeed = 1.5;
    const d0 = g.dist[cell];
    run(w, 60);
    const cell1 = Math.floor(e.y) * g.cols + Math.floor(e.x);
    expect(g.dist[cell1]).toBeLessThan(d0); // 沿流场往出口走
    const st = place(
      w,
      'stapler',
      Math.floor(e.x) + (Math.floor(e.x) < 6 ? 1 : -1),
      Math.floor(e.y) - 1 < 0 ? Math.floor(e.y) + 1 : Math.floor(e.y) - 1,
    );
    const hits: number[] = [];
    run(w, 90, (ev) => {
      if (ev.type === 'hit' && ev.enemyUid === e.uid && e.netUntil > w.state.time) hits.push(ev.amount);
    });
    expect(w.state.towers.get(st)!.damage).toBeGreaterThan(0);
    // 到期：恢复飞行，从当前位置直线飞向出口
    run(w, 60 * 6);
    expect(e.flying).toBe(true);
    expect(e.netUntil).toBe(0);
    const ex = e as unknown as { fx0: number; fy0: number; fx1: number; fy1: number; flyT: number };
    // 飞行起点是网到期时的位置（不会瞬移回原来的航线）
    expect(Math.hypot(ex.fx0 - e.x, ex.fy0 - e.y)).toBeLessThanOrEqual(ex.flyT + 1e-6 + 0.3);
  });

  it('net vulnerability is +15%', () => {
    const w = createWorld(opts());
    const a = spawn(w, 'plane', 6.5, 6.5);
    const b = spawn(w, 'plane', 2.5, 6.5);
    a.hp = a.maxHp = b.hp = b.maxHp = 1e6;
    expect(priv(w).netEnemy(a, 10, null)).toBe(true);
    const dmg = (w as unknown as { damage(e: unknown, n: number, t: null, f: number): number }).damage.bind(w);
    expect(dmg(a, 100, null, 128) / dmg(b, 100, null, 128)).toBeCloseTo(1 + SWATTER.netVuln, 6);
  });

  it('landing on a tower snaps to the nearest walkable cell; no reachable cell → not netted; bosses / unstoppable immune', () => {
    const w = createWorld(opts());
    place(w, 'wall', 4, 6);
    const e = spawn(w, 'plane', 4.5, 6.5);
    expect(priv(w).netEnemy(e, 4, null)).toBe(true);
    const g = w.state.grid;
    const i = Math.floor(e.y) * g.cols + Math.floor(e.x);
    expect(g.cells[i]).not.toBe(CellKind.Tower);
    expect(g.dist[i]).toBeLessThan(Infinity);
    expect(Math.hypot(e.x - 4.5, e.y - 6.5)).toBeLessThanOrEqual(1.01);
    // 有敌人站着的格子不能建塔（被网住的敌人算地面单位）
    expect(w.canPlace('wall', Math.floor(e.x), Math.floor(e.y)).ok).toBe(false);
    // 无处可落：不网
    const f = spawn(w, 'plane', 8.5, 3.5);
    const saved = g.dist.slice();
    g.dist.fill(Infinity);
    expect(priv(w).netEnemy(f, 4, null)).toBe(false);
    expect(f.flying).toBe(true);
    g.dist.set(saved);
    // Boss：捕虫网不网（canNet），免控：免疫
    const u = spawn(w, 'plane', 8.5, 2.5);
    u.unstoppable = 1 as never;
    expect(priv(w).netEnemy(u, 4, null)).toBe(false);
    const bossy = spawn(w, 'plane', 9.5, 2.5);
    bossy.boss = true;
    expect((w as unknown as { canNet(e: unknown, b: boolean): boolean }).canNet(bossy, false)).toBe(false);
  });

  it('★3 abilities: 电网 burns flyers by % max hp, 天网 nets every flyer (boss shorter)', () => {
    const mk = (branch: 'A' | 'B') => {
      const w = createWorld(opts({ seed: `ab-${branch}` }));
      const uid = place(w, 'swatter', 0, 13, 10, branch);
      for (let k = 0; k < 3; k++) expect(w.command({ type: 'evolve', uid }).ok).toBe(true);
      w.command({ type: 'startWave' });
      const fl = [spawn(w, 'plane', 9.5, 2.5), spawn(w, 'moth', 10.5, 4.5), spawn(w, 'plane', 8.5, 5.5)];
      for (const f of fl) f.hp = f.maxHp = 1000;
      fl[2].boss = true;
      return { w, uid, fl };
    };
    const a = mk('A');
    expect(a.w.command({ type: 'towerAbility', uid: a.uid }).ok).toBe(true);
    expect(a.w.command({ type: 'towerAbility', uid: a.uid }).ok).toBe(false);
    run(a.w, 60 * 7);
    const fx = ABILITY_FX.swatter_a;
    expect(a.fl[0].hp).toBeLessThanOrEqual(Math.max(0, 1000 * (1 - 3 * fx.pct)) + 1e-6);
    expect(a.fl[2].hp).toBeLessThanOrEqual(1000 * (1 - 6 * fx.bossPct) + 1e-6); // Boss 按 bossPct（6 秒约 6～7 次）
    expect(a.fl[2].hp).toBeGreaterThanOrEqual(1000 * (1 - 7 * fx.bossPct) - 1e-6);
    expect(a.fl[2].hp).toBeGreaterThan(a.fl[0].hp);
    const b = mk('B');
    expect(b.w.command({ type: 'towerAbility', uid: b.uid }).ok).toBe(true);
    expect(b.fl.every((f) => !f.flying)).toBe(true);
    const now = b.w.state.time;
    expect(b.fl[0].netUntil).toBeCloseTo(now + ABILITY_FX.swatter_b.net, 6);
    expect(b.fl[2].netUntil).toBeCloseTo(now + ABILITY_FX.swatter_b.bossNet, 6);
    run(b.w, Math.ceil(60 * ABILITY_FX.swatter_b.bossNet) + 10);
    expect(b.fl[2].flying || b.fl[2].dead).toBe(true);
  });

  it('netting gives the swatter assist xp when the netted enemy dies', () => {
    const w = createWorld(opts());
    const uid = place(w, 'swatter', 0, 13, 10, 'B');
    const e = spawn(w, 'plane', 6.5, 6.5);
    const t = w.state.towers.get(uid)!;
    priv(w).netEnemy(e, 4, t);
    const ev0 = t.evoXp;
    (w as unknown as { damage(e: unknown, n: number, t: null, f: number): number }).damage(e, 1e6, null, 128);
    expect(t.evoXp).toBeGreaterThan(ev0);
  });

  it('is deterministic with swatters (both branches) in a long endless run', () => {
    const play = () => {
      const w = createWorld({
        mode: 'endless',
        map: 'ch2',
        difficulty: 'normal',
        seed: 'swat-det',
        skills: [],
        fixedLayout: true,
        autoWave: false,
        pure: true,
      });
      w.state.gold = 1e6;
      const free: [number, number][] = [];
      for (let y = 4; y < 10; y++) for (let x = 2; x < 10; x++) if (w.canPlace('swatter', x, y).ok && free.length < 4) free.push([x, y]);
      place(w, 'swatter', free[0][0], free[0][1], 10, 'A');
      place(w, 'swatter', free[1][0], free[1][1], 10, 'B');
      place(w, 'pencil', free[2][0], free[2][1], 5);
      for (let k = 0; k < 2500; k++) {
        if (w.state.phase === 'build') w.command({ type: 'startWave' });
        w.step();
        w.drainEvents();
        if (w.state.wave >= 12 && w.state.phase === 'build') break;
      }
      return stateHash(w);
    };
    expect(play()).toBe(play());
  });
});

describe('small fixes (doc review)', () => {
  const legend = (id: 'lamp' | 'compass', branch: 'A' | 'B', perks: string[] = [], seed = 'fix') => {
    const w = createWorld(opts({ seed }));
    for (const p of perks) w.state.perks.push(p);
    const uid = place(w, id as never, 5, 6, 10, branch);
    return { w, uid };
  };

  it('节能灯泡 boosts the 激光笔 beam dps by 1/0.8', () => {
    const dealt = (perks: string[]) => {
      const { w, uid } = legend('lamp', 'A', perks);
      const e = spawn(w, 'paperclip', 5.5, 4.5);
      e.hp = e.maxHp = 1e9;
      e.armor = 0;
      run(w, 60);
      return w.state.towers.get(uid)!.damage;
    };
    expect(dealt(['bulb']) / dealt([])).toBeCloseTo(1.25, 2);
  });

  it('compass branch B stars add range like every other tower', () => {
    const { w, uid } = legend('compass', 'B');
    const r0 = w.getTowerInfo(uid)!.range;
    for (let k = 0; k < 3; k++) expect(w.command({ type: 'evolve', uid }).ok).toBe(true);
    expect(w.getTowerInfo(uid)!.range - r0).toBeCloseTo(3 * 0.1, 6);
  });

  it('二次元口袋 only grants skills reachable at this point of the run', () => {
    const w = createWorld(opts({ mode: 'campaign', map: 'ch1', skills: ['eraser_strike', 'bell', 'whiteout_zone'], seed: 'pocket' }));
    const apply = (w as unknown as { applyPerk(id: string): void }).applyPerk.bind(w);
    apply('pocket');
    // 第 1 章开局：只剩默认技能里没带的——没有了，所以不会给出第 2、3 章才解锁的技能
    for (const k of w.state.skills) expect(['eraser_strike', 'bell', 'whiteout_zone']).toContain(k.id);
    const w2 = createWorld(opts({ mode: 'campaign', map: 'ch1', skills: ['eraser_strike', 'bell'], seed: 'pocket2' }));
    (w2 as unknown as { applyPerk(id: string): void }).applyPerk('pocket');
    expect(w2.state.skills.map((k) => k.id)).toContain('whiteout_zone');
  });
});
