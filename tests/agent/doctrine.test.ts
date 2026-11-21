/**
 * 中心策略（文档 10 §20）：预设、DOC 行、修改规则（why / 冷却 / 锁定）、玩家原话解析、多层攻击、规划器挂钩、act 的 end.doctrine、整局。
 */
import { describe, expect, it } from 'vitest';

import {
  applyDoctrine,
  DOCTRINE_COOLDOWN,
  DOCTRINE_PRESETS,
  doctrineLine,
  executeTool,
  initialDoctrine,
  layers,
  parseDoctrine,
  Planner,
  type PlannerState,
  presetDoctrine,
  rotationFor,
  runAgentGame,
  scriptedFallback,
  ScriptedProvider,
  systemBlocks,
} from '../../src/agent';
import { createWorld, type RunOptions } from '../../src/core';

const OPTS: RunOptions = {
  mode: 'endless',
  map: 'ch1',
  difficulty: 'normal',
  seed: 'doctrine-test',
  skills: ['eraser_strike', 'bell', 'whiteout_zone'],
  pure: true,
};

describe('doctrine presets & DOC line', () => {
  it('every preset starts with 4 pencils and keeps armor answers', () => {
    for (const p of DOCTRINE_PRESETS) {
      const r = rotationFor(presetDoctrine(p));
      expect(r.slice(0, 4)).toEqual(['pencil', 'pencil', 'pencil', 'pencil']);
      expect(r.some((id) => id === 'eraser' || id === 'lamp')).toBe(true);
    }
  });

  it('DOC line is compact, stable and English', () => {
    const st = initialDoctrine({ preset: 'aoe', locked: true });
    const a = doctrineLine(st, 3)!;
    expect(a).toBe(doctrineLine(st, 3));
    expect(a).toMatch(/^DOC aoe\(player,w0,locked\) \| core stapler>compass>glue \| maze long 3.5x uturn/);
    expect(a.length).toBeLessThan(220);
    expect(doctrineLine(initialDoctrine(), 1)).toMatch(/^DOC none/);
  });

  it('prompt explains DOC and doctrine in the fixed prefix', () => {
    const [rules] = systemBlocks('player');
    expect(rules).toMatch(/DOC strategy/);
    expect(rules).toMatch(/end\.doctrine/);
    expect(systemBlocks('player')).toEqual(systemBlocks('player'));
  });
});

describe('doctrine changes', () => {
  it('model: needs why, first pick is free, then 5-wave cooldown unless hurt', () => {
    const st = initialDoctrine();
    expect(applyDoctrine(st, { preset: 'aoe' }, 'model', { wave: 1 }).ok).toBe(false);
    expect(applyDoctrine(st, { preset: 'nope', why: 'x' }, 'model', { wave: 1 }).ok).toBe(false);
    const r = applyDoctrine(st, { preset: 'aoe', why: 'rush waves' }, 'model', { wave: 1 });
    expect(r.ok).toBe(true);
    expect(st.chosen && st.doc.preset === 'aoe' && st.by === 'model').toBe(true);
    expect(applyDoctrine(st, { why: 'keep it' }, 'model', { wave: 2 }).text).toMatch(/unchanged \(aoe\)/);
    expect(applyDoctrine(st, { preset: 'lamp', why: 'armor' }, 'model', { wave: 3 }).text).toMatch(/cooldown/);
    expect(applyDoctrine(st, { preset: 'lamp', why: 'armor' }, 'model', { wave: 3, hurt: true }).ok).toBe(true);
    expect(applyDoctrine(st, { preset: 'pencil', why: 'x' }, 'model', { wave: 3 + DOCTRINE_COOLDOWN }).ok).toBe(true);
    expect(st.log.map((l) => `${l.from}>${l.to}`)).toEqual(['none>aoe', 'aoe>lamp', 'lamp>pencil']);
  });

  it('player lock: model only suggests; player changes anytime', () => {
    const st = initialDoctrine({ preset: 'pencil', locked: true });
    const r = applyDoctrine(st, { preset: 'aoe', why: 'flyers' }, 'model', { wave: 20 });
    expect(r.ok).toBe(false);
    expect(st.suggested).toBe('aoe');
    expect(st.doc.preset).toBe('pencil');
    expect(applyDoctrine(st, { preset: 'aoe' }, 'player', { wave: 20 }).ok).toBe(true);
    expect(st.suggested).toBeUndefined();
  });

  it('custom core and maze', () => {
    const st = initialDoctrine({ preset: 'balanced' });
    applyDoctrine(st, { core: ['lamp', 'ruler', 'wall', 'bogus'], maze: 'lean', why: 'x' }, 'model', { wave: 9 });
    expect(st.doc.preset).toBe('custom');
    expect(st.doc.core).toEqual(['lamp', 'ruler']);
    expect(st.doc.maze).toBe('lean');
    expect(rotationFor(st.doc)).toEqual(rotationFor(presetDoctrine('lamp')));
  });

  it('parses the player’s words', () => {
    expect(parseDoctrine('我主要玩铅笔塔')).toEqual({ preset: 'pencil' });
    expect(parseDoctrine('主打范围攻击，把路绕成弯弯绕')).toEqual({ preset: 'aoe', maze: 'long', focus: 'uturn' });
    expect(parseDoctrine('主要打单点')).toEqual({ preset: 'pencil' });
    expect(parseDoctrine('go lamp')).toEqual({ preset: 'lamp' });
    expect(parseDoctrine('造个塔')).toBeNull();
  });
});

