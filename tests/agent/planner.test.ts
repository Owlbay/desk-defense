/**
 * 打法辅助（文档 10 §19）：意图规划器、被拒放置自动挪位、战报、威胁估算、闲置提醒、评测场。全部离线、确定性。
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { markdownTable, parseVariants, runEval, summarize } from '../../scripts/eval-lib';
import {
  ACT_TOOL_V1,
  BattleLog,
  DecisionEngine,
  estimateTokens,
  executeTool,
  flightLines,
  idleLine,
  INTENT_KINDS,
  Planner,
  resolveConfig,
  runAgentGame,
  scriptedFallback,
  ScriptedProvider,
  systemBlocks,
  threatEstimate,
  threatLine,
  toolsForRole,
  validateAgainst,
} from '../../src/agent';
import { compactObservation } from '../../src/agent';
import { McpGameServer } from '../../src/agent/mcp';
import { type Command, createWorld, type IWorld, type MapId, type RunOptions, stateHash } from '../../src/core';
import { replaySync } from '../../src/meta/midrun';

const opts = (seed: string, map: MapId = 'ch1', difficulty: RunOptions['difficulty'] = 'normal'): RunOptions => ({
  mode: 'endless',
  map,
  difficulty,
  seed,
  skills: ['eraser_strike', 'bell', 'whiteout_zone'],
  pure: true,
});

/** 每条开放出生点都还能走到出口（地面路线最后一格是出口） */
function allRoutesOpen(w: IWorld): boolean {
  const g = w.state.grid;
  const exits = new Set(g.exits.map((e) => e.y * g.cols + e.x));
  const paths = w.currentPaths();
  if (paths.length < w.state.spawners.filter((s) => s.active && s.kind !== 'drop').length) return false;
  return paths.every((p) => p.length > 0 && exits.has(p[p.length - 1].y * g.cols + p[p.length - 1].x));
}

/** 记录 world.command 的指令（规划器只能经它改世界） */
function recorder(w: IWorld): { send: (c: Command) => ReturnType<IWorld['command']>; cmds: Command[] } {
  const cmds: Command[] = [];
  return {
    cmds,
    send: (c) => {
      const r = w.command(c);
      if (r.ok) cmds.push(c);
      return r;
    },
  };
}

