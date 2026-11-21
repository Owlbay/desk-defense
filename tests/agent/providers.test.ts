import { afterEach, describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from '@mariozechner/pi-ai';
import { createWorld, type RunOptions } from '../../src/core';
import {
  executeTool, resolveConfig, runAgentGame, systemBlocks, toolsForRole, testConnection,
  type DecisionContext, type LLMProvider, type ToolResult,
} from '../../src/agent';
import { ClaudeProvider } from '../../src/agent/providers/claude';
import { PiProvider, toTypeBox } from '../../src/agent/providers/pi';
import { extractJsonObject, parseActions } from '../../src/agent/providers/json-mode';
import { BridgeProvider, createBridgeSession, originAllowed, type BridgeServerMsg, type WsLike } from '../../src/agent/bridge';
import { McpGameServer } from '../../src/agent/mcp';

const OPTS: RunOptions = { mode: 'endless', map: 'ch1', difficulty: 'normal', seed: 'prov', skills: ['eraser_strike', 'bell', 'whiteout_zone'], pure: true };

function ctxFor(world = createWorld(OPTS), extra: Partial<DecisionContext> = {}): DecisionContext & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    role: 'player',
    point: { seq: 1, tick: 0, time: 0, wave: 0, phase: 'build', reasons: ['game_start'] },
    system: systemBlocks('player'),
    message: 'state…',
    tools: toolsForRole('player'),
    maxToolCalls: 8,
    remainingTokens: 1e9,
    signal: new AbortController().signal,
    callTool: async (name, input): Promise<ToolResult> => {
      calls.push(name);
      return executeTool({ world, role: 'player' }, name, input);
    },
    afterRequest: async () => true,
    ...extra,
  };
}

