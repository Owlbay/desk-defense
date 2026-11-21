import { afterEach, describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, registerFauxProvider } from '@mariozechner/pi-ai';
import { createWorld, type RunOptions } from '../../src/core';
import {
  AgentTrace, DecisionEngine, executeTool, resolveConfig, runAgentGame, scriptedFallback, systemBlocks, toolsForRole,
  type DecisionContext, type LLMProvider, type ToolResult, type TraceEvent,
} from '../../src/agent';
import { redactError, redactJson, redactString, redactValue, REDACTED } from '../../src/agent/redact';
import { ClaudeProvider } from '../../src/agent/providers/claude';
import { PiProvider } from '../../src/agent/providers/pi';
import { ScriptedProvider } from '../../src/agent/providers/scripted';
import { BridgeProvider, createBridgeSession, type BridgeServerMsg, type WsLike } from '../../src/agent/bridge';

const OPTS: RunOptions = { mode: 'endless', map: 'ch1', difficulty: 'normal', seed: 'trace', skills: ['eraser_strike', 'bell', 'whiteout_zone'], pure: true };

const KEYS = {
  anthropic: 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdefXYZ',
  openai: 'sk-proj-ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210',
  google: 'AIzaSyA1234567890abcdefghijklmnopqrstu',
  custom: 'my-relay-secret-value-42',
};

function ctxFor(world = createWorld(OPTS), trace?: DecisionContext['trace']): DecisionContext & { calls: string[] } {
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
    trace,
  };
}

/** 一个"收集器"：模拟引擎给适配器的 ctx.trace */
function collector() {
  const t = new AgentTrace();
  const sink = t.begin({ k: 'decision_start', trigger: ['game_start'], wave: 0, time: 0, tick: 0, phase: 'build', provider: 'x', model: 'x', role: 'player' });
  return { t, sink, kinds: () => t.events().map((e) => e.k) };
}

const noKey = (s: string): void => {
  for (const k of Object.values(KEYS)) expect(s).not.toContain(k);
};

describe('redaction', () => {
  it('redacts secret-looking header and body fields', () => {
    const v = redactValue({
      headers: { Authorization: `Bearer ${KEYS.openai}`, 'x-api-key': KEYS.anthropic, 'X-Goog-Api-Key': KEYS.google, 'content-type': 'application/json' },
      body: { apiKey: KEYS.custom, api_key: 'abc', nested: [{ access_token: 'tok' }], model: 'claude-opus-5-5', max_tokens: 100, input_tokens: 5 },
    }) as { headers: Record<string, string>; body: Record<string, unknown> };
    expect(v.headers.Authorization).toBe(REDACTED);
    expect(v.headers['x-api-key']).toBe(REDACTED);
    expect(v.headers['X-Goog-Api-Key']).toBe(REDACTED);
    expect(v.headers['content-type']).toBe('application/json');
    expect(v.body.apiKey).toBe(REDACTED);
    expect(v.body.api_key).toBe(REDACTED);
    expect((v.body.nested as { access_token: string }[])[0].access_token).toBe(REDACTED);
    expect(v.body.model).toBe('claude-opus-5-5');
    expect(v.body.max_tokens).toBe(100);
    expect(v.body.input_tokens).toBe(5);
  });

  it('redacts keys inside free text and error strings in several formats', () => {
    const cases = [
      `401 Unauthorized: invalid x-api-key: ${KEYS.anthropic}`,
      `Incorrect API key provided: ${KEYS.openai}. You can find your API key at …`,
      `GET https://generativelanguage.googleapis.com/v1beta/models?key=${KEYS.google}&alt=sse failed`,
      `{"error":{"message":"bad key","apiKey":"${KEYS.custom}"}}`,
      `Authorization: Bearer ${KEYS.custom}`,
      `apiKey=${KEYS.custom}`,
      `token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U`,
    ];
    for (const c of cases) {
      const r = redactString(c);
      noKey(r);
      expect(r).toContain(REDACTED);
      expect(r).not.toMatch(/eyJzdWIi/);
    }
    // 已知密钥（不符合任何通用格式）也会被替换
    expect(redactString('relay said: hunter2-but-long-enough!!', ['hunter2-but-long-enough!!'])).toBe(`relay said: ${REDACTED}`);
    expect(redactError(new Error(`connection failed for ${KEYS.anthropic}`))).not.toContain(KEYS.anthropic);
    // 普通内容不受影响
    expect(redactString('place_tower tower=pencil x=3 y=5; max_tokens=1024; task-list ok')).toBe('place_tower tower=pencil x=3 y=5; max_tokens=1024; task-list ok');
  });

  it('caps huge JSON', () => {
    const r = redactJson({ big: 'x'.repeat(200_000) }, [], 1000);
    expect(r.chars).toBeGreaterThan(200_000);
    expect(r.json.length).toBeLessThan(1200);
    expect(r.json).toMatch(/已截断/);
  });

  it('trace store redacts registered secrets everywhere', () => {
    const t = new AgentTrace();
    t.addSecret(KEYS.custom);
    const sink = t.begin({ k: 'decision_start', trigger: [], wave: 0, time: 0, tick: 0, phase: 'build', provider: 'p', model: 'm', role: 'player', observation: `obs ${KEYS.custom}` });
    sink({ k: 'request', n: 1, provider: 'p', api: 'a', model: 'm', headers: { authorization: `Bearer ${KEYS.custom}` }, raw: { apiKey: KEYS.custom, note: `k=${KEYS.custom}` } });
    sink({ k: 'thinking', n: 1, text: `I should not say ${KEYS.custom}` });
    sink({ k: 'error', message: `HTTP 401 for key ${KEYS.custom}` });
    const all = JSON.stringify(t.export());
    noKey(all);
  });
});

