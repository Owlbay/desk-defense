import { describe, expect, it } from 'vitest';

import { AFFIX_ROLL_IDS, AFFIXES, ENEMIES } from '../../src/config/enemies';
import {
  createWorld,
  type EnemyState,
  eventSeverity,
  type GameEvent,
  goldScale,
  MONSTER_EVENTS,
  RANDOM_EVENT_IDS,
  RANDOM_EVENTS,
  type RandomEventId,
  type RunOptions,
  stateHash,
  type World,
} from '../../src/core';

/** 文档 09 §3.2：怪物类随机事件 */
const NEW_EVENTS: RandomEventId[] = [
  'tea_break',
  'medic_squad',
  'shield_supply',
  'frenzy',
  'goldbag',
  'bounty',
  'golden_elite',
  'training',
];

const opts = (o: Partial<RunOptions> = {}, c: RunOptions['custom'] = {}): RunOptions => ({
  mode: 'custom',
  map: 'ch1',
  difficulty: 'normal',
  seed: 'monster',
  skills: ['eraser_strike', 'bell', 'seal_tape'],
  fixedLayout: true,
  custom: { lives: 100000, startGold: 2000, eventRate: 0, ...c },
  ...o,
});

// 测试里直接调用内部方法（伤害 / 漏怪 / 加经验）
type Internals = {
  damage(e: EnemyState, amount: number, t: unknown, flags: number): number;
  leak(e: EnemyState): void;
  gainXp(t: unknown, amount: number): void;
};
const inner = (w: World) => w as unknown as Internals;

function run(w: World, sec: number, onEv?: (e: GameEvent) => void) {
  for (let i = 0; i < Math.round(sec * 60); i++) {
    w.step();
    const evs = w.drainEvents();
    if (onEv) for (const e of evs) onEv(e);
  }
}

/** 开第一波，跑 sec 秒（场上有敌人） */
function inWave(o: Partial<RunOptions> = {}, c: RunOptions['custom'] = {}, sec = 4): World {
  const w = createWorld(opts(o, c)) as World;
  w.command({ type: 'startWave' });
  run(w, sec);
  return w;
}

const alive = (w: World) => w.state.enemies.filter((e) => e.hp > 0);

describe('monster events: config', () => {
  it('every new event has meta, sane numbers and tone', () => {
    for (const id of NEW_EVENTS) {
      expect(RANDOM_EVENT_IDS).toContain(id);
      const d = RANDOM_EVENTS[id];
      expect(d.weight).toBeGreaterThan(0);
      expect(d.minWave).toBeGreaterThanOrEqual(2);
      expect(d.name.length).toBeGreaterThan(0);
    }
    expect(RANDOM_EVENTS.tea_break.tone).toBe('bad');
    expect(RANDOM_EVENTS.frenzy.tone).toBe('neutral');
    expect(RANDOM_EVENTS.goldbag.tone).toBe('good');
    // golden 只由事件赋予
    expect(AFFIX_ROLL_IDS).not.toContain('golden');
    expect(AFFIXES.golden.excludes).toContain('split');
    expect(ENEMIES.goldbag.lives).toBe(0);
    expect(ENEMIES.goldbag.weight).toBe(0);
    expect(eventSeverity(0.4)).toBeCloseTo(1, 5);
  });
});

