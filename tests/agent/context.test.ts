/**
 * 上下文与成本优化（文档 10 §13）：预算折算、act 批量动作、速查表、精简工具、门控、增量观测、历史压缩、备忘、
 * 前缀稳定、思考等级映射、预算分级、进攻路线与 preview。全部离线（mock / faux / 假客户端）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { fauxAssistantMessage, fauxThinking, fauxToolCall, registerFauxProvider, type Message } from '@mariozechner/pi-ai';
import { createWorld, stateHash, type IWorld, type MapId, type RunOptions } from '../../src/core';
import {
  AgentScheduler, ContextBuilder, DecisionEngine, Memo, MEMO_MAX_TOKENS, SLIM_TOOLS, ScriptedProvider, applyObsDelta, budgetTokens, cheatSheet, claudeThinkingPlan,
  compactObservation, compressWaypoints, contextSpec, coverage, diffObs, emptyUsage, estimateTokens, executeTool, expandWaypoints, flightLines,
  gateDecision, groundRoutes, keepThinkingInHistory, mayCompactHistory, piThinkingPlan, previewChanges, resolveConfig, rle, runAgentGame,
  scriptedFallback, systemBlocks, toolsForRole, unrle, usageTotal, validateAgainst,
  type DecisionContext, type JsonSchema, type LLMProvider, type TokenUsage,
} from '../../src/agent';
import { AgentTrace } from '../../src/agent/trace';
import { ClaudeProvider } from '../../src/agent/providers/claude';
import { PiProvider, compactToolResults, stripThinking } from '../../src/agent/providers/pi';
import { McpGameServer } from '../../src/agent/mcp';
import { tokenRun } from '../../scripts/token-model';

const OPTS: RunOptions = { mode: 'endless', map: 'ch1', difficulty: 'normal', seed: 'ctx-test', skills: ['eraser_strike', 'bell', 'whiteout_zone'], pure: true };
const usage = (p: Partial<TokenUsage>): TokenUsage => ({ ...emptyUsage(), ...p });

/** 不在路线上、可以放墙的空格（布局随种子随机） */
function emptyCells(w: IWorld): { x: number; y: number }[] {
  const route = new Set(w.currentPaths().flat().map((c) => c.y * 100 + c.x));
  const out: { x: number; y: number }[] = [];
  for (let y = 1; y < 13; y++) for (let x = 0; x < 12; x++) if (!route.has(y * 100 + x) && w.canPlace('wall', x, y).ok) out.push({ x, y });
  return out;
}

describe('budget weighting', () => {
  it('weights cache reads 0.1 and cache writes 1.25, keeps raw totals', () => {
    const u = usage({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 10_000, cacheWriteTokens: 2000, requests: 3 });
    expect(budgetTokens(u)).toBe(1000 + 500 + 2500 + 1000);
    expect(usageTotal(u)).toBe(13_500);
    // 实测基线：缓存读 215k + 新输入 102k + 输出 60k = 376k 原始 → 折算 ≈ 183.5k
    expect(budgetTokens(usage({ inputTokens: 102_000, outputTokens: 60_000, cacheReadTokens: 215_000 }))).toBe(183_500);
  });
});