describe('ring buffer', () => {
  it('caps by event count and by size, coalesces streaming deltas', () => {
    const t = new AgentTrace({ maxEvents: 100, maxChars: 1e9 });
    const seen: string[] = [];
    t.subscribe((e) => e.k === 'thinking' && seen.push(e.text));
    for (let i = 0; i < 50; i++) {
      const s = t.begin({ k: 'decision_start', trigger: [], wave: i, time: 0, tick: 0, phase: 'build', provider: 'p', model: 'm', role: 'player' });
      s({ k: 'thinking', n: 1, text: 'a' });
      s({ k: 'thinking', n: 1, text: 'b' });
      s({ k: 'decision_end', by: 'agent', ms: 1, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 }, costUsd: 0, toolCalls: 0 });
    }
    // 每次决策 3 条（两段思路合并为一条）
    expect(t.events().length).toBeLessThanOrEqual(100);
    expect(t.dropped).toBeGreaterThan(0);
    const th = t.events().find((e) => e.k === 'thinking') as Extract<TraceEvent, { k: 'thinking' }>;
    expect(th.text).toBe('ab');
    expect(seen.slice(0, 2)).toEqual(['a', 'b']); // 订阅者拿到的是增量
    // 最新的决策还在
    expect(t.events()[t.events().length - 1].d).toBe(50);

    const t2 = new AgentTrace({ maxEvents: 1e6, maxChars: 50_000 });
    for (let i = 0; i < 40; i++) {
      const s = t2.begin({ k: 'decision_start', trigger: [], wave: i, time: 0, tick: 0, phase: 'build', provider: 'p', model: 'm', role: 'player' });
      s({ k: 'response', n: 1, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1 }, ms: 5, raw: { body: 'y'.repeat(5000) } });
    }
    expect(t2.size.chars).toBeLessThanOrEqual(50_000);
    expect(t2.dropped).toBeGreaterThan(0);
  });

  it('dedupes big blobs and exports within a size cap', () => {
    const t = new AgentTrace();
    const sys = 'RULES '.repeat(2000);
    for (let i = 0; i < 20; i++) {
      const s = t.begin({ k: 'decision_start', trigger: [], wave: i, time: 0, tick: 0, phase: 'build', provider: 'p', model: 'm', role: 'player', system: sys, observation: `obs ${i}` });
      s({ k: 'request', n: 1, provider: 'p', api: 'a', model: 'm', raw: { pad: 'z'.repeat(3000) } });
    }
    const x = t.export();
    expect(Object.values(x.blobs).filter((b) => b === sys)).toHaveLength(1);
    const capped = t.export({ maxChars: 20_000 });
    expect(JSON.stringify(capped).length).toBeLessThan(40_000);
    const back = AgentTrace.fromExport(capped);
    expect(back.events().length).toBe(capped.events.length);
  });
});

