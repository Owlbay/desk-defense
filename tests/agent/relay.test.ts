/**
 * 中转服务（relay）：地址规范化、模型列表、接口探测顺序与诊断、经 pi 的三种接口端到端（全部 mock 网络，不用真实 Key）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getModels } from '@mariozechner/pi-ai';
import {
  classifyRelayError,
  detectRelayApi,
  groupModels,
  listModels,
  listRelayModels,
  modelFamily,
  normalizeRelayBase,
  parseRelayUrl,
  relayHost,
  relayProbeOrder,
  resolveConfig,
  saveableConfig,
  testConnection,
  validateConfig,
  type ConnectionDiagnostics,
  type RelayApi,
} from '../../src/agent';
import { buildPiModel } from '../../src/agent/providers/pi';

const KEY = 'test-key-not-real';

describe('normalizeRelayBase', () => {
  const cases: [string, string, string][] = [
    // 输入, openai-*, anthropic-messages
    ['https://www.packyapi.com', 'https://www.packyapi.com/v1', 'https://www.packyapi.com'],
    ['https://www.packyapi.com/', 'https://www.packyapi.com/v1', 'https://www.packyapi.com'],
    ['https://www.packyapi.com///', 'https://www.packyapi.com/v1', 'https://www.packyapi.com'],
    ['https://www.packyapi.com/v1', 'https://www.packyapi.com/v1', 'https://www.packyapi.com'],
    ['https://www.packyapi.com/v1/', 'https://www.packyapi.com/v1', 'https://www.packyapi.com'],
    ['https://www.packyapi.com/V1', 'https://www.packyapi.com/v1', 'https://www.packyapi.com'],
    ['https://www.packyapi.com/v1/chat/completions', 'https://www.packyapi.com/v1', 'https://www.packyapi.com'],
    ['https://www.packyapi.com/v1/chat/completions/', 'https://www.packyapi.com/v1', 'https://www.packyapi.com'],
    ['https://www.packyapi.com/v1/responses', 'https://www.packyapi.com/v1', 'https://www.packyapi.com'],
    ['https://www.packyapi.com/v1/messages', 'https://www.packyapi.com/v1', 'https://www.packyapi.com'],
    ['https://www.packyapi.com/v1/models', 'https://www.packyapi.com/v1', 'https://www.packyapi.com'],
    ['https://www.packyapi.com/v1/completions', 'https://www.packyapi.com/v1', 'https://www.packyapi.com'],
    ['https://x.com/openai/v1', 'https://x.com/openai/v1', 'https://x.com/openai'],
    ['https://x.com/openai/v1/chat/completions', 'https://x.com/openai/v1', 'https://x.com/openai'],
    ['https://x.com/openai', 'https://x.com/openai/v1', 'https://x.com/openai'],
    ['https://x.com/claude/v1/messages', 'https://x.com/claude/v1', 'https://x.com/claude'],
    ['https://x.com/api/v1/?foo=1#frag', 'https://x.com/api/v1', 'https://x.com/api'],
    ['  https://x.com/v1  ', 'https://x.com/v1', 'https://x.com'],
    ['www.packyapi.com', 'https://www.packyapi.com/v1', 'https://www.packyapi.com'],
    ['www.packyapi.com/v1/', 'https://www.packyapi.com/v1', 'https://www.packyapi.com'],
    ['http://localhost:3000/v1', 'http://localhost:3000/v1', 'http://localhost:3000'],
    ['http://127.0.0.1:8080', 'http://127.0.0.1:8080/v1', 'http://127.0.0.1:8080'],
    // 非 v1 的版本段：openai-* 原样保留
    ['https://ark.example.com/api/v3', 'https://ark.example.com/api/v3', 'https://ark.example.com/api'],
    ['https://ark.example.com/api/v3/chat/completions', 'https://ark.example.com/api/v3', 'https://ark.example.com/api'],
  ];
  it.each(cases)('%s', (input, openai, anthropic) => {
    expect(normalizeRelayBase(input, 'openai-completions')).toBe(openai);
    expect(normalizeRelayBase(input, 'openai-responses')).toBe(openai);
    expect(normalizeRelayBase(input, 'anthropic-messages')).toBe(anthropic);
  });

  it('幂等：规范化后的地址再规范化不变；OpenAI 形式的地址可转换成任意接口', () => {
    for (const [input] of cases) {
      for (const a of ['openai-completions', 'openai-responses', 'anthropic-messages'] as RelayApi[]) {
        const once = normalizeRelayBase(input, a);
        expect(normalizeRelayBase(once, a)).toBe(once);
        if (a !== 'anthropic-messages')
          for (const b of ['openai-completions', 'anthropic-messages'] as RelayApi[])
            expect(normalizeRelayBase(once, b)).toBe(normalizeRelayBase(input, b));
      }
    }
  });

  it('不合法的地址：parseRelayUrl 返回 null，normalize 原样返回', () => {
    for (const bad of ['', '   ', 'ftp://x.com/v1', 'https://', 'http://']) expect(parseRelayUrl(bad)).toBeNull();
    expect(normalizeRelayBase('ftp://x.com', 'openai-completions')).toBe('ftp://x.com');
    expect(relayHost('https://www.packyapi.com/v1/messages')).toBe('www.packyapi.com');
    expect(relayHost('http://127.0.0.1:8080/v1')).toBe('127.0.0.1:8080');
    expect(relayHost('')).toBe('');
  });
});

describe('模型分组与探测顺序', () => {
  it('按家族分组、去重排序、可搜索', () => {
    expect(modelFamily('claude-sonnet-5-5')).toBe('claude');
    expect(modelFamily('anthropic/claude-opus')).toBe('claude');
    expect(modelFamily('gpt-5-mini')).toBe('gpt');
    expect(modelFamily('o3')).toBe('gpt');
    expect(modelFamily('o4-mini')).toBe('gpt');
    expect(modelFamily('gemini-2.5-flash')).toBe('gemini');
    expect(modelFamily('deepseek-chat')).toBe('other');
    const g = groupModels(['gpt-5', 'claude-b', 'claude-a', 'gemini-x', 'qwen3', 'claude-a']);
    expect(g).toEqual([
      { family: 'claude', models: ['claude-a', 'claude-b'] },
      { family: 'gpt', models: ['gpt-5'] },
      { family: 'gemini', models: ['gemini-x'] },
      { family: 'other', models: ['qwen3'] },
    ]);
    expect(groupModels(['gpt-5', 'claude-b', 'claude-a'], 'B')).toEqual([{ family: 'claude', models: ['claude-b'] }]);
    expect(groupModels(['gpt-5'], 'zzz')).toEqual([]);
  });

  it('Claude 模型先试 Anthropic Messages，其余按 responses → completions → messages', () => {
    expect(relayProbeOrder('claude-sonnet-5-5')).toEqual(['anthropic-messages', 'openai-responses', 'openai-completions']);
    expect(relayProbeOrder('gpt-5-mini')).toEqual(['openai-responses', 'openai-completions', 'anthropic-messages']);
    expect(relayProbeOrder('')).toEqual(['openai-responses', 'openai-completions', 'anthropic-messages']);
  });

  it('错误分类', () => {
    expect(classifyRelayError('error: Connection error.', false)).toBe('cors');
    expect(classifyRelayError('error: Failed to fetch', false)).toBe('cors');
    expect(classifyRelayError('error: 401 Incorrect API key provided', false)).toBe('auth');
    expect(classifyRelayError('error: 403 {"error":{"message":"无效的令牌"}}', false)).toBe('auth');
    expect(classifyRelayError('error: 404 Not Found', false)).toBe('not_found');
    expect(classifyRelayError('error: 404 page not found', false)).toBe('not_found');
    expect(classifyRelayError('error: 400 The model `gpt-x` does not exist or you do not have access to it.', false)).toBe('model');
    expect(classifyRelayError('error: 503 当前分组 default 下对于模型 foo 无可用渠道', false)).toBe('model');
    expect(classifyRelayError('error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: foo"}}', false)).toBe(
      'model',
    );
    expect(classifyRelayError('error: 429 rate limit exceeded', false)).toBe('rate');
    expect(classifyRelayError(undefined, true)).toBe('no_tools');
    expect(classifyRelayError('error: 500 boom', true, 10)).toBe('other');
  });
});

describe('validateConfig / resolveConfig（relay）', () => {
  it('需要地址；不接受 google 接口；Key 不会被保存', () => {
    expect(validateConfig({ provider: 'pi', preset: 'relay', model: 'gpt-5-mini' })).toContain('中转服务需要填写服务地址');
    expect(
      validateConfig({ provider: 'pi', preset: 'relay', model: 'm', baseUrl: 'https://r.test/v1', api: 'google-generative-ai' }).join(),
    ).toMatch(/中转服务只支持/);
    expect(validateConfig({ provider: 'pi', preset: 'relay', model: 'm', baseUrl: 'https://r.test/v1', api: 'openai-responses' })).toEqual(
      [],
    );
    const c = resolveConfig({
      provider: 'pi',
      preset: 'relay',
      model: 'claude-sonnet-5-5',
      baseUrl: 'https://r.test',
      api: 'anthropic-messages',
      apiKey: KEY,
    });
    expect(c.api).toBe('anthropic-messages');
    expect(JSON.stringify(saveableConfig(c))).not.toContain(KEY);
  });

  it('buildPiModel：按接口规范化地址、关闭中转站常不支持的字段、借用已知模型价格', () => {
    const base = { provider: 'pi' as const, preset: 'relay' as const, model: 'some-model', baseUrl: 'https://r.test/v1/chat/completions' };
    const comp = buildPiModel(resolveConfig({ ...base, api: 'openai-completions' }));
    expect(comp).toMatchObject({ api: 'openai-completions', provider: 'relay', baseUrl: 'https://r.test/v1', reasoning: true });
    // 中转推理模型：开启推理强度控制；deepseek 系列使用 deepseek 思考参数格式；中转默认 low
    expect((comp as { compat?: Record<string, unknown> }).compat).toMatchObject({ supportsReasoningEffort: true });
    expect(
      (buildPiModel(resolveConfig({ ...base, model: 'deepseek-flash', api: 'openai-completions' })) as { compat?: Record<string, unknown> })
        .compat,
    ).toMatchObject({ thinkingFormat: 'deepseek' });
    expect(resolveConfig({ ...base, api: 'openai-completions' }).effort).toBe('low');
    expect((comp as { compat?: Record<string, unknown> }).compat).toMatchObject({
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: 'max_tokens',
    });
    const resp = buildPiModel(resolveConfig({ ...base, api: 'openai-responses' }));
    expect(resp.baseUrl).toBe('https://r.test/v1');
    expect((resp as { compat?: Record<string, unknown> }).compat).toMatchObject({ sendSessionIdHeader: false });
    const msg = buildPiModel(resolveConfig({ ...base, api: 'anthropic-messages' }));
    expect(msg.baseUrl).toBe('https://r.test');
    const known = getModels('anthropic')[0];
    const priced = buildPiModel(resolveConfig({ ...base, model: known.id, api: 'anthropic-messages' }));
    expect(priced.cost).toEqual(known.cost);
    expect(priced.provider).toBe('relay');
  });
});

// ───────────────────────── fetch mocks ─────────────────────────

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sse = (events: [string, unknown][]) =>
  new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}
function headersOf(init?: RequestInit, req?: Request): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers ?? req?.headers).forEach((v, k) => (out[k] = v));
  return out;
}
function mockFetch(handler: (url: string, seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : undefined;
    const url = req ? req.url : String(input);
    const raw = init?.body ?? (req ? await req.clone().text() : null);
    const s: Seen = {
      url,
      headers: headersOf(init, req),
      body: typeof raw === 'string' && raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
    };
    seen.push(s);
    return handler(url, s);
  });
  return { fn: fn as unknown as typeof fetch, seen };
}

describe('listRelayModels（mock fetch）', () => {
  it('Bearer 成功：请求 {根}/v1/models', async () => {
    const m = mockFetch(() => json(200, { data: [{ id: 'gpt-5-mini' }, { id: 'claude-sonnet-5-5' }] }));
    const r = await listRelayModels('https://r.test/v1/chat/completions', KEY, m.fn);
    expect(r).toMatchObject({ ok: true, models: ['gpt-5-mini', 'claude-sonnet-5-5'], auth: 'bearer' });
    expect(m.seen[0].url).toBe('https://r.test/v1/models');
    expect(m.seen[0].headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('Bearer 被拒 → 改用 x-api-key + anthropic-version', async () => {
    const m = mockFetch((_u, s) =>
      s.headers['x-api-key'] ? json(200, { data: [{ id: 'claude-opus-5-5' }] }) : json(401, { error: 'nope' }),
    );
    const r = await listRelayModels('https://r.test', KEY, m.fn);
    expect(r).toMatchObject({ ok: true, models: ['claude-opus-5-5'], auth: 'x-api-key' });
    expect(m.seen[1].headers['anthropic-version']).toBe('2023-06-01');
    expect(m.seen[1].headers.authorization).toBeUndefined();
  });

  it('网络错误（CORS）→ 说明中转站必须允许跨域；listModels 对 relay 走同一逻辑', async () => {
    const m = mockFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const r = await listModels({ provider: 'pi', preset: 'relay', baseUrl: 'https://r.test/v1', model: 'x', apiKey: KEY }, m.fn);
    expect(r.ok).toBe(false);
    expect(r.hint).toMatch(/CORS/);
    const m2 = mockFetch(() => json(401, {}));
    expect((await listRelayModels('https://r.test', KEY, m2.fn)).hint).toMatch(/Key/);
    // 只把 Key 发给玩家填写的主机
    expect([...m.seen, ...m2.seen].every((s) => new URL(s.url).host === 'r.test')).toBe(true);
  });
});

describe('detectRelayApi（mock probe）', () => {
  const diag = (over: Partial<ConnectionDiagnostics>): ConnectionDiagnostics => ({
    ok: false,
    reachable: false,
    toolCalling: false,
    latencyMs: 10,
    model: 'm',
    provider: 'pi',
    tokens: 0,
    ...over,
  });
  const cfg = { provider: 'pi' as const, preset: 'relay' as const, baseUrl: 'https://r.test/v1/messages', apiKey: KEY };

  it('按顺序探测，第一个调用了工具的即为结果；每种接口用各自规范化后的地址', async () => {
    const tried: { api?: string; baseUrl?: string; toolMode?: string }[] = [];
    const progress: string[] = [];
    const r = await detectRelayApi(
      { ...cfg, model: 'gpt-5-mini' },
      {
        probe: async (c) => {
          tried.push({ api: c.api, baseUrl: c.baseUrl, toolMode: c.toolMode });
          expect(c.maxRetries).toBe(0);
          return c.api === 'openai-completions'
            ? diag({ ok: true, reachable: true, toolCalling: true, tokens: 30 })
            : diag({ error: 'error: 404 Not Found' });
        },
        onProgress: (api) => progress.push(api),
      },
    );
    expect(r.ok).toBe(true);
    expect(r.api).toBe('openai-completions');
    expect(tried).toEqual([
      { api: 'openai-responses', baseUrl: 'https://r.test/v1', toolMode: 'native' },
      { api: 'openai-completions', baseUrl: 'https://r.test/v1', toolMode: 'native' },
    ]);
    expect(progress).toEqual(['openai-responses', 'openai-completions']);
    expect(r.attempts[0]).toMatchObject({ ok: false, failure: 'not_found' });
  });

  it('Claude 模型先试 Anthropic Messages（成功就不再发别的请求）', async () => {
    const tried: string[] = [];
    const r = await detectRelayApi(
      { ...cfg, model: 'claude-sonnet-5-5' },
      {
        probe: async (c) => (tried.push(`${c.api} ${c.baseUrl}`), diag({ ok: true, reachable: true, toolCalling: true, tokens: 9 })),
      },
    );
    expect(r).toMatchObject({ ok: true, api: 'anthropic-messages' });
    expect(tried).toEqual(['anthropic-messages https://r.test']);
  });

  it('全部网络错误 ⇒ CORS 诊断', async () => {
    const r = await detectRelayApi(
      { ...cfg, model: 'gpt-5' },
      { probe: async () => diag({ reachable: true, error: 'error: Connection error.' }) },
    );
    expect(r.ok).toBe(false);
    expect(r.attempts).toHaveLength(3);
    expect(r.failure).toBe('cors');
    expect(r.message).toMatch(/CORS/);
    expect(r.api).toBeUndefined();
  });

  it('401 ⇒ Key；模型不存在 ⇒ 去选模型；能回复但不调用工具 ⇒ 给出接口并建议 JSON 模式', async () => {
    const auth = await detectRelayApi(
      { ...cfg, model: 'gpt-5' },
      {
        probe: async (c) => diag({ error: c.api === 'openai-responses' ? 'error: 404 Not Found' : 'error: 401 Unauthorized' }),
      },
    );
    expect(auth.failure).toBe('auth');
    expect(auth.message).toMatch(/Key/);
    const model = await detectRelayApi({ ...cfg, model: 'gpt-x' }, { probe: async () => diag({ error: 'error: 400 model_not_found' }) });
    expect(model.failure).toBe('model');
    expect(model.message).toMatch(/模型列表/);
    const partial = await detectRelayApi(
      { ...cfg, model: 'tiny' },
      {
        probe: async (c) =>
          c.api === 'openai-completions' ? diag({ reachable: true, tokens: 12 }) : diag({ error: 'error: 404 Not Found' }),
      },
    );
    expect(partial).toMatchObject({ ok: false, api: 'openai-completions', failure: 'no_tools' });
    expect(partial.message).toMatch(/JSON/);
  });

  it('probe 抛异常也能继续', async () => {
    let n = 0;
    const r = await detectRelayApi(
      { ...cfg, model: 'gpt-5' },
      {
        probe: async () => {
          if (n++ === 0) throw new Error('boom');
          return diag({ ok: true, reachable: true, toolCalling: true, tokens: 5 });
        },
      },
    );
    expect(r).toMatchObject({ ok: true, api: 'openai-completions' });
  });
});

// ───────────────────────── 经 pi 的端到端（mock 全局 fetch） ─────────────────────────

describe('relay 经 pi 端到端（mock fetch，不用 Claude 官方适配器）', () => {
  afterEach(() => vi.unstubAllGlobals());

  const relayCfg = (api: RelayApi, model = 'relay-model') => ({
    provider: 'pi' as const,
    preset: 'relay' as const,
    api,
    model,
    apiKey: KEY,
    browser: true,
    baseUrl: normalizeRelayBase('https://r.test/v1/', api),
  });

  it('openai-responses：工具调用，POST {根}/v1/responses，无 session_id 头', async () => {
    const m = mockFetch(() =>
      sse([
        ['response.created', { type: 'response.created', response: { id: 'resp_1' } }],
        [
          'response.output_item.added',
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'end_turn', arguments: '' },
          },
        ],
        [
          'response.function_call_arguments.delta',
          { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{"note":"pong"}' },
        ],
        [
          'response.output_item.done',
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'end_turn', arguments: '{"note":"pong"}' },
          },
        ],
        [
          'response.completed',
          {
            type: 'response.completed',
            response: { id: 'resp_1', status: 'completed', usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } },
          },
        ],
      ]),
    );
    vi.stubGlobal('fetch', m.fn);
    const d = await testConnection(relayCfg('openai-responses'));
    expect(d.error).toBeUndefined();
    expect(d).toMatchObject({ ok: true, toolCalling: true, provider: 'pi' });
    expect(m.seen[0].url).toBe('https://r.test/v1/responses');
    expect(m.seen[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(m.seen[0].headers.session_id).toBeUndefined();
    expect(m.seen[0].body?.model).toBe('relay-model');
    expect(Array.isArray(m.seen[0].body?.tools)).toBe(true);
  });

  it('openai-responses + JSON 动作模式：解析文字里的 JSON', async () => {
    const text = '{"actions":[{"tool":"end_turn","args":{"note":"pong"}}]}';
    const m = mockFetch(() =>
      sse([
        [
          'response.output_item.added',
          { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] } },
        ],
        [
          'response.content_part.added',
          {
            type: 'response.content_part.added',
            item_id: 'msg_1',
            output_index: 0,
            content_index: 0,
            part: { type: 'output_text', text: '' },
          },
        ],
        [
          'response.output_text.delta',
          { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: text },
        ],
        [
          'response.output_item.done',
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text }] },
          },
        ],
        [
          'response.completed',
          {
            type: 'response.completed',
            response: { id: 'r', status: 'completed', usage: { input_tokens: 20, output_tokens: 9, total_tokens: 29 } },
          },
        ],
      ]),
    );
    vi.stubGlobal('fetch', m.fn);
    const d = await testConnection({ ...relayCfg('openai-responses'), toolMode: 'json' });
    expect(d.error).toBeUndefined();
    expect(d).toMatchObject({ ok: true, toolCalling: true });
    expect(m.seen[0].body?.tools).toBeUndefined();
  });

  it('openai-completions：POST {根}/v1/chat/completions，用 max_tokens、不发 store', async () => {
    const chunk = (delta: unknown, finish: string | null = null, usage?: unknown) => ({
      id: 'c1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'relay-model',
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    });
    const m = mockFetch(() =>
      sse([
        [
          'message',
          chunk({
            role: 'assistant',
            tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'end_turn', arguments: '' } }],
          }),
        ],
        ['message', chunk({ tool_calls: [{ index: 0, function: { arguments: '{"note":"pong"}' } }] })],
        ['message', chunk({}, 'tool_calls', { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 })],
      ]),
    );
    vi.stubGlobal('fetch', m.fn);
    const d = await testConnection(relayCfg('openai-completions'));
    expect(d.error).toBeUndefined();
    expect(d.ok).toBe(true);
    expect(m.seen[0].url).toBe('https://r.test/v1/chat/completions');
    expect(m.seen[0].body?.max_tokens).toBeTypeOf('number');
    expect(m.seen[0].body?.max_completion_tokens).toBeUndefined();
    expect(m.seen[0].body?.store).toBeUndefined();
  });

  it('anthropic-messages：POST {根}/v1/messages（地址不重复 /v1），x-api-key + 浏览器直连头', async () => {
    const m = mockFetch(() =>
      sse([
        [
          'message_start',
          {
            type: 'message_start',
            message: {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              model: 'claude-x',
              content: [],
              stop_reason: null,
              usage: { input_tokens: 20, output_tokens: 1 },
            },
          },
        ],
        [
          'content_block_start',
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'end_turn', input: {} } },
        ],
        [
          'content_block_delta',
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"note":"pong"}' } },
        ],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }],
        ['message_stop', { type: 'message_stop' }],
      ]),
    );
    vi.stubGlobal('fetch', m.fn);
    const d = await testConnection(relayCfg('anthropic-messages', 'claude-x'));
    expect(d.error).toBeUndefined();
    expect(d).toMatchObject({ ok: true, toolCalling: true, provider: 'pi' });
    expect(m.seen[0].url).toBe('https://r.test/v1/messages');
    expect(m.seen[0].headers['x-api-key']).toBe(KEY);
    expect(m.seen[0].headers['anthropic-dangerous-direct-browser-access']).toBe('true');
  });

  it('detectRelayApi 用真实的 testConnection：responses 404 → completions 成功', async () => {
    const m = mockFetch((url) => {
      if (url.endsWith('/responses')) return json(404, { error: { message: 'Not Found' } });
      return sse([
        [
          'message',
          {
            id: 'c',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'gpt-5',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [{ index: 0, id: 'k', type: 'function', function: { name: 'end_turn', arguments: '{}' } }],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
        ],
      ]);
    });
    vi.stubGlobal('fetch', m.fn);
    const r = await detectRelayApi({ provider: 'pi', preset: 'relay', baseUrl: 'https://r.test', model: 'gpt-5', apiKey: KEY });
    expect(r).toMatchObject({ ok: true, api: 'openai-completions' });
    expect(r.attempts[0]).toMatchObject({ api: 'openai-responses', failure: 'not_found' });
    expect(m.seen.map((s) => s.url)).toEqual(['https://r.test/v1/responses', 'https://r.test/v1/chat/completions']);
  });

  it('网络错误时不重试（每种接口只发一次），全部失败 ⇒ CORS', async () => {
    const m = mockFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', m.fn);
    const r = await detectRelayApi({ provider: 'pi', preset: 'relay', baseUrl: 'https://r.test/v1', model: 'gpt-5', apiKey: KEY });
    expect(r).toMatchObject({ ok: false, failure: 'cors' });
    expect(m.seen).toHaveLength(3);
    expect(new Set(m.seen.map((s) => new URL(s.url).host))).toEqual(new Set(['r.test']));
  });
});

describe('旧页面加载不到新分包', () => {
  it('识别为 stale，而不是跨域', async () => {
    const { classifyRelayError, relayFailureText } = await import('../../src/agent/relay');
    for (const msg of [
      'Failed to fetch dynamically imported module: https://jjjj.games/assets/ai/pi-BIrs1FJS.js',
      'Importing a module script failed.',
      'error loading dynamically imported module',
    ]) {
      expect(classifyRelayError(msg, false, 0)).toBe('stale');
    }
    expect(relayFailureText('stale')).toContain('刷新');
    expect(classifyRelayError('TypeError: Failed to fetch', false, 0)).toBe('cors');
  });
});
