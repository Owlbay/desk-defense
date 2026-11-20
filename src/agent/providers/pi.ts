/**
 * 多厂商适配器：@mariozechner/pi-ai（文档 10 §8.3）。
 *
 * 覆盖 anthropic-messages / openai-completions（含 Ollama、LM Studio、llama.cpp、vLLM、OpenRouter、DeepSeek）/
 * openai-responses / google-generative-ai。
 *  - 工具：我们的严格 JSON Schema → TypeBox（字符串枚举用 StringEnum，兼容 Google）；
 *  - toolMode 'json'：不发原生工具，改让模型输出 JSON 动作列表（./json-mode.ts）；
 *  - 中止：AbortSignal 透传；用量 / 费用：pi 的 usage.cost（本地模型为 0）。
 * 浏览器里只能经 dynamic import() 加载本文件（见 ../factory.ts），避免把 pi 及其各厂商 SDK 打进首屏包。
 */
import {
  Type, StringEnum, completeSimple, getModels,
  type Api, type AssistantMessage, type Context, type KnownProvider, type Message, type Model, type TSchema,
  type ThinkingLevel, type Tool, type ToolResultMessage,
} from '@mariozechner/pi-ai';
import type { AgentModelConfig, Effort, PiApi } from '../config';
import { PRESETS } from '../config';
import type { AgentToolDef, JsonSchema } from '../tools';
import { emptyUsage, type TokenUsage } from '../types';
import { LIMIT_TEXT, type DecisionContext, type DecisionOutcome, type LLMProvider } from './types';
import { READ_TOOLS, jsonModeInstructions, parseActions } from './json-mode';
import { normalizeRelayBase } from '../relay';

// ───────────────────────── Schema → TypeBox ─────────────────────────

export function toTypeBox(s: JsonSchema): TSchema {
  const d = s.description ? { description: s.description } : {};
  switch (s.type) {
    case 'string': return s.enum ? StringEnum(s.enum, d) : Type.String(d);
    case 'integer': return Type.Integer(d);
    case 'number': return Type.Number(d);
    case 'boolean': return Type.Boolean(d);
    case 'array': return Type.Array(toTypeBox(s.items), d);
    case 'object': {
      const props: Record<string, TSchema> = {};
      for (const [k, v] of Object.entries(s.properties)) props[k] = s.required.includes(k) ? toTypeBox(v) : Type.Optional(toTypeBox(v));
      return Type.Object(props, { ...d, additionalProperties: false });
    }
  }
}

export function toPiTools(tools: AgentToolDef[]): Tool[] {
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: toTypeBox(t.input_schema) }));
}

// ───────────────────────── 模型 ─────────────────────────

const KNOWN: Partial<Record<string, KnownProvider>> = { anthropic: 'anthropic', openai: 'openai', google: 'google', openrouter: 'openrouter', deepseek: 'deepseek' };

/** 配置 → pi Model：已知厂商优先用 pi 内置的模型表（含价格），否则构造自定义模型（本地服务 / 未收录的模型） */
export function buildPiModel(c: AgentModelConfig): Model<Api> {
  const preset = c.preset ?? 'custom';
  const info = PRESETS[preset];
  const api: PiApi = c.api ?? info.api;
  if (preset === 'relay') return buildRelayModel(c, api);
  const baseUrl = c.baseUrl ?? info.baseUrl;
  const kp = KNOWN[preset];
  if (kp) {
    const known = (getModels(kp) as Model<Api>[]).find((m) => m.id === c.model);
    if (known) return { ...known, baseUrl: c.baseUrl ?? known.baseUrl };
  }
  const m: Model<Api> = {
    id: c.model,
    name: c.model,
    api,
    provider: preset,
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: c.maxOutputTokens ?? 8192,
  };
  if (info.local && api === 'openai-completions') {
    (m as Model<'openai-completions'>).compat = { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStore: false, supportsStrictMode: false };
  }
  return m;
}

/**
 * 中转服务：地址按 API 规范化（openai-* → …/v1；anthropic-messages → 不带 /v1），
 * 价格 / 上下文借用 pi 模型表里同名模型（仅用于预算估算），并关掉中转站常不支持的可选字段 / 自定义头：
 *  - completions：不发 store、不用 developer 角色、不发 strict、用 max_tokens；
 *  - responses：不发 session_id 头（跨域预检多一个自定义头就可能被拒）；
 *  - messages：不发 eager_input_streaming、不用 1h 缓存。
 * Anthropic SDK 在 pi 里固定带 dangerouslyAllowBrowser + anthropic-dangerous-direct-browser-access 头。
 */
