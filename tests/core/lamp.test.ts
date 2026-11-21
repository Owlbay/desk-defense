import { describe, expect, it } from 'vitest';
import { createWorld, stateHash, type EnemyId, type EnemyState, type GameEvent, type IWorld, type RunOptions } from '../../src/core';
import { BRANCH, LAMP, TOWERS } from '../../src/config/towers';
import { ABILITY_FX } from '../../src/config/evolution';

// 台灯：持续光束 + 递增 + 联动（文档 02 §2.5）
const opts = (o: Partial<RunOptions> = {}): RunOptions => ({
  mode: 'custom', map: 'ch1', difficulty: 'normal', seed: 'lamp', skills: [], fixedLayout: true,
  custom: { startGold: 1e7, lives: 1e6, eventRate: 0 }, autoWave: false, ...o,
});

type LampT = {
  uid: number; cx: number; cy: number; damage: number; beamRamp: number; laserUid: number; disabledUntil: number;
  prism?: number; prismSize?: number; prismLead?: number; prismRelay?: number; prismRole: number; overUntil: number;
  xp: number; evoXp: number; level: number;
};
type Priv = {
  createEnemy(id: EnemyId, wave: number, eff: number, x: number, y: number, cx: number, cy: number, o: object): EnemyState & Record<string, number>;
  rebuildBuckets(): void;
};
const priv = (w: IWorld) => w as unknown as Priv;

function spawn(w: IWorld, x: number, y: number, hp = 1e9, id: EnemyId = 'paperclip') {
  const e = priv(w).createEnemy(id, 1, 30, x, y, Math.floor(x), Math.floor(y), {});
  e.stunUntil = 1e9;
  e.hp = e.maxHp = hp;
  e.armor = 0;
  priv(w).rebuildBuckets();
  return e;
}

function lamp(w: IWorld, cx: number, cy: number, levels = 1, branch?: 'A' | 'B'): LampT {
  const r = w.command({ type: 'place', tower: 'lamp', cx, cy });
  expect(r.ok, `place ${cx},${cy}: ${r.reason}`).toBe(true);
  const uid = w.state.grid.towerAt[cy * w.state.grid.cols + cx];
  for (let l = 1; l < levels; l++) expect(w.command({ type: 'upgrade', uid, branch }).ok).toBe(true);
  return w.state.towers.get(uid) as unknown as LampT;
}

function run(w: IWorld, n: number, on?: (e: GameEvent) => void) {
  for (let i = 0; i < n; i++) {
    w.step();
    for (const e of w.drainEvents()) on?.(e);
  }
}

/** 一排空格（第 6 行起，ch1 固定布局） */
const ROW = 6;
/** 8 座链式台灯（相邻 2 格） */
const POS8: [number, number][] = [[1, 6], [3, 6], [5, 6], [7, 6], [9, 6], [11, 6], [11, 8], [9, 8]];

describe('lamp continuous beam', () => {
  it('ticks every 0.1 s, ramps on the same target and ignores armor', () => {
    const dealt = (armor: number) => {
      const w = createWorld(opts());
      const t = lamp(w, 5, ROW);
      const e = spawn(w, 5.5, ROW - 1.5);
      e.armor = armor;
      let beams = 0;
      run(w, 120, (ev) => { if (ev.type === 'beam' && ev.uid === t.uid) beams++; });
      expect(beams).toBeGreaterThanOrEqual(19);
      expect(beams).toBeLessThanOrEqual(20);
      // 2 秒后递增 = 1 + 0.6 × 2
      expect(t.beamRamp).toBeCloseTo(1 + LAMP.ramp * 2, 1);
      return t.damage;
    };
    const d0 = dealt(0);
    // ∫₀² 13 (1 + 0.6 t) dt = 13 × (2 + 1.2) = 41.6
    expect(d0).toBeGreaterThan(TOWERS.lamp.damage * 3.0);
    expect(d0).toBeLessThan(TOWERS.lamp.damage * 3.3);
    expect(dealt(50)).toBeCloseTo(d0, 6);
  });

  it('ramp caps at ×3 and resets when the target dies', () => {
    const w = createWorld(opts());
    const t = lamp(w, 5, ROW);
    const e = spawn(w, 5.5, ROW - 1.5);
    run(w, 60 * 5);
    expect(t.beamRamp).toBeCloseTo(LAMP.cap, 6);
    spawn(w, 6.5, ROW - 1.5);
    e.hp = 1;
    run(w, 12);
    expect(e.hp).toBeLessThanOrEqual(0);
    expect(t.laserUid).not.toBe(e.uid);
    expect(t.beamRamp).toBeLessThan(1.2);
  });
});