describe('multi-layer coverage', () => {
  it('counts separate passes of a route through the range', () => {
    const s = (x: number, y: number) => ({ x: x + 0.5, y: y + 0.5, w: 1, sp: 'a' });
    // 往右走一行、掉头往左走回来：中间的格子射程内有两段
    const path = [...[0, 1, 2, 3, 4, 5].map((x) => s(x, 0)), s(5, 1), ...[5, 4, 3, 2, 1, 0].map((x) => s(x, 2))];
    expect(layers(2, 1, 1.2, 0, path)).toBe(2);
    expect(layers(2, 1, 0.4, 0, path)).toBe(0);
    expect(layers(5, 1, 1.2, 0, path)).toBe(1);
  });
});

describe('planner follows the doctrine', () => {
  it('same board, different doctrine ⇒ different next tower and branch default', () => {
    const w = createWorld(OPTS);
    // 开局 spend：4 支铅笔 + 墙（所有预设开局相同）
    new Planner(w, (c) => w.command(c), {}).spend(0);
    expect([...w.state.towers.values()].filter((t) => t.id === 'pencil').length).toBe(4);
    const bal = new Planner(w, (c) => w.command(c), {});
    const aoe: PlannerState = { doctrine: initialDoctrine({ preset: 'aoe' }) };
    const air: PlannerState = { doctrine: initialDoctrine({ preset: 'antiair' }) };
    expect(bal.nextRotation()).toBe('eraser');
    const pa = new Planner(w, (c) => w.command(c), aoe).nextRotation();
    const pb = new Planner(w, (c) => w.command(c), air).nextRotation();
    expect(pb).toBe('swatter');
    expect(pa).toBe('eraser');
    // 范围流：再往后核心塔进场
    expect(rotationFor(aoe.doctrine!.doc).slice(0, 8)).toContain('stapler');
  });

  it('act end.doctrine changes the state before the actions run', () => {
    const w = createWorld(OPTS);
    const planner: PlannerState = { doctrine: initialDoctrine() };
    const r = executeTool({ world: w, role: 'player', planner }, 'act', {
      actions: [{ do: 'spend', reserve: 0 }],
      end: { plan: 'aoe', doctrine: { preset: 'aoe', why: 'many rush waves' } },
    });
    expect(r.doctrine?.ok).toBe(true);
    expect(r.text).toMatch(/OK doctrine: none → aoe/);
    expect(planner.doctrine!.doc.preset).toBe('aoe');
    const r2 = executeTool({ world: w, role: 'player', planner }, 'act', {
      actions: [],
      end: { doctrine: { preset: 'lamp' } },
    });
    expect(r2.doctrine?.ok).not.toBe(true);
    expect(r2.text).toMatch(/why/);
    expect(planner.doctrine!.doc.preset).toBe('aoe');
  });

  it('fallback uses the planner once a non-balanced doctrine is bound', async () => {
    const w = createWorld(OPTS);
    const fb = scriptedFallback(w);
    fb.bindPlanner!({ doctrine: initialDoctrine({ preset: 'aoe' }) });
    await fb.decide(['game_start']);
    expect([...w.state.towers.values()].filter((t) => t.id === 'pencil').length).toBeGreaterThanOrEqual(3);
  });
});

describe('whole game with a doctrine', () => {
  const run = (preset: 'aoe' | 'balanced') =>
    runAgentGame(OPTS, {
      config: { provider: 'scripted', role: 'player', doctrine: { preset } },
      provider: new ScriptedProvider({ intents: true }),
      maxWaves: 12,
    });

  it('is deterministic and plays its core towers', async () => {
    const a = await run('aoe');
    const b = await run('aoe');
    expect(b.log).toEqual(a.log);
    expect(a.errors).toEqual([]);
    expect(a.result.cleared).toBeGreaterThanOrEqual(10);
    const placed = (r: typeof a) => r.log.filter((e) => e.cmd.type === 'place').map((e) => (e.cmd as { tower: string }).tower);
    const core = (ids: string[]) => ids.filter((t) => t === 'stapler' || t === 'compass' || t === 'glue').length;
    const c = await run('balanced');
    expect(core(placed(a))).toBeGreaterThan(core(placed(c)));
  }, 60_000);
});
