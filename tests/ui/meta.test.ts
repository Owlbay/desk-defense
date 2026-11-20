import { describe, expect, it } from 'vitest';
import type { DifficultyParams, RunOptions } from '../../src/core/types';
import { CUSTOM_FIELDS, decodeShare, ELITE_OFF, encodeShare, paramValue, sanitizeParams, sliderValue } from '../../src/meta/custom';
import { makeMidRun, replaySync, type ReplayWorld } from '../../src/meta/midrun';
import { defaultProfile, loadProfile, normalizeProfile, PROFILE_KEY, ProfileStore, saveProfile } from '../../src/meta/profile';
import {
  buyTalent,
  campaignDiffUnlocked,
  chapterUnlocked,
  difficultyUnlocked,
  endlessUnlocked,
  inkFor,
  insertLeader,
  maxAbyssLevel,
  recordCampaignClear,
  resolveLoadout,
  settleRun,
  skillSlots,
  starsFor,
  unlockReached,
  upgradeSkill,
} from '../../src/meta/progress';
import { memoryStorage, type KV } from '../../src/meta/storage';

const NORMAL: DifficultyParams = {
  startGold: 150, lives: 20, hpMul: 1, hpLinear: 0.18, hpExp: 1.04, countMul: 1, countGrowth: 0.08, speedMul: 1, armorStep: 12,
  rewardMul: 1, xpMul: 1, eliteStart: 30, eliteRate: 0.004, eliteCap: 0.15, maxAffix: 1, bossHpMul: 1, skillCdMul: 1, interestCap: 20, scoreMul: 1,
};

const endlessOpts = (over: Partial<RunOptions> = {}): RunOptions => ({ mode: 'endless', map: 'ch1', difficulty: 'normal', skills: ['bell'], ...over });

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
    expect(endlessUnlocked(p)).toBe(false);
    recordCampaignClear(p, 'ch1', 'normal', 1);
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
    expect(resolveLoadout(p, ['eraser_strike', 'bell', 'whiteout_zone'])).toEqual(['bell', 'eraser_strike', 'whiteout_zone']);
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
    for (let i = 0; i < 12; i++) insertLeader(p, 'normal', { wave: i, score: i * 10, seed: String(i), date: '', map: 'ch1', perks: [], kills: 0 });
    const list = p.leaderboard.normal;
    expect(list).toHaveLength(10);
    expect(list[0].score).toBe(110);
    expect(insertLeader(p, 'normal', { wave: 0, score: 1, seed: '', date: '', map: 'ch1', perks: [], kills: 0 })).toBe(0);
    expect(insertLeader(p, 'normal', { wave: 0, score: 1000, seed: '', date: '', map: 'ch1', perks: [], kills: 0 })).toBe(1);
  });

  it('settleRun: endless awards ink, leaderboard (pure separate), clears midRun', () => {
    const p = defaultProfile();
    p.midRun = { v: 1, opts: endlessOpts(), tick: 1, log: [], wave: 1, savedAt: 0 };
    const r = settleRun(p, endlessOpts({ difficulty: 'hard', pure: true }), { won: false, wavesSurvived: 12, score: 5000, kills: 100, lives: 0, maxLives: 15, seed: 'zz', perks: [] }, '2026-11-19');
    expect(r.ink).toBe(18);
    expect(r.rank).toBe(1);
    expect(p.leaderboard['hard:pure']).toHaveLength(1);
    expect(p.leaderboard.hard).toBeUndefined();
    expect(p.bestWave.hard).toBe(12);
    expect(p.midRun).toBeNull();
  });

  it('settleRun: campaign win gives stars', () => {
    const p = defaultProfile();
    const r = settleRun(p, { mode: 'campaign', map: 'ch2', difficulty: 'normal', skills: [] }, { won: true, wavesSurvived: 20, score: 1, kills: 1, lives: 19, maxLives: 20, seed: 's', perks: [] });
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
    expect(new Set(CUSTOM_FIELDS.map((f) => f.key)).size).toBe(Object.keys(NORMAL).length);
    const elite = CUSTOM_FIELDS.find((f) => f.key === 'eliteStart')!;
    expect(sliderValue(elite, ELITE_OFF)).toBe(101);
    expect(paramValue(elite, 101)).toBe(ELITE_OFF);
    expect(paramValue(elite, 30)).toBe(30);
    expect(sanitizeParams({}, NORMAL)).toEqual(NORMAL);
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
    const opts: RunOptions = { mode: 'endless', map: 'ch1', difficulty: 'normal', skills: ['eraser_strike', 'bell', 'whiteout_zone'], seed: 'replay-test' };
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