export function buildRelayModel(c: AgentModelConfig, api: PiApi = c.api ?? 'openai-completions'): Model<Api> {
  let known: Model<Api> | undefined;
  for (const kp of ['anthropic', 'openai', 'google'] as KnownProvider[]) {
    known = (getModels(kp) as Model<Api>[]).find((m) => m.id === c.model || c.model.endsWith(`/${m.id}`));
    if (known) break;
  }
  const m: Model<Api> = {
    id: c.model,
    name: c.model,
    api,
    provider: 'relay',
    baseUrl: normalizeRelayBase(c.baseUrl ?? '', api),
    reasoning: false,
    input: ['text'],
    cost: known ? { ...known.cost } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: known?.contextWindow ?? 128_000,
    maxTokens: c.maxOutputTokens ?? Math.min(known?.maxTokens ?? 8192, 16_000),
  };
  if (api === 'openai-completions') {
    (m as Model<'openai-completions'>).compat = { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStrictMode: false, maxTokensField: 'max_tokens' };
  } else if (api === 'openai-responses') {
    (m as Model<'openai-responses'>).compat = { sendSessionIdHeader: false, supportsLongCacheRetention: false };
  } else if (api === 'anthropic-messages') {
    (m as Model<'anthropic-messages'>).compat = { supportsEagerToolInputStreaming: false, supportsLongCacheRetention: false };
  }
  return m;
}

const LEVEL: Record<Effort, ThinkingLevel> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' };

function addPiUsage(u: TokenUsage, m: AssistantMessage): number {
  u.inputTokens += m.usage.input;
  u.outputTokens += m.usage.output;
  u.cacheReadTokens += m.usage.cacheRead;
  u.cacheWriteTokens += m.usage.cacheWrite;
  u.requests++;
  return m.usage.cost.total;
}

export interface PiProviderOptions {
  config: AgentModelConfig;
  /** 测试注入（例如 pi 的 faux provider 模型） */
  model?: Model<Api>;
}

export class PiProvider implements LLMProvider {
  readonly id: string;
  readonly model: string;
  private readonly m: Model<Api>;
  private readonly c: AgentModelConfig;

  constructor(o: PiProviderOptions) {
    this.c = o.config;
    this.m = o.model ?? buildPiModel(o.config);
    this.id = `pi:${o.config.preset ?? this.m.provider}`;
    this.model = this.m.id;
  }

  private options(ctx: DecisionContext) {
    const local = PRESETS[this.c.preset ?? 'custom']?.local;
    return {
      signal: ctx.signal,
      apiKey: this.c.apiKey ?? (local ? 'local' : undefined),
      maxTokens: Math.max(512, Math.min(this.c.maxOutputTokens ?? 4096, ctx.remainingTokens)),
      temperature: this.c.temperature,
      reasoning: this.m.reasoning && this.c.effort ? LEVEL[this.c.effort] : undefined,
      sessionId: `desk-defense-${ctx.role}`,
      cacheRetention: 'short' as const,
      ...(this.c.maxRetries !== undefined ? { maxRetries: this.c.maxRetries } : {}),
    };
  }

  async decide(ctx: DecisionContext): Promise<DecisionOutcome> {
    return (this.c.toolMode ?? 'native') === 'json' ? this.decideJson(ctx) : this.decideNative(ctx);
  }

  private systemPrompt(ctx: DecisionContext): string {
    return this.c.contextBudget === 'compact' ? ctx.system[0] : `${ctx.system[0]}\n\n${ctx.system[1]}`;
  }

