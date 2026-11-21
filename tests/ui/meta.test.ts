import { describe, expect, it } from 'vitest';

import type { DifficultyParams, RunOptions } from '../../src/core/types';
import { CUSTOM_FIELDS, decodeShare, ELITE_OFF, encodeShare, paramValue, sanitizeParams, sliderValue } from '../../src/meta/custom';
import { makeMidRun, replaySync, type ReplayWorld } from '../../src/meta/midrun';
import { defaultProfile, loadProfile, normalizeProfile, PROFILE_KEY, ProfileStore, saveProfile } from '../../src/meta/profile';
import {
  buyTalent,
  campaignDiffUnlocked,
  chapterUnlocked,
  customUnlocked,
  defaultAutoWave,
  difficultyUnlocked,
  effectiveAutoWave,
  endlessMaps,
  endlessUnlocked,
  inkFor,
  insertLeader,
  leaderKey,
  maxAbyssLevel,
  recordCampaignClear,
  resolveLoadout,
  settleRun,
  skillSlots,
  starsFor,
  unlockReached,
  upgradeSkill,
} from '../../src/meta/progress';
import { type KV, memoryStorage } from '../../src/meta/storage';

const NORMAL: DifficultyParams = {
  startGold: 150,
  lives: 20,
  hpMul: 1,
  hpLinear: 0.18,
  hpExp: 1.04,
  countMul: 1,
  countGrowth: 0.08,
  speedMul: 1,
  armorStep: 12,
  rewardMul: 1,
  xpMul: 1,
  eliteStart: 30,
  eliteRate: 0.004,
  eliteCap: 0.15,
  maxAffix: 1,
  bossHpMul: 1,
  skillCdMul: 1,
  interestCap: 20,
  scoreMul: 1,
  spawnMode: 'roundRobin',
  maxActiveSpawners: 2,
  maxDrops: 1,
  dropWarn: 5,
  eventRate: 1,
  eventHostile: 0.5,
  waveGap: 15,
  waveMax: 60,
};

const endlessOpts = (over: Partial<RunOptions> = {}): RunOptions => ({
  mode: 'endless',
  map: 'ch1',
  difficulty: 'normal',
  skills: ['bell'],
  ...over,
});

describe('profile save/load', () => {
  it('round-trips through storage', () => {
    const kv = memoryStorage();
    const p = defaultProfile();
    p.currency.ink = 123;
    p.campaign['ch1:normal'] = 3;
    p.talents.wallet = 2;
    p.settings.music = 0.25;
    p.leaderboard.normal = [{ wave: 12, score: 999, seed: 'abc', date: '2026-11-19', map: 'ch1', perks: ['x'], kills: 40 }];
    p.midRun = { v: 1, opts: endlessOpts({ seed: 's1' }), tick: 600, log: [{ tick: 3, cmd: { type: 'startWave' } }], wave: 1, savedAt: 1 };
    expect(saveProfile(kv, p)).toBe(true);
    const q = loadProfile(kv);
    expect(q).toEqual(p);
  });

  it('survives corrupt data and missing storage', () => {
    const kv = memoryStorage();
    kv.set(PROFILE_KEY, '{not json');
    expect(loadProfile(kv)).toEqual(defaultProfile());
    const broken: KV = {
      persistent: true,
      get: () => {
        throw new Error('denied');
      },
      set: () => {
        throw new Error('quota');
      },
      remove: () => {
        throw new Error('denied');
      },
    };
    expect(() => loadProfile({ ...broken, get: () => null })).not.toThrow();
    expect(saveProfile(broken, defaultProfile())).toBe(false);
  });

  it('normalizes partial / invalid fields', () => {
    const p = normalizeProfile({ currency: { star: -5, ink: 'x' }, settings: { sfx: 9, quality: 'ultra' }, midRun: { v: 2 } });
    expect(p.currency).toEqual({ star: 0, ink: 0 });
    expect(p.settings.sfx).toBe(1);
    expect(p.settings.quality).toBe('high');
    expect(p.midRun).toBeNull();
  });

  it('store persists updates and reset', () => {
    const kv = memoryStorage();
    const s = new ProfileStore(kv);
    s.update((p) => (p.currency.star = 7));
    expect(new ProfileStore(kv).get().currency.star).toBe(7);
    s.reset();
    expect(new ProfileStore(kv).get().currency.star).toBe(0);
  });
});

