import { describe, expect, it } from 'vitest';

import {
  AGENT_TOOLS,
  AgentScheduler,
  asciiMap,
  type DecisionContext,
  type DecisionReason,
  estimateTokens,
  executeTool,
  type JsonSchema,
  type LLMProvider,
  observe,
  renderObservation,
  resolveConfig,
  runAgentGame,
  saveableConfig,
  scriptedFallback,
  ScriptedProvider,
  systemBlocks,
  toCommand,
  toolsForRole,
  validateConfig,
  validateToolInput,
} from '../../src/agent';
import { emptyUsage } from '../../src/agent/types';
import { type Command, createWorld, type RunOptions, stateHash } from '../../src/core';
import { replaySync } from '../../src/meta/midrun';

const OPTS: RunOptions = {
  mode: 'endless',
  map: 'ch1',
  difficulty: 'normal',
  seed: 'agent-test',
  skills: ['eraser_strike', 'bell', 'whiteout_zone'],
  pure: true,
};

describe('observation', () => {
  it('has the documented shape and a 12×14 map', () => {
    const w = createWorld(OPTS);
    const o = observe(w);
    for (const k of [
      't',
      'tick',
      'phase',
      'wave',
      'gold',
      'lives',
      'score',
      'autoWave',
      'path',
      'towers',
      'enemies',
      'next',
      'skills',
      'events',
      'spawners',
      'pickups',
      'owned',
      'build',
    ]) {
      expect(o).toHaveProperty(k);
    }
    expect(o.skills.length).toBe(3);
    const map = asciiMap(w);
    expect(map.length).toBe(15);
    for (const row of map.slice(1)) expect(row.length).toBe(3 + 12);
    expect(map.join('')).toMatch(/S/);
    expect(map.join('')).toMatch(/X/);
  });

  it('stays within the token budget early and late', { timeout: 20_000 }, async () => {
    const w0 = createWorld(OPTS);
    const early = estimateTokens(renderObservation(w0));
    expect(early).toBeLessThan(1500);
    let late = 0;
    await runAgentGame(OPTS, {
      config: { provider: 'scripted' },
      provider: new ScriptedProvider(),
      maxWaves: 14,
      onDecision: (_r, w) => {
        late = Math.max(late, estimateTokens(renderObservation(w)));
      },
    });
    expect(late).toBeGreaterThan(early);
    expect(late).toBeLessThan(3000);
    // full 观测更大但仍有上限
    expect(estimateTokens(renderObservation(w0, { detail: 'full' }))).toBeLessThan(4000);
  });

  it('system prompt is byte-stable (cacheable prefix)', () => {
    expect(systemBlocks('player')).toEqual(systemBlocks('player'));
    expect(systemBlocks('player')[1]).toEqual(systemBlocks('advisor')[1]);
    expect(systemBlocks('player')[0]).not.toMatch(/seed|agent-test/);
  });
});

function checkStrict(s: JsonSchema, path: string): void {
  if (s.type === 'object') {
    expect(s.additionalProperties, path).toBe(false);
    for (const r of s.required) expect(Object.keys(s.properties), `${path}.${r}`).toContain(r);
    for (const [k, v] of Object.entries(s.properties)) checkStrict(v, `${path}.${k}`);
  } else if (s.type === 'array') checkStrict(s.items, `${path}[]`);
}