const act = (w: IWorld, actions: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
  executeTool({ world: w, role: 'player', ...extra }, 'act', { actions, end: {} });

/** 让世界跑到当前波结束（或 maxSec 秒） */
function runWave(w: IWorld, maxSec = 120): void {
  if (w.state.phase === 'build') w.command({ type: 'startWave' });
  const until = w.state.time + maxSec;
  while (w.state.time < until && w.state.phase === 'wave') w.step();
  if (w.state.phase === 'perk' && w.state.perkChoices) w.command({ type: 'choosePerk', id: w.state.perkChoices[0].id });
}

describe('planner intents', () => {
  it('maze serpentine: only valid commands, lengthens the path, deterministic, replayable', () => {
    const run = () => {
      const w = createWorld(opts('pl-1'));
      const rec = recorder(w);
      const p = new Planner(w, rec.send);
      const before = w.currentPaths()[0].length;
      const o = p.maze('serpentine', 80);
      return { w, rec, o, before };
    };
    const a = run();
    const b = run();
    expect(a.o.done).toBeGreaterThan(5);
    expect(a.o.spent).toBeLessThanOrEqual(80);
    expect(a.rec.cmds.every((c) => c.type === 'place' && c.tower === 'wall')).toBe(true);
    expect(a.w.currentPaths()[0].length).toBeGreaterThan(a.before);
    expect(allRoutesOpen(a.w)).toBe(true);
    expect(a.o.text).toMatch(/maze serpentine: \+\d+ walls -\d+g path \d+→\d+/);
    // 确定性：同一种子同一结果；世界日志可回放到同一状态
    expect(b.rec.cmds).toEqual(a.rec.cmds);
    expect(stateHash(b.w)).toBe(stateHash(a.w));
    const replay = createWorld(opts('pl-1'));
    replaySync(replay, {
      v: 1,
      opts: opts('pl-1'),
      tick: a.w.state.tick,
      log: a.w.log.map((e) => ({ tick: e.tick, cmd: e.cmd })),
      wave: 0,
      savedAt: 0,
    });
    expect(stateHash(replay)).toBe(stateHash(a.w));
  });

  it('maze funnel greedily lengthens a route', () => {
    const w = createWorld(opts('pl-2'));
    const p = new Planner(w, (c) => w.command(c));
    const before = w.currentPaths()[0].length;
    const o = p.maze('funnel', 30);
    expect(o.done).toBeGreaterThan(0);
    expect(w.currentPaths()[0].length).toBeGreaterThan(before);
    expect(allRoutesOpen(w)).toBe(true);
  });

  it('build_near places attack towers in range of the route, never on the planned route', () => {
    const w = createWorld(opts('pl-3'));
    const p = new Planner(w, (c) => w.command(c));
    const o = p.buildNear('pencil', 'route', 3);
    expect(o.done).toBe(3);
    const towers = [...w.state.towers.values()].filter((t) => t.id === 'pencil');
    expect(towers).toHaveLength(3);
    const route = w.currentPaths()[0];
    for (const t of towers) expect(route.some((c) => Math.hypot(c.x - t.cx, c.y - t.cy) <= 2.6)).toBe(true);
    expect(allRoutesOpen(w)).toBe(true);
    expect(o.text).toMatch(/build_near pencil route: pencil#\d+@\d+,\d+/);
    // 墙不走 build_near；未知 / 买不起
    expect(p.buildNear('wall').ok).toBe(false);
    w.state.gold = 0;
    expect(p.buildNear('lamp').text).toMatch(/金币不足/);
  });

  it('upgrade_best upgrades the most valuable tower; spend goes down to the reserve', () => {
    const w = createWorld(opts('pl-4'));
    const p = new Planner(w, (c) => w.command(c));
    p.buildNear('pencil', 'route', 3);
    w.state.gold = 200;
    // 3 座塔时买新铅笔更划算：upgrade_best 拒绝并指向 spend（与 spend 同一口径）
    const no = p.upgradeBest(2);
    expect(no.done).toBe(0);
    expect(no.text).toMatch(/stop: a new \w+ is worth more per gold now .*\{do:"spend"\}/);
    // 攻击塔到上限（第 1 波前 9 座）后就升级
    w.state.gold = 400;
    p.buildNear('pencil', 'route', 6);
    w.state.gold = 200;
    const u = p.upgradeBest(2);
    expect(u.done).toBe(2);
    expect([...w.state.towers.values()].some((t) => t.level >= 2)).toBe(true);
    w.state.gold = 400;
    const s = p.spend(30);
    expect(s.done).toBeGreaterThan(3);
    expect(Math.floor(w.state.gold)).toBeLessThan(30 + 80);
    expect(Math.floor(w.state.gold)).toBeGreaterThanOrEqual(0);
    expect(s.text).toMatch(/spend→30: .*spent \d+g, gold \d+ .*\| path \d+→\d+ \| maze \d+\/\d+/);
    expect(allRoutesOpen(w)).toBe(true);
  });

  it('anti_air covers the weakest flight line', () => {
    const w = createWorld(opts('pl-5'));
    const p = new Planner(w, (c) => w.command(c));
    const before = flightLines(w)[0].aa;
    const o = p.antiAir(undefined, 1);
    expect(o.done).toBe(1);
    expect(flightLines(w)[0].aa).toBeGreaterThan(before);
    expect([...w.state.towers.values()].some((t) => t.id === 'swatter' || t.id === 'pencil')).toBe(true);
  });

  it('opening maze keeps gold for the first 4 pencils (no tower-less wave 1)', () => {
    const w = createWorld(opts('pl-open'));
    const r = act(w, [{ do: 'maze' }, { do: 'spend', reserve: 0 }]);
    expect(r.text).toMatch(/^1 OK maze serpentine: \+\d+ walls/);
    expect([...w.state.towers.values()].filter((t) => t.id === 'pencil').length).toBeGreaterThanOrEqual(4);
    expect(allRoutesOpen(w)).toBe(true);
  });

  it('anti_air skips a flight line that is already safe (count ≥2 forces a build)', () => {
    const w = createWorld(opts('pl-aa'));
    // 放塔会重算下一波预告：每次调用前重新设成"2 架纸飞机"
    const air = () => {
      w.state.nextWave = {
        ...w.state.nextWave,
        tags: ['air'],
        groups: [{ enemy: 'plane', count: 2, elite: 0, affixes: [], spawner: 'north' }],
      };
    };
    w.state.gold = 1000;
    const p = new Planner(w, (c) => w.command(c));
    air();
    expect(p.antiAir('north', 1).done).toBe(1);
    for (let k = 0; k < 6; k++) {
      air();
      if (threatEstimate(w)[0].ratio >= 2) break;
      expect(p.antiAir('north', 2).done).toBeGreaterThan(0);
    }
    air();
    expect(threatEstimate(w)[0].ratio).toBeGreaterThanOrEqual(2);
    const n = w.state.towers.size;
    expect(p.antiAir('north', 1).text).toMatch(/already safe ×[\d.]+ — skipped/);
    expect(w.state.towers.size).toBe(n);
    air();
    expect(p.antiAir('north', 2).done).toBeGreaterThan(0);
  });

  it('spend rotation counts support towers (no endless calculators) and brings piggies / calculators in', () => {
    const w = createWorld(opts('pl-rot'));
    w.state.wave = 20; // 攻击塔上限随波数放宽（8 + 1.5×波）
    const p = new Planner(w, (c) => w.command(c));
    w.state.gold = 4000;
    p.maze('serpentine', 400);
    for (let k = 0; k < 6; k++) p.spend(0, 'towers');
    const n = (id: string) => [...w.state.towers.values()].filter((t) => t.id === id).length;
    expect(n('calculator')).toBeGreaterThanOrEqual(1);
    expect(n('calculator')).toBeLessThanOrEqual(4);
    expect(n('piggy')).toBeGreaterThanOrEqual(1);
    expect(n('pencil')).toBeGreaterThan(n('calculator') * 3);
    expect(allRoutesOpen(w)).toBe(true);
  });

  it('never blocks a path: random intent sequences on every map, through waves and terrain events', () => {
    const kinds = ['maze', 'build_near', 'spend', 'upgrade_best', 'anti_air', 'funnel'] as const;
    for (const map of ['ch1', 'ch2', 'ch3'] as MapId[]) {
      for (const seed of ['fz-1', 'fz-2']) {
        const w = createWorld(opts(seed, map));
        let h = 7;
        for (const c of seed + map) h = (h * 31 + c.charCodeAt(0)) >>> 0;
        for (let step = 0; step < 6; step++) {
          w.state.gold += 120;
          const p = new Planner(w, (c) => w.command(c));
          for (let k = 0; k < 3; k++) {
            h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
            const kind = kinds[h % kinds.length];
            if (kind === 'maze') p.maze('serpentine', 40);
            else if (kind === 'funnel') p.maze('funnel', 15);
            else if (kind === 'build_near')
              p.buildNear(
                (['pencil', 'glue', 'lamp', 'eraser'] as const)[h % 4],
                ['route', 'early', 'exit', 'chokepoint'][(h >> 3) % 4],
                2,
              );
            else if (kind === 'spend') p.spend(10);
            else if (kind === 'upgrade_best') p.upgradeBest(2);
            else p.antiAir();
            expect(allRoutesOpen(w), `${map} ${seed} step ${step} ${kind}`).toBe(true);
          }
          runWave(w, 40);
          if (w.state.phase === 'lost') break;
        }
      }
    }
  }, 60_000);

  it('save holds gold and silences the idle nudge until the target', () => {
    const w = createWorld(opts('pl-6'));
    const ps = {};
    // 空棋盘：下一波"危险"，攒钱被拒
    expect(act(w, [{ do: 'save', until: 300 }], { planner: ps }).text).toMatch(/save refused: next wave 危险 on north/);
    const p = new Planner(w, (c) => w.command(c));
    w.state.gold = 400;
    p.maze('serpentine', 200);
    p.buildNear('pencil', 'route', 6);
    w.state.gold = 150;
    const r = act(w, [{ do: 'save', until: 300 }], { planner: ps });
    expect(r.text).toMatch(/save: holding gold until 300/);
    expect(idleLine(w, ps)).toBeUndefined();
    expect(idleLine(w, {})).toMatch(/IDLE 150g unspent/);
    w.state.gold = 20;
    expect(idleLine(w, {})).toBeUndefined();
  });
});

describe('act with assist', () => {
  it('six intents in the schema; old intent names still work (act and MCP)', () => {
    expect([...INTENT_KINDS]).toEqual(['maze', 'build_near', 'upgrade_best', 'spend', 'save', 'reclaim']);
    const a = toolsForRole('player').find((t) => t.name === 'act')!;
    for (const old of ['anti_air', 'combo', 'support', 'economy', 'rebuild_maze'])
      expect(validateAgainst(a.input_schema, { actions: [{ do: old }] })).not.toEqual([]);
    // 合并后的写法
    const w = createWorld(opts('as-alias'));
    w.state.gold = 2000;
    const r = act(w, [
      { do: 'maze', budget: 100 },
      { do: 'build_near', purpose: 'air', route: 'north' },
      { do: 'build_near', pair: 'glue+stapler' },
      { do: 'maze', rebuild: true },
    ]);
    const lines = r.text.split('\n');
    expect(lines[1]).toMatch(/^2 OK anti_air north: build_near/);
    expect(lines[2]).toMatch(/^3 OK combo glue\+stapler/);
    expect(lines[3]).toMatch(/^4 (OK|NOOP) rebuild_maze: /);
    // 旧名照收
    const r2 = act(w, [
      { do: 'anti_air', route: 'north', count: 2 },
      { do: 'combo', pair: 'lamp+pen', near: 'route' },
    ]);
    expect(r2.text.split('\n')[0]).toMatch(/^1 OK anti_air north/);
    expect(r2.text.split('\n')[1]).toMatch(/^2 (OK|NOOP) combo lamp\+pen/);
    // MCP：旧名先改写再校验
    const srv = new McpGameServer();
    const sid = /session_id: (g\d+)/.exec(srv.callTool('new_game', { seed: 'alias', auto_wave: true }).content[0].text)![1];
    const m = srv.callTool('act', { session_id: sid, actions: [{ do: 'anti_air' }, { do: 'combo', pair: 'glue+stapler', near: 'route' }] });
    expect(m.isError ?? false).toBe(false);
    expect(m.content[0].text).toMatch(/^1 (OK|NOOP) anti_air/);
  });

  it('AR lists the next wave per route (incl. a wave rewritten by the attacker)', () => {
    const w = createWorld(opts('as-ar'));
    w.state.nextWave = {
      ...w.state.nextWave,
      groups: [
        { enemy: 'paperclip', count: 4, elite: 1, affixes: [], spawner: 'north' },
        { enemy: 'plane', count: 3, elite: 0, affixes: [], spawner: 'north' },
        { enemy: 'crumb', count: 5, elite: 0, affixes: [], spawner: '' },
      ],
    };
    const ar = compactObservation(w).AR as string[];
    expect(ar[0]).toMatch(/^north: pc×4\(e1\) \| 5,0>.* L\d+ \| gap \d+,\d+>\d+,\d+\(\d+\)/);
    expect(ar).toContainEqual(expect.stringMatching(/^air:north: pl×3 \| \d+,\d+>\d+,\d+ L\d+ aa0%$/));
    expect(ar).toContainEqual('*: cr×5');
  });

  it('intents run inside act; results are one line each; assist off rejects intents', () => {
    const w = createWorld(opts('as-1'));
    const r = act(w, [
      { do: 'maze', budget: 30 },
      { do: 'build_near', tower: 'pencil', count: 2 },
      { do: 'spend', reserve: 0 },
    ]);
    const lines = r.text.split('\n');
    expect(lines[0]).toMatch(/^1 OK maze serpentine/);
    expect(lines[1]).toMatch(/^2 OK build_near pencil/);
    expect(lines[2]).toMatch(/^3 OK spend→0/);
    expect(r.endTurn).toBe(true);
    expect(Math.floor(w.state.gold)).toBeLessThan(40);
    const w2 = createWorld(opts('as-1'));
    const off = executeTool({ world: w2, role: 'player', assist: false }, 'act', { actions: [{ do: 'spend' }] });
    expect(off.text).toMatch(/ERROR unknown do "spend"/);
    expect(w2.state.towers.size).toBe(0);
  });

  it('a blocked low-level place is moved to a nearby valid cell; walls are not moved', () => {
    const w = createWorld(opts('as-2'));
    const first = act(w, [{ do: 'place', tower: 'pencil', x: 3, y: 6 }]);
    expect(first.ok).toBe(true);
    const r = act(w, [{ do: 'place', tower: 'pencil', x: 3, y: 6 }]);
    expect(r.text).toMatch(/^1 MOVED 3,6 \(已经有塔了\) → OK placed pencil #\d+ at \d+,\d+/);
    expect(r.ok).toBe(true);
    expect([...w.state.towers.values()].filter((t) => t.id === 'pencil')).toHaveLength(2);
    const wall = act(w, [{ do: 'place', tower: 'wall', x: 3, y: 6 }]);
    expect(wall.text).toMatch(/^1 REJECTED/);
    // 出口格（不能建造）也会挪
    const ex = w.state.grid.exits[0];
    expect(act(w, [{ do: 'place', tower: 'pencil', x: ex.x, y: ex.y }]).text).toMatch(/MOVED/);
    expect(allRoutesOpen(w)).toBe(true);
  });

  it('failures the model cannot fix this turn (no gold) end the turn instead of asking for a correction', () => {
    const w = createWorld(opts('as-3'));
    w.state.gold = 10;
    const r = executeTool({ world: w, role: 'player' }, 'act', { actions: [{ do: 'place', tower: 'lamp', x: 3, y: 6 }] });
    expect(r.ok).toBe(false);
    expect(r.endTurn).toBe(true);
    expect(r.text).toMatch(/cannot be fixed this turn/);
    const legacy = executeTool({ world: w, role: 'player', assist: false }, 'act', {
      actions: [{ do: 'place', tower: 'lamp', x: 3, y: 6 }],
    });
    expect(legacy.endTurn).toBe(false);
  });

  it('schemas: intents only in the assisted act; v1 act and rules kept for the baseline; prefix small and stable', () => {
    const a = toolsForRole('player').find((t) => t.name === 'act')!;
    const v1 = toolsForRole('player', false).find((t) => t.name === 'act')!;
    expect(v1).toBe(ACT_TOOL_V1);
    for (const k of INTENT_KINDS) {
      expect(validateAgainst(a.input_schema, { actions: [{ do: k }] })).toEqual([]);
      expect(validateAgainst(v1.input_schema, { actions: [{ do: k }] })).not.toEqual([]);
    }
    expect(
      validateAgainst(a.input_schema, { actions: [{ do: 'build_near', tower: 'pencil', target: 'airline:north', count: 2 }] }),
    ).toEqual([]);
    expect(validateAgainst(a.input_schema, { actions: [{ tower: 'pencil' }] })).not.toEqual([]);
    const [rules] = systemBlocks('player');
    const [old] = systemBlocks('player', false);
    expect(rules).toMatch(/\{do:"maze"\}/);
    expect(old).not.toMatch(/do:"maze"/);
    expect(systemBlocks('player')).toEqual(systemBlocks('player'));
    expect(estimateTokens(rules)).toBeLessThan(1800);
    // 含 end.doctrine（中心策略，§20）
    expect(estimateTokens(JSON.stringify(a))).toBeLessThan(1450);
    // 军师不发意图规则
    expect(systemBlocks('advisor')[0]).not.toMatch(/do:"maze"/);
  });
});

describe('battle report, threat estimate, idle nudge', () => {
  it('reports leaks by enemy and spawner, kills, per-tower damage and zero-damage towers', () => {
    const w = createWorld(opts('br-1'));
    const log = new BattleLog(w);
    // 一座塔放在离路线很远的角落：0 伤害
    const far = [
      [0, 13],
      [11, 13],
      [0, 12],
      [11, 12],
    ].find(([x, y]) => w.canPlace('pencil', x, y).ok)!;
    w.command({ type: 'place', tower: 'pencil', cx: far[0], cy: far[1] });
    const near = w.currentPaths()[0][6];
    const spot = [
      [near.x - 1, near.y],
      [near.x + 1, near.y],
    ].find(([x, y]) => w.canPlace('pencil', x, y).ok)!;
    w.command({ type: 'place', tower: 'pencil', cx: spot[0], cy: spot[1] });
    log.feed(w.drainEvents());
    w.command({ type: 'startWave' });
    let guard = 0;
    while (w.state.phase === 'wave' && guard++ < 20_000) w.step();
    log.feed(w.drainEvents());
    const br = log.take()!;
    expect(br).toMatch(/^BR w1: /);
    expect(br).toMatch(/kills \d+/);
    expect(br).toMatch(/LEAK \d+ cr×\d+@north/);
    expect(br).toMatch(/dmg #\d+pencil:\d+/);
    expect(br).toMatch(/0dmg #\d+/);
    expect(log.take()).toBeUndefined();
  });

  it('threat: no towers = 危险; more damage on the route raises the ratio; flyers count only against air lines', () => {
    const w = createWorld(opts('th-1'));
    const t0 = threatEstimate(w);
    expect(t0[0].verdict).toBe('危险');
    expect(t0[0].ratio).toBe(0);
    expect(threatLine(w)).toMatch(/^TH w1: north 危险 ×0 \(cr×\d+ hp\d+\) → \{do:"build_near"/);
    w.state.gold = 1000;
    const p = new Planner(w, (c) => w.command(c));
    p.maze('serpentine', 200);
    p.buildNear('pencil', 'route', 6);
    const t1 = threatEstimate(w);
    expect(t1[0].ratio).toBeGreaterThan(2);
    expect(t1[0].verdict).toBe('安全');
    // 空中：把下一波预告换成纸飞机（只是测试估算；不跑世界）
    const air = createWorld(opts('th-1'));
    air.state.nextWave = {
      ...air.state.nextWave,
      tags: ['air'],
      groups: [{ enemy: 'plane', count: 6, elite: 0, affixes: [], spawner: 'north' }],
    };
    const ta = threatEstimate(air);
    expect(ta.map((t) => t.id)).toEqual(['air:north']);
    expect(ta[0].verdict).toBe('危险');
    // 建议的意图必须能直接通过 act 的 Schema（字段是 route，不是 line；§19.12 起对空写成 build_near purpose air）
    const hint = /\{do:"build_near",purpose:"air"[^}]*\}/.exec(threatLine(air)!)![0];
    expect(hint).toBe('{do:"build_near",purpose:"air",route:"north"}');
    const act0 = toolsForRole('player').find((t) => t.name === 'act')!;
    expect(validateAgainst(act0.input_schema, { actions: [{ do: 'build_near', purpose: 'air', route: 'north' }] })).toEqual([]);
    expect(threatLine(air)).toMatch(/CTR pl→air/);
  });

  it('engine injects BR / TH / NEXT once per decision and records build-phase gold', { timeout: 30_000 }, async () => {
    const msgs: string[] = [];
    const inner = new ScriptedProvider({ intents: true });
    const provider = {
      id: 'scripted',
      model: 'peek',
      decide: (ctx: Parameters<ScriptedProvider['decide']>[0]) => {
        msgs.push(ctx.message);
        return inner.decide(ctx);
      },
    };
    const rep = await runAgentGame(opts('en-1'), { config: { provider: 'scripted' }, provider, maxWaves: 3 });
    expect(msgs[0]).toMatch(/\nTH w1: /);
    // 闲置金币并进 NEXT 的 spend（开局全花）；其他行不再带「→ 建议」
    expect(msgs[0]).toMatch(/\nNEXT \[.*\{"do":"spend","reserve":0\}\] ← /);
    expect(msgs[0]).not.toMatch(/\nIDLE /);
    expect(msgs[0].split('\n').filter((l) => /^(TH|CTR|MZ|CB|RC|GAP) /.test(l) && l.includes('→ {do:'))).toEqual([]);
    expect(msgs.some((m) => /\nBR w1: /.test(m))).toBe(true);
    expect(msgs.filter((m) => /\nBR w1: /.test(m))).toHaveLength(1);
    expect(rep.play.idleSamples).toBeGreaterThan(0);
    expect(rep.play.pathLen).toBeGreaterThan(rep.play.pathLen0);
    expect(rep.result.lives).toBe(rep.result.maxLives);
    // assist 关闭：没有这些行
    const off: string[] = [];
    const p2 = {
      id: 'scripted',
      model: 'peek',
      decide: (ctx: Parameters<ScriptedProvider['decide']>[0]) => {
        off.push(ctx.message);
        return new ScriptedProvider().decide(ctx);
      },
    };
    await runAgentGame(opts('en-1'), { config: { provider: 'scripted', assist: false }, provider: p2, maxWaves: 1 });
    expect(off.some((m) => /\n(TH|BR|IDLE|NEXT) /.test(m))).toBe(false);
  });

  it('scripted intents beat the old scripted policy and are deterministic', { timeout: 30_000 }, async () => {
    const a = await runAgentGame(opts('sc-1', 'ch1', 'hard'), {
      config: { provider: 'scripted', model: 'scripted-intents' },
      provider: new ScriptedProvider({ intents: true }),
      maxWaves: 6,
    });
    const b = await runAgentGame(opts('sc-1', 'ch1', 'hard'), {
      config: { provider: 'scripted', model: 'scripted-intents' },
      provider: new ScriptedProvider({ intents: true }),
      maxWaves: 6,
    });
    const v1 = await runAgentGame(opts('sc-1', 'ch1', 'hard'), {
      config: { provider: 'scripted' },
      provider: new ScriptedProvider(),
      maxWaves: 6,
    });
    expect(a.log).toEqual(b.log);
    expect(a.result.lives).toBeGreaterThanOrEqual(v1.result.lives);
    expect(a.play.pathLen).toBeGreaterThan(v1.play.pathLen);
    expect(a.play.rejected).toBe(0);
    // 引擎层：DecisionEngine 的 assist 缺省开
    const w = createWorld(opts('sc-2'));
    const eng = new DecisionEngine({
      world: w,
      opts: opts('sc-2'),
      config: resolveConfig({ provider: 'scripted' }),
      provider: null,
      fallback: scriptedFallback(w),
    });
    expect(eng.assist).toBe(true);
  });
});

describe('eval harness', () => {
  it('runs a scripted matrix with bot references and writes table / json / html', { timeout: 30_000 }, async () => {
    const out = mkdtempSync(join(tmpdir(), 'agent-eval-'));
    const r = await runEval(['--seeds', 'ev-1', '--max-waves', '2', '--bots', 'medium', '--out', out, '--quiet']);
    expect(r.rows.map((x) => x.variant)).toEqual(['v1', 'intents', 'bot:medium']);
    for (const row of r.rows) {
      expect(row.cleared).toBe(2);
      expect(row.rawTokens).toBe(0);
      expect(row.pathLen).toBeGreaterThan(0);
    }
    expect(r.summary).toHaveLength(3);
    const md = markdownTable(r.summary);
    expect(md.split('\n')[0]).toMatch(/\| variant \| runs \| lost \| wave \| lives/);
    expect(existsSync(join(out, 'eval.html'))).toBe(true);
    expect(JSON.parse(readFileSync(join(out, 'eval.json'), 'utf8')).rows).toHaveLength(3);
    expect(parseVariants('a:assist=off,thinking=low;b:model=x')).toEqual([
      { name: 'a', kv: { assist: 'off', thinking: 'low' } },
      { name: 'b', kv: { model: 'x' } },
    ]);
    expect(summarize(r.rows).find((s) => s.variant === 'bot:medium')!.kind).toBe('bot');
  });
});