describe('progress rules', () => {
  it('stars by remaining lives', () => {
    expect(starsFor(20, 20)).toBe(3);
    expect(starsFor(18, 20)).toBe(3);
    expect(starsFor(17, 20)).toBe(2);
    expect(starsFor(10, 20)).toBe(2);
    expect(starsFor(1, 20)).toBe(1);
  });

  it('campaign stars only add improvements to currency', () => {
    const p = defaultProfile();
    expect(recordCampaignClear(p, 'ch1', 'normal', 2)).toBe(2);
    expect(recordCampaignClear(p, 'ch1', 'normal', 1)).toBe(0);
    expect(recordCampaignClear(p, 'ch1', 'normal', 3)).toBe(1);
    expect(p.currency.star).toBe(3);
  });

  it('chapter / difficulty unlocks', () => {
    const p = defaultProfile();
    expect(chapterUnlocked(p, 'ch1')).toBe(true);
    expect(chapterUnlocked(p, 'ch2')).toBe(false);
    expect(campaignDiffUnlocked(p, 'ch1', 'hard')).toBe(false);
    // 无尽模式默认开放（新玩家可直接玩，简单 / 普通可选，只有第一章地图）；自定义仍需通关第一章
    expect(endlessUnlocked(p)).toBe(true);
    expect(difficultyUnlocked(p, 'normal')).toBe(true);
    expect(endlessMaps(p, ['ch1', 'ch2', 'ch3'])).toEqual(['ch1']);
    expect(customUnlocked(p)).toBe(false);
    recordCampaignClear(p, 'ch1', 'normal', 1);
    expect(customUnlocked(p)).toBe(true);
    expect(endlessMaps(p, ['ch1', 'ch2', 'ch3'])).toEqual(['ch1']);
    expect(chapterUnlocked(p, 'ch2')).toBe(true);
    expect(campaignDiffUnlocked(p, 'ch1', 'hard')).toBe(true);
    expect(difficultyUnlocked(p, 'normal')).toBe(true);
    expect(difficultyUnlocked(p, 'hard')).toBe(false);
    p.bestWave.normal = 30;
    expect(difficultyUnlocked(p, 'hard')).toBe(true);
    expect(difficultyUnlocked(p, 'nightmare')).toBe(false);
    p.bestWave.hard = 40;
    expect(difficultyUnlocked(p, 'nightmare')).toBe(true);
    expect(maxAbyssLevel(p)).toBe(0);
    p.bestWave.nightmare = 35;
    expect(maxAbyssLevel(p)).toBe(1);
    p.bestWave.abyss1 = 30;
    p.bestWave.abyss2 = 29;
    expect(maxAbyssLevel(p)).toBe(2);
    expect(difficultyUnlocked(p, 'abyss', 2)).toBe(true);
    expect(difficultyUnlocked(p, 'abyss', 3)).toBe(false);
    for (let i = 1; i <= 10; i++) p.bestWave[`abyss${i}`] = 60;
    expect(maxAbyssLevel(p)).toBe(10);
  });

  it('ink by difficulty factor', () => {
    expect(inkFor('endless', 'easy', 10)).toBe(5);
    expect(inkFor('endless', 'normal', 10)).toBe(10);
    expect(inkFor('custom', 'hard', 10)).toBe(15);
    expect(inkFor('endless', 'nightmare', 10)).toBe(20);
    expect(inkFor('endless', 'abyss', 10)).toBe(30);
    expect(inkFor('campaign', 'abyss', 10)).toBe(0);
  });

  it('skill unlock strings', () => {
    const p = defaultProfile();
    expect(unlockReached(p, 'default')).toBe(true);
    expect(unlockReached(p, '1-10')).toBe(false);
    p.campaignWave.ch1 = 10;
    expect(unlockReached(p, '1-10')).toBe(true);
    expect(unlockReached(p, '2-5')).toBe(false);
  });

  it('loadout respects slots and unlocks', () => {
    const p = defaultProfile();
    p.skills.loadout = ['caffeine', 'bell', 'bell'];
    // 去掉未解锁和重复的；玩家选了的不自动补满（可以取消带入）
    expect(resolveLoadout(p, ['eraser_strike', 'bell', 'whiteout_zone'])).toEqual(['bell']);
    // 一个都没选时才补默认
    p.skills.loadout = [];
    expect(resolveLoadout(p, ['eraser_strike', 'bell', 'whiteout_zone'])).toEqual(['eraser_strike', 'bell', 'whiteout_zone']);
    expect(skillSlots(p)).toBe(3);
    p.talents.bigbag = 1;
    expect(skillSlots(p)).toBe(4);
  });

  it('skill upgrade with ink up to Lv3', () => {
    const p = defaultProfile();
    expect(upgradeSkill(p, 'bell')).toBe(false);
    p.currency.ink = 400;
    expect(upgradeSkill(p, 'bell')).toBe(true);
    expect(upgradeSkill(p, 'bell')).toBe(true);
    expect(upgradeSkill(p, 'bell')).toBe(false);
    expect(p.skills.levels.bell).toBe(3);
    expect(p.currency.ink).toBe(50);
  });

  it('talents with star or ink', () => {
    const p = defaultProfile();
    const price = { max: 2, star: 2, ink: 40 };
    expect(buyTalent(p, 'wallet', price, 'star')).toBe(false);
    p.currency.star = 2;
    p.currency.ink = 40;
    expect(buyTalent(p, 'wallet', price, 'star')).toBe(true);
    expect(buyTalent(p, 'wallet', price, 'ink')).toBe(true);
    expect(buyTalent(p, 'wallet', price, 'ink')).toBe(false);
    expect(p.talents.wallet).toBe(2);
    expect(p.currency).toEqual({ star: 0, ink: 0 });
  });

  it('leaderboard keeps top 10 sorted', () => {
    const p = defaultProfile();
    for (let i = 0; i < 12; i++)
      insertLeader(p, 'normal', { wave: i, score: i * 10, seed: String(i), date: '', map: 'ch1', perks: [], kills: 0 });
    const list = p.leaderboard.normal;
    expect(list).toHaveLength(10);
    expect(list[0].score).toBe(110);
    expect(insertLeader(p, 'normal', { wave: 0, score: 1, seed: '', date: '', map: 'ch1', perks: [], kills: 0 })).toBe(0);
    expect(insertLeader(p, 'normal', { wave: 0, score: 1000, seed: '', date: '', map: 'ch1', perks: [], kills: 0 })).toBe(1);
  });

  it('settleRun: endless awards ink, leaderboard (pure separate), clears midRun', () => {
    const p = defaultProfile();
    p.midRun = { v: 1, opts: endlessOpts(), tick: 1, log: [], wave: 1, savedAt: 0 };
    const r = settleRun(
      p,
      endlessOpts({ difficulty: 'hard', pure: true }),
      { won: false, wavesSurvived: 12, score: 5000, kills: 100, lives: 0, maxLives: 15, seed: 'zz', perks: [] },
      '2026-11-19',
    );
    expect(r.ink).toBe(18);
    expect(r.rank).toBe(1);
    expect(p.leaderboard['hard:pure']).toHaveLength(1);
    expect(p.leaderboard.hard).toBeUndefined();
    expect(p.bestWave.hard).toBe(12);
    expect(p.midRun).toBeNull();
  });

  it('settleRun: campaign win gives stars', () => {
    const p = defaultProfile();
    const r = settleRun(
      p,
      { mode: 'campaign', map: 'ch2', difficulty: 'normal', skills: [] },
      { won: true, wavesSurvived: 20, score: 1, kills: 1, lives: 19, maxLives: 20, seed: 's', perks: [] },
    );
    expect(r.stars).toBe(3);
    expect(p.currency.star).toBe(3);
    expect(p.campaignWave.ch2).toBe(20);
  });
});

