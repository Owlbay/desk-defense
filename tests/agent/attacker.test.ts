/**
 * AI 进攻方（文档 10 §2.3）：attack_plan 工具、进攻方观测 / 提示、确定性出题策略、无头整局与回放。
 */
import { describe, expect, it } from 'vitest';

import {
  attackObservation,
  createAgentController,
  createProvider,
  type DecisionContext,
  emptyUsage,
  executeTool,
  type LLMProvider,
  runAgentGame,
  ScriptedAttackerProvider,
  scriptedAttackPlan,
  type SessionLike,
  systemBlocks,
  toolsForRole,
} from '../../src/agent';
import { attackBudget, checkAttackPlan } from '../../src/config/attack';
import { type Command, createWorld, type GameEvent, type RunOptions, stateHash } from '../../src/core';
import { replaySync } from '../../src/meta/midrun';

const OPTS: RunOptions = {
  mode: 'endless',
  map: 'ch1',
  difficulty: 'normal',
  seed: 'attacker-test',
  skills: ['eraser_strike', 'bell', 'whiteout_zone'],
  pure: true,
};

describe('attacker tools & prompt', () => {
  it('offers attack_plan + read tools + end_turn only', () => {
    const names = toolsForRole('attacker').map((t) => t.name);
    expect(names[0]).toBe('attack_plan');
    expect(names).toContain('end_turn');
    expect(names).not.toContain('act');
    expect(names).not.toContain('suggest');
    expect(toolsForRole('player').some((t) => t.name === 'attack_plan')).toBe(false);
    const [rules] = systemBlocks('attacker');
    expect(rules).toMatch(/进攻方/);
    expect(rules).toMatch(/attack_plan/);
    // 固定前缀逐字节稳定
    expect(systemBlocks('attacker')).toEqual(systemBlocks('attacker'));
  });

  it('attack_plan rewrites the next wave through the command log', () => {
    const w = createWorld(OPTS);
    const ctx = { world: w, role: 'attacker' as const };
    expect(executeTool({ world: w, role: 'player' }, 'attack_plan', { groups: [{ enemy: 'crumb', count: 3 }] }).text).toMatch(
      /not available/,
    );
    const bad = executeTool(ctx, 'attack_plan', { groups: [{ enemy: 'moth', count: 3 }] });
    expect(bad.ok).toBe(false);
    expect(bad.text).toMatch(/REJECTED/);
    expect(bad.endTurn).toBeFalsy();
    const ok = executeTool(ctx, 'attack_plan', { groups: [{ enemy: 'crumb', count: 5 }], note: '先试探' });
    expect(ok.ok).toBe(true);
    expect(ok.endTurn).toBe(true);
    expect(ok.note).toBe('先试探');
    expect(w.state.nextWave.override?.budget).toBe(attackBudget(1));
    expect(w.log.at(-1)?.cmd).toEqual({ type: 'overrideWave', wave: 1, plan: { groups: [{ enemy: 'crumb', count: 5 }] } });
    // 进攻方不能下防守指令
    expect(executeTool(ctx, 'act', { actions: [{ do: 'start_wave' }] }).text).toMatch(/not available/);
  });

  it('has a compact observation with budget, pool, prices and the defender summary', () => {
    const w = createWorld(OPTS);
    w.command({ type: 'place', tower: 'pencil', cx: 5, cy: 6 });
    const o = attackObservation(w)!;
    const j = JSON.parse(o.text) as Record<string, unknown>;
    expect(j.w).toBe(1);
    expect(j.budget).toBe(attackBudget(1));
    expect((j.pool as string[])[0]).toMatch(/^crumb \$5 hp20/);
    expect((j.def as { T: string }).T).toMatch(/pencil×1/);
    expect(o.text.length).toBeLessThan(1500);
  });
});

