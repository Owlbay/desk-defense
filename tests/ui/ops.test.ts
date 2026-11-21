/**
 * 操作解读（思路与请求面板右栏）：指令 / 事件归属到决策、act 结果与意图对齐、被拒解析、文案（zh-CN / en）、四种语言的 key 一致。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createWorld } from '../../src/core';
import { SKILL_META, TOWER_META } from '../../src/core';
import type { Command, CommandResult, GameEvent, RunOptions } from '../../src/core/types';
import type { TraceEvent } from '../../src/agent/trace';
import { setLocale } from '../../src/i18n';
import { OpsRecorder, alignAct, opsTotals, type CapturedCmd, type Op, type OpsWorld } from '../../src/ui/ai/ops';
import { groupSummary, groupTitle, opGold, opLine } from '../../src/ui/ai/ops-format';
import zhCN from '../../src/i18n/locales/zh-CN/agent.ops';
import zhTW from '../../src/i18n/locales/zh-TW/agent.ops';
import en from '../../src/i18n/locales/en/agent.ops';
import ja from '../../src/i18n/locales/ja/agent.ops';

afterAll(async () => {
  await setLocale('zh-CN');
});

// ── 假世界：够记录器读金币 / 塔 / 波次 ──
function fakeWorld(): OpsWorld & { state: OpsWorld['state'] } {
  return {
    state: {
      gold: 200,
      wave: 3,
      tick: 100,
      towers: new Map(),
      spawners: [{ id: 'drop-1', cells: [{ x: 7, y: 2 }] }],
      grid: { cols: 12, rows: 16 },
    },
  };
}

let tt = 1000;
const ev = (d: number, body: Record<string, unknown>): TraceEvent => ({ d, t: tt++, ...body }) as unknown as TraceEvent;

/** 模拟 Session 代理：执行（改假世界）并同步冒出事件 */
function runCmd(
  rec: OpsRecorder,
  w: ReturnType<typeof fakeWorld>,
  cmd: Command,
  effect: { ok?: boolean; code?: string; reason?: string; gold?: number; events?: GameEvent[]; apply?: () => void },
): CommandResult {
  return rec.record(cmd, () => {
    if (effect.ok === false) return { ok: false, code: effect.code, reason: effect.reason };
    w.state.gold += effect.gold ?? 0;
    effect.apply?.();
    for (const e of effect.events ?? []) rec.onGameEvent(e);
    return { ok: true };
  });
}