describe('custom share code', () => {
  it('encodes and decodes params', () => {
    const params = { ...NORMAL, hpMul: 2.35, eliteStart: ELITE_OFF, lives: 7 };
    const code = encodeShare({ params, map: 'ch3', base: 'hard' });
    const r = decodeShare(code, NORMAL);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.params).toEqual(params);
      expect(r.value.map).toBe('ch3');
      expect(r.value.base).toBe('hard');
    }
  });

  it('rejects garbage and clamps out-of-range values', () => {
    expect(decodeShare('', NORMAL).ok).toBe(false);
    expect(decodeShare('!!!notbase64', NORMAL).ok).toBe(false);
    expect(decodeShare(btoa('{"a":1}'), NORMAL).ok).toBe(false);
    const r = decodeShare(btoa(JSON.stringify({ hpMul: 999, lives: -3 })), NORMAL);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.params.hpMul).toBe(6);
      expect(r.value.params.lives).toBe(1);
      expect(r.value.params.startGold).toBe(150);
    }
  });

  it('slider <-> param mapping covers every DifficultyParams field', () => {
    // 数值字段都有滑块，spawnMode 单独用分段按钮
    expect(new Set(CUSTOM_FIELDS.map((f) => f.key)).size).toBe(Object.keys(NORMAL).length - 1);
    const elite = CUSTOM_FIELDS.find((f) => f.key === 'eliteStart')!;
    expect(sliderValue(elite, ELITE_OFF)).toBe(101);
    expect(paramValue(elite, 101)).toBe(ELITE_OFF);
    expect(paramValue(elite, 30)).toBe(30);
    expect(sanitizeParams({}, NORMAL)).toEqual(NORMAL);
  });
});

