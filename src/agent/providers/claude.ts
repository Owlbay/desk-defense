/**
 * Claude 原生适配器（官方 @anthropic-ai/sdk，文档 10 §8.2）。
 *
 * 按 claude-api 技能的约定：
 *  - 默认模型 claude-opus-5-5；可选 claude-sonnet-5-5 / claude-haiku-5-5 / claude-fable-5-2；
 *  - 思考等级 → thinking / output_config.effort（../thinking.ts claudeThinkingPlan：Opus 5.5 / Fable 不能关思考 → 最低强度；
 *    Sonnet 5.5 关思考用 {type:'between_tools'}；Haiku 5.5 用 {type:'disabled'}；不用 budget_tokens）；
 *  - 决策内历史：助手消息（含 thinking 块）原样放回——保留思考的历史校验要求逐字节不变，所以这里不自己改写旧的工具结果，
 *    而是用服务端 context editing（clear_tool_uses_20250919，beta context-management-2025-06-27）在超过阈值时清理，
 *    它不算改写历史；
 *  - tool_choice 用 auto（Opus 5.5 / Sonnet 5.5 / Fable 5.2 上强制 any/tool 会 400），工具全部 strict: true，由提示要求以 end_turn 收尾；
 *  - 提示缓存：tools（固定顺序）→ system[规则] → system[速查表 + cache_control 断点 1]，顶层自动缓存（断点 2）覆盖本次决策内的多轮；
 *    前缀里没有任何随局 / 随决策变化的内容（开局信息在 user 消息里），所以跨决策、跨对局都能命中；
 *  - 拒答：检查 stop_reason === 'refusal'；opus-5-5 / sonnet-5-5 / fable-5-2 默认开服务端回退 fallbacks: 'default'
 *    （beta server-side-fallback-2026-07-01）；haiku-5-5 没有服务端回退，拒答时本回合交给内置机器人；
 *  - 助手消息原样（含 thinking 块）放回对话；
 *  - 不硬编码密钥：new Anthropic() 自己按 ANTHROPIC_API_KEY → ANTHROPIC_AUTH_TOKEN → `ant auth` 档案解析；
 *    浏览器 BYO key 模式才显式传 apiKey + dangerouslyAllowBrowser。
 */
import Anthropic from '@anthropic-ai/sdk';

import { t } from '../../i18n';
import type { Effort, ThinkingLevel } from '../config';
import { type ModelPrice, priceOf, usageCost } from '../modelinfo';
import { claudeThinkingPlan } from '../thinking';
import { blobRef, hashText, hostOf } from '../trace';
import { emptyUsage, type TokenUsage } from '../types';
import { type DecisionContext, type DecisionOutcome, LIMIT_TEXT, type LLMProvider } from './types';

/** 美元 / 百万 token（估算；以 Anthropic 账单为准）。cacheWrite 按 5 分钟缓存 = 1.25× 输入。
 *  只在模型目录（../modelinfo.ts）查不到、也没有手填价格时兜底 */
export const CLAUDE_PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
};

/** 费用：手填 > 模型目录 > 内置价格表（未知模型按 Opus 5.5） */
export function claudeCost(model: string, u: TokenUsage, override?: ModelPrice | null): number {
  const known = priceOf(model, override);
  if (known) return usageCost(u, known);
  const p = CLAUDE_PRICES[model] ?? CLAUDE_PRICES['claude-opus-5-5'];
  return (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * p.cacheRead + u.cacheWriteTokens * p.cacheWrite) / 1e6;
}

/** 支持服务端拒答回退（"default" 形式）的模型 */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2']);

export interface ClaudeProviderOptions {
  model?: string;
  /** 旧字段（= thinking 的非 off 取值） */
  effort?: Effort;
  thinking?: ThinkingLevel;
  /** 浏览器 BYO key；Node 下留空让 SDK 自己解析凭据 */
  apiKey?: string;
  browser?: boolean;
  maxOutputTokens?: number;
  refusalFallback?: boolean;
  /** 手填价格（美元 / 百万 token），优先于模型目录 */
  price?: ModelPrice;
  /** 测试注入 */
  client?: Anthropic;
}

export class ClaudeProvider implements LLMProvider {
  readonly id = 'claude-native';
  readonly model: string;
  private readonly client: Anthropic;
  private readonly thinking: ThinkingLevel;
  private readonly maxOut: number;
  private readonly fallback: boolean;
  private readonly price?: ModelPrice;

  constructor(o: ClaudeProviderOptions = {}) {
    this.model = o.model ?? 'claude-opus-5-5';
    this.thinking = o.thinking ?? o.effort ?? 'medium';
    this.maxOut = o.maxOutputTokens ?? 16000;
    this.fallback = (o.refusalFallback ?? true) && FALLBACK_MODELS.has(this.model);
    this.price = o.price;
    this.client =
      o.client ??
      (o.apiKey
        ? new Anthropic({ apiKey: o.apiKey, dangerouslyAllowBrowser: !!o.browser, maxRetries: 2 })
        : new Anthropic({ maxRetries: 2 }));
  }

