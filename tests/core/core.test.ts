import { describe, expect, it } from 'vitest';
import {
  CellKind, DT, abyssParams, createWorld, generateWave, rawUpgradeCost, refundRate, resolveParams, stateHash, xpForLevel,
  DIFFICULTY_PRESETS, type RunOptions, type IWorld, type Command,
} from '../../src/core';
import { computeDist, nextCell } from '../../src/core/flowfield';

// 固定布局（杂物位置与旧版地图一致），便于按坐标断言
const base = (o: Partial<RunOptions> = {}): RunOptions => ({
  mode: 'endless', map: 'ch1', difficulty: 'normal', seed: 'test-seed', skills: ['eraser_strike', 'bell', 'whiteout_zone'], fixedLayout: true, ...o,
});
const rich = (o: Partial<RunOptions> = {}) => base({ mode: 'custom', custom: { startGold: 100000 }, ...o });

function run(w: IWorld, n: number) {
  for (let i = 0; i < n; i++) w.step();
}

describe('flow field', () => {
  it('computes distances with 1 / 1.414 costs', () => {
    const cells = new Uint8Array(4 * 4);
    const d = computeDist(4, 4, cells, [{ x: 0, y: 0 }], new Float32Array(16));
    expect(d[0]).toBe(0);
    expect(d[1]).toBe(1);
    expect(d[5]).toBeCloseTo(1.414, 3);
    expect(d[15]).toBeCloseTo(3 * 1.414, 3);
  });

  it('does not cut corners', () => {
    const cells = new Uint8Array(3 * 3);
    cells[1] = CellKind.Tower; // (1,0)
    const d = computeDist(3, 3, cells, [{ x: 0, y: 0 }], new Float32Array(9));
    // (1,1) 不能斜穿 (0,0)：必须经 (0,1) 走 2 步
    expect(d[4]).toBeCloseTo(2, 5);
    expect(nextCell(3, 3, cells, d, 4)).toBe(3);
  });

  it('marks unreachable cells as Infinity', () => {
    const cells = new Uint8Array(3 * 3);
    cells[1] = CellKind.Tower;
    cells[3] = CellKind.Tower;
    cells[4] = CellKind.Tower;
    const d = computeDist(3, 3, cells, [{ x: 0, y: 0 }], new Float32Array(9));
    expect(d[8]).toBe(Infinity);
  });
});

describe('placement', () => {
  it('rejects spawn / exit / obstacle / occupied cells', () => {
    const w = createWorld(rich());
    expect(w.canPlace('wall', 5, 0).ok).toBe(false);
    expect(w.canPlace('wall', 5, 13).ok).toBe(false);
    expect(w.canPlace('wall', 8, 3).reason).toBe('这里不能建造');
    expect(w.command({ type: 'place', tower: 'wall', cx: 0, cy: 5 }).ok).toBe(true);
    expect(w.canPlace('wall', 0, 5).reason).toBe('已经有塔了');
  });

  it('rejects placements that block the road', () => {
    const w = createWorld(rich());
    for (let x = 0; x < 12; x++) {
      if (x === 11) continue;
      expect(w.command({ type: 'place', tower: 'wall', cx: x, cy: 6 }).ok).toBe(true);
    }
    const r = w.canPlace('wall', 11, 6);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('会堵死道路');
    expect(w.previewPath('wall', 11, 6)).toBeNull();
    const paths = w.currentPaths();
    expect(paths.length).toBe(1);
    expect(paths[0].some((c) => c.x === 11 && c.y === 6)).toBe(true);
    const ev = w.drainEvents();
    w.command({ type: 'place', tower: 'wall', cx: 11, cy: 6 });
    expect(w.drainEvents().some((e) => e.type === 'toast')).toBe(true);
    void ev;
  });

  it('rejects enemy current / target cells and trapping enemies', () => {
    const w = createWorld(rich());
    w.command({ type: 'startWave' });
    let e = w.state.enemies[0];
    for (let i = 0; i < 200 && !e; i++) {
      w.step();
      e = w.state.enemies[0];
    }
    run(w, 30);
    e = w.state.enemies[0];
    const cx = Math.floor(e.x);
    const cy = Math.floor(e.y);
    expect(w.canPlace('wall', cx, cy).reason).toBe('有敌人在这里');
  });
});