describe('scripted attacker policy', () => {
  it('is deterministic and always valid', () => {
    const w = createWorld(OPTS);
    const a = scriptedAttackPlan(w)!;
    expect(a).toEqual(scriptedAttackPlan(createWorld(OPTS)));
    const info = w.attackContext!()!;
    const chk = checkAttackPlan({ groups: a }, { wave: info.wave, pool: info.pool, spawners: info.spawners, baseHp: info.baseHp });
    expect(chk.ok).toBe(true);
    expect(w.command({ type: 'overrideWave', wave: 1, plan: { groups: a } }).ok).toBe(true);
  });

  it('the factory returns it for role attacker', async () => {
    const p = await createProvider({ provider: 'scripted', role: 'attacker' });
    expect(p).toBeInstanceOf(ScriptedAttackerProvider);
  });

  it('plays a headless game (bot defends) and replays exactly', async () => {
    const run = () =>
      runAgentGame(OPTS, { config: { provider: 'scripted', role: 'attacker' }, provider: new ScriptedAttackerProvider(), maxWaves: 6 });
    const a = await run();
    expect(a.errors).toEqual([]);
    const plans = a.log.filter((e) => e.cmd.type === 'overrideWave');
    // 每波开始前都出了题（上一波一开始就给下一波出题，所以封顶时可能多出一波的题）
    expect(plans.slice(0, a.result.wave).map((p) => (p.cmd as { wave: number }).wave)).toEqual(
      Array.from({ length: a.result.wave }, (_, i) => i + 1),
    );
    expect(plans.length - a.result.wave).toBeLessThanOrEqual(1);
    expect(a.decisions.filter((d) => d.by === 'agent').length).toBe(plans.length);
    expect(a.replay.agent.role).toBe('attacker');
    const b = await run();
    expect(b.log).toEqual(a.log);
    expect(b.result).toEqual(a.result);
    const live = createWorld(a.replay.opts);
    replaySync(live, a.replay);
    expect(live.state.tick).toBe(a.result.ticks);
    const again = createWorld(a.replay.opts);
    replaySync(again, a.replay);
    expect(stateHash(again)).toBe(stateHash(live));
  });

  it('falls back to the scripted plan when the model fails', async () => {
    const broken: LLMProvider = {
      id: 'remote',
      model: 'broken',
      decide: async (_ctx: DecisionContext) => ({ usage: emptyUsage(), costUsd: 0, toolCalls: 0, ended: false, error: 'boom' }),
    };
    const r = await runAgentGame(OPTS, { config: { provider: 'scripted', role: 'attacker' }, provider: broken, maxWaves: 2 });
    expect(r.log.filter((e) => e.cmd.type === 'overrideWave').length).toBeGreaterThanOrEqual(1);
    expect(r.decisions.some((d) => d.by === 'fallback')).toBe(true);
  });
});

describe('AI 出题 timing (browser controller)', () => {
  const flush = async (n = 6): Promise<void> => {
    for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it('plans the next wave as soon as the previous one starts, without pausing; holds wave start while planning', async () => {
    const w = createWorld({ ...OPTS, autoWave: false });
    let paused = false;
    const subs = new Set<(ev: GameEvent) => void>();
    const session: SessionLike = {
      world: w,
      get paused() {
        return paused;
      },
      holdStart: null,
      command(c: Command) {
        if (c.type === 'startWave' && session.holdStart?.()) return { ok: false, reason: 'attackPending' };
        return w.command(c);
      },
      togglePause(force?: boolean) {
        paused = force ?? !paused;
      },
      on: (fn) => (subs.add(fn), () => subs.delete(fn)),
    };
    // 可控的慢模型：放行之前一直在「出题中」
    let release: () => void = () => undefined;
    class Slow extends ScriptedAttackerProvider {
      override async decide(ctx: DecisionContext) {
        await new Promise<void>((r) => (release = r));
        return super.decide(ctx);
      }
    }
    const ctl = createAgentController({
      session,
      config: { provider: 'scripted', role: 'attacker', decision: { mode: 'pause', waveIntervalSec: 0 } },
      provider: new Slow(),
      pollMs: 0,
    });
    await ctl.start();
    // 建造阶段：开始给第 1 波出题；不暂停游戏，但手动开波被挡住
    ctl.poll();
    await flush();
    expect(paused).toBe(false);
    expect(session.command({ type: 'startWave' }).ok).toBe(false);
    release();
    await flush();
    expect(w.state.nextWave.override).toBeDefined();
    expect(session.command({ type: 'startWave' }).ok).toBe(true);
    // 第 1 波一开始：马上给第 2 波出题（战斗中，不暂停）
    ctl.poll();
    await flush();
    expect(w.state.phase).toBe('wave');
    expect(paused).toBe(false);
    // 自动开波快到了、题还没出完 → 临时暂停，出完再继续
    w.state.autoWave.enabled = true;
    w.state.autoWave.started = true;
    w.state.autoWave.deadline = w.state.time + 0.5;
    ctl.poll();
    expect(paused).toBe(true);
    release();
    await flush();
    expect(paused).toBe(false);
    expect(w.state.wave).toBe(1);
    expect(w.state.nextWave.override).toBeDefined();
    expect(w.attackContext!()!.wave).toBe(2);
    ctl.stop();
    expect(session.holdStart).toBeNull();
  });
});