describe('scripted provider trace (no keys, offline demo)', () => {
  it('emits a full synthetic decision sequence through the engine', async () => {
    const w = createWorld({ ...OPTS, autoWave: false });
    const trace = new AgentTrace();
    const engine = new DecisionEngine({ world: w, opts: w.state.opts, config: resolveConfig({ provider: 'scripted' }), provider: new ScriptedProvider(), fallback: scriptedFallback(w), trace });
    await engine.decide({ seq: 1, tick: 0, time: 0, wave: 0, phase: 'build', reasons: ['game_start'] }, []);
    const ev = trace.events();
    const kinds = ev.map((e) => e.k);
    expect(kinds[0]).toBe('decision_start');
    expect(kinds[1]).toBe('request');
    expect(kinds).toContain('thinking');
    expect(kinds).toContain('tool_call');
    expect(kinds).toContain('tool_result');
    expect(kinds).toContain('response');
    expect(kinds[kinds.length - 1]).toBe('decision_end');
    // 顺序：request 在第一个工具调用之前；每个 tool_call 后紧跟它的 tool_result
    expect(kinds.indexOf('request')).toBeLessThan(kinds.indexOf('tool_call'));
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i];
      if (e.k === 'tool_call') {
        const r = ev.slice(i + 1).find((x) => x.k === 'tool_result') as Extract<TraceEvent, { k: 'tool_result' }>;
        expect(r.id).toBe(e.id);
      }
    }
    const start = ev[0] as Extract<TraceEvent, { k: 'decision_start' }>;
    expect(trace.blob(start.observationHash)).toMatch(/#/); // 观测里有 ASCII 地图
    expect(trace.blob(start.systemHash)!.length).toBeGreaterThan(1000);
    expect(JSON.parse(trace.blob(start.toolsHash)!)[0].input_schema).toBeTruthy();
    const place = ev.find((e) => e.k === 'tool_result' && e.name === 'place_tower' && e.ok) as Extract<TraceEvent, { k: 'tool_result' }>;
    expect(place.effect).toMatch(/金币 .*→/);
    expect(place.cell).toBeTruthy();
    const thinking = ev.filter((e) => e.k === 'thinking').map((e) => (e as { text: string }).text).join('');
    expect(thinking).toMatch(/建塔|迷宫|兵力/);
    const end = ev[ev.length - 1] as Extract<TraceEvent, { k: 'decision_end' }>;
    expect(end.by).toBe('agent');
    expect(end.toolCalls).toBeGreaterThan(1);
    expect(trace.totals().decisions).toBe(1);
  });

  it('records error + fallback when the provider fails', async () => {
    const w = createWorld(OPTS);
    const trace = new AgentTrace();
    const bad: LLMProvider = { id: 'bad', model: 'm', decide: async () => { throw new Error(`boom ${KEYS.openai}`); } };
    const engine = new DecisionEngine({ world: w, opts: w.state.opts, config: resolveConfig({ provider: 'scripted' }), provider: bad, fallback: scriptedFallback(w), trace });
    await engine.decide({ seq: 1, tick: 0, time: 0, wave: 0, phase: 'build', reasons: ['game_start'] }, []);
    const kinds = trace.events().map((e) => e.k);
    expect(kinds).toEqual(expect.arrayContaining(['decision_start', 'error', 'fallback', 'decision_end']));
    const end = trace.events()[trace.events().length - 1] as Extract<TraceEvent, { k: 'decision_end' }>;
    expect(end.by).toBe('fallback');
    noKey(JSON.stringify(trace.export()));
  });

  it('runner records a trace across a whole game', async () => {
    const trace = new AgentTrace();
    const r = await runAgentGame(OPTS, { config: { provider: 'scripted' }, provider: new ScriptedProvider(), maxWaves: 2, trace });
    expect(trace.totals().decisions).toBe(r.decisions.length);
  });
});