describe('economy & leveling', () => {
  it('pencil upgrade costs match the doc table', () => {
    const want = [12, 29, 47, 68, 90, 113, 137, 161, 281];
    for (let L = 1; L <= 9; L++) expect(Math.round(rawUpgradeCost(20, L))).toBe(want[L - 1]);
    const w = createWorld(rich());
    w.command({ type: 'place', tower: 'pencil', cx: 0, cy: 5 });
    const uid = [...w.state.towers.keys()][0];
    for (let L = 1; L <= 9; L++) {
      const info = w.getTowerInfo(uid)!;
      expect(info.level).toBe(L);
      expect(info.upgradeCost).toBe(want[L - 1]);
      expect(info.needsBranch).toBe(L === 9);
      if (L === 9) expect(w.command({ type: 'upgrade', uid }).ok).toBe(false);
      expect(w.command({ type: 'upgrade', uid, branch: 'A' }).ok).toBe(true);
    }
    const info = w.getTowerInfo(uid)!;
    expect(info.level).toBe(10);
    expect(info.tier).toBe(4);
    expect(info.tierName).toContain('自动铅笔');
    expect(info.upgradeCost).toBeNull();
  });

  it('xp thresholds', () => {
    expect(xpForLevel(1)).toBe(30);
    expect(xpForLevel(5)).toBe(462);
    expect(xpForLevel(8)).toBe(1029);
  });

  it('refund rates by level', () => {
    const want = [0.7, 0.65, 0.6, 0.55, 0.5, 0.45, 0.4, 0.35, 0.3, 0.25];
    for (let L = 1; L <= 10; L++) expect(refundRate(L)).toBeCloseTo(want[L - 1], 6);
  });

  it('undo gives a full refund within 5 seconds, then the level rate applies', () => {
    const w = createWorld(base());
    const g0 = w.state.gold;
    w.command({ type: 'place', tower: 'pencil', cx: 0, cy: 5 });
    const uid = [...w.state.towers.keys()][0];
    expect(w.getTowerInfo(uid)!.canUndo).toBe(true);
    w.command({ type: 'sell', uid });
    expect(w.state.gold).toBe(g0);

    w.command({ type: 'place', tower: 'pencil', cx: 0, cy: 5 });
    const uid2 = [...w.state.towers.keys()][0];
    run(w, Math.ceil(5.1 / DT));
    const info = w.getTowerInfo(uid2)!;
    expect(info.canUndo).toBe(false);
    expect(info.sellValue).toBe(14);
    w.command({ type: 'sell', uid: uid2 });
    expect(w.state.gold).toBe(g0 - 20 + 14);
  });

  it('sell refund counts only invested gold', () => {
    const w = createWorld(rich());
    w.command({ type: 'place', tower: 'pencil', cx: 0, cy: 5 });
    const uid = [...w.state.towers.keys()][0];
    w.command({ type: 'upgrade', uid });
    run(w, 400);
    const info = w.getTowerInfo(uid)!;
    expect(info.sellValue).toBe(Math.floor((20 + 12) * 0.65));
  });
});