describe('custom share code · dynamic battlefield (doc 09)', () => {
  it('round-trips new params, spawn mode, disabled events and auto-wave', () => {
    const params = {
      ...NORMAL,
      spawnMode: 'focus' as const,
      maxDrops: 3,
      dropWarn: 3.5,
      eventRate: 2.2,
      eventHostile: 0.8,
      waveGap: 9,
      waveMax: 45,
    };
    const code = encodeShare({ params, map: 'ch2', base: 'nightmare', events: { fan: false, coins: false, nap: true }, autoWave: false });
    const r = decodeShare(code, NORMAL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.params).toEqual(params);
    expect(r.value.events).toEqual({ fan: false, coins: false });
    expect(r.value.autoWave).toBe(false);
  });

  it('old codes without new fields fall back to base values; bad values are clamped / ignored', () => {
    const old = { hpMul: 2, lives: 5 };
    const r = decodeShare(btoa(JSON.stringify({ v: 1, p: old })), NORMAL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.params.waveGap).toBe(15);
    expect(r.value.params.spawnMode).toBe('roundRobin');
    expect(r.value.events).toBeUndefined();
    expect(r.value.autoWave).toBeUndefined();
    const bad = decodeShare(
      btoa(JSON.stringify({ v: 1, p: { ...old, spawnMode: 'teleport', waveGap: 999, eventHostile: -1 }, e: ['fan', 'nope', 3] })),
      NORMAL,
    );
    expect(bad.ok).toBe(true);
    if (!bad.ok) return;
    expect(bad.value.params.spawnMode).toBe('roundRobin');
    expect(bad.value.params.waveGap).toBe(30);
    expect(bad.value.params.eventHostile).toBe(0);
    expect(bad.value.events).toEqual({ fan: false });
  });
});

