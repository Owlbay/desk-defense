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
  type Api,
  type AssistantMessage,
  type Context,
  getModels,
  type KnownProvider,
  type Message,
  type Model,
  streamSimple,
  StringEnum,
  type Tool,
  type ToolResultMessage,
  type TSchema,
  Type,
} from '@mariozechner/pi-ai';

import type { AgentModelConfig, PiApi, ThinkingLevel } from '../config';
import { PRESETS } from '../config';
import { normalizeRelayBase } from '../relay';
import { keepThinkingInHistory, mayCompactHistory, type PiThinkingPlan, piThinkingPlan } from '../thinking';
import type { AgentToolDef, JsonSchema } from '../tools';
import { hostOf } from '../trace';
import { emptyUsage, type TokenUsage } from '../types';
import { jsonModeInstructions, parseActions, READ_TOOLS } from './json-mode';
import { type DecisionContext, type DecisionOutcome, LIMIT_TEXT, type LLMProvider } from './types';

// ───────────────────────── Schema → TypeBox ─────────────────────────

export function toTypeBox(s: JsonSchema): TSchema {
  const d = s.description ? { description: s.description } : {};
  switch (s.type) {
    case 'string':
      return s.enum ? StringEnum(s.enum, d) : Type.String(d);
    case 'integer':
      return Type.Integer(d);
    case 'number':
      return Type.Number(d);
    case 'boolean':
      return Type.Boolean(d);
    case 'array':
      return Type.Array(toTypeBox(s.items), d);
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

const KNOWN: Partial<Record<string, KnownProvider>> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  openrouter: 'openrouter',
  deepseek: 'deepseek',
};

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
    (m as Model<'openai-completions'>).compat = {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStore: false,
      supportsStrictMode: false,
    };
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
    // 推理模型在复杂局面下会把输出全花在思考上（实测 deepseek-flash 4096 token 全是推理、没调用工具），
    // 所以中转服务一律开启推理强度控制：按模型名选择参数格式，强度取配置的 effort（中转默认 low）。
    const id = c.model.toLowerCase();
    const thinkingFormat = id.includes('deepseek') ? 'deepseek' : id.includes('qwen') ? 'qwen' : undefined;
    m.reasoning = true;
    (m as Model<'openai-completions'>).compat = {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      supportsStrictMode: false,
      maxTokensField: 'max_tokens',
      ...(thinkingFormat ? { thinkingFormat } : {}),
    };
  } else if (api === 'openai-responses') {
    // 只有推理模型（o 系列 / gpt-5 / codex）才发 reasoning.effort；其余模型带这个字段会 400
    m.reasoning = /(^|\/)(o\d|gpt-5|codex)/i.test(c.model);
    (m as Model<'openai-responses'>).compat = { sendSessionIdHeader: false, supportsLongCacheRetention: false };
  } else if (api === 'anthropic-messages') {
    (m as Model<'anthropic-messages'>).compat = { supportsEagerToolInputStreaming: false, supportsLongCacheRetention: false };
  }
  return m;
}

/**
 * 决策内历史压缩：对话超过 maxChars 时，把最近一轮之前的工具结果改成一行摘要（"[…]" 开头）。返回压缩的条数。
 * 只在允许改写历史的 API 上调用（见 thinking.ts mayCompactHistory）。
 */
export function compactToolResults(messages: Message[], maxChars: number): number {
  const size = (m: Message): number => JSON.stringify(m.content).length;
  let total = messages.reduce((n, m) => n + size(m), 0);
  if (total <= maxChars) return 0;
  // 最近一条助手消息之后的工具结果是模型马上要读的，保留
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i].role === 'assistant') {
      lastAssistant = i;
      break;
    }
  let n = 0;
  for (let i = 0; i < lastAssistant && total > maxChars; i++) {
    const m = messages[i];
    if (m.role !== 'toolResult') continue;
    const txt = m.content.map((b) => (b.type === 'text' ? b.text : '')).join(' ');
    if (txt.startsWith('[…]')) continue;
    const firstLine = txt.split('\n')[0].slice(0, 100);
    const before = size(m);
    m.content = [{ type: 'text', text: `[…] ${firstLine}${txt.length > firstLine.length ? ' (older result summarized)' : ''}` }];
    total -= before - size(m);
    n++;
  }
  return n;
}

