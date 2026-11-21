import { describe, expect, it } from 'vitest';

import {
  AgentTrace,
  createAgentController,
  type DecisionContext,
  DecisionDetector,
  DecisionEngine,
  type DecisionOutcome,
  emptyUsage,
  gateDecision,
  type LLMProvider,
  resolveConfig,
  scriptedFallback,
  ScriptedProvider,
  type SessionLike,
  systemBlocks,
  type TraceEvent,
} from '../../src/agent';
import {
  cleanInstruction,
  findAck,
  INSTRUCTION_MAX_CHARS,
  instructionIntents,
  InstructionQueue,
  instructionSection,
  STANDING_MAX,
} from '../../src/agent/instructions';
import { decisionMessage } from '../../src/agent/prompts';
import { createWorld, type RunOptions } from '../../src/core';

const OPTS: RunOptions = {
  mode: 'endless',
  map: 'ch1',
  difficulty: 'normal',
  seed: 'instr',
  skills: ['eraser_strike', 'bell', 'whiteout_zone'],
  pure: true,
};

/** 记下收到的 message / instructions 的假模型：回复里按编号回应 */
function recorder(reply = (ids: number[]) => ids.map((id) => `P${id} ok: done`).join(' | ')): LLMProvider & { seen: DecisionContext[] } {
  const seen: DecisionContext[] = [];
  return {
    id: 'fake',
    model: 'fake-1',
    seen,
    async decide(ctx): Promise<DecisionOutcome> {
      seen.push(ctx);
      const ids = ctx.instructions?.once.map((x) => x.id) ?? [];
      return { usage: emptyUsage(), costUsd: 0, toolCalls: 0, ended: true, text: reply(ids) };
    },
  };
}

const engineFor = (provider: LLMProvider, queue: InstructionQueue, trace?: AgentTrace, role: 'player' | 'advisor' = 'player') => {
  const w = createWorld({ ...OPTS, autoWave: false });
  return {
    w,
    engine: new DecisionEngine({
      world: w,
      opts: w.state.opts,
      config: resolveConfig({ provider: 'scripted', role }),
      provider,
      fallback: scriptedFallback(w),
      instructions: queue,
      trace,
    }),
  };
};

describe('instruction queue: one-shot vs standing', () => {
  it('one-shot goes pending → sent → done with the model ack; standing stays until removed', () => {
    const q = new InstructionQueue();
    const a = q.add('多造防空', 'once', 12);
    const b = q.add('别动右半边', 'standing');
    expect(a.ok && b.ok).toBe(true);
    expect(q.hasPending()).toBe(true);
    const t1 = q.take(7);
    expect(t1.once.map((x) => x.text)).toEqual(['多造防空']);
    expect(t1.standing.map((x) => x.text)).toEqual(['别动右半边']);
    expect(q.hasPending()).toBe(false);
    const done = q.complete(
      t1.once.map((x) => x.id),
      'P1 ok: built 2 lamps | P9 无法: x',
    );
    expect(done[0].status).toBe('done');
    expect(done[0].ack).toBe('P1 ok: built 2 lamps');
    expect(done[0].decision).toBe(7);
    // 第二次决策：一次性指令不再带，长期方针仍在
    const t2 = q.take(8);
    expect(t2.once).toEqual([]);
    expect(t2.standing.map((x) => x.id)).toEqual([2]);
    expect(q.remove(2)).toBe(true);
    expect(q.take(9).standing).toEqual([]);
  });

  it('caps standing orders, cleans and truncates text, requeues on abort', () => {
    const q = new InstructionQueue();
    for (let i = 0; i < STANDING_MAX; i++) expect(q.add(`方针 ${i}`, 'standing').ok).toBe(true);
    const full = q.add('再来一条', 'standing');
    expect(full.ok ? '' : full.reason).toBe('standing_full');
    expect(q.add('   ', 'once').ok).toBe(false);
    expect(cleanInstruction('a\u0000b\n\nc')).toBe('a b c');
    expect([...cleanInstruction('长'.repeat(500))].length).toBe(INSTRUCTION_MAX_CHARS + 1);
    q.add('开波', 'once');
    const t = q.take(1);
    q.requeue(t.once.map((x) => x.id));
    expect(q.hasPending()).toBe(true);
    // 没有回应：按状态码标记
    const t2 = q.take(2);
    const [x] = q.complete(
      t2.once.map((i) => i.id),
      'nothing relevant',
      'noReply',
    );
    expect(x.ack).toBeUndefined();
    expect(x.ackCode).toBe('noReply');
  });

  it('findAck matches by id only', () => {
    expect(findAck('P12 ok: a | P1 无法: no gold', 1)).toBe('P1 无法: no gold');
    expect(findAck('P12 ok: a', 1)).toBeUndefined();
  });
});

