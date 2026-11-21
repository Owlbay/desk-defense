/**
 * 打法情报与新意图（文档 10 §19.8）：漏怪明细 / 缺口、无用墙、回收、用途选塔、组合技相邻、前缀稳定。全部离线、确定性。
 */
import { describe, expect, it } from 'vitest';

import { DecisionEngine, executeTool, resolveConfig, scriptedFallback } from '../../src/agent';
import { comboLine, comboState, crowdedCells, mazeLine, reclaimLine, uselessWalls, wallInfo } from '../../src/agent/board';
import { BattleIntel, findGap, gapLine, killLine, leakLine, segTarget, segText } from '../../src/agent/intel';
import { planMaze } from '../../src/agent/maze';
import { estimateTokens } from '../../src/agent/observation';
import { Planner } from '../../src/agent/planner';
import { cheatSheet, systemBlocks } from '../../src/agent/prompts';
import { COMBOS } from '../../src/config/towers';
import { CellKind, type Command, createWorld, type IWorld, type MapId, type RunOptions } from '../../src/core';
import { loadLocale, setLocale, SOURCE_LOCALE, withLocale } from '../../src/i18n';

const opts = (seed: string, map: MapId = 'ch1', difficulty: RunOptions['difficulty'] = 'normal'): RunOptions => ({
  mode: 'endless',
  map,
  difficulty,
  seed,
  skills: ['eraser_strike', 'bell', 'whiteout_zone'],
  pure: true,
});

function allRoutesOpen(w: IWorld): boolean {
  const g = w.state.grid;
  const exits = new Set(g.exits.map((e) => e.y * g.cols + e.x));
  return w.currentPaths().every((p) => p.length > 0 && exits.has(p[p.length - 1].y * g.cols + p[p.length - 1].x));
}

const send = (w: IWorld) => (c: Command) => w.command(c);

/** 一格空地：不在路线上、放墙不改变任何路线长度 */
function idleCell(w: IWorld, skip = new Set<number>()): { x: number; y: number } {
  const g = w.state.grid;
  const on = new Set(
    w
      .currentPaths()
      .flat()
      .map((c) => c.y * g.cols + c.x),
  );
  const lens = w
    .currentPaths()
    .map((p) => p.length)
    .join('/');
  for (let y = g.rows - 1; y >= 0; y--)
    for (let x = 0; x < g.cols; x++) {
      const i = y * g.cols + x;
      if (g.cells[i] !== CellKind.Empty || on.has(i) || skip.has(i) || !w.canPlace('wall', x, y).ok) continue;
      const pv = w.previewPath('wall', x, y);
      if (pv && pv.map((p) => p.length).join('/') === lens) return { x, y };
    }
  throw new Error('no idle cell');
}

/** 跑完一波，每个事件喂给情报 */
function runWaveWith(w: IWorld, intel: BattleIntel, maxSec = 150): void {
  if (w.state.phase === 'build') w.command({ type: 'startWave' });
  const until = w.state.time + maxSec;
  while (w.state.time < until && w.state.phase === 'wave') {
    w.step();
    for (const ev of w.drainEvents()) intel.onEvent(ev);
  }
}