/** 助手消息里去掉思考块（不回传推理内容） */
export function stripThinking(m: AssistantMessage): AssistantMessage {
  if (!m.content.some((b) => b.type === 'thinking')) return m;
  return { ...m, content: m.content.filter((b) => b.type !== 'thinking') };
}

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

  /** 本次请求的思考设置（预算分级可覆盖为 off） */
  thinkingPlan(ctx?: Pick<DecisionContext, 'thinking'>): PiThinkingPlan {
    const level: ThinkingLevel = ctx?.thinking ?? this.c.thinking ?? this.c.effort ?? 'off';
    const fmt = (this.m as Model<'openai-completions'>).compat?.thinkingFormat;
    return piThinkingPlan(this.m.api as PiApi, this.m.id, level, { thinkingFormat: fmt, reasoningModel: this.m.reasoning });
  }

  /** 按思考设置调整 model.reasoning（例如 responses 的 off 不能让 pi 发 effort:'none'） */
  private modelFor(plan: PiThinkingPlan): Model<Api> {
    return plan.modelReasoning === undefined || plan.modelReasoning === this.m.reasoning
      ? this.m
      : { ...this.m, reasoning: plan.modelReasoning };
  }

  private options(ctx: DecisionContext, plan: PiThinkingPlan) {
    const local = PRESETS[this.c.preset ?? 'custom']?.local;
    return {
      signal: ctx.signal,
      apiKey: this.c.apiKey ?? (local ? 'local' : undefined),
      // 推理模型（如 deepseek 系列）会先输出大量思考，4096 容易在调用工具前就被截断；上下文模式给上限，默认 16000
      maxTokens: Math.max(512, Math.min(ctx.maxOutputTokens ?? this.c.maxOutputTokens ?? 16_000, ctx.remainingTokens)),
      temperature: this.c.temperature,
      reasoning: plan.reasoning,
      sessionId: `desk-defense-${ctx.role}`,
      cacheRetention: 'short' as const,
      ...(this.c.maxRetries !== undefined ? { maxRetries: this.c.maxRetries } : {}),
    };
  }

  async decide(ctx: DecisionContext): Promise<DecisionOutcome> {
    return (this.c.toolMode ?? 'native') === 'json' ? this.decideJson(ctx) : this.decideNative(ctx);
  }

  /** 系统提示 = 规则 + 速查表（两块都很短且固定，逐字节稳定，供各家的前缀缓存） */
  private systemPrompt(ctx: DecisionContext): string {
    return ctx.system[1] ? `${ctx.system[0]}\n\n${ctx.system[1]}` : ctx.system[0];
  }

  /**
   * 一次模型请求（流式）：pi 的事件流里 thinking_delta（Anthropic 思考摘要 / OpenAI responses 推理摘要 /
   * completions 的 reasoning_content / Gemini thoughts）与 text_delta 边到边报给面板；
   * onPayload 拿到真正发出的请求体（脱敏后存档），onResponse 拿到 HTTP 状态与响应头。
   */
  private async request(
    context: Context,
    ctx: DecisionContext,
    n: number,
    api: string,
    compacted = 0,
  ): Promise<{ msg: AssistantMessage; ms: number }> {
    const tr = ctx.trace;
    const plan = this.thinkingPlan(ctx);
    const model = this.modelFor(plan);
    const opts = this.options(ctx, plan);
    const t0 = Date.now();
    let http: { status: number; headers: Record<string, string> } | undefined;
    if (tr) {
      tr({
        k: 'request',
        n,
        provider: this.id,
        api,
        model: this.m.id,
        host: hostOf(this.m.baseUrl),
        effort: plan.reasoning,
        thinking: plan.effective,
        ...(plan.note ? { thinkingNote: plan.note } : {}),
        ...(compacted ? { compacted } : {}),
        params: {
          maxTokens: opts.maxTokens,
          temperature: opts.temperature,
          reasoning: opts.reasoning ?? null,
          cacheRetention: opts.cacheRetention,
          toolMode: this.c.toolMode ?? 'native',
          contextMode: this.c.contextMode ?? 'balanced',
          baseUrl: this.m.baseUrl,
        },
        system: context.systemPrompt,
        toolDefs: context.tools ? ctx.tools : undefined,
        toolNames: context.tools?.map((t) => t.name),
        messages: context.messages.length,
        headers: { authorization: this.c.apiKey ? 'Bearer •••' : '(无)', 'content-type': 'application/json' },
        // 真正的请求体在 onPayload 里补一条（各家格式不同）；这里先放 pi 的上下文
        raw: {
          model: this.m.id,
          api: this.m.api,
          systemPrompt: '(见「系统提示词」)',
          messages: context.messages,
          tools: context.tools?.map((t) => t.name),
        },
      });
    }
    const stream = streamSimple(model, context, {
      ...opts,
      onPayload: tr
        ? (payload: unknown) => {
            tr({ k: 'request_raw', n, raw: payload });
            return undefined;
          }
        : undefined,
      onResponse: tr
        ? (r: { status: number; headers: Record<string, string> }) => {
            http = r;
          }
        : undefined,
    });
    for await (const ev of stream) {
      if (!tr) continue;
      if (ev.type === 'thinking_delta' && ev.delta) tr({ k: 'thinking', n, text: ev.delta });
      else if (ev.type === 'text_delta' && ev.delta) tr({ k: 'text', n, text: ev.delta });
    }
    const msg = await stream.result();
    const ms = Date.now() - t0;
    if (tr) {
      if (msg.stopReason === 'error' && msg.errorMessage) tr({ k: 'error', n, message: msg.errorMessage });
      tr({
        k: 'response',
        n,
        stop: msg.stopReason,
        ms,
        costUsd: msg.usage.cost.total,
        usage: {
          inputTokens: msg.usage.input,
          outputTokens: msg.usage.output,
          cacheReadTokens: msg.usage.cacheRead,
          cacheWriteTokens: msg.usage.cacheWrite,
          requests: 1,
        },
        raw: { http, message: msg },
      });
    }
    return { msg, ms };
  }

  private async decideNative(ctx: DecisionContext): Promise<DecisionOutcome> {
    const usage = emptyUsage();
    const out: DecisionOutcome = { usage, costUsd: 0, toolCalls: 0, ended: false };
    const context: Context = {
      systemPrompt: this.systemPrompt(ctx),
      messages: [{ role: 'user', content: ctx.message, timestamp: Date.now() }],
      tools: toPiTools(ctx.tools),
    };
    const api = this.m.api as PiApi;
    const fmt = (this.m as Model<'openai-completions'>).compat?.thinkingFormat;
    const keepThinking = keepThinkingInHistory(api, fmt);
    const texts: string[] = [];
    let nudged = false;
    for (let req = 0; req < ctx.maxToolCalls + 2; req++) {
      let msg: AssistantMessage;
      let ms: number;
      const compacted =
        req > 0 && ctx.historyCompactChars && mayCompactHistory(api) ? compactToolResults(context.messages, ctx.historyCompactChars) : 0;
      try {
        ({ msg, ms } = await this.request(context, ctx, req + 1, this.m.api, compacted));
      } catch (e) {
        out.error = `error: ${e instanceof Error ? e.message : String(e)}`;
        break;
      }
      out.costUsd += addPiUsage(usage, msg);
      const alive = await ctx.afterRequest(ms);
      if (msg.stopReason === 'error' || msg.stopReason === 'aborted') {
        out.error = msg.stopReason === 'aborted' ? 'aborted' : `error: ${msg.errorMessage ?? 'unknown'}`;
        break;
      }
      for (const b of msg.content) if (b.type === 'text' && b.text.trim()) texts.push(b.text.trim());
      const calls = msg.content.filter((b) => b.type === 'toolCall');
      if (msg.stopReason === 'length' && calls.length) {
        out.error = 'output length reached inside a tool call';
        break;
      }
      // 因长度被截断、还没有任何动作：追问一次，要求直接行动（只回了一段文字 = 本回合不做事，直接结束，不再追问）
      if (!calls.length && alive && msg.stopReason === 'length' && !nudged && !ctx.signal.aborted) {
        nudged = true;
        context.messages.push(keepThinking ? msg : stripThinking(msg));
        context.messages.push({
          role: 'user',
          content: '回复因长度被截断。不要再分析，立即调用一次 act（包含全部动作和 end）。',
          timestamp: Date.now(),
        });
        continue;
      }
      if (!calls.length || !alive) break;
      context.messages.push(keepThinking ? msg : stripThinking(msg));
      for (const call of calls) {
        let text: string;
        let isError: boolean;
        if (out.toolCalls >= ctx.maxToolCalls) {
          text = LIMIT_TEXT;
          isError = true;
        } else {
          out.toolCalls++;
          const r = await ctx.callTool(call.name, call.arguments, { id: call.id });
          text = r.text;
          isError = !r.ok;
          if (r.endTurn) {
            out.ended = true;
            out.note = r.note;
          }
        }
        const tr: ToolResultMessage = {
          role: 'toolResult',
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: 'text', text }],
          isError,
          timestamp: Date.now(),
        };
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
      let msg: AssistantMessage;
      let ms: number;
      try {
        ({ msg, ms } = await this.request(context, ctx, round + 1, `json-mode/${this.m.api}`));
      } catch (e) {
        out.error = `error: ${e instanceof Error ? e.message : String(e)}`;
        break;
      }
      out.costUsd += addPiUsage(usage, msg);
      const alive = await ctx.afterRequest(ms);
      if (msg.stopReason === 'error' || msg.stopReason === 'aborted') {
        out.error = msg.stopReason === 'aborted' ? 'aborted' : `error: ${msg.errorMessage ?? 'unknown'}`;
        break;
      }
      const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      texts.push(text.slice(0, 500));
      if (!alive) break;
      messages.push(
        keepThinkingInHistory(this.m.api as PiApi, (this.m as Model<'openai-completions'>).compat?.thinkingFormat)
          ? msg
          : stripThinking(msg),
      );
      const parsed = parseActions(text, ctx.tools);
      if (parsed.note) out.note = parsed.note;
      const results: string[] = [...parsed.errors.map((e) => `ERROR ${e}`)];
      let readUsed = false;
      for (const a of parsed.actions) {
        if (out.toolCalls >= ctx.maxToolCalls) {
          results.push(LIMIT_TEXT);
          break;
        }
        out.toolCalls++;
        const r = await ctx.callTool(a.tool, a.args, { id: `json_${round + 1}_${out.toolCalls}` });
        results.push(`${a.tool}: ${r.text}`);
        if (READ_TOOLS.has(a.tool)) readUsed = true;
        if (r.endTurn) {
          out.ended = true;
          if (r.note) out.note = r.note;
          break;
        }
      }
      const retry = parsed.actions.length === 0 && parsed.errors.length > 0;
      // 有动作且没有读取类工具 → 本回合结束；只有读取 / 解析失败 → 把结果回给模型再来一轮
      if (out.ended || out.toolCalls >= ctx.maxToolCalls || (!readUsed && !retry) || ctx.signal.aborted) break;
      messages.push({ role: 'user', content: `RESULTS\n${results.join('\n')}\nReply with the next JSON object.`, timestamp: Date.now() });
    }
    out.text = texts.join('\n').slice(0, 2000);
    return out;
  }
}