describe('auto-wave leaderboard split (doc 09 §4)', () => {
  const res = { won: false, wavesSurvived: 10, score: 900, kills: 50, lives: 0, maxLives: 20, seed: 's', perks: [] };

  it('separate keys for auto and manual, flag stored on entries', () => {
    const p = defaultProfile();
    settleRun(p, endlessOpts({ autoWave: true }), res, '2026-11-19');
    settleRun(p, endlessOpts({ autoWave: false }), { ...res, score: 100 }, '2026-11-19');
    settleRun(p, endlessOpts({ pure: true }), { ...res, autoWave: true }, '2026-11-19');
    expect(p.leaderboard['normal:auto']).toHaveLength(1);
    expect(p.leaderboard['normal:auto'][0].auto).toBe(true);
    expect(p.leaderboard.normal).toHaveLength(1);
    expect(p.leaderboard.normal[0].auto).toBe(false);
    expect(p.leaderboard['normal:pure:auto']).toHaveLength(1);
    expect(leaderKey('hard', false, true)).toBe('hard:auto');
    expect(leaderKey('hard', true)).toBe('hard:pure');
  });

  it('auto flag survives save/load; default auto-wave per difficulty', () => {
    const kv = memoryStorage();
    const p = defaultProfile();
    settleRun(p, endlessOpts({ autoWave: true }), res);
    p.settings.autoWave = false;
    p.settings.fixedLayout = true;
    saveProfile(kv, p);
    const q = loadProfile(kv);
    expect(q.leaderboard['normal:auto'][0].auto).toBe(true);
    expect(q.settings.autoWave).toBe(false);
    expect(q.settings.fixedLayout).toBe(true);
    expect(normalizeProfile({ settings: { autoWave: 'x' } }).settings.autoWave).toBeNull();

    const d = defaultProfile();
    expect(defaultAutoWave(d, 'endless', 'ch1', 'easy')).toBe(false);
    expect(defaultAutoWave(d, 'endless', 'ch1', 'normal')).toBe(true);
    expect(defaultAutoWave(d, 'campaign', 'ch1', 'normal')).toBe(false); // 新手引导
    recordCampaignClear(d, 'ch1', 'normal', 1);
    expect(defaultAutoWave(d, 'campaign', 'ch1', 'normal')).toBe(true);
    d.settings.autoWave = false;
    expect(effectiveAutoWave(d, 'endless', 'ch2', 'hard')).toBe(false);
  });
});

describe('mid-run replay', () => {
  /** 简单的确定性假 World：tick 推进；指令记录在其执行时的 tick */
  class FakeWorld implements ReplayWorld {
    state = { tick: 0, phase: 'build', wave: 0, seed: 'seed1', opts: endlessOpts({ seed: 'seed1' }), gold: 100 };
    log: { tick: number; cmd: import('../../src/core/types').Command }[] = [];
    applied: { tick: number; type: string }[] = [];
    step() {
      this.state.tick++;
      this.state.gold += 1;
      if (this.state.tick % 100 === 0) this.state.wave++;
    }
    command(cmd: import('../../src/core/types').Command) {
      this.log.push({ tick: this.state.tick, cmd });
      this.applied.push({ tick: this.state.tick, type: cmd.type });
      if (cmd.type === 'place') this.state.gold -= 10;
      return { ok: true };
    }
    drainEvents() {
      return [];
    }
  }

  it('reproduces commands at the same ticks and stops at saved tick', () => {
    const a = new FakeWorld();
    for (let t = 0; t < 350; t++) {
      if (t === 0 || t === 120 || t === 120) a.command({ type: 'place', tower: 'wall', cx: 1, cy: t % 7 });
      if (t === 120) a.command({ type: 'startWave' });
      if (t === 300) a.command({ type: 'sell', uid: 1 });
      a.step();
    }
    const run = makeMidRun(a as never);
    expect(run.opts.seed).toBe('seed1');
    expect(run.tick).toBe(350);
    const b = new FakeWorld();
    replaySync(b, run);
    expect(b.state.tick).toBe(350);
    expect(b.state.gold).toBe(a.state.gold);
    expect(b.applied).toEqual(a.applied);
  });
});