describe('prompt placement', () => {
  it('instructions go into the per-decision user message, never the cached prefix', async () => {
    const before = systemBlocks('player');
    const q = new InstructionQueue();
    q.add('集火 Boss', 'once');
    q.add('先存钱', 'standing');
    const p = recorder();
    const { engine } = engineFor(p, q);
    await engine.decide({ seq: 2, tick: 0, time: 0, wave: 0, phase: 'build', reasons: ['build'] }, []);
    const ctx = p.seen[0];
    expect(ctx.message).toContain('P1! 集火 Boss');
    expect(ctx.message).toContain('P2 先存钱');
    // 原因行之后、STATE 之前
    expect(ctx.message.indexOf('P1!')).toBeGreaterThan(ctx.message.indexOf('Decision #'));
    expect(ctx.message.indexOf('P1!')).toBeLessThan(ctx.message.indexOf('STATE'));
    // 固定前缀逐字节不变，且不含任何指令文字
    expect(ctx.system).toEqual(before);
    expect(systemBlocks('player')).toEqual(before);
    expect(ctx.system.join('')).not.toContain('集火');
    expect(ctx.system[0]).toContain('P<id>!');
    expect(engine.systemPrompt).toEqual(before);
    // 没有指令时 message 里也没有这一段
    expect(
      decisionMessage({ header: '', point: { seq: 1, tick: 0, time: 0, wave: 0, phase: 'build', reasons: ['build'] }, observation: '{}' }),
    ).not.toMatch(/P\d+!/);
    expect(instructionSection([], [])).toBe('');
  });

  it('advisor role answers with suggestions (prefix rule + verb)', () => {
    expect(systemBlocks('advisor')[0]).toMatch(/answer "P<id>!" in suggest/);
    expect(instructionSection([{ id: 3, text: 'q', kind: 'once' }], [], 'advisor')).toContain('回答');
  });
});

describe('gating bypass & controller trigger', () => {
  it('player reason always calls the model; detector fires immediately for pending one-shots', () => {
    const w = createWorld({ ...OPTS, autoWave: false });
    // 没钱：普通决策会被门控跳过
    w.state.gold = 0;
    expect(gateDecision(w, ['wave_interval'], 'aggressive', { goldAtLastCall: 0, seq: 5 })).not.toBeNull();
    expect(gateDecision(w, ['wave_interval', 'player'], 'aggressive', { goldAtLastCall: 0, seq: 5 })).toBeNull();
    const d = new DecisionDetector({ waveIntervalSec: 15, minGapSec: 3 });
    d.done(w);
    w.state.phase = 'wave';
    expect(d.check(w)).toBeNull();
    expect(d.check(w, true)).toEqual(['player']);
  });

  it('engine adds the player reason and the model is called even when gating would skip', async () => {
    const q = new InstructionQueue();
    q.add('多造防空', 'once');
    const p = recorder();
    const { engine, w } = engineFor(p, q);
    w.state.gold = 0;
    const rec = await engine.decide({ seq: 5, tick: 0, time: 30, wave: 3, phase: 'wave', reasons: ['wave_interval'] }, []);
    expect(rec.by).toBe('agent');
    expect(rec.point.reasons).toContain('player');
    expect(p.seen).toHaveLength(1);
    expect(rec.instructions?.[0].ack).toBe('P1 ok: done');
    expect(q.list()[0].status).toBe('done');
  });

  it('browser controller: sending a one-shot mid-wave triggers a decision on the next poll (pause mode pauses)', async () => {
    const w = createWorld({ ...OPTS, autoWave: false });
    let paused = false;
    const pauses: boolean[] = [];
    const session: SessionLike = {
      world: w,
      get paused() {
        return paused;
      },
      command: (c) => w.command(c),
      togglePause(force?: boolean) {
        paused = force ?? !paused;
        pauses.push(paused);
      },
      on: () => () => {},
    };
    const q = new InstructionQueue();
    const p = recorder();
    const ctl = createAgentController({
      config: { provider: 'scripted' },
      session,
      provider: p,
      mode: 'pause',
      pollMs: 0,
      instructions: q,
    });
    await ctl.start();
    ctl.poll(); // 开局决策
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    w.state.phase = 'wave';
    w.state.time = 0.5; // 离上次决策不到最小间隔
    ctl.poll();
    expect(p.seen).toHaveLength(1);
    q.add('集火 Boss', 'once', w.state.time);
    pauses.length = 0;
    ctl.poll();
    expect(pauses[0]).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(p.seen).toHaveLength(2);
    expect(p.seen[1].point.reasons).toContain('player');
    expect(p.seen[1].message).toContain('P1! 集火 Boss');
    ctl.stop();
  });
});