describe('操作归属到决策', () => {
  it('决策中的指令、工具调用里的指令、决策后的拾取各归其位', () => {
    let now = 0;
    const w = fakeWorld();
    const rec = new OpsRecorder({ world: w, eventOps: true, now: () => now });
    rec.onTrace(
      ev(1, {
        k: 'decision_start',
        trigger: ['build'],
        wave: 3,
        time: 10,
        tick: 100,
        phase: 'build',
        provider: 'scripted',
        model: 'x',
        role: 'player',
      }),
    );
    const args = { actions: [{ do: 'place', tower: 'pencil', x: 5, y: 4 }, { do: 'start_wave' }], end: { note: 'hold' } };
    rec.onTrace(ev(1, { k: 'tool_call', id: 'c1', name: 'act', args }));
    runCmd(
      rec,
      w,
      { type: 'place', tower: 'pencil', cx: 5, cy: 4 },
      {
        gold: -20,
        events: [{ type: 'place', uid: 12, tower: 'pencil', cx: 5, cy: 4 }],
        apply: () => w.state.towers.set(12, { uid: 12, id: 'pencil', cx: 5, cy: 4, level: 1, targetMode: 'first' }),
      },
    );
    runCmd(rec, w, { type: 'startWave' }, { gold: 12, events: [{ type: 'waveStart', wave: 4, tags: [] } as unknown as GameEvent] });
    rec.onTrace(
      ev(1, {
        k: 'tool_result',
        id: 'c1',
        name: 'act',
        ok: true,
        text: '1 OK placed pencil #12 at 5,4 (-20g, gold 180)\n2 OK wave 4 started (+12g early bonus)\n→ gold 192',
      }),
    );
    // 决策里、工具外（推进保证 / 兜底）
    runCmd(rec, w, { type: 'setTarget', uid: 12, mode: 'air' }, { apply: () => (w.state.towers.get(12)!.targetMode = 'air') });
    // 兜底机器人直接下指令：只有事件
    rec.onGameEvent({ type: 'levelUp', uid: 12, level: 2, tier: 1, tierChanged: false, byXp: false } as unknown as GameEvent);
    rec.onGameEvent({ type: 'levelUp', uid: 12, level: 3, tier: 1, tierChanged: false, byXp: true } as unknown as GameEvent); // 经验升级不算
    rec.onTrace(ev(1, { k: 'decision_end', by: 'agent', ms: 5, usage: {}, costUsd: 0, toolCalls: 1 }));
    // 决策之后：自动拾取（经代理）
    runCmd(
      rec,
      w,
      { type: 'collect', uid: 77 },
      { gold: 7, events: [{ type: 'pickup', uid: 77, kind: 'coin', x: 3.4, y: 6.6, phase: 'collect', value: 7 }] },
    );
    // 很久之后的事件（玩家自己的操作）不算
    now = 10_000;
    rec.onGameEvent({ type: 'place', uid: 30, tower: 'wall', cx: 1, cy: 1 });

    const d = rec.get(1)!;
    expect(d.tick).toBe(100);
    expect(d.groups.map((g) => g.kind)).toEqual(['act', 'auto', 'after']);
    const [act, auto, after] = d.groups;
    expect(act.ops.map((o) => [o.k, o.gold])).toEqual([
      ['place', -20],
      ['wave', 12],
      ['end', undefined],
    ]);
    expect(act.ops[0]).toMatchObject({ uid: 12, tower: 'pencil', cells: [{ x: 5, y: 4 }] });
    expect(act.ops[1].wave).toBe(4);
    expect(act.ops[2].note).toBe('hold');
    expect(auto.ops.map((o) => [o.k, o.from, o.to])).toEqual([
      ['target', 'first', 'air'],
      ['upgrade', 1, 2],
    ]);
    expect(auto.ops[1].src).toBe('event');
    expect(after.ops).toHaveLength(1);
    expect(after.ops[0]).toMatchObject({ k: 'collect', pickup: 'coin', gold: 7, cells: [{ x: 3, y: 6 }] });

    const tot = opsTotals(rec.all());
    expect(tot).toMatchObject({ build: 1, upgrade: 1, rejected: 0, spent: 20 });
  });

  it('兜底机器人的事件在下一条代理指令时才刷出：不算进那条指令', () => {
    const w = fakeWorld();
    const rec = new OpsRecorder({ world: w, eventOps: true });
    rec.onTrace(
      ev(2, {
        k: 'decision_start',
        trigger: ['build'],
        wave: 3,
        time: 10,
        tick: 5,
        phase: 'build',
        provider: 'x',
        model: 'x',
        role: 'player',
      }),
    );
    runCmd(
      rec,
      w,
      { type: 'startWave' },
      {
        gold: 0,
        events: [{ type: 'place', uid: 3, tower: 'glue', cx: 2, cy: 2 }, { type: 'waveStart', wave: 4, tags: [] } as unknown as GameEvent],
      },
    );
    const ops = rec.get(2)!.groups[0].ops;
    expect(ops.map((o) => [o.k, o.src])).toEqual([
      ['place', 'event'],
      ['wave', 'cmd'],
    ]);
  });

  it('导出 / 恢复', () => {
    const w = fakeWorld();
    const rec = new OpsRecorder({ world: w });
    rec.onTrace(
      ev(3, { k: 'decision_start', trigger: [], wave: 1, time: 0, tick: 0, phase: 'build', provider: 'x', model: 'x', role: 'player' }),
    );
    runCmd(rec, w, { type: 'rerollPerks' }, { gold: -50 });
    rec.onTrace(ev(3, { k: 'decision_end', by: 'agent', ms: 1, usage: {}, costUsd: 0, toolCalls: 0 }));
    const x = JSON.parse(JSON.stringify(rec.export()));
    const back = OpsRecorder.fromExport(x);
    expect(back.get(3)!.groups[0].ops[0]).toMatchObject({ k: 'reroll', gold: -50 });
    expect(rec.export((d) => d !== 3).decisions).toEqual([]);
  });
});