describe('mid-run replay with real core', () => {
  it('fast-forwards to an identical state', async () => {
    const core = await import('../../src/core');
    const opts: RunOptions = {
      mode: 'endless',
      map: 'ch1',
      difficulty: 'normal',
      skills: ['eraser_strike', 'bell', 'whiteout_zone'],
      seed: 'replay-test',
    };
    const a = core.createWorld(opts);
    const opt = a.getBuildOptions().find((o) => o.id === 'pencil');
    let placed = 0;
    for (let t = 0; t < 60 * 40; t++) {
      if (t === 10 || t === 30) {
        for (let cy = 4; cy < 10 && placed < 3; cy++) {
          for (let cx = 0; cx < 12 && placed < 3; cx++) {
            if (opt && a.canPlace('pencil', cx, cy).ok) {
              a.command({ type: 'place', tower: 'pencil', cx, cy });
              placed++;
              break;
            }
          }
        }
      }
      if (t === 60) a.command({ type: 'startWave' });
      if (a.state.phase === 'build' && a.state.wave >= 1 && t % 600 === 0) a.command({ type: 'startWave' });
      if (a.state.phase === 'won' || a.state.phase === 'lost' || a.state.phase === 'perk') break;
      a.step();
      a.drainEvents();
    }
    const run = makeMidRun(a);
    const b = core.createWorld(run.opts);
    replaySync(b, run);
    expect(b.state.tick).toBe(a.state.tick);
    expect(core.stateHash(b)).toBe(core.stateHash(a));
  });
});

describe('mid-run replay with auto waves, events and pickups (doc 09)', () => {
  it('auto waves are not logged but replay reproduces them; collect / chooseCrate are logged', async () => {
    const core = await import('../../src/core');
    const opts: RunOptions = {
      mode: 'custom',
      map: 'ch1',
      difficulty: 'normal',
      custom: { eventRate: 3, eventHostile: 0.3, waveGap: 4, waveMax: 25 },
      skills: ['eraser_strike', 'bell', 'whiteout_zone'],
      seed: 'auto-replay',
      autoWave: true,
    };
    const a = core.createWorld(opts);
    let placed = 0;
    for (let t = 0; t < 60 * 150; t++) {
      if (t === 10) {
        for (let cy = 4; cy < 12 && placed < 4; cy++) {
          for (let cx = 0; cx < 12 && placed < 4; cx++) {
            if (a.canPlace('pencil', cx, cy).ok) {
              a.command({ type: 'place', tower: 'pencil', cx, cy });
              placed++;
            }
          }
        }
      }
      if (t === 60) a.command({ type: 'startWave' });
      const st = a.state;
      if (st.phase === 'won' || st.phase === 'lost') break;
      if (st.phase === 'perk' && st.perkChoices?.length) {
        const card = st.perkChoices.find((c) => !c.needsTower) ?? st.perkChoices[0];
        a.command({ type: 'choosePerk', id: card.id });
      }
      if (t % 30 === 0 && st.pickups?.length) a.command({ type: 'collect', uid: st.pickups[0].uid });
      if (st.crateChoice?.options.length) a.command({ type: 'chooseCrate', option: st.crateChoice.options[0].id });
      if (a.state.phase !== 'perk') a.step();
      a.drainEvents();
    }
    expect(a.state.wave).toBeGreaterThan(1);
    // 自动开波不进指令记录：只有第一次 startWave
    expect(a.log.filter((e) => e.cmd.type === 'startWave')).toHaveLength(1);
    const run = makeMidRun(a);
    expect(run.opts.autoWave).toBe(true);
    const b = core.createWorld(run.opts);
    replaySync(b, run);
    expect(b.state.tick).toBe(a.state.tick);
    expect(b.state.wave).toBe(a.state.wave);
    expect(core.stateHash(b)).toBe(core.stateHash(a));
  });
});

describe('pure mode loadout', () => {
  it('drops the 4th slot when pure', () => {
    const p = defaultProfile();
    p.talents.bigbag = 1;
    p.skills.loadout = ['eraser_strike', 'bell', 'whiteout_zone', 'caffeine'];
    const unlocked = ['eraser_strike', 'bell', 'whiteout_zone', 'caffeine'] as const;
    expect(resolveLoadout(p, [...unlocked])).toHaveLength(4);
    expect(resolveLoadout(p, [...unlocked], true)).toEqual(['eraser_strike', 'bell', 'whiteout_zone']);
  });
});
