/**
 * listModels / testConnection（文档 10 §8.4）——给设置面板、CLI 与桥接器用。
 *
 * listModels：OpenAI 兼容服务（含 Ollama / LM Studio / llama.cpp / vLLM / OpenRouter / DeepSeek）GET {baseUrl}/models；
 *             Anthropic GET /v1/models（需要 key，浏览器直连要带 anthropic-dangerous-direct-browser-access 头）；
 *             其他走 pi 内置模型表。
 * testConnection：用一个只有 ping 工具的极小请求验证"能连上 + 会调用工具"，返回诊断信息。
 */
import { PRESETS, resolveConfig, type AgentModelConfig } from './config';
import type { LLMProvider } from './providers/types';
import { createProvider } from './factory';
import type { AgentToolDef } from './tools';
import { listRelayModels, relayCorsHint } from './relay';
import { t } from '../i18n';

export interface ModelListing {
  ok: boolean;
  models: string[];
  error?: string;
  /** 浏览器直连本机服务失败时的提示（CORS / 本地网络权限） */
  hint?: string;
}

const corsHint = (c: AgentModelConfig): string | undefined => {
  if (c.preset === 'relay') return relayCorsHint();
  if (!PRESETS[c.preset ?? 'custom']?.local) return undefined;
  return t('agent.diag.localHint');
};

export async function listModels(partial: Partial<AgentModelConfig>, fetchImpl: typeof fetch = fetch): Promise<ModelListing> {
  const c = resolveConfig(partial);
  if (c.provider === 'pi' && c.preset === 'relay') {
    const r = await listRelayModels(c.baseUrl ?? '', c.apiKey, fetchImpl);
    return { ok: r.ok, models: r.models, ...(r.error ? { error: r.error } : {}), ...(r.hint ? { hint: r.hint } : {}) };
  }
  try {
    if (c.provider === 'claude-native' || (c.provider === 'pi' && c.api === 'anthropic-messages')) {
      const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' };
      if (c.apiKey) headers['x-api-key'] = c.apiKey;
      if (c.browser) headers['anthropic-dangerous-direct-browser-access'] = 'true';
      const base = (c.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
      const r = await fetchImpl(`${base}/v1/models?limit=100`, { headers });
      if (!r.ok) return { ok: false, models: [], error: `HTTP ${r.status}` };
      const j = (await r.json()) as { data?: { id: string }[] };
      return { ok: true, models: (j.data ?? []).map((m) => m.id) };
    }
    if (c.provider === 'pi' && (c.api === 'openai-completions' || c.api === 'openai-responses')) {
      const headers: Record<string, string> = {};
      if (c.apiKey) headers.authorization = `Bearer ${c.apiKey}`;
      const r = await fetchImpl(`${(c.baseUrl ?? '').replace(/\/$/, '')}/models`, { headers });
      if (!r.ok) return { ok: false, models: [], error: `HTTP ${r.status}`, hint: corsHint(c) };
      const j = (await r.json()) as { data?: { id: string }[]; models?: { name: string }[] };
      const ids = j.data?.map((m) => m.id) ?? j.models?.map((m) => m.name) ?? [];
      return { ok: true, models: ids };
    }
    if (c.provider === 'pi') {
      const { getModels } = await import('@mariozechner/pi-ai');
      const kp = c.preset === 'google' ? 'google' : c.preset === 'openai' ? 'openai' : undefined;
      return { ok: true, models: kp ? getModels(kp).map((m) => m.id) : [] };
    }
    if (c.provider === 'scripted') return { ok: true, models: ['scripted-v1'] };
    return { ok: false, models: [], error: t('agent.diag.bridgeModels') };
  } catch (e) {
    return { ok: false, models: [], error: e instanceof Error ? e.message : String(e), hint: corsHint(c) };
  }
}

export interface ConnectionDiagnostics {
  ok: boolean;
  /** 连上并拿到回复 */
  reachable: boolean;
  /** 模型确实调用了 ping 工具（原生工具模式）/ 输出了可解析的 JSON 动作（json 模式） */
  toolCalling: boolean;
  latencyMs: number;
  model: string;
  provider: string;
  tokens: number;
  error?: string;
  hint?: string;
  advice?: string;
}

const PING_TOOL: AgentToolDef = {
  name: 'end_turn', kind: 'control', roles: ['player'],
  description: 'Call this tool to answer. Put the word "pong" in note.',
  input_schema: { type: 'object', properties: { note: { type: 'string', description: 'answer' } }, required: [], additionalProperties: false },
};

export async function testConnection(partial: Partial<AgentModelConfig>, provider?: LLMProvider): Promise<ConnectionDiagnostics> {
  const c = resolveConfig(partial);
  const t0 = Date.now();
  const diag: ConnectionDiagnostics = { ok: false, reachable: false, toolCalling: false, latencyMs: 0, model: c.model, provider: c.provider, tokens: 0 };
  try {
    const p = provider ?? (await createProvider(c));
    let called = false;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), c.decisionTimeoutMs ?? 60_000);
    const out = await p.decide({
      role: 'player',
      point: { seq: 0, tick: 0, time: 0, wave: 0, phase: 'build', reasons: ['game_start'] },
      system: ['Connection test. Respond only by calling the end_turn tool.', ''],
      message: 'Connection test: call end_turn with note "pong".',
      tools: [PING_TOOL],
      maxToolCalls: 1,
      remainingTokens: 4000,
      signal: ac.signal,
      callTool: async (name) => {
        called = name === 'end_turn';
        return { ok: true, text: 'OK', endTurn: true, note: 'pong' };
      },
      afterRequest: async () => true,
    }).finally(() => clearTimeout(timer));
    diag.latencyMs = Date.now() - t0;
    diag.tokens = out.usage.inputTokens + out.usage.outputTokens + out.usage.cacheReadTokens + out.usage.cacheWriteTokens;
    diag.reachable = !out.error || out.usage.requests > 0;
    diag.toolCalling = called;
    diag.ok = called && !out.error;
    if (out.error) diag.error = out.error;
    if (diag.reachable && !called) diag.advice = (c.toolMode ?? 'native') === 'native' ? t('agent.diag.noToolCall') : t('agent.diag.noJsonAction');
    if (!diag.reachable) diag.hint = corsHint(c);
  } catch (e) {
    diag.latencyMs = Date.now() - t0;
    diag.error = e instanceof Error ? e.message : String(e);
    diag.hint = corsHint(c);
  }
  return diag;
}