describe('claude-native adapter (mocked SDK client, no network)', () => {
  it('sends adaptive thinking + effort + strict tools + caching + refusal fallback, and loops tools', async () => {
    const seen: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
    const replies = [
      {
        content: [
          { type: 'thinking', thinking: '', signature: 'sig' },
          { type: 'tool_use', id: 'tu1', name: 'place_tower', input: { tower: 'pencil', x: 0, y: 6 } },
          { type: 'tool_use', id: 'tu2', name: 'start_wave', input: {} },
        ],
        stop_reason: 'tool_use',
      },
      { content: [{ type: 'tool_use', id: 'tu3', name: 'end_turn', input: { note: 'plan A' } }], stop_reason: 'tool_use' },
    ];
    const client = {
      beta: {
        messages: {
          create: async (p: Anthropic.Beta.MessageCreateParamsNonStreaming) => {
            seen.push(structuredClone(p));
            const r = replies.shift()!;
            return { ...r, stop_details: null, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0 } };
          },
        },
      },
    } as unknown as Anthropic;
    const p = new ClaudeProvider({ client, model: 'claude-opus-5-5', effort: 'low' });
    const w = createWorld(OPTS);
    const ctx = ctxFor(w);
    const out = await p.decide(ctx);
    expect(out.error).toBeUndefined();
    expect(out.ended).toBe(true);
    expect(out.note).toBe('plan A');
    expect(ctx.calls).toEqual(['place_tower', 'start_wave', 'end_turn']);
    expect(w.state.phase).toBe('wave');
    expect(out.usage).toMatchObject({ inputTokens: 200, outputTokens: 40, cacheReadTokens: 8000, requests: 2 });
    expect(out.costUsd).toBeGreaterThan(0);
    const p0 = seen[0];
    expect(p0.model).toBe('claude-opus-5-5');
    expect(p0.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(p0.output_config).toEqual({ effort: 'low' });
    expect(p0.tool_choice).toEqual({ type: 'auto' });
    expect(p0.fallbacks).toBe('default');
    expect(p0.betas).toContain('server-side-fallback-2026-07-01');
    expect((p0.tools as { strict?: boolean }[]).every((t) => t.strict === true)).toBe(true);
    expect((p0.system as { cache_control?: unknown }[])[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(JSON.stringify(p0)).not.toMatch(/budget_tokens|temperature/);
    // 第二次请求：助手内容原样放回（含 thinking 块），工具结果在同一条 user 消息里
    const m = seen[1].messages;
    expect(m[1].role).toBe('assistant');
    expect((m[1].content as { type: string }[])[0].type).toBe('thinking');
    expect((m[2].content as { type: string }[]).map((b) => b.type)).toEqual(['tool_result', 'tool_result']);
  });

  it('haiku has no server-side fallback; refusal becomes an error (→ bot fallback)', async () => {
    const seen: Record<string, unknown>[] = [];
    const client = {
      beta: { messages: { create: async (p: Record<string, unknown>) => { seen.push(p); return { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' }, usage: { input_tokens: 5, output_tokens: 0 } }; } } },
    } as unknown as Anthropic;
    const out = await new ClaudeProvider({ client, model: 'claude-haiku-5-5' }).decide(ctxFor());
    expect(seen[0].fallbacks).toBeUndefined();
    expect(out.error).toMatch(/refusal \(cyber\)/);
  });
});

describe('pi adapter (faux provider, no network)', () => {
  let unregister: (() => void) | null = null;
  afterEach(() => { unregister?.(); unregister = null; });

  it('maps tools to TypeBox and runs the native tool loop', async () => {
    const reg = registerFauxProvider();
    unregister = reg.unregister;
    reg.setResponses([
      fauxAssistantMessage([fauxToolCall('place_tower', { tower: 'pencil', x: 0, y: 6 })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxText('done'), fauxToolCall('end_turn', { note: 'n1' })], { stopReason: 'toolUse' }),
    ]);
    const cfg = resolveConfig({ provider: 'pi', preset: 'custom', baseUrl: 'http://127.0.0.1:9/v1', model: 'faux' });
    const p = new PiProvider({ config: cfg, model: reg.getModel() });
    const w = createWorld(OPTS);
    const ctx = ctxFor(w);
    const out = await p.decide(ctx);
    expect(out.error).toBeUndefined();
    expect(ctx.calls).toEqual(['place_tower', 'end_turn']);
    expect(out.ended).toBe(true);
    expect(w.state.towers.size).toBe(1);
    expect(out.usage.requests).toBe(2);
    const tb = toTypeBox(toolsForRole('player').find((t) => t.name === 'act')!.input_schema) as unknown as { properties: Record<string, { items?: { properties: Record<string, { enum?: string[] }>; required: string[] } }>; required: string[] };
    expect(tb.required).toEqual(['actions']);
    expect(tb.properties.actions.items!.required).toEqual(['do']);
    expect(tb.properties.actions.items!.properties.tower.enum).toContain('pencil');
    expect(tb.properties.actions.items!.properties.do.enum).toContain('start_wave');
  });

  it('JSON action mode parses, validates and executes', async () => {
    const reg = registerFauxProvider();
    unregister = reg.unregister;
    reg.setResponses([
      fauxAssistantMessage([fauxText('```json\n{"actions":[{"tool":"preview_placement","args":{"tower":"wall","x":5,"y":5}}]}\n```')]),
      fauxAssistantMessage([fauxText('{"actions":[{"tool":"place_tower","args":{"tower":"pencil","x":0,"y":6}},{"tool":"bogus","args":{}},{"tool":"end_turn","args":{}}],"note":"ok"}')]),
    ]);
    const cfg = resolveConfig({ provider: 'pi', preset: 'ollama', toolMode: 'json' });
    const p = new PiProvider({ config: cfg, model: reg.getModel() });
    const w = createWorld(OPTS);
    const ctx = ctxFor(w);
    const out = await p.decide(ctx);
    expect(ctx.calls).toEqual(['preview_placement', 'place_tower', 'end_turn']);
    expect(out.ended).toBe(true);
    expect(out.note).toBe('ok');
    expect(w.state.towers.size).toBe(1);
  });

  it('json helpers are robust', () => {
    expect(extractJsonObject('blah {"a":{"b":"}"}} tail')).toEqual({ a: { b: '}' } });
    expect(extractJsonObject('no json')).toBeUndefined();
    const r = parseActions('{"actions":[{"tool":"place_tower","args":{"tower":"pencil","x":"1","y":2}}]}', toolsForRole('player'));
    expect(r.actions).toEqual([]);
    expect(r.errors[0]).toMatch(/integer/);
  });

  it('testConnection reports tool-calling capability', async () => {
    const reg = registerFauxProvider();
    unregister = reg.unregister;
    reg.setResponses([fauxAssistantMessage([fauxToolCall('end_turn', { note: 'pong' })], { stopReason: 'toolUse' })]);
    const cfg = { provider: 'pi' as const, preset: 'custom' as const, baseUrl: 'http://127.0.0.1:9/v1', model: 'faux' };
    const d = await testConnection(cfg, new PiProvider({ config: resolveConfig(cfg), model: reg.getModel() }));
    expect(d.ok).toBe(true);
    expect(d.toolCalling).toBe(true);
    reg.setResponses([fauxAssistantMessage([fauxText('hello')])]);
    const d2 = await testConnection(cfg, new PiProvider({ config: resolveConfig(cfg), model: reg.getModel() }));
    expect(d2.reachable).toBe(true);
    expect(d2.toolCalling).toBe(false);
    expect(d2.advice).toMatch(/json/);
  });
});

describe('bridge protocol (in-memory sockets)', () => {
  it('pairs with a one-time code and relays tool calls back to the game', async () => {
    // 桥接器侧用一个会下两个指令的假模型
    const remote: LLMProvider = {
      id: 'remote', model: 'm1',
      async decide(ctx) {
        await ctx.callTool('place_tower', { tower: 'pencil', x: 0, y: 6 });
        const alive = await ctx.afterRequest(5);
        const r = await ctx.callTool('end_turn', { note: alive ? 'alive' : 'dead' });
        return { usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1 }, costUsd: 0, toolCalls: 2, ended: !!r.endTurn, note: r.note };
      },
    };
    let client!: WsLike;
    const session = createBridgeSession({ provider: remote, code: '123456', send: (m: BridgeServerMsg) => queueMicrotask(() => client.onmessage?.({ data: JSON.stringify(m) })) });
    client = { readyState: 1, onopen: null, onmessage: null, onclose: null, onerror: null, close: () => {}, send: (d: string) => queueMicrotask(() => session.handle(d)) };
    // 错误配对码
    const errs: string[] = [];
    client.onmessage = (ev) => errs.push(String(ev.data));
    client.send(JSON.stringify({ t: 'hello', code: '000000', client: 't', v: 1 }));
    await new Promise((r) => setTimeout(r, 5));
    expect(errs[0]).toMatch(/配对码不对/);
    // 正确配对
    const welcome = await new Promise<BridgeServerMsg>((res) => {
      client.onmessage = (ev) => res(JSON.parse(String(ev.data)));
      client.send(JSON.stringify({ t: 'hello', code: '123456', client: 't', v: 1 }));
    });
    expect(welcome.t).toBe('welcome');
    const bp = new BridgeProvider(client, welcome as Extract<BridgeServerMsg, { t: 'welcome' }>);
    const w = createWorld(OPTS);
    const ctx = ctxFor(w);
    const out = await bp.decide(ctx);
    expect(ctx.calls).toEqual(['place_tower', 'end_turn']);
    expect(out.note).toBe('alive');
    expect(w.state.towers.size).toBe(1);
    expect(bp.id).toBe('bridge:remote');
    expect(session.paired).toBe(true);
  });

  it('origin allowlist', () => {
    expect(originAllowed('https://jjjj.games')).toBe(true);
    expect(originAllowed('http://localhost:5173')).toBe(true);
    expect(originAllowed('https://evil.example')).toBe(false);
    expect(originAllowed('https://my.site', ['https://my.site'])).toBe(true);
    expect(originAllowed(undefined)).toBe(true);
  });
});

describe('MCP handlers', () => {
  it('new_game → actions → advance → replay', () => {
    const srv = new McpGameServer();
    const names = srv.listTools().map((t) => t.name);
    for (const n of ['new_game', 'observe', 'advance', 'get_replay', 'place_tower', 'cast_skill', 'choose_perk', 'start_wave']) expect(names).toContain(n);
    expect(names).not.toContain('end_turn');
    for (const t of srv.listTools()) if (!['new_game', 'list_sessions'].includes(t.name)) expect(t.inputSchema.required).toContain('session_id');

    const ng = srv.callTool('new_game', { seed: 'mcp1', auto_wave: true, include_rules: true, agent_name: 'claude-test' });
    expect(ng.isError).toBeUndefined();
    const txt = ng.content[0].text;
    expect(txt).toMatch(/Rules/);
    const sid = /session_id: (\w+)/.exec(txt)![1];
    expect(srv.callTool('observe', { session_id: sid }).content[0].text).toMatch(/"phase":"build"/);
    expect(srv.callTool('place_tower', { session_id: sid, tower: 'pencil', x: 0, y: 6 }).content[0].text).toMatch(/^OK placed/);
    expect(srv.callTool('place_tower', { session_id: sid, tower: 'pencil', x: 0, y: 6 }).isError).toBe(true);
    expect(srv.callTool('place_tower', { session_id: sid, tower: 'pencil' }).isError).toBe(true);
    // 手动开第一波之前 advance 会被挡住
    expect(srv.callTool('advance', { session_id: sid }).content[0].text).toMatch(/start_wave/);
    expect(srv.callTool('start_wave', { session_id: sid }).isError).toBeUndefined();
    const adv = srv.callTool('advance', { session_id: sid });
    expect(adv.content[0].text).toMatch(/decision point #\d+/);
    expect(srv.callTool('advance', { session_id: sid, seconds: 5 }).isError).toBeUndefined();
    const rep = JSON.parse(srv.callTool('get_replay', { session_id: sid }).content[0].text);
    expect(rep.board).toBe('ai:normal:pure:auto');
    expect(rep.replay.agent).toEqual({ provider: 'mcp', model: 'claude-test', role: 'player' });
    expect(rep.replay.log.length).toBe(2);
    expect(srv.callTool('observe', { session_id: 'nope' }).isError).toBe(true);
    expect(JSON.parse(srv.callTool('list_sessions', {}).content[0].text)).toHaveLength(1);
    expect(srv.callTool('end_session', { session_id: sid }).content[0].text).toMatch(/closed/);
  });
});

describe('runner with the pi adapter end to end (faux)', () => {
  it('records agent decisions and falls back when responses run out', async () => {
    const reg = registerFauxProvider();
    try {
      reg.setResponses([
        fauxAssistantMessage([fauxToolCall('place_tower', { tower: 'pencil', x: 5, y: 3 }), fauxToolCall('end_turn', {})], { stopReason: 'toolUse' }),
      ]);
      const cfg = resolveConfig({ provider: 'pi', preset: 'custom', baseUrl: 'http://127.0.0.1:9/v1', model: 'faux' });
      const r = await runAgentGame(OPTS, { config: cfg, provider: new PiProvider({ config: cfg, model: reg.getModel() }), maxWaves: 2 });
      expect(r.decisions[0].by).toBe('agent');
      expect(r.decisions[0].toolCalls.map((c) => c.name)).toEqual(['place_tower', 'end_turn']);
      expect(r.decisions.slice(1).some((d) => d.by === 'fallback')).toBe(true);
      expect(r.result.cleared).toBe(2);
    } finally {
      reg.unregister();
    }
  });
});

describe('browser controller (real Session, no DOM)', () => {
  it('pauses the session while deciding and drives the game with session.command', async () => {
    const { Session } = await import('../../src/game/Session');
    const { createAgentController, ScriptedProvider } = await import('../../src/agent');
    const session = new Session({ ...OPTS, autoWave: true });
    const events: string[] = [];
    let pausedDuringDecision = false;
    const provider = new ScriptedProvider();
    const orig = provider.decide.bind(provider);
    provider.decide = async (ctx) => {
      pausedDuringDecision = session.paused;
      return orig(ctx);
    };
    const ctl = createAgentController({ config: { provider: 'scripted' }, session, provider, pollMs: 0, onEvent: (e) => events.push(e.type === 'status' ? `status:${e.status}` : e.type) });
    await ctl.start();
    expect(ctl.status).toBe('running');
    for (let i = 0; i < 1500; i++) {
      ctl.poll();
      await Promise.resolve();
      await Promise.resolve();
      session.update(1000 / 60);
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(pausedDuringDecision).toBe(true);
    expect(session.paused).toBe(false);
    expect(ctl.decisions.length).toBeGreaterThan(1);
    expect(session.world.state.wave).toBeGreaterThanOrEqual(1);
    expect(session.world.log.length).toBeGreaterThan(0);
    expect(events).toContain('decision');
    const rep = ctl.report();
    expect(rep.board.startsWith('ai:')).toBe(true);
    expect(rep.agent.provider).toBe('scripted');
    ctl.stop();
    expect(ctl.status).toBe('stopped');
  });
});