describe('lamp prism link', () => {
  it('groups lamps within link range, chains, caps at 4, deterministic', () => {
    const w = createWorld(opts());
    const ls = [1, 3, 5, 7, 9].map((x) => lamp(w, x, ROW));
    const far = lamp(w, 1, ROW + 3); // 距离 3 > 2.5
    run(w, 1);
    // 5 座链式（相邻 2 格）：前 4 座一组，第 5 座单独
    const g = ls[0].prism!;
    expect(g).toBe(ls[0].uid);
    for (const t of ls.slice(0, 4)) {
      expect(t.prism).toBe(g);
      expect(t.prismSize).toBe(4);
    }
    expect(ls[4].prism).toBe(0);
    expect(far.prism).toBe(0);
    expect(far.prismSize).toBe(1);
  });

  it('helpers relay into the emitter: bonus = Σ relay·k^-decay', () => {
    const w = createWorld(opts());
    const a = lamp(w, 5, ROW);
    const b = lamp(w, 7, ROW);
    const c = lamp(w, 9, ROW);
    // 只在 a 射程内（b、c 没有目标 → 并入 a）
    spawn(w, 3, ROW + 0.5);
    run(w, 6);
    expect(a.prismRole).toBe(1);
    expect(b.prismRole).toBe(2);
    expect(c.prismRole).toBe(2);
    expect(b.prismLead).toBe(a.uid);
    const want = 1 + LAMP.relay + LAMP.relay * Math.pow(2, -LAMP.decay);
    expect(a.prismRelay).toBeCloseTo(want, 6);
    // 辅灯分到伤害统计与经验
    run(w, 60);
    expect(b.damage).toBeGreaterThan(0);
    expect(b.damage / a.damage).toBeCloseTo(LAMP.relay, 4);
    expect(b.xp).toBeGreaterThan(0);
  });

  it('a disabled helper breaks the link', () => {
    const w = createWorld(opts());
    const a = lamp(w, 5, ROW);
    const b = lamp(w, 7, ROW);
    const c = lamp(w, 9, ROW);
    spawn(w, 3, ROW + 0.5);
    run(w, 2);
    expect(a.prismSize).toBe(3);
    b.disabledUntil = w.state.time + 5; // 咖啡渍
    run(w, 2);
    expect(a.prismSize).toBe(1);
    expect(c.prismSize).toBe(1); // b 是链的中间环节
    expect(a.prismRelay).toBe(1);
    run(w, 60 * 6);
    expect(a.prismSize).toBe(3);
  });

  it('the emitter is the lamp whose target is furthest along; ties go to the lower uid', () => {
    const play = () => {
      const w = createWorld(opts());
      const ls = [lamp(w, 5, ROW), lamp(w, 7, ROW)];
      spawn(w, 6, ROW - 1.5);
      run(w, 3);
      return ls.map((t) => t.prismRole).join(',');
    };
    expect(play()).toBe('1,2');
    expect(play()).toBe(play());
  });

  it('a Laser Pointer group has no size cap and the relay keeps growing (8 lamps)', () => {
    const relays: number[] = [];
    const sizes: number[] = [];
    const hashes: string[] = [];
    for (const n of [2, 4, 6, 8]) {
      for (let rep = 0; rep < (n === 8 ? 2 : 1); rep++) {
        const w = createWorld(opts({ seed: 'laser8' }));
        const xs = POS8.slice(0, n);
        const ls = xs.map(([x, y], i) => lamp(w, x, y, i === 0 ? 10 : 1, 'A'));
        spawn(w, 1.5, ROW - 1.5);
        run(w, 6);
        // 主灯是激光笔；其余全部并入
        expect(ls[0].prismRole).toBe(1);
        sizes.push(ls[0].prismSize!);
        if (rep === 0) relays.push(ls[0].prismRelay!);
        run(w, 120);
        hashes.push(stateHash(w));
      }
    }
    expect(sizes).toEqual([2, 4, 6, 8, 8]);
    for (let i = 1; i < relays.length; i++) expect(relays[i]).toBeGreaterThan(relays[i - 1]);
    expect(hashes[3]).toBe(hashes[4]);
    // 同样 8 座、没有激光笔：拆成 4 + 4
    const w = createWorld(opts());
    const ls = POS8.map(([x, y]) => lamp(w, x, y));
    run(w, 1);
    expect(ls[0].prismSize).toBe(4);
    expect(ls[7].prismSize).toBe(4);
    expect(ls[0].prism).not.toBe(ls[7].prism);
    expect(BRANCH.lamp.A.relay).toBeGreaterThan(1);
  });

  it('replays deterministically with lamps, links and a wave', () => {
    const play = () => {
      const w = createWorld(opts({ seed: 'lamprep' }));
      for (const x of [3, 5, 7]) lamp(w, x, ROW, 4);
      w.command({ type: 'startWave' });
      run(w, 60 * 40);
      return stateHash(w);
    };
    expect(play()).toBe(play());
  });
});

describe('lamp mythic abilities', () => {
  const mythic = (w: IWorld, x: number, br: 'A' | 'B') => {
    const t = lamp(w, x, ROW, 10, br);
    for (let k = 0; k < 3; k++) expect(w.command({ type: 'evolve', uid: t.uid }).ok).toBe(true);
    return t;
  };

  it('过载 overcharges the whole group: ramp maxed, beams split', () => {
    const w = createWorld(opts());
    const t = mythic(w, 5, 'A');
    const h = lamp(w, 7, ROW, 4);
    for (let k = 0; k < 6; k++) spawn(w, 3.5 + k * 0.3, ROW - 1.5);
    run(w, 2);
    expect(w.command({ type: 'towerAbility', uid: t.uid }).ok).toBe(true);
    expect(t.overUntil).toBeGreaterThan(w.state.time);
    expect(h.overUntil).toBeGreaterThan(w.state.time);
    const targets = new Set<string>();
    run(w, 6, (ev) => { if (ev.type === 'beam' && ev.uid === t.uid) targets.add(`${ev.tx.toFixed(2)},${ev.ty.toFixed(2)}`); });
    expect(targets.size).toBeGreaterThanOrEqual(ABILITY_FX.lamp_a.beams);
    expect(t.beamRamp).toBeGreaterThan(BRANCH.lamp.A.cap * BRANCH.lamp.A.s1 - 1e-6);
  });

  it('白昼 still castable; 护眼灯 marks targets of its group', () => {
    const w = createWorld(opts());
    const t = mythic(w, 5, 'B');
    lamp(w, 7, ROW);
    const e = spawn(w, 5.5, ROW - 1.5);
    run(w, 12);
    expect(e.litUntil).toBeGreaterThan(w.state.time);
    expect(w.command({ type: 'towerAbility', uid: t.uid }).ok).toBe(true);
  });
});
