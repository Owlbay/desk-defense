/**
 * AI 对战（双模型，文档 10 §2.3）：进攻方 + 防守方在同一个世界里；无头整局确定、可回放；网页控制器的顺序与暂停。
 */
import { describe, expect, it } from 'vitest';

import {
  createDuelController,
  createProvider,
  type DecisionRecord,
  runAgentGame,
  ScriptedAttackerProvider,
  ScriptedProvider,
  type SessionLike,
} from '../../src/agent';
import { createWorld, type GameEvent, type RunOptions, stateHash } from '../../src/core';
import { replaySync } from '../../src/meta/midrun';

const OPTS: RunOptions = {
  mode: 'endless',
  map: 'ch1',
  difficulty: 'normal',
  seed: 'duel-test',
  skills: ['eraser_strike', 'bell', 'whiteout_zone'],
  pure: true,
};

const flush = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('AI vs AI (headless)', () => {
  const run = () =>
    runAgentGame(OPTS, {
      config: { provider: 'scripted', role: 'player' },
      provider: new ScriptedProvider(),
      attacker: { config: { provider: 'scripted' }, provider: new ScriptedAttackerProvider() },
      maxWaves: 6,
    });

  it('runs to completion with both sides deciding; attacker plans every wave before it starts', async () => {
    const order: string[] = [];
    const r = await runAgentGame(OPTS, {
      config: { provider: 'scripted', role: 'player' },
      provider: new ScriptedProvider(),
      attacker: { config: { provider: 'scripted' }, provider: new ScriptedAttackerProvider() },
      maxWaves: 6,
      onDecision: (rec) => order.push(`${rec.side}:${rec.point.seq}`),
    });
    expect(r.result.outcome).toBe('cap');
    expect(r.result.cleared).toBe(6);
    expect(r.errors).toEqual([]);
    expect(r.attacker).toBeDefined();
    expect(r.attacker!.errors).toEqual([]);
    const plans = r.log.filter((e) => e.cmd.type === 'overrideWave');
    expect(plans.length - r.result.wave).toBeGreaterThanOrEqual(0);
    expect(plans.length - r.result.wave).toBeLessThanOrEqual(1);
    expect(r.attacker!.planned).toBe(plans.length);
    expect(r.attacker!.decisions.every((d) => d.side === 'attack' && d.by === 'agent')).toBe(true);
    expect(r.decisions.every((d) => d.side === 'defend')).toBe(true);
    // 每一波（1..N）都在开始前被改写过（core 只接受「下一波、尚未开始」的 overrideWave）
    expect(plans.map((p) => (p.cmd as { wave: number }).wave)).toEqual(Array.from({ length: plans.length }, (_, i) => i + 1));
    // 第 k 波的题总在第 k 次开波之前落地（指令日志顺序）
    const starts = r.log.map((e, i) => (e.cmd.type === 'startWave' ? i : -1)).filter((i) => i >= 0);
    r.log.forEach((e, i) => {
      if (e.cmd.type !== 'overrideWave') return;
      const k = (e.cmd as { wave: number }).wave;
      if (starts[k - 1] !== undefined) expect(i).toBeLessThan(starts[k - 1]);
    });
    expect(order[0]).toMatch(/^attack:/);
    expect(r.replay.agent.role).toBe('player');
    expect(r.replay.attacker).toEqual({ provider: 'scripted', model: 'scripted-v1' });
  });

  it('is deterministic: same command log, and replaying it gives the same stateHash', async () => {
    const a = await run();
    const b = await run();
    expect(b.log).toEqual(a.log);
    expect(b.result).toEqual(a.result);
    const live = createWorld(a.replay.opts);
    replaySync(live, a.replay);
    expect(live.state.tick).toBe(a.result.ticks);
    expect(live.state.score).toBe(a.result.score);
    expect(live.state.lives).toBe(a.result.lives);
    const again = createWorld(b.replay.opts);
    replaySync(again, b.replay);
    expect(stateHash(again)).toBe(stateHash(live));
  });

  for (const autoWave of [true, false])
    it(`plans every wave, including the one right after a perk choice (autoWave ${autoWave})`, async () => {
      // 只测增益后的出题时机，不测平衡：给防守方足够的命，保证能打过第 11 波
      const r = await runAgentGame(
        { ...OPTS, autoWave, mode: 'custom', custom: { lives: 1000 } },
        {
          config: { provider: 'scripted', role: 'player' },
          provider: new ScriptedProvider(),
          attacker: { config: { provider: 'scripted' }, provider: new ScriptedAttackerProvider() },
          maxWaves: 12,
        },
      );
      expect(r.result.wave).toBeGreaterThan(11);
      expect(r.log.some((e) => e.cmd.type === 'choosePerk')).toBe(true);
      const waves = r.log.filter((e) => e.cmd.type === 'overrideWave').map((e) => (e.cmd as { wave: number }).wave);
      // 自动开波时，上一波没清完下一波就会按计时开始（不经过建造阶段，进攻方没有出题机会）：只看清完之前的波
      const n = Math.min(r.result.wave, r.result.cleared + 1);
      expect(waves.slice(0, n)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
      expect(waves).toContain(11);
    }, 30_000);

  it('baseline attacker (no provider) falls back to the scripted plan', async () => {
    const r = await runAgentGame(OPTS, {
      config: { provider: 'scripted', role: 'player' },
      provider: await createProvider({ provider: 'scripted' }),
      attacker: { config: { provider: 'scripted' }, provider: null },
      maxWaves: 3,
    });
    expect(r.log.filter((e) => e.cmd.type === 'overrideWave').length).toBeGreaterThanOrEqual(r.result.wave);
    expect(r.attacker!.agent.model).toBe('scripted-attacker');
  });

  it('rejects a non-player defender', async () => {
    await expect(
      runAgentGame(OPTS, {
        config: { provider: 'scripted', role: 'advisor' },
        provider: null,
        attacker: { config: { provider: 'scripted' }, provider: null },
      }),
    ).rejects.toThrow();
  });
});

describe('AI vs AI (browser controller)', () => {
  it('pauses once per decision point, attacker before defender, then resumes', async () => {
    const w = createWorld({ ...OPTS, autoWave: false });
    let paused = false;
    const pauses: boolean[] = [];
    const subs = new Set<(ev: GameEvent) => void>();
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
      on: (fn) => (subs.add(fn), () => subs.delete(fn)),
    };
    const recs: DecisionRecord[] = [];
    const sides: string[] = [];
    const ctl = createDuelController({
      session,
      attacker: { config: { provider: 'scripted', model: 'scripted-v1' } },
      defender: { config: { provider: 'scripted', model: 'scripted-v1' } },
      pollMs: 0,
      onEvent: (ev) => {
        if (ev.type === 'decision') recs.push(ev.record);
        if (ev.type === 'status' && ev.side && ev.status === 'thinking') sides.push(ev.side);
      },
    });
    await ctl.start();
    expect(ctl.status).toBe('running');
    ctl.poll();
    // 思考期间再 poll 不会重复发起
    ctl.poll();
    await flush();
    // 进攻方出题 → 防守方开波 → 进攻方马上给第 2 波出题（同一次暂停里完成）
    expect(sides).toEqual(['attack', 'defend', 'attack']);
    expect(recs.map((r) => r.side)).toEqual(['attack', 'defend', 'attack']);
    expect(recs[0].point.seq).toBe(recs[1].point.seq);
    expect(pauses).toEqual([true, false]);
    expect(paused).toBe(false);
    // 进攻方出了题、防守方开了波
    const types = w.log.map((e) => e.cmd.type);
    expect(types.indexOf('overrideWave')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('overrideWave')).toBeLessThan(types.indexOf('startWave'));
    const rep = ctl.report();
    expect(rep.agent.role).toBe('duel');
    expect(rep.attacker).toEqual({ provider: 'scripted', model: 'scripted-v1' });
    // 第 2 波已经出过题：同一波不会再问进攻方
    w.state.time += 20;
    w.state.phase = 'wave';
    ctl.poll();
    await flush();
    expect(recs.filter((r) => r.side === 'attack').length).toBe(2);
    ctl.stop();
    expect(ctl.status).toBe('stopped');
  });
});