describe('leak intelligence', () => {
  it('records every leak with spawner, hp left, time in range, damage share and the uncovered segment', () => {
    const w = createWorld(opts('intel-1'));
    const intel = new BattleIntel(w);
    // 一支铅笔放在路线开头：后半段无覆盖
    const p = new Planner(w, send(w));
    p.buildNear('pencil', 'early', 1);
    runWaveWith(w, intel);
    expect(w.state.stats.leaks).toBeGreaterThan(0);
    const leaks = intel.takeLeaks();
    expect(leaks.length).toBe(w.state.stats.leaks);
    for (const l of leaks) {
      expect(l.sp).toBe('north');
      expect(l.hp).toBeGreaterThan(0);
      expect(l.hp).toBeLessThanOrEqual(1);
      expect(l.inRange).toBeGreaterThanOrEqual(0);
      expect(l.inRange).toBeLessThan(1);
      expect(l.gap).not.toBeNull();
      expect(l.gap!.cells.length).toBeGreaterThanOrEqual(2);
    }
    // 被铅笔打过的漏怪：主伤塔就是那支铅笔
    const hit = leaks.find((l) => l.towers.length);
    if (hit) expect(hit.towers[0].id).toBe('pencil');
    const line = withLocale(SOURCE_LOCALE, () => leakLine(w, leaks)!);
    expect(line).toMatch(/^LK w1 漏\d+: 橡皮屑×\d+\(.*剩\d+%血 射程内\d+% north .*(无覆盖|仅1塔)/);
    expect(estimateTokens(line)).toBeLessThan(120);
    const gap = gapLine(w, intel)!;
    expect(gap).toMatch(/^GAP .*north .*×\d+ → \{do:"build_near",purpose:"dps",target:"seg:\d+,\d+-\d+,\d+"\}/);
    // 击杀分布
    const kills = intel.takeKills();
    const kh = killLine(w, kills);
    if ([...kills.values()].reduce((a, b) => a + b, 0) >= 3) expect(kh).toMatch(/^KH 击杀 \d+: 前\/中\/后段/);
  });

  it('gap detection: longest uncovered run (≥2), else longest single-tower run (≥3)', () => {
    expect(findGap([1, 2, 3, 4, 5, 6], [2, 0, 0, 0, 1, 2], 'n')).toEqual({ sp: 'n', cells: [2, 3, 4], level: 0 });
    expect(findGap([1, 2, 3, 4, 5], [2, 1, 1, 1, 2], 'n')).toEqual({ sp: 'n', cells: [2, 3, 4], level: 1 });
    expect(findGap([1, 2, 3], [2, 0, 2], 'n')).toBeNull();
    expect(segText([5 + 9 * 12, 5 + 10 * 12, 5 + 11 * 12], 12)).toBe('x5 y9..11');
    expect(segText([3 + 4 * 12, 4 + 4 * 12], 12)).toBe('y4 x3..4');
    expect(segTarget([5 + 9 * 12, 6 + 11 * 12], 12)).toBe('seg:5,9-6,11');
  });

  it('caps and aggregates the per-wave leak list', () => {
    const w = createWorld(opts('intel-2'));
    const mk = (enemy: 'crumb' | 'inkdot' | 'plane' | 'paperclip' | 'ant', hp: number) => ({
      wave: 3,
      enemy,
      elite: false,
      affixes: [],
      flying: enemy === 'plane',
      netted: false,
      hp,
      sp: 'north',
      inRange: 0.4,
      towers: [],
      gap: null,
    });
    const leaks = [
      mk('crumb', 0.4),
      mk('crumb', 0.4),
      mk('crumb', 0.4),
      mk('inkdot', 1),
      mk('plane', 0.8),
      mk('paperclip', 0.5),
      mk('ant', 1),
    ];
    const line = withLocale(SOURCE_LOCALE, () => leakLine(w, leaks, 4)!);
    expect(line).toMatch(/^LK w3 漏7: 橡皮屑×3\(均剩40%血/);
    expect(line).toMatch(/\+1种$/);
  });
});

describe('board check & reclaim', () => {
  it('useless walls: off-route walls are flagged, maze walls that lengthen the route are not', () => {
    const w = createWorld(opts('rc-1'));
    w.state.gold = 500;
    const p = new Planner(w, send(w));
    p.maze('serpentine', 60);
    const a = idleCell(w);
    w.command({ type: 'place', tower: 'wall', cx: a.x, cy: a.y });
    const info = wallInfo(w);
    const idle = info.find((x) => x.x === a.x && x.y === a.y)!;
    expect(idle.shortens).toBe(false);
    expect(uselessWalls(w).some((x) => x.uid === idle.uid)).toBe(!idle.inPlan);
    // 迷宫墙：在规划里（或拆了会变短）→ 不算无用
    for (const x of info.filter((x) => x.uid !== idle.uid)) expect(x.inPlan || x.shortens).toBe(true);
    for (const x of uselessWalls(w)) expect(x.inPlan || x.shortens || x.bonus).toBe(false);
  });

  it('reclaim useless_walls never shortens or blocks a route and refunds the sell value', () => {
    const w = createWorld(opts('rc-2'));
    w.state.gold = 500;
    const p0 = new Planner(w, send(w));
    p0.maze('serpentine', 80);
    const plan = new Set(planMaze(w).all);
    const placed: number[] = [];
    const skip = new Set(plan);
    for (let k = 0; k < 3; k++) {
      const c = idleCell(w, skip);
      skip.add(c.y * w.state.grid.cols + c.x);
      if (w.command({ type: 'place', tower: 'wall', cx: c.x, cy: c.y }).ok)
        placed.push(w.state.grid.towerAt[c.y * w.state.grid.cols + c.x]);
    }
    // 过了 5 秒撤销期：按退款率（Lv1 墙 5g × 0.7 → 3g）
    for (let i = 0; i < 400 && w.state.phase === 'build'; i++) w.step();
    const useless = uselessWalls(w).map((x) => x.uid);
    expect(useless.length).toBeGreaterThan(0);
    const lens0 = w.currentPaths().map((x) => x.length);
    const g0 = w.state.gold;
    const sellValue = useless.reduce((a, u) => a + (w.getTowerInfo(u)?.sellValue ?? 0), 0);
    const o = new Planner(w, send(w)).reclaim('useless_walls', 12);
    expect(o.done).toBe(useless.length);
    expect(Math.round(w.state.gold - g0)).toBe(sellValue);
    expect(sellValue).toBe(useless.length * 3);
    const lens1 = w.currentPaths().map((x) => x.length);
    lens1.forEach((l, i) => expect(l).toBeGreaterThanOrEqual(lens0[i]));
    expect(allRoutesOpen(w)).toBe(true);
    for (const u of useless) expect(w.state.towers.has(u)).toBe(false);
    // dry：只列，不改
    const before = w.state.towers.size;
    expect(new Planner(w, send(w)).reclaim('useless_walls', 4, undefined, true).text).toMatch(/dry/);
    expect(w.state.towers.size).toBe(before);
  });

  it('reclaim idle_towers sells towers that reach no route; reclaim cells swaps walls for towers without changing the route', () => {
    const w = createWorld(opts('rc-3'));
    w.state.gold = 2000;
    const p = new Planner(w, send(w));
    p.maze('serpentine', 400);
    const lens0 = w.currentPaths().map((x) => x.length);
    // 一座够不着路线的铅笔（离所有路线格 > 射程）
    const g = w.state.grid;
    const route = w.currentPaths().flat();
    let far: { x: number; y: number } | null = null;
    for (let y = 0; y < g.rows && !far; y++)
      for (let x = 0; x < g.cols && !far; x++) {
        if (g.cells[y * g.cols + x] !== CellKind.Empty || !w.canPlace('pencil', x, y).ok) continue;
        if (route.every((c) => Math.hypot(c.x - x, c.y - y) > 3.2)) {
          const pv = w.previewPath('pencil', x, y);
          if (pv && pv.map((q) => q.length).join('/') === lens0.join('/')) far = { x, y };
        }
      }
    if (far) {
      w.command({ type: 'place', tower: 'pencil', cx: far.x, cy: far.y });
      const uid = g.towerAt[far.y * g.cols + far.x];
      const o = new Planner(w, send(w)).reclaim('idle_towers', 4);
      expect(o.done).toBeGreaterThan(0);
      expect(w.state.towers.has(uid)).toBe(false);
    }
    expect(w.currentPaths().map((x) => x.length)).toEqual(lens0);
    const crowded = crowdedCells(w);
    if (crowded.length) {
      const o = new Planner(w, send(w)).reclaim('cells', 2, 'pencil');
      expect(o.done).toBeGreaterThan(0);
      expect(w.currentPaths().map((x) => x.length)).toEqual(lens0);
      const c = crowded[0];
      expect(w.state.towers.get(g.towerAt[c.y * g.cols + c.x])?.id).toBe('pencil');
    }
    expect(allRoutesOpen(w)).toBe(true);
  });

  it('RC / CB / MZ lines appear when there is something to say', () => {
    const w = createWorld(opts('rc-4'));
    w.state.gold = 1000;
    const p = new Planner(w, send(w));
    expect(mazeLine(w)).toMatch(/^MZ 路线 L\d+ = 直线 \d+ 的 [\d.]+×/);
    p.maze('serpentine', 100);
    const skip = new Set(planMaze(w).all);
    for (let k = 0; k < 2; k++) {
      const c = idleCell(w, skip);
      skip.add(c.y * w.state.grid.cols + c.x);
      w.command({ type: 'place', tower: 'wall', cx: c.x, cy: c.y });
    }
    expect(reclaimLine(w)).toMatch(/^RC 无用墙 \d+.*\{do:"reclaim",target:"useless_walls"/);
    p.buildNear('glue', 'route', 1);
    for (const id of ['pencil', 'pencil', 'pencil'] as const) p.buildNear(id, 'route', 1);
    const cb = comboLine(w)!;
    expect(cb).toMatch(/^CB /);
    expect(cb).toMatch(/\{do:"combo",pair:"glue\+stapler"\}/);
  });
});

describe('purposes & combos', () => {
  it('purpose → best affordable tower for the job', () => {
    const w = createWorld(opts('pu-1'));
    w.state.gold = 500;
    const p = new Planner(w, send(w));
    expect(p.towerForPurpose('slow')?.id).toBe('glue');
    expect(p.towerForPurpose('stealth')?.id).toBe('lamp');
    expect(p.towerForPurpose('antiheal')?.id).toBe('pen');
    expect(['eraser', 'lamp']).toContain(p.towerForPurpose('armor')?.id);
    expect(['swatter', 'pencil', 'lamp', 'ruler']).toContain(p.towerForPurpose('air')?.id);
    expect(['stapler', 'compass', 'ruler']).toContain(p.towerForPurpose('aoe')?.id);
    // 钱不够买台灯：破甲选橡皮擦
    w.state.gold = 45;
    expect(new Planner(w, send(w)).towerForPurpose('armor')?.id).toBe('eraser');
    w.state.gold = 10;
    expect(new Planner(w, send(w)).towerForPurpose('armor')).toBeNull();
    // act：build_near purpose
    w.state.gold = 200;
    const r = executeTool({ world: w, role: 'player' }, 'act', { actions: [{ do: 'build_near', purpose: 'slow' }], end: {} });
    expect(r.text).toMatch(/build_near purpose=slow: glue/);
    expect([...w.state.towers.values()].some((t) => t.id === 'glue')).toBe(true);
  });

  it('combo places the pair orthogonally adjacent (combo active), and pairs a lonely tower first', () => {
    const w = createWorld(opts('cb-1'));
    w.state.gold = 1000;
    const p = new Planner(w, send(w));
    p.maze('serpentine', 120);
    const o = new Planner(w, send(w)).combo('glue+stapler');
    expect(o.done).toBe(2);
    const st = comboState(w);
    expect(st.active.length).toBe(1);
    const [a, b] = [w.state.towers.get(st.active[0].a)!, w.state.towers.get(st.active[0].b)!];
    expect(Math.abs(a.cx - b.cx) + Math.abs(a.cy - b.cy)).toBe(1);
    expect(new Set([a.id, b.id])).toEqual(new Set(['glue', 'stapler']));
    expect(allRoutesOpen(w)).toBe(true);
    // 落单的台灯 → 钢笔放在它旁边
    new Planner(w, send(w)).buildNear('lamp', 'route', 1);
    const lamp = [...w.state.towers.values()].find((t) => t.id === 'lamp')!;
    const o2 = new Planner(w, send(w)).combo('lamp+pen');
    expect(o2.done).toBeGreaterThan(0);
    // 落单的台灯旁有好格就配它（1 座钢笔），否则新放一对：总之多了一个激活的台灯 + 钢笔
    w.getTowerInfo(lamp.uid);
    if (o2.done === 1) expect(w.state.towers.get(lamp.uid)!.comboWith.length).toBe(1);
    expect(comboState(w).active.some((x) => new Set([w.state.towers.get(x.a)!.id, w.state.towers.get(x.b)!.id]).has('pen'))).toBe(true);
    expect(new Planner(w, send(w)).combo('pencil+lamp').text).toMatch(/unknown pair/);
  });

  it('economy only when the defense has a clear margin', () => {
    const w = createWorld(opts('ec-1'));
    w.state.gold = 300;
    expect(new Planner(w, send(w)).economy().text).toMatch(/not safe/);
  });
});

describe('prefix', () => {
  it('rules + cheat sheet are byte-stable, bounded, and list every combo / purpose', () => {
    const a = withLocale(SOURCE_LOCALE, () => systemBlocks('player'));
    const b = withLocale(SOURCE_LOCALE, () => systemBlocks('player'));
    expect(a).toEqual(b);
    const cs = a[1];
    expect(estimateTokens(cs)).toBeLessThan(1250);
    expect(estimateTokens(a[0])).toBeLessThan(1300);
    for (const c of COMBOS) expect(cs).toContain(`${c.a}+${c.b}`);
    for (const pu of ['armor', 'aoe', 'slow', 'air', 'stealth', 'boss', 'antiheal', 'shield']) expect(cs).toContain(`${pu}(`);
    expect(cs).toMatch(/Wall next to attack towers/);
    expect(a[0]).toMatch(/reclaim/);
    expect(cheatSheet()).toBe(withLocale(SOURCE_LOCALE, () => cheatSheet()));
  });

  it('the engine builds the prefix in zh-CN whatever the UI locale', async () => {
    const ref = withLocale(SOURCE_LOCALE, () => systemBlocks('player'));
    await loadLocale('en');
    await setLocale('en');
    try {
      const w = createWorld(opts('loc-1'));
      const eng = new DecisionEngine({
        world: w,
        opts: opts('loc-1'),
        config: resolveConfig({ provider: 'scripted' }),
        provider: null,
        fallback: scriptedFallback(w),
      });
      expect(eng.systemPrompt).toEqual(ref);
      expect(eng.systemPrompt[1]).toMatch(/铅笔每次命中/);
    } finally {
      await setLocale(SOURCE_LOCALE);
    }
  });
});