describe('pi adapter trace (faux provider)', () => {
  let unregister: (() => void) | null = null;
  afterEach(() => { unregister?.(); unregister = null; });

  it('streams thinking + text, reports request/response and tool call ids', async () => {
    const reg = registerFauxProvider();
    unregister = reg.unregister;
    reg.setResponses([
      fauxAssistantMessage([fauxThinking('The left lane is open; a pencil at (0,6) covers it.'), fauxText('Placing a pencil.'), fauxToolCall('place_tower', { tower: 'pencil', x: 0, y: 6 })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxThinking('Done for now.'), fauxToolCall('end_turn', { note: 'n1' })], { stopReason: 'toolUse' }),
    ]);
    const cfg = resolveConfig({ provider: 'pi', preset: 'custom', baseUrl: 'http://127.0.0.1:9/v1', model: 'faux', apiKey: KEYS.custom });
    const p = new PiProvider({ config: cfg, model: reg.getModel() });
    const c = collector();
    c.t.addSecret(KEYS.custom);
    const ids: (string | undefined)[] = [];
    const w = createWorld(OPTS);
    const ctx = ctxFor(w, c.sink);
    const orig = ctx.callTool;
    ctx.callTool = async (n, i, meta) => { ids.push(meta?.id); return orig(n, i, meta); };
    const out = await p.decide(ctx);
    expect(out.error).toBeUndefined();
    const ev = c.t.events();
    const reqs = ev.filter((e) => e.k === 'request') as Extract<TraceEvent, { k: 'request' }>[];
    expect(reqs.map((r) => r.n)).toEqual([1, 2]);
    expect(reqs[0].provider).toBe(p.id);
    expect(reqs[0].toolNames).toContain('act');
    expect(reqs[0].thinking).toBeTruthy();
    expect(c.t.blob(reqs[0].systemHash)).toBeTruthy();
    const th = ev.filter((e) => e.k === 'thinking').map((e) => (e as { text: string }).text);
    expect(th.join('|')).toMatch(/left lane is open.*\|Done for now/);
    expect(ev.some((e) => e.k === 'text' && e.text.includes('Placing a pencil'))).toBe(true);
    const resps = ev.filter((e) => e.k === 'response') as Extract<TraceEvent, { k: 'response' }>[];
    expect(resps).toHaveLength(2);
    expect(resps[0].stop).toBe('toolUse');
    expect(resps[0].raw).toBeTruthy();
    expect(ids.every((x) => typeof x === 'string' && x.length > 0)).toBe(true);
    noKey(JSON.stringify(c.t.export()));
  });

  it('json mode is traced as json-mode requests', async () => {
    const reg = registerFauxProvider();
    unregister = reg.unregister;
    reg.setResponses([fauxAssistantMessage([fauxText('{"actions":[{"tool":"end_turn","args":{}}]}')])]);
    const cfg = resolveConfig({ provider: 'pi', preset: 'ollama', toolMode: 'json' });
    const c = collector();
    await new PiProvider({ config: cfg, model: reg.getModel() }).decide(ctxFor(createWorld(OPTS), c.sink));
    const req = c.t.events().find((e) => e.k === 'request') as Extract<TraceEvent, { k: 'request' }>;
    expect(req.api).toMatch(/^json-mode/);
    expect(c.t.blob(req.systemHash)).toMatch(/JSON action mode/);
    expect(c.kinds()).toContain('text');
  });
});