describe('determinism', () => {
  function scripted(seed: string): IWorld {
    const w = createWorld(base({ seed, fixedLayout: false }));
    const plan: [number, Command][] = [
      [0, { type: 'place', tower: 'pencil', cx: 4, cy: 2 }],
      [0, { type: 'place', tower: 'pencil', cx: 7, cy: 2 }],
      [1, { type: 'place', tower: 'glue', cx: 4, cy: 5 }],
      [2, { type: 'startWave' }],
      [400, { type: 'cast', skill: 'eraser_strike', x: 6, y: 4 }],
      [900, { type: 'startWave' }],
    ];
    for (let tick = 0; tick < 3000; tick++) {
      for (const [t, c] of plan) if (t === tick) w.command(c);
      if (w.state.phase === 'build' && tick > 900) w.command({ type: 'startWave' });
      w.step();
    }
    return w;
  }

  it('same seed + same commands => identical state', () => {
    const a = scripted('alpha');
    const b = scripted('alpha');
    expect(stateHash(a)).toBe(stateHash(b));
    expect(a.state.wave).toBeGreaterThan(1);
  });

  it('replaying the command log reproduces the state', () => {
    const a = scripted('beta');
    const b = createWorld(base({ seed: 'beta', fixedLayout: false }));
    const log = a.log.slice();
    let li = 0;
    while (b.state.tick < a.state.tick) {
      while (li < log.length && log[li].tick === b.state.tick) b.command(log[li++].cmd);
      b.step();
    }
    expect(stateHash(b)).toBe(stateHash(a));
  });

  it('wave generation is deterministic per seed', () => {
    const ctx = { seed: 'gen', mode: 'endless' as const, map: 'ch2' as const, params: DIFFICULTY_PRESETS.nightmare };
    for (const wv of [1, 7, 10, 25, 50, 100]) {
      expect(JSON.stringify(generateWave(ctx, wv))).toBe(JSON.stringify(generateWave(ctx, wv)));
    }
    const other = { ...ctx, seed: 'gen2' };
    expect(JSON.stringify(generateWave(ctx, 35))).not.toBe(JSON.stringify(generateWave(other, 35)));
    const w50 = generateWave(ctx, 50);
    expect(w50.tags).toContain('boss');
    expect(w50.entries.filter((e) => e.enemy.startsWith('boss')).length).toBe(2);
    expect(generateWave(ctx, 100).entries.filter((e) => e.enemy.startsWith('boss')).length).toBe(3);
    expect(generateWave(ctx, 14).tags).toContain('air');
    expect(generateWave(ctx, 15).tags).toContain('rush');
  });

  it('next wave preview matches the spawned wave', () => {
    const w = createWorld(base({ seed: 'prev' }));
    const pv = JSON.stringify(w.state.nextWave.groups);
    w.command({ type: 'startWave' });
    run(w, 60 * 30);
    const counts: Record<string, number> = {};
    for (const g of JSON.parse(pv) as { enemy: string; count: number }[]) counts[g.enemy] = g.count;
    expect(w.state.stats.kills + w.state.stats.leaks + w.state.enemies.length).toBeGreaterThanOrEqual(counts.crumb ?? 0);
  });
});

describe('difficulty params', () => {
  it('abyss I equals the base row and abyss X applies increments and limits', () => {
    const a1 = abyssParams(1);
    expect(a1.hpMul).toBe(1.2);
    expect(a1.lives).toBe(10);
    const a10 = resolveParams(base({ difficulty: 'abyss', abyssLevel: 10 }));
    expect(a10.hpMul).toBeCloseTo(2.1, 6);
    expect(a10.hpLinear).toBeCloseTo(0.29, 6);
    expect(a10.hpExp).toBeCloseTo(1.057, 6);
    expect(a10.lives).toBe(6);
    expect(a10.armorStep).toBe(4);
    expect(a10.speedMul).toBeCloseTo(1.24, 6);
    expect(a10.rewardMul).toBeCloseTo(0.77, 6);
    expect(a10.xpMul).toBeCloseTo(0.67, 6);
    expect(a10.eliteStart).toBeCloseTo(7.5, 6);
    expect(a10.eliteCap).toBeCloseTo(0.7, 6);
    expect(a10.maxAffix).toBe(4);
    expect(abyssParams(4).maxAffix).toBe(3);
    expect(a10.scoreMul).toBeCloseTo(7.5, 6);
    expect(a10.bossHpMul).toBeCloseTo(2.1, 6);
  });

  it('custom overrides apply on top of the preset', () => {
    const p = resolveParams(base({ mode: 'custom', difficulty: 'hard', custom: { lives: 3, hpMul: 9 } }));
    expect(p.lives).toBe(3);
    expect(p.hpMul).toBe(9);
    expect(p.armorStep).toBe(10);
  });

  it('talents apply unless pure', () => {
    const t = { wallet: 2, bandaid: 3 } as const;
    expect(createWorld(base({ talents: t })).state.gold).toBe(165);
    expect(createWorld(base({ talents: t })).state.lives).toBe(23);
    expect(createWorld(base({ talents: t, pure: true })).state.gold).toBe(150);
  });
});