describe('monster events: effects', () => {
  it('tea_break regenerates enemies; pen ink halves it', () => {
    const w = inWave();
    const es = alive(w);
    expect(es.length).toBeGreaterThan(1);
    for (const e of es) e.hp = e.maxHp * 0.3;
    (es[0] as EnemyState & { inkStacks: number; inkUntil: number }).inkStacks = 1;
    (es[0] as EnemyState & { inkUntil: number }).inkUntil = 999;
    expect(w.forceEvent('tea_break')).toBe(true);
    run(w, 2 + 1); // 预警 2 秒 + 生效 1 秒
    const rate = MONSTER_EVENTS.teaRegen * eventSeverity(w.state.params.eventHostile);
    const inked = es[0].hp / es[0].maxHp - 0.3;
    const plain = es[1].hp / es[1].maxHp - 0.3;
    expect(plain).toBeGreaterThan(rate * 0.9);
    expect(plain).toBeLessThan(rate * 1.1);
    expect(inked).toBeCloseTo(plain / 2, 2);
    // 结束后不再回血
    run(w, 10);
    const h = es[1].hp;
    run(w, 1);
    expect(es[1].hp).toBeCloseTo(h, 5);
  });

  it('shield_supply gives every enemy a shield of 25% max HP', () => {
    const w = inWave();
    const es = alive(w);
    expect(w.forceEvent('shield_supply')).toBe(true);
    run(w, 2.1);
    for (const e of es) {
      if (e.hp <= 0) continue;
      expect(e.shield).toBeCloseTo(e.maxHp * MONSTER_EVENTS.shieldRatio * eventSeverity(w.state.params.eventHostile), 3);
    }
  });

  it('medic_squad spawns correction-fluid healers from one spawner', () => {
    const w = inWave();
    let n = 0;
    expect(w.forceEvent('medic_squad')).toBe(true);
    run(w, 8, (e) => {
      if (e.type === 'spawn' && e.enemy === 'whiteout') n++;
    });
    expect(n).toBe(MONSTER_EVENTS.medicBase);
  });

  it('frenzy: +30% speed and ×1.5 kill gold; bounty: ×2 kill gold', () => {
    const w = inWave();
    const e = alive(w)[0];
    const base = e.speed;
    expect(w.forceEvent('frenzy')).toBe(true);
    run(w, 2.1);
    expect(e.speed).toBeCloseTo(base * MONSTER_EVENTS.frenzySpeed, 5);
    const muls: number[] = [];
    inner(w).damage(alive(w)[0], 1e6, null, 0);
    for (const ev of w.drainEvents()) if (ev.type === 'death') muls.push(ev.goldMul ?? 1);
    expect(muls).toEqual([MONSTER_EVENTS.frenzyGold]);
    run(w, 13);
    expect(alive(w)[0]?.speed ?? base).toBeCloseTo(base, 5);

    const b = inWave({ seed: 'bounty' });
    expect(b.forceEvent('bounty')).toBe(true);
    const g0 = b.state.gold;
    const v = alive(b)[0];
    inner(b).damage(v, 1e6, null, 0);
    const d = b.drainEvents().find((x) => x.type === 'death');
    expect(d && d.type === 'death' && d.goldMul).toBe(2);
    expect(b.state.gold - g0).toBeGreaterThanOrEqual(Math.floor((v as unknown as { bounty: number }).bounty * 2) - 1);
  });

  it('training doubles tower XP while active', () => {
    const w = createWorld(opts()) as World;
    w.command({ type: 'place', tower: 'pencil', cx: 2, cy: 2 });
    const t = [...w.state.towers.values()][0];
    w.command({ type: 'startWave' });
    run(w, 1);
    const x0 = t.xp;
    inner(w).gainXp(t, 2);
    const plain = t.xp - x0;
    expect(w.forceEvent('training')).toBe(true);
    const x1 = t.xp;
    inner(w).gainXp(t, 2);
    expect(t.xp - x1).toBeCloseTo(plain * MONSTER_EVENTS.trainingXp, 5);
    run(w, 21);
    const x2 = t.xp;
    inner(w).gainXp(t, 2);
    expect(t.xp - x2).toBeCloseTo(plain, 5);
  });
});