  async decide(ctx: DecisionContext): Promise<DecisionOutcome> {
    const usage: TokenUsage = emptyUsage();
    const out: DecisionOutcome = { usage, costUsd: 0, toolCalls: 0, ended: false };
    const tools: Anthropic.Beta.BetaToolUnion[] = ctx.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as unknown as Anthropic.Beta.BetaTool.InputSchema,
      strict: true,
    }));
    const system: Anthropic.Beta.BetaTextBlockParam[] = [
      { type: 'text', text: ctx.system[0] },
      { type: 'text', text: ctx.system[1], cache_control: { type: 'ephemeral' } },
    ];
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: ctx.message }];
    const texts: string[] = [];
    const maxRequests = ctx.maxToolCalls + 2;
    const tr = ctx.trace;
    const host = hostOf(clientBaseUrl(this.client)) ?? 'api.anthropic.com';
    // 原始请求里系统提示 / 工具定义用占位符（面板里另有完整展示，复制 / 导出时还原）
    const sysRef = tr ? blobRef(hashText(JSON.stringify(system, null, 2))) : '';
    const toolsRef = tr ? blobRef(hashText(JSON.stringify(tools, null, 2))) : '';
    let n = 0;
    // 思考等级（预算分级可覆盖为 off）；同一决策内不变（between_tools 不允许中途改 effort）
    const plan = claudeThinkingPlan(this.model, ctx.thinking ?? this.thinking);
    try {
      for (let req = 0; req < maxRequests; req++) {
        const t0 = Date.now();
        n++;
        const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
          model: this.model,
          max_tokens: Math.max(1024, Math.min(ctx.maxOutputTokens ?? this.maxOut, ctx.remainingTokens)),
          output_config: { effort: plan.effort },
          cache_control: { type: 'ephemeral' },
          tool_choice: { type: 'auto' },
          system,
          tools,
          messages,
        };
        // 当前模型默认 display: "omitted"（思考文本为空）；面板要看思路摘要，开启时显式要 summarized
        if (plan.thinking) params.thinking = plan.thinking;
        const betas: string[] = [];
        if (this.fallback) {
          betas.push('server-side-fallback-2026-07-01');
          params.fallbacks = 'default';
        }
        if (ctx.historyCompactChars) {
          // 服务端清理较早的工具结果（不算改写历史，保留思考块有效）；阈值按 ~3.5 字符/token 换算
          betas.push('context-management-2025-06-27');
          params.context_management = {
            edits: [
              {
                type: 'clear_tool_uses_20250919',
                trigger: { type: 'input_tokens', value: Math.max(4000, Math.round(ctx.historyCompactChars / 3.5) + 3000) },
                keep: { type: 'tool_uses', value: 2 },
              },
            ],
          };
        }
        if (betas.length) params.betas = betas;
        if (tr) {
          tr({
            k: 'request',
            n,
            provider: this.id,
            api: 'anthropic-messages',
            model: this.model,
            host,
            effort: plan.effort,
            thinking: plan.effective,
            ...(plan.note ? { thinkingNote: plan.note } : {}),
            params: {
              max_tokens: params.max_tokens,
              thinking: params.thinking ?? null,
              output_config: params.output_config,
              tool_choice: params.tool_choice,
              cache_control: params.cache_control,
              betas: params.betas,
              fallbacks: params.fallbacks,
              context_management: params.context_management,
              stream: this.canStream(),
            },
            system: JSON.stringify(system, null, 2),
            toolDefs: tools,
            toolNames: ctx.tools.map((t) => t.name),
            messages: messages.length,
            headers: {
              'x-api-key': '•••',
              'anthropic-version': '2023-06-01',
              ...(params.betas ? { 'anthropic-beta': params.betas.join(',') } : {}),
              'content-type': 'application/json',
            },
            raw: { ...params, system: sysRef, tools: toolsRef, ...(this.canStream() ? { stream: true } : {}) },
          });
        }
        const res = await this.send(params, ctx, n);
        addClaudeUsage(usage, res.message.usage);
        const ms = Date.now() - t0;
        if (tr) {
          // 非流式（测试注入的客户端）：思路 / 文字在这里一次性补上
          for (const b of res.message.content) {
            if (b.type === 'thinking' && !res.streamedThinking && b.thinking) tr({ k: 'thinking', n, text: b.thinking });
            else if (b.type === 'redacted_thinking' && !res.streamedThinking)
              tr({ k: 'thinking', n, text: t('agent.demo.redactedThinking') });
            else if (b.type === 'text' && !res.streamedText && b.text) tr({ k: 'text', n, text: b.text });
          }
          const u1 = emptyUsage();
          addClaudeUsage(u1, res.message.usage);
          tr({
            k: 'response',
            n,
            stop: res.message.stop_reason ?? undefined,
            usage: u1,
            ms,
            costUsd: claudeCost(this.model, u1, this.price),
            raw: res.message,
          });
        }
        const alive = await ctx.afterRequest(ms);
        for (const b of res.message.content) if (b.type === 'text' && b.text.trim()) texts.push(b.text.trim());

        const m = res.message;
        if (m.stop_reason === 'refusal') {
          out.error = `refusal${m.stop_details?.category ? ` (${m.stop_details.category})` : ''}`;
          break;
        }
        const uses = m.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
        if (m.stop_reason === 'max_tokens' && uses.length) {
          out.error = 'max_tokens reached inside a tool call';
          break;
        }
        if (!uses.length || !alive) break;
        // 原样放回（含 thinking 块）
        messages.push({ role: 'assistant', content: m.content as unknown as Anthropic.Beta.BetaContentBlockParam[] });
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
        for (const u of uses) {
          if (out.toolCalls >= ctx.maxToolCalls) {
            results.push({ type: 'tool_result', tool_use_id: u.id, content: LIMIT_TEXT, is_error: true });
            continue;
          }
          out.toolCalls++;
          const r = await ctx.callTool(u.name, u.input, { id: u.id });
          results.push({ type: 'tool_result', tool_use_id: u.id, content: r.text, is_error: !r.ok });
          if (r.endTurn) {
            out.ended = true;
            out.note = r.note;
          }
        }
        messages.push({ role: 'user', content: results });
        if (out.ended || out.toolCalls >= ctx.maxToolCalls || ctx.signal.aborted) break;
      }
    } catch (err) {
      out.error = describeClaudeError(err);
    }
    out.costUsd = claudeCost(this.model, usage, this.price);
    if (texts.length) out.text = texts.join('\n').slice(0, 2000);
    return out;
  }

  private canStream(): boolean {
    return typeof (this.client.beta?.messages as { stream?: unknown } | undefined)?.stream === 'function';
  }

  /**
   * 发一次请求。客户端支持流式时用 messages.stream()：思路摘要（thinking_delta）与文字（text_delta）边到边报给面板，
   * 最后用 finalMessage() 拿完整消息（stop_reason / 工具调用 / 用量）。
   */
  private async send(
    params: Anthropic.Beta.MessageCreateParamsNonStreaming,
    ctx: DecisionContext,
    n: number,
  ): Promise<{ message: Anthropic.Beta.BetaMessage; streamedThinking: boolean; streamedText: boolean }> {
    if (!this.canStream()) {
      const message = await this.client.beta.messages.create(params, { signal: ctx.signal });
      return { message, streamedThinking: false, streamedText: false };
    }
    const stream = this.client.beta.messages.stream(params as Anthropic.Beta.MessageCreateParams, { signal: ctx.signal });
    let streamedThinking = false;
    let streamedText = false;
    const tr = ctx.trace;
    for await (const ev of stream) {
      if (!tr) continue;
      if (ev.type === 'content_block_delta') {
        if (ev.delta.type === 'thinking_delta' && ev.delta.thinking) {
          streamedThinking = true;
          tr({ k: 'thinking', n, text: ev.delta.thinking });
        } else if (ev.delta.type === 'text_delta' && ev.delta.text) {
          streamedText = true;
          tr({ k: 'text', n, text: ev.delta.text });
        }
      } else if (ev.type === 'content_block_start' && ev.content_block.type === 'redacted_thinking') {
        streamedThinking = true;
        tr({ k: 'thinking', n, text: t('agent.demo.redactedThinking') });
      }
    }
    const message = await stream.finalMessage();
    return { message, streamedThinking, streamedText };
  }
}