describe('claude adapter trace (injected fake client)', () => {
  const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 4000, cache_creation_input_tokens: 10 };
  const turn1 = {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
    content: [
      { type: 'thinking', thinking: 'Summary: build a pencil near the exit.', signature: 'sig' },
      { type: 'text', text: 'Placing one pencil.' },
      { type: 'tool_use', id: 'toolu_01', name: 'place_tower', input: { tower: 'pencil', x: 0, y: 6 } },
    ],
    stop_reason: 'tool_use', stop_details: null, usage,
  };
  const turn2 = { ...turn1, id: 'msg_2', content: [{ type: 'tool_use', id: 'toolu_02', name: 'end_turn', input: { note: 'ok' } }], stop_reason: 'tool_use' };

  it('non-streaming client: summarized thinking, tool_use ids, usage per response', async () => {
    const replies = [turn1, turn2];
    const seen: Record<string, unknown>[] = [];
    const client = { baseURL: 'https://api.anthropic.com', beta: { messages: { create: async (p: Record<string, unknown>) => { seen.push(p); return replies.shift(); } } } } as unknown as Anthropic;
    const c = collector();
    const ids: (string | undefined)[] = [];
    const ctx = ctxFor(createWorld(OPTS), c.sink);
    const orig = ctx.callTool;
    ctx.callTool = async (n, i, meta) => { ids.push(meta?.id); return orig(n, i, meta); };
    const out = await new ClaudeProvider({ client, model: 'claude-opus-5-5', effort: 'low', apiKey: KEYS.anthropic }).decide(ctx);
    expect(out.error).toBeUndefined();
    expect(seen[0].thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(ids).toEqual(['toolu_01', 'toolu_02']);
    const ev = c.t.events();
    const req = ev.find((e) => e.k === 'request') as Extract<TraceEvent, { k: 'request' }>;
    expect(req.api).toBe('anthropic-messages');
    expect(req.host).toBe('api.anthropic.com');
    expect(req.effort).toBe('low');
    expect(req.headers!['x-api-key']).toBe(REDACTED);
    expect(req.raw).toMatch(/\$blob:/);
    expect(c.t.inflate(req.raw!)).toMatch(/You are|Rules|规则/);
    expect(ev.some((e) => e.k === 'thinking' && e.text.includes('build a pencil'))).toBe(true);
    expect(ev.some((e) => e.k === 'text' && e.text.includes('Placing one pencil'))).toBe(true);
    const resp = ev.filter((e) => e.k === 'response') as Extract<TraceEvent, { k: 'response' }>[];
    expect(resp).toHaveLength(2);
    expect(resp[0].usage).toMatchObject({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 4000, cacheWriteTokens: 10 });
    expect(resp[0].costUsd).toBeGreaterThan(0);
    expect(resp[0].stop).toBe('tool_use');
    noKey(JSON.stringify(c.t.export()));
  });

  it('streaming client: thinking_delta / text_delta arrive live before the response', async () => {
    const replies = [turn1, turn2];
    const deltas = [
      [
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Summary: build ' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'a pencil near the exit.' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Placing one pencil.' } },
      ],
      [],
    ];
    let params: Record<string, unknown> | null = null;
    const client = {
      beta: {
        messages: {
          create: async () => { throw new Error('should stream'); },
          stream: (p: Record<string, unknown>) => {
            params = p;
            const evs = deltas.shift()!;
            const msg = replies.shift();
            return {
              async *[Symbol.asyncIterator]() { for (const e of evs) yield e; },
              finalMessage: async () => msg,
            };
          },
        },
      },
    } as unknown as Anthropic;
    const c = collector();
    const live: string[] = [];
    c.t.subscribe((e) => (e.k === 'thinking' || e.k === 'text' || e.k === 'response') && live.push(e.k === 'response' ? 'R' : e.text));
    const out = await new ClaudeProvider({ client, model: 'claude-sonnet-5-5' }).decide(ctxFor(createWorld(OPTS), c.sink));
    expect(out.error).toBeUndefined();
    expect((params as unknown as { thinking: unknown }).thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(live.slice(0, 4)).toEqual(['Summary: build ', 'a pencil near the exit.', 'Placing one pencil.', 'R']);
    // 流式时不会再从最终消息里重复补一遍
    const stored = c.t.events().filter((e) => e.k === 'thinking') as Extract<TraceEvent, { k: 'thinking' }>[];
    expect(stored.map((s) => s.text).join('')).toBe('Summary: build a pencil near the exit.');
  });
});