describe('act (batched actions)', () => {
  it('runs actions in order with per-action results and ends the turn', () => {
    const w = createWorld(OPTS);
    // 旧行为（assist 关闭）：被拒的放置原样报 REJECTED；assist 下的自动挪位见 tests/agent/planner.test.ts
    const ctx = { world: w, role: 'player' as const, assist: false };
    const r = executeTool(ctx, 'act', {
      actions: [
        { do: 'place', tower: 'pencil', x: 0, y: 6 },
        { do: 'place', tower: 'pencil', x: 0, y: 6 },
        { do: 'upgrade', uid: 999 },
        { do: 'place', tower: 'pencil' },
        { do: 'start_wave' },
      ],
      end: { plan: 'hold the left lane', maze: 'wall row 5' },
    });
    const lines = r.text.split('\n');
    expect(lines[0]).toMatch(/^1 OK placed pencil #\d+/);
    expect(lines[1]).toMatch(/^2 REJECTED/);
    expect(lines[2]).toMatch(/^3 REJECTED/);
    expect(lines[3]).toMatch(/^4 ERROR place/);
    expect(lines[4]).toMatch(/^5 OK wave 1 started/);
    expect(r.text).toMatch(/→ gold \d+ lives/);
    expect(r.ok).toBe(false);
    expect(r.endTurn).toBe(true);
    expect(r.memo).toEqual({ plan: 'hold the left lane', maze: 'wall row 5' });
    expect(w.state.towers.size).toBe(1);
    expect(w.state.phase).toBe('wave');
  });

  it('all-OK without end also ends; a failure without end leaves room for a correction', () => {
    const w = createWorld(OPTS);
    const ctx = { world: w, role: 'player' as const };
    const ok = executeTool(ctx, 'act', { actions: [{ do: 'place', tower: 'wall', x: 2, y: 2 }] });
    expect(ok.ok).toBe(true);
    expect(ok.endTurn).toBe(true);
    const bad = executeTool(ctx, 'act', { actions: [{ do: 'sell', uid: 4242 }] });
    expect(bad.endTurn).toBe(false);
    expect(bad.text).toMatch(/fix the failed actions/);
    expect(executeTool(ctx, 'act', { actions: [{ do: 'nuke' }] }).text).toMatch(/must be one of/);
    const end = executeTool(ctx, 'act', { actions: [{ do: 'end_turn', note: 'later' }] });
    expect(end.endTurn).toBe(true);
    expect(end.memo).toEqual({ note: 'later' });
    // 军师不能 act
    expect(executeTool({ world: w, role: 'advisor' }, 'act', { actions: [] }).text).toMatch(/not available/);
  });
});

describe('fixed prefix', () => {
  it('cheat sheet is small and covers every tower / enemy', () => {
    const cs = cheatSheet();
    expect(estimateTokens(cs)).toBeLessThan(1250);
    for (const id of ['pencil', 'swatter', 'lamp', 'wall', 'calculator']) expect(cs).toContain(` ${id} `);
    for (const id of ['plane', 'boss_alarm', 'invisink']) expect(cs).toContain(id);
    const [rules, sheet] = systemBlocks('player');
    expect(sheet).toBe(cs);
    expect(estimateTokens(rules)).toBeLessThan(1300);
    expect(rules).not.toMatch(/seed|ctx-test|\d{13}/);
  });

  function strict(s: JsonSchema, path: string): void {
    if (s.type === 'object') {
      expect(s.additionalProperties, path).toBe(false);
      for (const r of s.required) expect(Object.keys(s.properties)).toContain(r);
      for (const [k, v] of Object.entries(s.properties)) strict(v, `${path}.${k}`);
    } else if (s.type === 'array') strict(s.items, `${path}[]`);
  }

  it('≤ 7 slim tools with strict schemas, stable order', () => {
    expect(SLIM_TOOLS.length).toBeLessThanOrEqual(7);
    expect(SLIM_TOOLS.map((t) => t.name)).toEqual(['act', 'observe', 'preview', 'get_catalog', 'get_tower', 'suggest']);
    for (const t of SLIM_TOOLS) {
      strict(t.input_schema, t.name);
      expect(t.description.length, t.name).toBeLessThan(600);
    }
    expect(toolsForRole('player').map((t) => t.name)).toEqual(['act', 'observe', 'preview', 'get_catalog', 'get_tower']);
    expect(toolsForRole('advisor').map((t) => t.name)).toEqual(['observe', 'preview', 'get_catalog', 'get_tower', 'suggest']);
    expect(validateAgainst(SLIM_TOOLS[0].input_schema, { actions: [{ do: 'place', tower: 'pencil', x: 1, y: 2 }], end: { plan: 'x' } })).toEqual([]);
    expect(validateAgainst(SLIM_TOOLS[0].input_schema, { actions: [{ do: 'place', bogus: 1 }] })).not.toEqual([]);
    // 完整资料表仍能按需取到
    const w = createWorld(OPTS);
    expect(executeTool({ world: w, role: 'player' }, 'get_catalog', { id: 'lamp' }).text).toMatch(/台灯/);
    expect(executeTool({ world: w, role: 'player' }, 'get_catalog', { id: 'boss_alarm' }).text).toMatch(/boss/);
    expect(executeTool({ world: w, role: 'player' }, 'get_catalog', { section: 'perks' }).text.length).toBeGreaterThan(500);
  });

  it('MCP keeps the granular tools and adds act', () => {
    const names = new McpGameServer().listTools().map((t) => t.name);
    for (const n of ['act', 'preview', 'place_tower', 'upgrade_tower', 'start_wave', 'new_game', 'advance', 'observe']) expect(names).toContain(n);
    const srv = new McpGameServer();
    const sid = /session_id: (g\d+)/.exec(srv.callTool('new_game', { seed: 'm', auto_wave: true }).content[0].text)![1];
    const r = srv.callTool('act', { session_id: sid, actions: [{ do: 'place', tower: 'pencil', x: 0, y: 6 }, { do: 'start_wave' }] });
    expect(r.content[0].text).toMatch(/^1 OK placed/);
  });
});

/** 记录引擎交给模型的上下文（不联网）；每次决策 act 一次 */
function recorder(fn?: (ctx: DecisionContext) => Promise<void>): LLMProvider & { ctxs: DecisionContext[] } {
  const ctxs: DecisionContext[] = [];
  return {
    id: 'scripted', model: 'rec', ctxs,
    async decide(ctx) {
      ctxs.push(ctx);
      if (fn) await fn(ctx);
      else await ctx.callTool('act', { actions: [], end: { note: `d${ctx.point.seq}` } });
      return { usage: usage({ inputTokens: 300, outputTokens: 100, cacheReadTokens: 2500, requests: 1 }), costUsd: 0, toolCalls: 1, ended: true };
    },
  };
}

describe('prefix stability (cacheable)', () => {
  it('system + tools are byte-identical across decisions; run header lives in the user message', async () => {
    const p = recorder();
    await runAgentGame(OPTS, { config: { provider: 'scripted', contextMode: 'full' }, provider: p, maxWaves: 3 });
    expect(p.ctxs.length).toBeGreaterThan(5);
    const pre = (c: DecisionContext) => JSON.stringify({ system: c.system, tools: c.tools });
    for (const c of p.ctxs) expect(pre(c)).toBe(pre(p.ctxs[0]));
    expect(p.ctxs[0].message).toMatch(/seed ctx-test/);
    expect(pre(p.ctxs[0])).not.toMatch(/ctx-test/);
    // 另一局（不同种子）前缀也一样
    const q = recorder();
    await runAgentGame({ ...OPTS, seed: 'other' }, { config: { provider: 'scripted', contextMode: 'full' }, provider: q, maxWaves: 1 });
    expect(pre(q.ctxs[0])).toBe(pre(p.ctxs[0]));
  });

  it('Claude requests keep tools → system → cache_control breakpoints identical across decisions', async () => {
    const seen: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
    const client = {
      beta: {
        messages: {
          create: async (prm: Anthropic.Beta.MessageCreateParamsNonStreaming) => {
            seen.push(structuredClone(prm));
            return { content: [{ type: 'tool_use', id: `tu${seen.length}`, name: 'act', input: { actions: [], end: { note: 'ok' } } }], stop_reason: 'tool_use', stop_details: null, usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 2800, cache_creation_input_tokens: 0 } };
          },
        },
      },
    } as unknown as Anthropic;
    const provider = new ClaudeProvider({ client, model: 'claude-opus-5-5', thinking: 'low' });
    const r = await runAgentGame(OPTS, { config: { provider: 'claude-native', model: 'claude-opus-5-5', contextMode: 'balanced' }, provider, maxWaves: 2 });
    expect(r.errors).toEqual([]);
    expect(seen.length).toBeGreaterThan(2);
    const prefix = (p: Anthropic.Beta.MessageCreateParamsNonStreaming) => JSON.stringify({ tools: p.tools, system: p.system, tool_choice: p.tool_choice, cache_control: p.cache_control });
    for (const p of seen) expect(prefix(p)).toBe(prefix(seen[0]));
    const sys = seen[0].system as { text: string; cache_control?: unknown }[];
    expect(sys[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(sys.map((b) => b.text).join('')).not.toMatch(/ctx-test/);
    expect((seen[0].messages[0].content as string)).toMatch(/seed ctx-test/);
    expect(r.decisions.filter((d) => d.by === 'agent').every((d) => d.usage.requests === 1)).toBe(true);
  });
});

describe('decision gating', () => {
  it('skips quiet checks with no affordable useful action, never skips events / perks / first decision', () => {
    const w = createWorld({ ...OPTS, autoWave: true });
    const gc = { goldAtLastCall: 0, seq: 5 };
    // 开局金币够：不跳过
    expect(gateDecision(w, ['wave_interval'], 'normal', gc)).toBeNull();
    // 把钱花光
    const spots = emptyCells(w).slice(0, 3);
    executeTool({ world: w, role: 'player' }, 'act', { actions: [{ do: 'place', tower: 'piggy', ...spots[0] }, { do: 'place', tower: 'pencil', ...spots[1] }, { do: 'place', tower: 'pencil', ...spots[2] }] });
    const gold = Math.floor(w.state.gold);
    expect(gold).toBeLessThan(20);
    expect(gateDecision(w, ['wave_interval'], 'normal', gc)).toMatch(/无可行动作/);
    expect(gateDecision(w, ['build'], 'normal', gc)).toMatch(/无可行动作/);
    expect(gateDecision(w, ['wave_interval'], 'off', gc)).toBeNull();
    for (const r of ['game_start', 'perk', 'crate', 'event_warn', 'drop_warn', 'boss_spawn', 'leak'] as const) expect(gateDecision(w, [r, 'wave_interval'], 'aggressive', gc), r).toBeNull();
    expect(gateDecision(w, ['wave_interval'], 'aggressive', { goldAtLastCall: 0, seq: 1 })).toBeNull();
    // 省流：钱够一件事但不是"新到手"的 → 跳过；普通：不跳过
    w.state.gold = 60;
    expect(gateDecision(w, ['wave_interval'], 'normal', { goldAtLastCall: 55, seq: 9 })).toBeNull();
    expect(gateDecision(w, ['wave_interval'], 'aggressive', { goldAtLastCall: 55, seq: 9 })).toMatch(/新可行动作/);
    // 预算紧张：波次中的定期检查一律跳过
    expect(gateDecision(w, ['wave_interval'], 'normal', { goldAtLastCall: 0, seq: 9, quiet: true })).toMatch(/预算紧张/);
  });

  it('skipped points are recorded as local decisions; manual mode still auto-starts waves', async () => {
    const p = recorder(async (ctx) => {
      // 正常建造，然后把剩下的钱花在升级上（制造"没钱可花"的决策点）
      const w = ctx.world!;
      await scriptedFallback(w).decide(ctx.point.reasons);
      const ups = [...w.state.towers.values()].filter((x) => x.id !== 'wall').map((x) => ({ do: 'upgrade', uid: x.uid }));
      await ctx.callTool('act', { actions: [...ups, ...ups].slice(0, 16), end: {} });
    });
    const t = new AgentTrace();
    const r = await runAgentGame({ ...OPTS, autoWave: false }, { config: { provider: 'scripted', contextMode: 'balanced', decision: { waveIntervalSec: 2 } }, provider: p, maxWaves: 4, trace: t });
    expect(r.result.cleared).toBe(4);
    const local = r.decisions.filter((d) => d.by === 'local');
    expect(local.length).toBeGreaterThan(0);
    expect(local.every((d) => d.usage.requests === 0 && d.skipped)).toBe(true);
    const starts = t.events().filter((e) => e.k === 'decision_start' && e.skipped);
    expect(starts.length).toBe(local.length);
    expect(t.totals().skipped).toBe(local.length);
  });

  it('a skipped build point in manual mode starts the wave locally', async () => {
    const w = createWorld({ ...OPTS, autoWave: false });
    const spots = emptyCells(w);
    executeTool({ world: w, role: 'player' }, 'act', { actions: [{ do: 'place', tower: 'piggy', ...spots[0] }, { do: 'place', tower: 'pencil', ...spots[1] }, { do: 'place', tower: 'pencil', ...spots[2] }] });
    const p = recorder();
    const eng = new DecisionEngine({ world: w, opts: OPTS, config: resolveConfig({ provider: 'scripted', contextMode: 'balanced' }), provider: p, fallback: scriptedFallback(w) });
    const rec = await eng.decide({ seq: 5, tick: 0, time: 0, wave: 0, phase: 'build', reasons: ['build'] }, []);
    expect(rec.by).toBe('local');
    expect(rec.skipped).toMatch(/无可行动作/);
    expect(rec.fallbackReason).toMatch(/auto start_wave/);
    expect(w.state.phase).toBe('wave');
    expect(p.ctxs.length).toBe(0);
    expect(eng.skippedCount).toBe(1);
  });
});

describe('delta observations', () => {
  it('first decision full, later only changes; deltas reconstruct the full observation exactly', async () => {
    const w = createWorld({ ...OPTS, autoWave: true });
    const sched = new AgentScheduler(w, { waveIntervalSec: 5, maxWaves: 6 });
    const bot = scriptedFallback(w);
    let prev = compactObservation(w);
    let checks = 0;
    for (let p = sched.advance(); p && checks < 60; p = sched.advance()) {
      await bot.decide(p.reasons);
      sched.markDecided();
      const next = compactObservation(w, { recent: sched.takeRecent() });
      const d = diffObs(prev, next);
      expect(applyObsDelta(prev, d)).toEqual(next);
      expect(JSON.stringify(d).length).toBeLessThanOrEqual(JSON.stringify(next).length + 40);
      prev = next;
      checks++;
    }
    expect(checks).toBeGreaterThan(10);
  });

  it('ContextBuilder: full first, Δ afterwards, map only when terrain / routes change or every N', () => {
    const w = createWorld(OPTS);
    const spec = { ...contextSpec(resolveConfig({ provider: 'scripted', contextMode: 'balanced' })), mapEvery: 3 };
    const cb = new ContextBuilder(w, spec, 'Game: header');
    const pt = (seq: number) => ({ seq, tick: w.state.tick, time: w.state.time, wave: w.state.wave, phase: w.state.phase, reasons: ['build' as const] });
    const m1 = cb.build(pt(1), []);
    expect(m1.full).toBe(true);
    expect(m1.map).toBe(true);
    expect(m1.text).toMatch(/^Game: header/);
    const m2 = cb.build(pt(2), []);
    expect(m2.full).toBe(false);
    expect(m2.map).toBe(false);
    expect(m2.text).toMatch(/STATE Δ/);
    expect(m2.text).not.toMatch(/Game: header/);
    expect(m2.observationTokens).toBeLessThan(m1.observationTokens / 3);
    executeTool({ world: w, role: 'player' }, 'place_tower', { tower: 'wall', x: 5, y: 3 });
    const m3 = cb.build(pt(3), []);
    expect(m3.map).toBe(true); // 地形变了
    expect(m3.text).toMatch(/"T\+"|"W"/);
    cb.build(pt(4), []);
    cb.build(pt(5), []);
    expect(cb.build(pt(6), []).map).toBe(true); // 每 3 次
    // observe 拿到完整观测后基线更新；reset 后再次完整
    cb.reset();
    expect(cb.build(pt(7), []).full).toBe(true);
    // 完整模式：每次完整 + 地图
    const cf = new ContextBuilder(w, contextSpec(resolveConfig({ provider: 'scripted', contextMode: 'full' })), 'H');
    cf.build(pt(1), []);
    const f2 = cf.build(pt(2), []);
    expect(f2.full && f2.map).toBe(true);
  });

  it('RLE map rows round-trip', () => {
    for (const row of ['....##S.....', 'abc...+++XX.', '............']) expect(unrle(rle(row))).toBe(row);
    expect(rle('............')).toBe('12.');
  });

  it('observation size stays within mode budgets late in a game', async () => {
    let maxFull = 0;
    let maxDelta = 0;
    const p = recorder(async (ctx) => {
      const t = estimateTokens(ctx.message);
      if (/STATE Δ/.test(ctx.message)) maxDelta = Math.max(maxDelta, t);
      else maxFull = Math.max(maxFull, t);
      await scriptedFallback(ctx.world!).decide(ctx.point.reasons);
      await ctx.callTool('act', { actions: [], end: {} });
    });
    await runAgentGame(OPTS, { config: { provider: 'scripted', contextMode: 'balanced' }, provider: p, maxWaves: 14 });
    expect(maxFull).toBeLessThan(1500);
    expect(maxDelta).toBeLessThan(1100);
  }, 30_000);
});

describe('history compaction & thinking in history', () => {
  it('collapses older tool results above the threshold, keeps the latest round', () => {
    const long = 'x'.repeat(3000);
    const msgs: Message[] = [
      { role: 'user', content: 'state', timestamp: 0 },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'observe', arguments: {} }], api: 'openai-completions', provider: 'p', model: 'm', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'toolUse', timestamp: 0 },
      { role: 'toolResult', toolCallId: 'a', toolName: 'observe', content: [{ type: 'text', text: `first line\n${long}` }], isError: false, timestamp: 0 },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret reasoning' }, { type: 'toolCall', id: 'b', name: 'act', arguments: {} }], api: 'openai-completions', provider: 'p', model: 'm', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'toolUse', timestamp: 0 },
      { role: 'toolResult', toolCallId: 'b', toolName: 'act', content: [{ type: 'text', text: `1 OK\n${long}` }], isError: false, timestamp: 0 },
    ];
    expect(compactToolResults(msgs, 100_000)).toBe(0);
    expect(compactToolResults(msgs, 4000)).toBe(1);
    expect(JSON.stringify(msgs[2])).toMatch(/\[…\] first line/);
    expect(JSON.stringify(msgs[4])).toContain(long);
    const stripped = stripThinking(msgs[3] as Extract<Message, { role: 'assistant' }>);
    expect(JSON.stringify(stripped)).not.toMatch(/secret reasoning/);
    // 规则：anthropic 不改写历史、保留思考；completions（非 deepseek）去掉思考
    expect(mayCompactHistory('anthropic-messages')).toBe(false);
    expect(mayCompactHistory('openai-completions')).toBe(true);
    expect(keepThinkingInHistory('anthropic-messages')).toBe(true);
    expect(keepThinkingInHistory('openai-responses')).toBe(true);
    expect(keepThinkingInHistory('openai-completions', 'deepseek')).toBe(true);
    expect(keepThinkingInHistory('openai-completions', 'qwen')).toBe(false);
    expect(keepThinkingInHistory('openai-completions')).toBe(false);
  });

  let unregister: (() => void) | null = null;
  afterEach(() => { unregister?.(); unregister = null; });

  it('pi (openai-completions faux) does not re-send reasoning in the second request', async () => {
    const reg = registerFauxProvider({ api: 'openai-completions' } as never);
    unregister = reg.unregister;
    reg.setResponses([
      fauxAssistantMessage([fauxThinking('PRIVATE-REASONING'), fauxToolCall('observe', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('act', { actions: [], end: {} })], { stopReason: 'toolUse' }),
    ]);
    const payloads: string[] = [];
    const cfg = resolveConfig({ provider: 'pi', preset: 'custom', baseUrl: 'http://127.0.0.1:9/v1', model: 'faux' });
    const p = new PiProvider({ config: cfg, model: reg.getModel() });
    const w = createWorld(OPTS);
    const t = new AgentTrace();
    const sink = t.begin({ k: 'decision_start', trigger: [], wave: 0, time: 0, tick: 0, phase: 'build', provider: 'x', model: 'x', role: 'player' });
    await p.decide({
      role: 'player', point: { seq: 1, tick: 0, time: 0, wave: 0, phase: 'build', reasons: ['build'] }, system: systemBlocks('player'), message: 'm',
      tools: toolsForRole('player'), maxToolCalls: 4, remainingTokens: 1e9, signal: new AbortController().signal,
      callTool: async (n, i) => executeTool({ world: w, role: 'player' }, n, i), afterRequest: async () => true,
      trace: (ev) => { if (ev.k === 'request') payloads.push(JSON.stringify(ev.raw)); sink(ev); },
    });
    expect(payloads.length).toBe(2);
    if (reg.getModel().api === 'openai-completions') expect(payloads[1]).not.toMatch(/PRIVATE-REASONING/);
  });

  it('Claude: thinking blocks go back unchanged; server-side context editing instead of rewriting history', async () => {
    const seen: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
    const replies = [
      { content: [{ type: 'thinking', thinking: 'T1', signature: 's1' }, { type: 'tool_use', id: 't1', name: 'observe', input: {} }], stop_reason: 'tool_use' },
      { content: [{ type: 'tool_use', id: 't2', name: 'act', input: { actions: [], end: {} } }], stop_reason: 'tool_use' },
    ];
    const client = { beta: { messages: { create: async (prm: Anthropic.Beta.MessageCreateParamsNonStreaming) => { seen.push(structuredClone(prm)); return { ...replies.shift()!, stop_details: null, usage: { input_tokens: 1, output_tokens: 1 } }; } } } } as unknown as Anthropic;
    const w = createWorld(OPTS);
    await new ClaudeProvider({ client, model: 'claude-sonnet-5-5', thinking: 'medium' }).decide({
      role: 'player', point: { seq: 1, tick: 0, time: 0, wave: 0, phase: 'build', reasons: ['build'] }, system: systemBlocks('player'), message: 'm',
      tools: toolsForRole('player'), maxToolCalls: 4, remainingTokens: 1e9, signal: new AbortController().signal, historyCompactChars: 16_000,
      callTool: async (n, i) => executeTool({ world: w, role: 'player' }, n, i), afterRequest: async () => true,
    });
    expect((seen[1].messages[1].content as { type: string; thinking?: string }[])[0]).toMatchObject({ type: 'thinking', thinking: 'T1' });
    expect(seen[0].betas).toContain('context-management-2025-06-27');
    expect(JSON.stringify(seen[0].context_management)).toMatch(/clear_tool_uses_20250919/);
  });
});