function clientBaseUrl(c: Anthropic): string | undefined {
  try {
    const b = (c as unknown as { baseURL?: unknown }).baseURL;
    return typeof b === 'string' ? b : undefined;
  } catch {
    return undefined;
  }
}

function addClaudeUsage(u: TokenUsage, r: Anthropic.Beta.BetaUsage): void {
  u.inputTokens += r.input_tokens ?? 0;
  u.outputTokens += r.output_tokens ?? 0;
  u.cacheReadTokens += r.cache_read_input_tokens ?? 0;
  u.cacheWriteTokens += r.cache_creation_input_tokens ?? 0;
  u.requests++;
}

/** 最具体的错误类优先（可重试与不可重试区分开写进报告） */
export function describeClaudeError(err: unknown): string {
  if (err instanceof Anthropic.APIUserAbortError) return 'aborted';
  if (err instanceof Anthropic.AuthenticationError)
    return 'auth: 没有可用的 Anthropic 凭据（设置 ANTHROPIC_API_KEY 或运行 ant auth login）';
  if (err instanceof Anthropic.PermissionDeniedError) return `permission: ${err.message}`;
  if (err instanceof Anthropic.NotFoundError) return `not_found: ${err.message}`;
  if (err instanceof Anthropic.RateLimitError) return `rate_limited: ${err.message}`;
  if (err instanceof Anthropic.BadRequestError) return `bad_request: ${err.message}`;
  if (err instanceof Anthropic.InternalServerError) return `server_error ${err.status}: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return `connection: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `api_error ${err.status}: ${err.message}`;
  if (err instanceof Error && err.name === 'AbortError') return 'aborted';
  return `error: ${err instanceof Error ? err.message : String(err)}`;
}