describe('bridge trace forwarding', () => {
  it('forwards remote request/thinking/response over the socket, redacted, with tool ids', async () => {
    const remote: LLMProvider = {
      id: 'claude-native', model: 'm1',
      async decide(ctx) {
        ctx.trace?.({ k: 'request', n: 1, provider: 'claude-native', api: 'anthropic-messages', model: 'm1', headers: { 'x-api-key': KEYS.anthropic }, raw: { key: KEYS.anthropic } });
        ctx.trace?.({ k: 'thinking', n: 1, text: `thinking… ${KEYS.anthropic}` });
        ctx.trace?.({ k: 'response', n: 1, usage: { inputTokens: 3, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1 }, ms: 7, stop: 'tool_use' });
        const r = await ctx.callTool('end_turn', { note: 'via bridge' }, { id: 'toolu_bridge' });
        return { usage: { inputTokens: 3, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1 }, costUsd: 0, toolCalls: 1, ended: !!r.endTurn, note: r.note };
      },
    };
    let client!: WsLike;
    const wire: string[] = [];
    const session = createBridgeSession({
      provider: remote, code: '654321', secrets: [KEYS.anthropic],
      send: (m: BridgeServerMsg) => { wire.push(JSON.stringify(m)); queueMicrotask(() => client.onmessage?.({ data: JSON.stringify(m) })); },
    });
    client = { readyState: 1, onopen: null, onmessage: null, onclose: null, onerror: null, close: () => {}, send: (d: string) => queueMicrotask(() => session.handle(d)) };
    const welcome = await new Promise<BridgeServerMsg>((res) => {
      client.onmessage = (ev) => res(JSON.parse(String(ev.data)));
      client.send(JSON.stringify({ t: 'hello', code: '654321', client: 't', v: 1 }));
    });
    const bp = new BridgeProvider(client, welcome as Extract<BridgeServerMsg, { t: 'welcome' }>);
    // 走真正的引擎：tool_call / tool_result 由网页这边的引擎记录，并带上桥接器传来的 id
    const w = createWorld(OPTS);
    const trace = new AgentTrace();
    const engine = new DecisionEngine({ world: w, opts: w.state.opts, config: resolveConfig({ provider: 'scripted' }), provider: bp, fallback: scriptedFallback(w), trace });
    await engine.decide({ seq: 1, tick: 0, time: 0, wave: 0, phase: 'build', reasons: ['game_start'] }, []);
    const ev = trace.events();
    // 模型没开波 → 引擎的推进保证自动开波，记作一条 fallback
    expect(ev.map((e) => e.k)).toEqual(['decision_start', 'request', 'thinking', 'response', 'tool_call', 'tool_result', 'fallback', 'decision_end']);
    expect((ev[6] as Extract<TraceEvent, { k: 'fallback' }>).reason).toBe('auto start_wave');
    const req = ev[1] as Extract<TraceEvent, { k: 'request' }>;
    expect(req.provider).toBe('bridge:claude-native');
    expect((ev[4] as Extract<TraceEvent, { k: 'tool_call' }>).id).toBe('toolu_bridge');
    // 线上传输的内容里也没有密钥
    for (const m of wire) expect(m).not.toContain(KEYS.anthropic);
    noKey(JSON.stringify(trace.export()));
  });
});