describe('campaign', () => {
  it('unlocks towers by chapter-wave code', () => {
    const w = createWorld(base({ mode: 'campaign', map: 'ch2' }));
    expect(w.state.totalWaves).toBe(20);
    expect(w.state.unlockedTowers).toContain('lamp');
    expect(w.state.unlockedTowers).toContain('compass');
    expect(w.state.unlockedTowers).not.toContain('eraser');
    expect(w.state.unlockedTowers).not.toContain('pen');
    expect(w.canPlace('eraser', 0, 5).reason).toBe('尚未解锁');
  });
});

describe('skills & perks', () => {
  it('relocate keeps level / xp and consumes a charge', () => {
    const w = createWorld(rich({ skills: ['relocate', 'inspiration', 'scholarship'] }));
    w.command({ type: 'place', tower: 'pencil', cx: 0, cy: 5 });
    const uid = [...w.state.towers.keys()][0];
    w.command({ type: 'upgrade', uid });
    w.command({ type: 'upgrade', uid });
    expect(w.command({ type: 'cast', skill: 'inspiration', uid }).ok).toBe(true);
    const xp = w.state.towers.get(uid)!.xp;
    expect(xp).toBeGreaterThan(0);
    expect(w.command({ type: 'cast', skill: 'relocate', uid, cx: 3, cy: 9 }).ok).toBe(true);
    const t = w.state.towers.get(uid)!;
    expect([t.cx, t.cy, t.level, t.xp]).toEqual([3, 9, 3, xp]);
    expect(w.state.grid.towerAt[5 * 12 + 0]).toBe(0);
    expect(w.state.skills.find((s) => s.id === 'relocate')!.charges).toBe(1);
    const g = w.state.gold;
    expect(w.command({ type: 'cast', skill: 'scholarship' }).ok).toBe(true);
    expect(w.state.gold).toBe(g + 35);
    expect(w.command({ type: 'cast', skill: 'scholarship' }).reason).toBe('技能冷却中');
  });

  it('offers perks after wave 10 in endless and applies them', () => {
    // 手动开波：自动波次会让第 11 波在第 10 波结束前开始
    const w = createWorld(base({ mode: 'custom', custom: { lives: 100000 }, seed: 'perk', autoWave: false }));
    let guard = 0;
    while (w.state.phase !== 'perk' && guard++ < 60 * 60 * 20) {
      if (w.state.phase === 'build') w.command({ type: 'startWave' });
      w.step();
    }
    expect(w.state.phase).toBe('perk');
    expect(w.state.wave).toBe(10);
    const cards = w.state.perkChoices!;
    expect(cards.length).toBe(3);
    const g = w.state.gold;
    expect(w.command({ type: 'rerollPerks' }).ok).toBe(g >= 50);
    const pick = w.state.perkChoices!.find((c) => !c.needsTower)!;
    expect(w.command({ type: 'choosePerk', id: pick.id }).ok).toBe(true);
    expect(w.state.perks).toContain(pick.id);
    expect(w.state.phase).toBe('build');
  });

  it('legend perk with a branch goes straight to Lv10 at half the legend cost; without a branch keeps Lv9 + half price', () => {
    const setup = () => {
      const w = createWorld(rich({ seed: 'legend' }));
      expect(w.command({ type: 'place', tower: 'pencil', cx: 0, cy: 5 }).ok).toBe(true);
      const uid = [...w.state.towers.keys()][0];
      // 先把塔升到 Lv7
      for (let i = 0; i < 6; i++) expect(w.command({ type: 'upgrade', uid }).ok).toBe(true);
      expect(w.state.towers.get(uid)!.level).toBe(7);
      // 强制进入选增益阶段
      w.state.phase = 'perk';
      w.state.perkChoices = [{ id: 'legend', name: '传奇在望', desc: '', rarity: 'epic', needsTower: true }];
      return { w, uid };
    };
    const half = Math.round(rawUpgradeCost(20, 9) * 0.5);
    // 带分支：直接 Lv10，扣一半传奇费用
    {
      const { w, uid } = setup();
      const info7 = w.getTowerInfo(uid)!;
      expect(info7.branches?.A.name).toBe('自动铅笔');
      expect(info7.branches?.B.name).toBe('彩色铅笔');
      const g = w.state.gold;
      const inv = w.state.towers.get(uid)!.invested;
      expect(w.command({ type: 'choosePerk', id: 'legend', uid, branch: 'B' }).ok).toBe(true);
      const t = w.state.towers.get(uid)!;
      expect(t.level).toBe(10);
      expect(t.branch).toBe('B');
      expect(t.tier).toBe(4);
      expect(g - w.state.gold).toBe(half);
      expect(t.invested - inv).toBe(half);
      expect(w.getTowerInfo(uid)!.upgradeCost).toBeNull();
      expect(w.getTowerInfo(uid)!.branches).toBeDefined();
    }
    // 不带分支：Lv9 + 传奇费用减半
    {
      const { w, uid } = setup();
      const g = w.state.gold;
      expect(w.command({ type: 'choosePerk', id: 'legend', uid }).ok).toBe(true);
      const t = w.state.towers.get(uid)!;
      expect(t.level).toBe(9);
      expect(w.state.gold).toBe(g);
      const info = w.getTowerInfo(uid)!;
      expect(info.needsBranch).toBe(true);
      expect(info.upgradeCost).toBe(half);
    }
    // 金币不足时带分支失败，状态不变
    {
      const { w, uid } = setup();
      w.state.gold = 10;
      expect(w.command({ type: 'choosePerk', id: 'legend', uid, branch: 'A' }).ok).toBe(false);
      expect(w.state.towers.get(uid)!.level).toBe(7);
      expect(w.state.phase).toBe('perk');
    }
  });
});