describe('tools', () => {
  it('all schemas are strict-compatible', () => {
    for (const t of AGENT_TOOLS) checkStrict(t.input_schema, t.name);
    expect(new Set(AGENT_TOOLS.map((t) => t.name)).size).toBe(AGENT_TOOLS.length);
  });

  const valid: Record<string, [Record<string, unknown>, Command['type']]> = {
    place_tower: [{ tower: 'pencil', x: 3, y: 5 }, 'place'],
    upgrade_tower: [{ uid: 1 }, 'upgrade'],
    choose_branch: [{ uid: 1, branch: 'B' }, 'upgrade'],
    evolve_tower: [{ uid: 1 }, 'evolve'],
    sell_tower: [{ uid: 1 }, 'sell'],
    set_target_mode: [{ uid: 1, mode: 'strong' }, 'setTarget'],
    cast_skill: [{ skill: 'eraser_strike', x: 4, y: 6 }, 'cast'],
    tower_ability: [{ uid: 1, x: 2, y: 2 }, 'towerAbility'],
    choose_perk: [{ id: 'legend', uid: 3, branch: 'A' }, 'choosePerk'],
    reroll_perks: [{}, 'rerollPerks'],
    collect_pickup: [{ uid: 7 }, 'collect'],
    choose_crate: [{ option: 'gold' }, 'chooseCrate'],
    demolish_spawner: [{ id: 'drop-1' }, 'demolishSpawner'],
    start_wave: [{}, 'startWave'],
  };

  it('every action tool maps to a valid Command', () => {
    const w = createWorld(OPTS);
    const actions = AGENT_TOOLS.filter((t) => t.kind === 'action')
      .map((t) => t.name)
      .sort();
    expect(actions).toEqual(Object.keys(valid).sort());
    for (const [name, [input, type]] of Object.entries(valid)) {
      expect(validateToolInput(name, input), name).toEqual([]);
      const c = toCommand(w, name, input);
      expect('type' in c && c.type, name).toBe(type);
    }
    expect(toCommand(w, 'choose_branch', { uid: 4, branch: 'A' })).toEqual({ type: 'upgrade', uid: 4, branch: 'A' });
    expect(toCommand(w, 'place_tower', { tower: 'glue', x: 1, y: 2 })).toEqual({ type: 'place', tower: 'glue', cx: 1, cy: 2 });
  });

  it('cast_skill picks the right target fields per skill', () => {
    const w = createWorld(OPTS);
    expect(toCommand(w, 'cast_skill', { skill: 'eraser_strike', x: 4, y: 6 })).toEqual({
      type: 'cast',
      skill: 'eraser_strike',
      x: 4.5,
      y: 6.5,
    });
    expect(toCommand(w, 'cast_skill', { skill: 'whiteout_zone', x: 4, y: 6 })).toEqual({
      type: 'cast',
      skill: 'whiteout_zone',
      cx: 4,
      cy: 6,
    });
    expect(toCommand(w, 'cast_skill', { skill: 'bell' })).toEqual({ type: 'cast', skill: 'bell' });
    expect(toCommand(null, 'cast_skill', { skill: 'ruler_sweep', axis: 'col', index: 3 })).toEqual({
      type: 'cast',
      skill: 'ruler_sweep',
      axis: 'col',
      cx: 3,
    });
    expect(toCommand(null, 'cast_skill', { skill: 'relocate', uid: 2, x: 1, y: 1 })).toEqual({
      type: 'cast',
      skill: 'relocate',
      uid: 2,
      cx: 1,
      cy: 1,
    });
    expect(toCommand(null, 'cast_skill', { skill: 'seal_tape', spawner: 'drop-2' })).toEqual({
      type: 'cast',
      skill: 'seal_tape',
      spawner: 'drop-2',
    });
    expect(toCommand(w, 'cast_skill', { skill: 'eraser_strike' })).toHaveProperty('error');
  });

  it('executes against the world and reports errors readably', () => {
    const w = createWorld(OPTS);
    const ctx = { world: w, role: 'player' as const };
    const ok = executeTool(ctx, 'place_tower', { tower: 'pencil', x: 0, y: 6 });
    expect(ok.ok, ok.text).toBe(true);
    expect(ok.text).toMatch(/^OK placed pencil #\d+/);
    expect(w.log.length).toBe(1);
    // 非法输入
    expect(executeTool(ctx, 'place_tower', { tower: 'pencil', x: 'a', y: 1 }).text).toMatch(/must be an integer/);
    expect(executeTool(ctx, 'place_tower', { tower: 'laser', x: 1, y: 1 }).text).toMatch(/must be one of/);
    expect(executeTool(ctx, 'place_tower', { tower: 'pencil', x: 1 }).text).toMatch(/y is required/);
    expect(executeTool(ctx, 'upgrade_tower', { uid: 1, extra: 1 }).text).toMatch(/not allowed/);
    expect(executeTool(ctx, 'nope', {}).ok).toBe(false);
    // 被世界拒绝
    const dup = executeTool(ctx, 'place_tower', { tower: 'pencil', x: 0, y: 6 });
    expect(dup.ok).toBe(false);
    expect(dup.text).toMatch(/^REJECTED/);
    expect(executeTool(ctx, 'sell_tower', { uid: 999 }).text).toMatch(/REJECTED/);
    expect(executeTool(ctx, 'choose_perk', { id: 'sale' }).ok).toBe(false);
    expect(executeTool(ctx, 'cast_skill', { skill: 'caffeine' }).text).toMatch(/REJECTED|没有携带/);
    // 只读工具不下指令
    const n = w.log.length;
    expect(executeTool(ctx, 'preview_placement', { tower: 'wall', x: 5, y: 5 }).text).toMatch(/place|cannot/);
    expect(executeTool(ctx, 'get_state', { detail: 'full' }).ok).toBe(true);
    expect(executeTool(ctx, 'get_catalog', { section: 'skills' }).text).toMatch(/eraser_strike/);
    expect(executeTool(ctx, 'get_tower', { uid: 1 }).ok).toBe(true);
    expect(w.log.length).toBe(n);
    // end_turn
    const e = executeTool(ctx, 'end_turn', { note: 'plan' });
    expect(e.endTurn).toBe(true);
    expect(e.note).toBe('plan');
    // 开波
    expect(executeTool(ctx, 'start_wave', {}).ok).toBe(true);
    expect(w.state.phase).toBe('wave');
  });

  it('advisor cannot act', () => {
    const w = createWorld(OPTS);
    const tips: string[] = [];
    const ctx = { world: w, role: 'advisor' as const, onSuggest: (t: string) => tips.push(t) };
    expect(toolsForRole('advisor').some((t) => t.kind === 'action')).toBe(false);
    expect(executeTool(ctx, 'place_tower', { tower: 'pencil', x: 0, y: 6 }).text).toMatch(/not available/);
    expect(executeTool(ctx, 'suggest', { text: '在 3,5 放铅笔', actions: ['place_tower pencil 3,5'] }).ok).toBe(true);
    expect(tips).toEqual(['在 3,5 放铅笔']);
    expect(w.log.length).toBe(0);
  });
});

describe('scheduler', () => {
  it('stops at the documented decision points', async () => {
    const w = createWorld({ ...OPTS, autoWave: true });
    const sched = new AgentScheduler(w, { waveIntervalSec: 10, maxWaves: 11 });
    const seen = new Set<DecisionReason>();
    const bot = scriptedFallback(w);
    const first = sched.advance();
    expect(first?.reasons).toContain('game_start');
    expect(first?.tick).toBe(0);
    let lastWaveInterval = -Infinity;
    let p = first;
    let guard = 0;
    while (p && guard++ < 500) {
      p.reasons.forEach((r) => seen.add(r));
      if (p.reasons.includes('wave_interval')) {
        expect(p.time - lastWaveInterval).toBeGreaterThanOrEqual(3 - 1e-6);
        lastWaveInterval = p.time;
      }
      await bot.decide(p.reasons);
      sched.markDecided();
      p = sched.advance();
    }
    expect(seen.has('game_start')).toBe(true);
    expect(seen.has('build')).toBe(true);
    expect(seen.has('wave_interval')).toBe(true);
    expect(seen.has('perk')).toBe(true); // 第 10 波后
    expect(['cap', 'lost']).toContain(sched.stopped);
  });

  it('manual mode waits in build phase', () => {
    const w = createWorld({ ...OPTS, autoWave: false });
    const sched = new AgentScheduler(w);
    expect(sched.advance()?.reasons).toContain('build');
    sched.markDecided();
    // 没开波：仍然是 build 决策点，世界不前进
    const p = sched.advance();
    expect(p?.reasons).toContain('build');
    expect(w.state.tick).toBe(0);
  });

  it('realtime elapse moves the world without deciding', () => {
    const w = createWorld(OPTS);
    const sched = new AgentScheduler(w, { mode: 'realtime' });
    sched.advance();
    executeTool({ world: w, role: 'player' }, 'start_wave', {});
    sched.markDecided();
    expect(sched.elapse(2)).toBe(true);
    expect(w.state.tick).toBe(120);
  });
});

describe('runner', () => {
  it('scripted agent plays ≥10 waves end to end, deterministically and replayably', async () => {
    const a = await runAgentGame(OPTS, { config: { provider: 'scripted' }, provider: new ScriptedProvider(), maxWaves: 12 });
    expect(a.result.cleared).toBeGreaterThanOrEqual(10);
    expect(a.result.outcome).toBe('cap');
    expect(a.errors).toEqual([]);
    expect(a.decisions.every((d) => d.by !== 'fallback')).toBe(true);
    expect(a.decisions.filter((d) => d.by === 'agent').length).toBeGreaterThan(15);
    expect(a.waves.length).toBe(a.result.cleared);
    expect(a.board).toBe('ai:normal:pure:auto');
    expect(a.replay.agent).toEqual({ provider: 'scripted', model: 'scripted-v1', role: 'player' });

    const b = await runAgentGame(OPTS, { config: { provider: 'scripted' }, provider: new ScriptedProvider(), maxWaves: 12 });
    expect(b.result).toEqual(a.result);
    expect(b.log).toEqual(a.log);

    // 回放：同 seed + 指令日志 ⇒ 同状态
    const live = createWorld(a.replay.opts);
    replaySync(live, a.replay);
    expect(live.state.tick).toBe(a.result.ticks);
    expect(live.state.score).toBe(a.result.score);
    const again = createWorld(a.replay.opts);
    replaySync(again, a.replay);
    expect(stateHash(again)).toBe(stateHash(live));
  }, 60_000);

  it('baseline (no provider) uses the fallback bot', async () => {
    const r = await runAgentGame(OPTS, { config: {}, provider: null, maxWaves: 3 });
    expect(r.decisions.every((d) => d.by === 'fallback')).toBe(true);
    expect(r.agent.provider).toBe('baseline');
  });

  function fakeProvider(
    fn: (ctx: DecisionContext, n: number) => Promise<Partial<ReturnType<typeof emptyUsage>> | 'error' | 'hang'>,
  ): LLMProvider {
    let n = 0;
    return {
      id: 'fake',
      model: 'fake-1',
      async decide(ctx) {
        const r = await fn(ctx, n++);
        if (r === 'error') return { usage: emptyUsage(), costUsd: 0, toolCalls: 0, ended: false, error: 'boom' };
        if (r === 'hang') {
          await new Promise((res) => ctx.signal.addEventListener('abort', res));
          return { usage: emptyUsage(), costUsd: 0, toolCalls: 0, ended: false, error: 'aborted' };
        }
        await ctx.callTool('end_turn', {});
        return { usage: { ...emptyUsage(), ...r, requests: 1 }, costUsd: 0.01, toolCalls: 1, ended: true };
      },
    };
  }

  it('token budget exhaustion hands the rest to the fallback bot', async () => {
    const p = fakeProvider(async () => ({ inputTokens: 600, outputTokens: 100 }));
    const r = await runAgentGame(OPTS, {
      config: { provider: 'scripted', contextMode: 'full', budget: { tokens: 2000, mode: 'hard' } },
      provider: p,
      maxWaves: 3,
    });
    const agentDecisions = r.decisions.filter((d) => d.by === 'agent').length;
    expect(agentDecisions).toBe(3);
    expect(r.decisions.some((d) => d.fallbackReason?.includes('budget'))).toBe(true);
    expect(r.disabledReason).toMatch(/budget/);
    expect(r.result.cleared).toBe(3);
  });

  it('timeout falls back for that decision; repeated errors disable the model', async () => {
    const hang = fakeProvider(async (_c, n) => (n === 0 ? 'hang' : {}));
    const r1 = await runAgentGame(OPTS, { config: { decisionTimeoutMs: 30 }, provider: hang, maxWaves: 1 });
    expect(r1.decisions[0].by).toBe('fallback');
    expect(r1.decisions[0].fallbackReason).toMatch(/timeout/);
    expect(r1.decisions.slice(1).every((d) => d.by === 'agent')).toBe(true);

    const bad = fakeProvider(async () => 'error');
    const r2 = await runAgentGame(OPTS, { config: { contextMode: 'full' }, provider: bad, maxWaves: 2 });
    expect(r2.errors.length).toBe(3);
    expect(r2.disabledReason).toMatch(/consecutive/);
    expect(r2.result.cleared).toBe(2);
  });

  it('realtime mode advances the world while the model "thinks"', async () => {
    const ticks: number[] = [];
    const p: LLMProvider = {
      id: 'rt',
      model: 'rt',
      async decide(ctx) {
        const before = ctx.world?.state.tick ?? 0;
        await ctx.afterRequest(0);
        ticks.push(before);
        await ctx.callTool('end_turn', {});
        return { usage: emptyUsage(), costUsd: 0, toolCalls: 1, ended: true };
      },
    };
    Object.defineProperty(p, 'id', { value: 'scripted' }); // 让 engine 传入 world 便于断言
    const r = await runAgentGame(OPTS, { config: { decision: { mode: 'realtime', realtimeLatencySec: 2 } }, provider: p, maxWaves: 2 });
    expect(r.result.cleared).toBe(2);
    // 每次决策后世界至少前进了 2 秒
    const d = r.decisions.map((x) => x.point.tick);
    for (let i = 1; i < d.length; i++) expect(d[i] - d[i - 1]).toBeGreaterThanOrEqual(120);
  });
});

describe('config', () => {
  it('fills presets and validates', () => {
    const c = resolveConfig({ provider: 'pi', preset: 'ollama' });
    expect(c.api).toBe('openai-completions');
    expect(c.baseUrl).toBe('http://localhost:11434/v1');
    expect(c.model).toBe('qwen3:8b');
    expect(c.decision?.waveIntervalSec).toBe(20);
    expect(validateConfig(c)).toEqual([]);
    expect(validateConfig({ provider: 'pi', preset: 'custom', model: 'x' })).toContain('自定义预设需要 baseUrl');
    expect(validateConfig({ provider: 'claude-native', model: 'gpt-4' }).length).toBe(1);
    expect(validateConfig({ provider: 'bridge', bridge: { url: 'http://x', code: '' } }).length).toBe(2);
    expect(saveableConfig(resolveConfig({ provider: 'claude-native', apiKey: 'sk-secret' })).apiKey).toBeUndefined();
  });
});