  private async decideNative(ctx: DecisionContext): Promise<DecisionOutcome> {
    const usage = emptyUsage();
    const out: DecisionOutcome = { usage, costUsd: 0, toolCalls: 0, ended: false };
    const context: Context = {
      systemPrompt: this.systemPrompt(ctx),
      messages: [{ role: 'user', content: ctx.message, timestamp: Date.now() }],
      tools: toPiTools(ctx.tools),
    };
    const texts: string[] = [];
    for (let req = 0; req < ctx.maxToolCalls + 2; req++) {
      const t0 = Date.now();
      let msg: AssistantMessage;
      try {
        msg = await completeSimple(this.m, context, this.options(ctx));
      } catch (e) {
        out.error = `error: ${e instanceof Error ? e.message : String(e)}`;
        break;
      }
      out.costUsd += addPiUsage(usage, msg);
      const alive = await ctx.afterRequest(Date.now() - t0);
      if (msg.stopReason === 'error' || msg.stopReason === 'aborted') {
        out.error = msg.stopReason === 'aborted' ? 'aborted' : `error: ${msg.errorMessage ?? 'unknown'}`;
        break;
      }
      for (const b of msg.content) if (b.type === 'text' && b.text.trim()) texts.push(b.text.trim());
      const calls = msg.content.filter((b) => b.type === 'toolCall');
      if (msg.stopReason === 'length' && calls.length) { out.error = 'output length reached inside a tool call'; break; }
      if (!calls.length || !alive) break;
      context.messages.push(msg);
      for (const call of calls) {
        let text: string;
        let isError: boolean;
        if (out.toolCalls >= ctx.maxToolCalls) {
          text = LIMIT_TEXT;
          isError = true;
        } else {
          out.toolCalls++;
          const r = await ctx.callTool(call.name, call.arguments);
          text = r.text;
          isError = !r.ok;
          if (r.endTurn) { out.ended = true; out.note = r.note; }
        }
        const tr: ToolResultMessage = { role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text }], isError, timestamp: Date.now() };
        context.messages.push(tr);
      }
      if (out.ended || out.toolCalls >= ctx.maxToolCalls || ctx.signal.aborted) break;
    }
    if (texts.length) out.text = texts.join('\n').slice(0, 2000);
    return out;
  }

  private async decideJson(ctx: DecisionContext): Promise<DecisionOutcome> {
    const usage = emptyUsage();
    const out: DecisionOutcome = { usage, costUsd: 0, toolCalls: 0, ended: false };
    const messages: Message[] = [{ role: 'user', content: ctx.message, timestamp: Date.now() }];
    const context: Context = { systemPrompt: `${this.systemPrompt(ctx)}\n\n${jsonModeInstructions(ctx.tools)}`, messages };
    const texts: string[] = [];
    for (let round = 0; round < 4; round++) {
      const t0 = Date.now();
      let msg: AssistantMessage;
      try {
        msg = await completeSimple(this.m, context, this.options(ctx));
      } catch (e) {
        out.error = `error: ${e instanceof Error ? e.message : String(e)}`;
        break;
      }
      out.costUsd += addPiUsage(usage, msg);
      const alive = await ctx.afterRequest(Date.now() - t0);
      if (msg.stopReason === 'error' || msg.stopReason === 'aborted') {
        out.error = msg.stopReason === 'aborted' ? 'aborted' : `error: ${msg.errorMessage ?? 'unknown'}`;
        break;
      }
      const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      texts.push(text.slice(0, 500));
      if (!alive) break;
      messages.push(msg);
      const parsed = parseActions(text, ctx.tools);
      if (parsed.note) out.note = parsed.note;
      const results: string[] = [...parsed.errors.map((e) => `ERROR ${e}`)];
      let readUsed = false;
      for (const a of parsed.actions) {
        if (out.toolCalls >= ctx.maxToolCalls) { results.push(LIMIT_TEXT); break; }
        out.toolCalls++;
        const r = await ctx.callTool(a.tool, a.args);
        results.push(`${a.tool}: ${r.text}`);
        if (READ_TOOLS.has(a.tool)) readUsed = true;
        if (r.endTurn) { out.ended = true; if (r.note) out.note = r.note; break; }
      }
      const retry = parsed.actions.length === 0 && parsed.errors.length > 0;
      if (out.ended || out.toolCalls >= ctx.maxToolCalls || (!readUsed && !retry) || ctx.signal.aborted) break;
      messages.push({ role: 'user', content: `RESULTS\n${results.join('\n')}\nReply with the next JSON object.`, timestamp: Date.now() });
    }
    out.text = texts.join('\n').slice(0, 2000);
    return out;
  }
}