describe('act 结果对齐（意图分组 / 被拒）', () => {
  const cap = (cmd: Command, ok = true, extra: Partial<CapturedCmd> = {}): CapturedCmd => ({
    cmd,
    ok,
    gold: ok && cmd.type === 'place' ? -(cmd.tower === 'wall' ? 10 : 20) : 0,
    pre: { gold: 100 },
    events: [],
    post: { wave: 1 },
    ...extra,
  });

  it('意图成组：maze 的墙归组头，后面的底层放置单独一组', () => {
    const args = {
      actions: [
        { do: 'maze', style: 'serpentine', budget: 80 },
        { do: 'place', tower: 'wall', x: 9, y: 9 },
      ],
    };
    const cmds = [
      cap({ type: 'place', tower: 'wall', cx: 3, cy: 6 }),
      cap({ type: 'place', tower: 'wall', cx: 4, cy: 6 }),
      cap({ type: 'place', tower: 'wall', cx: 9, cy: 9 }),
    ];
    const text = '1 OK maze serpentine: +2 walls -20g path 24→41\n2 OK placed wall #9 at 9,9\n→ gold 70';
    const groups = alignAct(args, text, cmds);
    expect(groups.map((g) => [g.kind, g.ops.length])).toEqual([
      ['intent', 2],
      ['act', 1],
    ]);
    expect(groups[0].path).toEqual(['24', '41']);
    expect(groups[1].ops[0].cells).toEqual([{ x: 9, y: 9 }]);
  });

  it('参数错误（没走到指令）从结果文字解析；被拒的指令带原因码；自动挪位只显示结果', () => {
    const args = {
      actions: [{ do: 'place', tower: 'stapler', x: 6, y: 11 }, { do: 'upgrade' }, { do: 'place', tower: 'pencil', x: 1, y: 1 }],
    };
    const cmds = [
      cap({ type: 'place', tower: 'stapler', cx: 6, cy: 11 }, false, { code: 'enemyHere', reason: '有敌人在这里' }),
      cap({ type: 'place', tower: 'pencil', cx: 1, cy: 1 }, false, { code: 'occupied' }),
      cap({ type: 'place', tower: 'pencil', cx: 2, cy: 1 }),
    ];
    const text = [
      '1 REJECTED {"type":"place","tower":"stapler","cx":6,"cy":11}: 有敌人在这里',
      '2 ERROR upgrade: input.uid is required',
      '3 MOVED 1,1 (已经有塔了) → OK placed pencil #4 at 2,1 (-20g, gold 10)',
    ].join('\n');
    const [g] = alignAct(args, text, cmds);
    expect(g.ops.map((o) => [o.k, o.ok, o.code ?? null, !!o.invalid])).toEqual([
      ['place', false, 'enemyHere', false],
      ['upgrade', false, null, true],
      ['place', true, null, false],
    ]);
    expect(g.ops[1].reason).toBe('upgrade: input.uid is required');
    expect(g.ops[2]).toMatchObject({ cells: [{ x: 2, y: 1 }], movedFrom: { x: 1, y: 1 } });
    expect(opsTotals([{ d: 1, groups: [g] }]).rejected).toBe(2);
  });

  it('两个相邻意图按指令类型切分；save 不收指令', () => {
    const args = {
      actions: [
        { do: 'reclaim', what: 'useless_walls' },
        { do: 'build_near', tower: 'lamp', count: 1 },
        { do: 'save', until: 300 },
      ],
    };
    const cmds = [
      cap({ type: 'sell', uid: 3 }, true, { gold: 5 }),
      cap({ type: 'sell', uid: 4 }, true, { gold: 5 }),
      cap({ type: 'place', tower: 'lamp', cx: 4, cy: 4 }),
    ];
    const groups = alignAct(
      args,
      '1 OK reclaim useless_walls: sold #3wall@1,1 +5g; sold #4wall@1,2 +5g → path 30→28\n2 OK build_near lamp route: ...\n3 OK save: holding gold until 300 (gold 90)',
      cmds,
    );
    expect(groups.map((g) => [g.intent, g.ops.length])).toEqual([
      ['reclaim', 2],
      ['build_near', 1],
      ['save', 0],
    ]);
  });
});

describe('真实世界：放置 / 拆除 / 被拒', () => {
  it('经记录器下发的指令得到正确的金币变化与格子', () => {
    const OPTS: RunOptions = {
      mode: 'endless',
      map: 'ch1',
      difficulty: 'normal',
      seed: 'ops',
      skills: ['eraser_strike', 'bell'],
      pure: true,
      autoWave: false,
    };
    const world = createWorld(OPTS);
    const rec = new OpsRecorder({ world: world as unknown as OpsWorld });
    const send = (c: Command): CommandResult =>
      rec.record(c, () => {
        const r = world.command(c);
        for (const e of world.drainEvents()) rec.onGameEvent(e);
        return r;
      });
    let cell: { x: number; y: number } | null = null;
    const g = world.state.grid;
    for (let y = 0; y < g.rows && !cell; y++)
      for (let x = 0; x < g.cols && !cell; x++) if (world.canPlace('pencil', x, y).ok) cell = { x, y };
    expect(cell).not.toBeNull();
    rec.onTrace(
      ev(9, {
        k: 'decision_start',
        trigger: ['build'],
        wave: 0,
        time: 0,
        tick: 0,
        phase: 'build',
        provider: 'x',
        model: 'x',
        role: 'player',
      }),
    );
    send({ type: 'place', tower: 'pencil', cx: cell!.x, cy: cell!.y });
    send({ type: 'place', tower: 'pencil', cx: cell!.x, cy: cell!.y });
    const uid = [...world.state.towers.keys()][0];
    send({ type: 'sell', uid });
    rec.onTrace(ev(9, { k: 'decision_end', by: 'agent', ms: 1, usage: {}, costUsd: 0, toolCalls: 0 }));
    const ops = rec.get(9)!.groups.flatMap((x) => x.ops);
    expect(ops.map((o) => [o.k, o.ok])).toEqual([
      ['place', true],
      ['place', false],
      ['sell', true],
    ]);
    expect(ops[0].gold).toBe(-TOWER_META.pencil.cost);
    expect(ops[0].uid).toBe(uid);
    expect(ops[1].code).toBeTruthy();
    expect(ops[2].gold).toBeGreaterThan(0);
    expect(ops[2].cells).toEqual([cell]);
  });
});