describe('scripted (offline demo) mapping', () => {
  it('maps keywords in all four languages to intents', () => {
    const keys = (s: string) => instructionIntents(s).map((i) => i.key);
    expect(keys('多造防空')).toEqual(['anti_air']);
    expect(keys('More anti-air')).toEqual(['anti_air']);
    expect(keys('対空を増やして')).toEqual(['anti_air']);
    expect(keys('先存钱')).toEqual(['save']);
    expect(keys('先存錢')).toEqual(['save']);
    expect(keys('把迷宫拉长')).toEqual(['maze']);
    expect(keys('迷路を長くして')).toEqual(['maze']);
    expect(keys('拆掉没用的墙')).toEqual(['reclaim']);
    expect(keys('换成范围伤害')).toEqual(['aoe']);
    expect(keys('下一波前开波')).toEqual(['start_wave']);
    expect(keys('Start the next wave')).toEqual(['start_wave']);
    expect(keys('别动右半边')).toEqual(['hold_right']);
    expect(instructionIntents('集火 Boss', { bossCells: [{ x: 3, y: 4 }] })[0].actions).toEqual([
      { do: 'cast_skill', skill: 'eraser_strike', x: 3, y: 4 },
    ]);
    expect(instructionIntents('换成范围伤害')[0].actions).toEqual([{ do: 'build_near', purpose: 'aoe' }]);
    expect(keys('今天天气不错')).toEqual([]);
  });

  it('scripted provider executes the intents and acknowledges each one-shot by id', async () => {
    const q = new InstructionQueue();
    q.add('下一波前开波', 'once');
    q.add('今天天气不错', 'once');
    q.add('先存钱', 'standing');
    const trace = new AgentTrace();
    const { engine, w } = engineFor(new ScriptedProvider(), q, trace);
    const rec = await engine.decide({ seq: 1, tick: 0, time: 0, wave: 0, phase: 'build', reasons: ['game_start', 'build'] }, []);
    expect(w.state.phase).toBe('wave');
    const act = rec.toolCalls.find((c) => c.name === 'act');
    expect((act?.input as { actions: { do: string }[] }).actions.map((a) => a.do)).toEqual(['start_wave', 'save']);
    const [a, b] = q.list();
    expect(a.ack).toMatch(/^P1 ok: start_wave/);
    expect(b.ack).toMatch(/^P2 无法/);
    // 存钱（长期方针）：这回合不按规则建塔
    expect(rec.toolCalls.filter((c) => c.name === 'place_tower')).toEqual([]);

    // 追踪：玩家指令块 + 回应
    const ev = trace.events();
    const ins = ev.find((e) => e.k === 'instruction') as Extract<TraceEvent, { k: 'instruction' }>;
    expect(ins.items.map((x) => [x.id, x.kind])).toEqual([
      [1, 'once'],
      [2, 'once'],
      [3, 'standing'],
    ]);
    const ack = ev.find((e) => e.k === 'instruction_ack') as Extract<TraceEvent, { k: 'instruction_ack' }>;
    expect(ack.items.map((x) => x.id)).toEqual([1, 2]);
    expect(ack.items[0].ack).toMatch(/^P1 ok/);
    expect(ev.indexOf(ins)).toBeLessThan(ev.indexOf(ack));
    expect(ev[ev.length - 1].k).toBe('decision_end');
    // 导出 / 回放保留
    const back = AgentTrace.fromExport(trace.export());
    expect(back.events().some((e) => e.k === 'instruction')).toBe(true);
  });

  it('model failure marks one-shots with a status code instead of a fake ack', async () => {
    const q = new InstructionQueue();
    q.add('多造防空', 'once');
    const bad: LLMProvider = {
      id: 'bad',
      model: 'bad',
      decide: async () => ({ usage: emptyUsage(), costUsd: 0, toolCalls: 0, ended: false, error: 'boom' }),
    };
    const { engine } = engineFor(bad, q);
    const rec = await engine.decide({ seq: 2, tick: 0, time: 0, wave: 0, phase: 'build', reasons: ['build'] }, []);
    expect(rec.by).toBe('fallback');
    expect(q.list()[0].status).toBe('done');
    expect(q.list()[0].ackCode).toBe('bot');
  });
});