describe('leaderboard score fields', () => {
  it('stats.cleared / stats.bonus reproduce state.score via computeScore at game over', async () => {
    const { computeScore } = await import('../../src/shared/leaderboard');
    // 少量生命、不建塔：很快结束；跑到结束（或兜底步数）
    for (const o of [base({ seed: 'lb-1', custom: { lives: 3 }, mode: 'custom' }), base({ seed: 'lb-2', mode: 'campaign', difficulty: 'hard' })]) {
      const w = createWorld(o);
      w.command({ type: 'place', tower: 'pencil', cx: 5, cy: 5 });
      for (let i = 0; i < 60 * 60 * 30 && w.state.phase !== 'lost' && w.state.phase !== 'won'; i++) {
        if (w.state.phase === 'perk') { w.command({ type: 'choosePerk', id: w.state.perkChoices![0].id }); continue; }
        if (w.state.phase === 'build') w.command({ type: 'startWave' });
        w.step();
        w.drainEvents();
      }
      const s = w.state;
      expect(s.phase === 'lost' || s.phase === 'won').toBe(true);
      expect(s.stats.cleared).toBeGreaterThanOrEqual(0);
      expect(s.stats.bonus).toBeGreaterThanOrEqual(0);
      expect(computeScore({ cleared: s.stats.cleared, kills: s.stats.kills, lives: s.lives, gold: s.gold, bonus: s.stats.bonus }, s.params.scoreMul)).toBe(s.score);
    }
  });
});