describe('文案', () => {
  const place: Op = { k: 'place', ok: true, tower: 'pencil', cells: [{ x: 5, y: 4 }], gold: -20 };
  const sell: Op = { k: 'sell', ok: true, tower: 'wall', uid: 3, cells: [{ x: 3, y: 6 }], gold: 3 };
  const up: Op = { k: 'upgrade', ok: true, tower: 'pencil', uid: 12, from: 2, to: 3, gold: -29 };
  const target: Op = { k: 'target', ok: true, tower: 'pencil', uid: 12, from: 'first', to: 'air' };
  const wave: Op = { k: 'wave', ok: true, wave: 9, gold: 12 };
  const end: Op = { k: 'end', ok: true, note: 'hold' };
  const rej: Op = { k: 'place', ok: false, tower: 'stapler', cells: [{ x: 6, y: 11 }], code: 'enemyHere', reason: 'x' };
  const cast: Op = { k: 'cast', ok: true, skill: 'eraser_strike', cells: [{ x: 6, y: 8 }] };
  const maze = {
    kind: 'intent' as const,
    intent: 'maze',
    args: { style: 'serpentine', budget: 80 },
    path: ['24', '41'] as [string, string],
    ops: Array.from({ length: 8 }, (_, i): Op => ({ k: 'place', ok: true, tower: 'wall', cells: [{ x: i, y: 1 }], gold: -10 })),
  };

  it('简体中文', () => {
    const P = TOWER_META.pencil.name;
    expect(opLine(place)).toBe(`建造 ${P} @ (5,4)`);
    expect(opGold(place)).toBe('−20 金');
    expect(opLine(sell)).toBe(`拆除 ${TOWER_META.wall.name}#3 @ (3,6)`);
    expect(opGold(sell)).toBe('+3 金');
    expect(opLine(up)).toBe(`升级 ${P}#12 Lv2→Lv3`);
    expect(opLine(target)).toBe(`设置目标 ${P}#12：最前→优先飞行`);
    expect(opLine(wave)).toBe('开始第 9 波（提前 +12 金）');
    expect(opGold(wave)).toBeNull();
    expect(opLine(end)).toBe('结束本回合（笔记：hold）');
    expect(opLine(rej)).toBe(`✗ 被拒绝：建造 ${TOWER_META.stapler.name} @ (6,11) — 有敌人在这里`);
    expect(opLine(cast)).toBe(`施放 ${SKILL_META.eraser_strike.name} @ (6,8)`);
    expect(groupTitle(maze)).toBe('造迷宫（蛇形，预算 80）');
    expect(groupSummary(maze)).toBe('8 面墙，−80 金，路线 24→41');
  });

  it('English', async () => {
    await setLocale('en');
    const P = TOWER_META.pencil.name;
    expect(P).not.toMatch(/[一-鿿]/);
    expect(opLine(place)).toBe(`Build ${P} @ (5,4)`);
    expect(opGold(place)).toBe('−20g');
    expect(opLine(up)).toBe(`Upgrade ${P}#12 Lv2→Lv3`);
    expect(opLine(target)).toBe(`Set target ${P}#12: First→Air first`);
    expect(opLine(wave)).toBe('Start wave 9 (early +12g)');
    expect(opLine(rej)).toMatch(/^✗ Rejected: Build .+ @ \(6,11\) — /);
    expect(opLine(rej)).not.toMatch(/[一-鿿]/);
    expect(groupTitle(maze)).toBe('Build maze (serpentine, budget 80)');
    expect(groupSummary(maze)).toBe('8 walls, −80g, route 24→41');
    await setLocale('zh-CN');
  });
});

describe('i18n：agent.ops.* 四种语言一致', () => {
  it('key 与占位符相同', () => {
    const ph = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort().join();
    const src = zhCN as Record<string, string>;
    for (const d of [zhTW, en, ja] as Record<string, string>[]) {
      expect(Object.keys(d).sort()).toEqual(Object.keys(src).sort());
      for (const k of Object.keys(src)) expect(ph(d[k]), k).toBe(ph(src[k]));
    }
    expect(Object.keys(src).every((k) => k.startsWith('agent.ops.'))).toBe(true);
  });
});