describe('goldbag (doc 09 §3.2)', () => {
  function withBag(seed = 'bag') {
    const w = inWave({ seed });
    expect(w.forceEvent('goldbag')).toBe(true);
    let bag: EnemyState | undefined;
    for (let i = 0; i < 300 && !bag; i++) {
      run(w, 1 / 60);
      bag = w.state.enemies.find((e) => e.id === 'goldbag');
    }
    expect(bag).toBeTruthy();
    return { w, bag: bag! };
  }

  it('kill → coin pickups worth the burst + no lives lost; coins collectible', () => {
    const { w, bag } = withBag();
    const lives = w.state.lives;
    const n0 = w.state.pickups.length;
    inner(w).damage(bag, 1e7, null, 0);
    const coins = w.state.pickups.slice(n0);
    const G = MONSTER_EVENTS.goldbag;
    expect(coins.length).toBeGreaterThanOrEqual(G.coinsMin);
    expect(coins.length).toBeLessThanOrEqual(G.coinsMax);
    const total = coins.reduce((s, p) => s + p.value, 0);
    const want = G.burst * goldScale(w.state.params, w.state.wave);
    expect(total).toBeGreaterThan(want * 0.8);
    expect(total).toBeLessThan(want * 1.25);
    const g0 = w.state.gold;
    for (const p of coins) expect(w.command({ type: 'collect', uid: p.uid }).ok).toBe(true);
    expect(w.state.gold - g0).toBeGreaterThanOrEqual(total - 1);
    expect(w.state.lives).toBe(lives);
  });

  it('leak → steals max(15, 8% gold), costs no lives', () => {
    const { w, bag } = withBag('bag-leak');
    const lives = w.state.lives;
    const g0 = w.state.gold;
    inner(w).leak(bag);
    const G = MONSTER_EVENTS.goldbag;
    expect(g0 - w.state.gold).toBe(Math.max(G.stealMin, Math.floor(g0 * G.stealPct)));
    expect(w.state.lives).toBe(lives);
  });

  it('regenerates after 2 s without hits; walks off on its own (cannot be farmed by stalling)', () => {
    const { w, bag } = withBag('bag-regen');
    inner(w).damage(bag, bag.maxHp * 0.5, null, 0);
    const h0 = bag.hp;
    run(w, 1.5);
    expect(bag.hp).toBeCloseTo(h0, 5);
    run(w, 1.5);
    expect(bag.hp).toBeGreaterThan(h0);
    // 没有塔：袋怪自己跑掉（偷钱），不会一直留在场上
    let leaked = false;
    run(w, 60, (e) => {
      if (e.type === 'leak' && e.enemy === 'goldbag') leaked = true;
    });
    expect(leaked).toBe(true);
    expect(w.state.enemies.some((e) => e.id === 'goldbag')).toBe(false);
  });
});

describe('golden elite', () => {
  it('converts one upcoming enemy into a golden elite that drops coins', () => {
    const w = inWave({}, {}, 1);
    expect(w.forceEvent('golden_elite')).toBe(true);
    let g: EnemyState | undefined;
    for (let i = 0; i < 60 * 15 && !g; i++) {
      run(w, 1 / 60);
      g = w.state.enemies.find((e) => e.affixes.includes('golden'));
    }
    expect(g).toBeTruthy();
    expect(g!.elite).toBe(true);
    expect(g!.affixes).not.toContain('split');
    const n0 = w.state.pickups.length;
    inner(w).damage(g!, 1e7, null, 0);
    expect(w.state.pickups.length - n0).toBe(MONSTER_EVENTS.golden.coins);
  });
});

describe('monster events: determinism', () => {
  function play(seed: string): World {
    const only = Object.fromEntries(RANDOM_EVENT_IDS.map((k) => [k, NEW_EVENTS.includes(k)]));
    const w = createWorld(
      opts({ seed, map: 'ch2', fixedLayout: false, events: only }, { eventRate: 3, eventHostile: 0.5, startGold: 3000 }),
    ) as World;
    for (const [x, y] of [
      [3, 3],
      [6, 3],
      [8, 4],
      [4, 9],
      [7, 9],
      [9, 11],
    ] as [number, number][])
      w.command({ type: 'place', tower: 'pencil', cx: x, cy: y });
    w.command({ type: 'startWave' });
    for (let tick = 0; tick < 60 * 60 * 8; tick++) {
      const s = w.state;
      if (s.phase === 'perk') w.command({ type: 'choosePerk', id: s.perkChoices![0].id });
      if (s.pickups.length && tick % 5 === 0) w.command({ type: 'collect', uid: s.pickups[0].uid });
      w.step();
      w.drainEvents();
    }
    return w;
  }

  it('same seed + command log reproduces state with the new events', () => {
    const a = play('monster-replay');
    const ids = new Set(a.state.eventLog.map((l) => l.id));
    expect([...ids].every((id) => NEW_EVENTS.includes(id))).toBe(true);
    expect(ids.size).toBeGreaterThanOrEqual(4);
    const b = createWorld({ ...a.state.opts }) as World;
    let li = 0;
    while (b.state.tick < a.state.tick) {
      while (li < a.log.length && a.log[li].tick === b.state.tick) b.command(a.log[li++].cmd);
      b.step();
    }
    expect(stateHash(b)).toBe(stateHash(a));
    expect(JSON.stringify(b.state.eventLog)).toBe(JSON.stringify(a.state.eventLog));
  });
});
