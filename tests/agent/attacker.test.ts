/**
 * AI 进攻方（文档 10 §2.3）：attack_plan 工具、进攻方观测 / 提示、确定性出题策略、无头整局与回放。
 */
import { describe, expect, it } from 'vitest';

import {
  attackObservation,
  createProvider,
  type DecisionContext,
  emptyUsage,
  executeTool,
  type LLMProvider,
  runAgentGame,
  ScriptedAttackerProvider,
  scriptedAttackPlan,
  systemBlocks,
  toolsForRole,
} from '../../src/agent';
import { checkAttackPlan } from '../../src/config/attack';
import { createWorld, type RunOptions, stateHash } from '../../src/core';
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
    expect(w.state.nextWave.override?.budget).toBe(60);
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
    expect(j.budget).toBe(60);
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
    // 每波开始前都出了题
    expect(plans.length).toBe(a.result.wave);
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