describe('cross-decision memo', () => {
  it('merges structured fields and caps at 300 tokens', () => {
    const m = new Memo();
    m.update({ plan: 'build a long maze on the left', maze: 'walls at row 5' });
    m.update({ priorities: 'anti-air before wave 6' });
    expect(m.text()).toBe('plan: build a long maze on the left | maze: walls at row 5 | priorities: anti-air before wave 6');
    m.update({ note: 'x'.repeat(5000), plan: '计划'.repeat(400) });
    expect(m.tokens()).toBeLessThanOrEqual(MEMO_MAX_TOKENS);
    expect(m.fields.plan).toMatch(/^计划/);
  });

  it('the memo written with act end is shown in the next decision message', async () => {
    let n = 0;
    const p = recorder(async (ctx) => {
      if (n++ === 1) expect(ctx.message).toMatch(/MEMO plan: P1 \| maze: M1/);
      await ctx.callTool('act', { actions: [], end: { plan: 'P1', maze: 'M1' } });
    });
    await runAgentGame(OPTS, { config: { provider: 'scripted', contextMode: 'full' }, provider: p, maxWaves: 1 });
    expect(n).toBeGreaterThan(1);
  });
});

describe('thinking levels', () => {
  let unregister: (() => void) | null = null;
  afterEach(() => { unregister?.(); unregister = null; });
  it('Claude: per-model off mapping and normal levels', () => {
    expect(claudeThinkingPlan('claude-opus-5-5', 'off')).toMatchObject({ thinking: { type: 'adaptive' }, effort: 'low', note: 'Opus 5.5 不支持关闭思考，已用最低强度' });
    expect(claudeThinkingPlan('claude-fable-5-2', 'off')).toMatchObject({ thinking: { type: 'adaptive' }, effort: 'low' });
    expect(claudeThinkingPlan('claude-fable-5-2', 'off').note).toMatch(/Fable 5.2 不支持关闭思考/);
    expect(claudeThinkingPlan('claude-sonnet-5-5', 'off')).toEqual({ thinking: { type: 'between_tools' }, effort: 'low', effective: expect.any(String) });
    expect(claudeThinkingPlan('claude-haiku-5-5', 'off')).toMatchObject({ thinking: { type: 'disabled' }, effort: 'low' });
    expect(claudeThinkingPlan('claude-opus-5-5', 'max')).toMatchObject({ thinking: { type: 'adaptive', display: 'summarized' }, effort: 'max' });
    // between_tools / disabled 只在 effort ≤ high 时合法：off 一律配 low
    for (const m of ['claude-sonnet-5-5', 'claude-haiku-5-5']) expect(['low', 'medium', 'high']).toContain(claudeThinkingPlan(m, 'off').effort);
  });

  it('Claude adapter sends between_tools with no other thinking fields for Sonnet 5.5 off', async () => {
    const seen: Record<string, unknown>[] = [];
    const client = { beta: { messages: { create: async (prm: Record<string, unknown>) => { seen.push(prm); return { content: [], stop_reason: 'end_turn', stop_details: null, usage: { input_tokens: 1, output_tokens: 1 } }; } } } } as unknown as Anthropic;
    const ctx = {
      role: 'player' as const, point: { seq: 1, tick: 0, time: 0, wave: 0, phase: 'build', reasons: ['build' as const] }, system: systemBlocks('player'), message: 'm',
      tools: toolsForRole('player'), maxToolCalls: 2, remainingTokens: 1e9, signal: new AbortController().signal,
      callTool: async () => ({ ok: true, text: 'ok' }), afterRequest: async () => true,
    };
    await new ClaudeProvider({ client, model: 'claude-sonnet-5-5', thinking: 'off' }).decide(ctx);
    expect(seen[0].thinking).toEqual({ type: 'between_tools' });
    expect(seen[0].output_config).toEqual({ effort: 'low' });
    await new ClaudeProvider({ client, model: 'claude-opus-5-5', thinking: 'off' }).decide(ctx);
    expect(seen[1].thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    // 预算分级覆盖：ctx.thinking = off
    await new ClaudeProvider({ client, model: 'claude-haiku-5-5', thinking: 'high' }).decide({ ...ctx, thinking: 'off' });
    expect(seen[2].thinking).toEqual({ type: 'disabled' });
    expect(JSON.stringify(seen)).not.toMatch(/budget_tokens/);
  });

  it('pi: per-API mapping', () => {
    expect(piThinkingPlan('openai-completions', 'deepseek-flash', 'off', { thinkingFormat: 'deepseek' }).reasoning).toBeUndefined();
    expect(piThinkingPlan('openai-completions', 'deepseek-flash', 'low', { thinkingFormat: 'deepseek' })).toMatchObject({ reasoning: 'low' });
    expect(piThinkingPlan('openai-completions', 'qwen3', 'off', { thinkingFormat: 'qwen' }).effective).toMatch(/enable_thinking false/);
    expect(piThinkingPlan('openai-completions', 'gpt-x', 'medium', {})).toMatchObject({ reasoning: 'medium' });
    expect(piThinkingPlan('openai-completions', 'gpt-x', 'off', {}).reasoning).toBeUndefined();
    expect(piThinkingPlan('openai-responses', 'gpt-5-mini', 'off', { reasoningModel: true })).toMatchObject({ modelReasoning: false });
    expect(piThinkingPlan('openai-responses', 'gpt-5-mini', 'high', { reasoningModel: true })).toMatchObject({ modelReasoning: true, reasoning: 'high' });
    expect(piThinkingPlan('openai-responses', 'gpt-4o', 'high', { reasoningModel: false })).toMatchObject({ modelReasoning: false });
    expect(piThinkingPlan('anthropic-messages', 'claude-opus-5-5', 'high', {})).toMatchObject({ modelReasoning: false });
    expect(piThinkingPlan('anthropic-messages', 'claude-haiku-5-5', 'off', {})).toMatchObject({ modelReasoning: true });
    expect(piThinkingPlan('anthropic-messages', 'claude-sonnet-4-6', 'low', {})).toMatchObject({ modelReasoning: true, reasoning: 'low' });
    expect(piThinkingPlan('google-generative-ai', 'gemini-2.5-flash', 'off', {}).reasoning).toBeUndefined();
    expect(piThinkingPlan('openai-completions', 'x', 'max', {}).reasoning).toBe('xhigh');
  });

  it('config defaults: relay low, local off, claude medium; --effort alias', () => {
    expect(resolveConfig({ provider: 'pi', preset: 'relay', baseUrl: 'https://r.test', model: 'deepseek-flash' }).thinking).toBe('low');
    expect(resolveConfig({ provider: 'pi', preset: 'ollama' }).thinking).toBe('off');
    expect(resolveConfig({ provider: 'pi', preset: 'ollama' }).contextMode).toBe('saver');
    expect(resolveConfig({ provider: 'claude-native' }).thinking).toBe('medium');
    expect(resolveConfig({ provider: 'claude-native' }).contextMode).toBe('balanced');
    expect(resolveConfig({ provider: 'claude-native', effort: 'high' }).thinking).toBe('high');
    expect(resolveConfig({ provider: 'claude-native', thinking: 'off' }).effort).toBeUndefined();
    expect(resolveConfig({ provider: 'scripted', contextBudget: 'compact' }).contextMode).toBe('saver');
  });

  it('relay pi model: request trace shows the effective thinking setting', async () => {
    const reg = registerFauxProvider();
    unregister = reg.unregister;
    reg.setResponses([fauxAssistantMessage([fauxToolCall('act', { actions: [], end: {} })], { stopReason: 'toolUse' })]);
    const cfg = resolveConfig({ provider: 'pi', preset: 'custom', baseUrl: 'http://127.0.0.1:9/v1', model: 'faux', thinking: 'off' });
    const t = new AgentTrace();
    const sink = t.begin({ k: 'decision_start', trigger: [], wave: 0, time: 0, tick: 0, phase: 'build', provider: 'x', model: 'x', role: 'player' });
    const w = createWorld(OPTS);
    await new PiProvider({ config: cfg, model: reg.getModel() }).decide({
      role: 'player', point: { seq: 1, tick: 0, time: 0, wave: 0, phase: 'build', reasons: ['build'] }, system: systemBlocks('player'), message: 'm',
      tools: toolsForRole('player'), maxToolCalls: 2, remainingTokens: 1e9, signal: new AbortController().signal,
      callTool: async (n, i) => executeTool({ world: w, role: 'player' }, n, i), afterRequest: async () => true, trace: sink,
    });
    const req = t.events().find((e) => e.k === 'request') as Extract<ReturnType<AgentTrace['events']>[number], { k: 'request' }>;
    expect(req.thinking).toBeTruthy();
  });
});

describe('budget policy (soft / hard / ask)', () => {
  function costly(per: number): LLMProvider & { thinking: (string | undefined)[]; outs: number[] } {
    const thinking: (string | undefined)[] = [];
    const outs: number[] = [];
    return {
      id: 'scripted', model: 'costly', thinking, outs,
      async decide(ctx) {
        thinking.push(ctx.thinking);
        outs.push(ctx.maxOutputTokens ?? 0);
        await scriptedFallback(ctx.world!).decide(ctx.point.reasons);
        await ctx.callTool('act', { actions: [], end: { plan: `wave ${ctx.point.wave}` } });
        return { usage: usage({ inputTokens: per, requests: 1 }), costUsd: 0, toolCalls: 1, ended: true };
      },
    };
  }

  it('soft (default): 70% → saver, 90% → thinking low (not off), ≥100% keeps playing with the model; compaction recorded', async () => {
    const p = costly(1000);
    const t = new AgentTrace();
    const stages: number[] = [];
    const r = await runAgentGame(OPTS, { config: { provider: 'scripted', contextMode: 'full', budget: { tokens: 20_000 } }, provider: p, maxWaves: 12, trace: t, onBudget: (b) => stages.push(b.stage) });
    expect(stages).toEqual(expect.arrayContaining([1, 2, 3]));
    expect(r.disabledReason).toBeNull();
    expect(r.decisions.some((d) => d.by === 'fallback')).toBe(false);
    const afterOver = r.decisions.filter((d) => d.by === 'agent').length;
    expect(afterOver).toBeGreaterThan(8);
    // ≥90% 降到"低"，不关思考（实测无思考时打法明显变弱）
    expect(p.thinking).toContain('low');
    expect(p.thinking).not.toContain('off');
    expect(Math.min(...p.outs)).toBeLessThan(Math.max(...p.outs));
    const compacts = t.events().filter((e) => e.k === 'compact');
    expect(compacts.length).toBe(3);
    expect(compacts.every((e) => e.k === 'compact' && e.after <= 310)).toBe(true);
    expect(t.totals().compactions).toBe(3);
    expect(r.budget?.modeLabel).toBe('最省');
    expect(r.budget?.message).toMatch(/已超出预算，已切换到最省模式继续/);
  });

  it('hard: bot takes over at 100%', async () => {
    const r = await runAgentGame(OPTS, { config: { provider: 'scripted', contextMode: 'full', budget: { tokens: 5000, mode: 'hard' } }, provider: costly(1000), maxWaves: 3 });
    expect(r.disabledReason).toMatch(/budget/);
    expect(r.decisions.some((d) => d.by === 'fallback' && d.fallbackReason?.includes('budget'))).toBe(true);
    expect(r.result.cleared).toBe(3);
  });

  it('ask: the controller pauses the game and waits for continue / extend / bot', async () => {
    const { Session } = await import('../../src/game/Session');
    const { createAgentController } = await import('../../src/agent');
    const session = new Session({ ...OPTS, autoWave: true });
    const asks: number[] = [];
    const provider = costly(7000);
    const ctl = createAgentController({
      config: { provider: 'scripted', contextMode: 'full', budget: { tokens: 6000, mode: 'ask' } }, session, provider, pollMs: 0,
      onEvent: (e) => { if (e.type === 'budget_ask') asks.push(e.budget.stage); },
    });
    await ctl.start();
    for (let i = 0; i < 4000 && !ctl.budgetPending; i++) {
      ctl.poll();
      await new Promise((r) => setTimeout(r, 0));
      session.update(1000 / 60);
    }
    expect(ctl.budgetPending).toBe(true);
    expect(asks).toEqual([3]);
    expect(session.paused).toBe(true);
    expect(ctl.status).toBe('paused');
    const tick = session.world.state.tick;
    session.update(1000);
    expect(session.world.state.tick).toBe(tick);
    ctl.resolveBudget('extend');
    await new Promise((r) => setTimeout(r, 0));
    expect(ctl.budgetPending).toBe(false);
    expect(ctl.budget()?.limit).toBe(6000 + 500_000);
    expect(ctl.budget()!.stage).toBeLessThan(3);
    ctl.stop();
  });
});

// ───────────────────────── 进攻路线 ─────────────────────────

function checkRoutes(w: IWorld): { drops: number; warns: number } {
  const rs = groundRoutes(w);
  for (const r of rs) {
    expect(expandWaypoints(compressWaypoints(r.cells))).toEqual(r.cells);
    expect(expandWaypoints(r.wp)).toEqual(r.cells);
    expect(r.wp.length).toBeLessThanOrEqual(r.cells.length);
    expect(r.blocked).toBeUndefined();
  }
  // 开放的路线与世界自己的路线一致
  const open = rs.filter((r) => r.status === 'open').map((r) => r.cells);
  expect(open).toEqual(w.currentPaths());
  return { drops: rs.filter((r) => r.kind === 'drop').length, warns: rs.filter((r) => r.status === 'warn').length };
}

describe('attack routes', () => {
  it('waypoint compression is exact on all maps, random layouts and drop spawners', async () => {
    let drops = 0;
    let warns = 0;
    for (const map of ['ch1', 'ch2', 'ch3'] as MapId[]) {
      for (const seed of ['r1', 'r2']) {
        const w = createWorld({ ...OPTS, map, difficulty: 'hard', seed: `${map}-${seed}` });
        const sched = new AgentScheduler(w, { maxWaves: 11 });
        const bot = scriptedFallback(w);
        for (let p = sched.advance(); p; p = sched.advance()) {
          await bot.decide(p.reasons);
          sched.markDecided();
          const c = checkRoutes(w);
          drops += c.drops;
          warns += c.warns;
        }
      }
    }
    expect(drops).toBeGreaterThan(0);
    expect(warns).toBeGreaterThan(0);
  }, 60_000);

  it('compressWaypoints keeps only turn points', () => {
    const cells = [{ x: 5, y: 0 }, { x: 5, y: 1 }, { x: 5, y: 2 }, { x: 6, y: 3 }, { x: 7, y: 4 }, { x: 8, y: 4 }, { x: 9, y: 4 }];
    expect(compressWaypoints(cells)).toEqual([{ x: 5, y: 0 }, { x: 5, y: 2 }, { x: 7, y: 4 }, { x: 9, y: 4 }]);
  });

  it('preview does not mutate the world and reports route / coverage changes', () => {
    const w = createWorld(OPTS);
    executeTool({ world: w, role: 'player' }, 'place_tower', { tower: 'pencil', x: 4, y: 11 });
    const h0 = stateHash(w);
    const log0 = w.log.length;
    const before = groundRoutes(w)[0];
    // 一面墙挡在直路上（让路线变长），再在旁边放一座塔
    const gain = (c: { x: number; y: number }) => (w.canPlace('wall', c.x, c.y).ok ? (w.previewPath('wall', c.x, c.y)?.[0]?.length ?? 0) - before.len : -1);
    const onRoute = before.cells.slice(1, -1).sort((a, b) => gain(b) - gain(a))[0];
    expect(gain(onRoute)).toBeGreaterThan(0);
    const side = emptyCells(w).find((c) => Math.abs(c.x - onRoute.x) <= 2 && Math.abs(c.y - onRoute.y) <= 3 && !(c.x === onRoute.x && c.y === onRoute.y))!;
    const r = previewChanges(w, { place: [{ tower: 'wall', ...onRoute }, { tower: 'pencil', ...side }] });
    expect(stateHash(w)).toBe(h0);
    expect(w.log.length).toBe(log0);
    expect(r.ok, r.steps.join(' | ')).toBe(true);
    expect(r.routes[0].after).toBeGreaterThan(before.len);
    expect(r.gains.some((g) => g.startsWith(`new pencil@${side.x},${side.y}`))).toBe(true);
    expect(r.cost).toBe(5 + 20);
    // 重叠被拒，世界不变
    const dup = previewChanges(w, { place: [{ tower: 'wall', ...side }, { tower: 'wall', ...side }] });
    expect(dup.ok).toBe(false);
    expect(dup.steps[1]).toMatch(/已经有塔了/);
    const removal = previewChanges(w, { remove: [1] });
    expect(removal.losses.some((l) => l.includes('#1 removed'))).toBe(true);
    expect(stateHash(w)).toBe(h0);
    // 工具形式
    const txt = executeTool({ world: w, role: 'player' }, 'preview', { place: [{ tower: 'wall', ...onRoute }] }).text;
    expect(txt).toMatch(/^VALID/);
    expect(txt).toMatch(/route north L\d+→\d+/);
    expect(executeTool({ world: w, role: 'player' }, 'preview', {}).text).toMatch(/north L\d+: \d+,0>/);
    expect(stateHash(w)).toBe(h0);
  });

  it('coverage numbers are sane; flight lines report anti-air coverage', () => {
    const w = createWorld(OPTS);
    expect(flightLines(w)[0].aa).toBe(0);
    executeTool({ world: w, role: 'player' }, 'act', { actions: [{ do: 'place', tower: 'pencil', x: 4, y: 11 }, { do: 'place', tower: 'stapler', x: 0, y: 6 }] });
    const cov = coverage(w);
    const pencil = cov.find((c) => c.id === 'pencil')!;
    const stapler = cov.find((c) => c.id === 'stapler')!;
    expect(pencil.ground).toBeGreaterThan(0);
    expect(pencil.ground).toBeLessThanOrEqual(groundRoutes(w)[0].len);
    expect(pencil.air).toBeGreaterThan(0);
    expect(stapler.ground).toBe(0); // 离路线太远
    expect(stapler.air).toBe(0); // 不打空
    const fl = flightLines(w)[0];
    expect(fl.aa).toBeGreaterThan(0);
    expect(fl.aa).toBeLessThanOrEqual(1);
    expect(fl.by).toEqual([1]);
    const full = executeTool({ world: w, role: 'player' }, 'observe', { detail: 'full' }).text;
    expect(full).toMatch(/COVERAGE #1 pencil g\d+ a/);
    const obs = compactObservation(w);
    expect(obs.R).toEqual([expect.stringMatching(/^north:5,0>.* L\d+$/)]);
    expect(String(obs.nx)).toMatch(/north: crumb×/);
  });
});

describe('offline token model', () => {
  it('the optimized prompt builders cost far less per wave than the old ones', async () => {
    const before = await tokenRun('before', 'low', { waves: 6 });
    const balanced = await tokenRun('balanced', 'low', { waves: 6 });
    const saver = await tokenRun('saver', 'low', { waves: 6 });
    expect(before.reqPerDecision).toBe(4);
    expect(balanced.reqPerDecision).toBeLessThan(1.5);
    expect(balanced.prefixTokens).toBeLessThan(before.prefixTokens / 2);
    expect(balanced.perWaveWeighted).toBeLessThan(before.perWaveWeighted / 3);
    expect(saver.perWaveWeighted).toBeLessThanOrEqual(balanced.perWaveWeighted * 1.2);
    expect(balanced.waves).toBe(6);
  }, 30_000);

  it('scripted agent still plays ≥10 waves in every context mode', async () => {
    for (const m of ['saver', 'balanced', 'full'] as const) {
      const r = await runAgentGame(OPTS, { config: { provider: 'scripted', contextMode: m }, provider: new ScriptedProvider(), maxWaves: 10 });
      expect(r.result.cleared, m).toBe(10);
      expect(r.errors).toEqual([]);
    }
  }, 60_000);
});
