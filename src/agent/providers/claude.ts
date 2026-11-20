/**
 * Claude 原生适配器（官方 @anthropic-ai/sdk，文档 10 §8.2）。
 *
 * 按 claude-api 技能的约定：
 *  - 默认模型 claude-opus-5-5；可选 claude-sonnet-5-5 / claude-haiku-5-5 / claude-fable-5-2；
 *  - 自适应思考 thinking: {type:'adaptive'} + output_config.effort（不用 budget_tokens；Opus 5.5 不能关思考）；
 *  - tool_choice 用 auto（Opus 5.5 / Sonnet 5.5 / Fable 5.2 上强制 any/tool 会 400），工具全部 strict: true，由提示要求以 end_turn 收尾；
 *  - 提示缓存：tools → system[规则] → system[资料表 + cache_control]，再加顶层自动缓存覆盖本次决策内的多轮；
 *  - 拒答：检查 stop_reason === 'refusal'；opus-5-5 / sonnet-5-5 / fable-5-2 默认开服务端回退 fallbacks: 'default'
 *    （beta server-side-fallback-2026-07-01）；haiku-5-5 没有服务端回退，拒答时本回合交给内置机器人；
 *  - 助手消息原样（含 thinking 块）放回对话；
 *  - 不硬编码密钥：new Anthropic() 自己按 ANTHROPIC_API_KEY → ANTHROPIC_AUTH_TOKEN → `ant auth` 档案解析；
 *    浏览器 BYO key 模式才显式传 apiKey + dangerouslyAllowBrowser。
 */
import Anthropic from '@anthropic-ai/sdk';
import { emptyUsage, type TokenUsage } from '../types';
import { LIMIT_TEXT, type DecisionContext, type DecisionOutcome, type LLMProvider } from './types';
import type { Effort } from '../config';

/** 美元 / 百万 token（估算；以 Anthropic 账单为准）。cacheWrite 按 5 分钟缓存 = 1.25× 输入 */
export const CLAUDE_PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
};

export function claudeCost(model: string, u: TokenUsage): number {
  const p = CLAUDE_PRICES[model] ?? CLAUDE_PRICES['claude-opus-5-5'];
  return (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * p.cacheRead + u.cacheWriteTokens * p.cacheWrite) / 1e6;
}

/** 支持服务端拒答回退（"default" 形式）的模型 */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2']);

export interface ClaudeProviderOptions {
  model?: string;
  effort?: Effort;
  /** 浏览器 BYO key；Node 下留空让 SDK 自己解析凭据 */
  apiKey?: string;
  browser?: boolean;
  maxOutputTokens?: number;
  refusalFallback?: boolean;
  /** 测试注入 */
  client?: Anthropic;
}

export class ClaudeProvider implements LLMProvider {
  readonly id = 'claude-native';
  readonly model: string;
  private readonly client: Anthropic;
  private readonly effort: Effort;
  private readonly maxOut: number;
  private readonly fallback: boolean;

  constructor(o: ClaudeProviderOptions = {}) {
    this.model = o.model ?? 'claude-opus-5-5';
    this.effort = o.effort ?? 'medium';
    this.maxOut = o.maxOutputTokens ?? 16000;
    this.fallback = (o.refusalFallback ?? true) && FALLBACK_MODELS.has(this.model);
    this.client = o.client ?? (o.apiKey
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
    try {
      for (let req = 0; req < maxRequests; req++) {
        const t0 = Date.now();
        const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
          model: this.model,
          max_tokens: Math.max(1024, Math.min(this.maxOut, ctx.remainingTokens)),
          thinking: { type: 'adaptive' },
          output_config: { effort: this.effort },
          cache_control: { type: 'ephemeral' },
          tool_choice: { type: 'auto' },
          system,
          tools,
          messages,
        };
        if (this.fallback) {
          params.betas = ['server-side-fallback-2026-07-01'];
          params.fallbacks = 'default';
        }
        const res = await this.client.beta.messages.create(params, { signal: ctx.signal });
        addClaudeUsage(usage, res.usage);
        const alive = await ctx.afterRequest(Date.now() - t0);
        for (const b of res.content) if (b.type === 'text' && b.text.trim()) texts.push(b.text.trim());

        if (res.stop_reason === 'refusal') {
          out.error = `refusal${res.stop_details?.category ? ` (${res.stop_details.category})` : ''}`;
          break;
        }
        const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
        if (res.stop_reason === 'max_tokens' && uses.length) {
          out.error = 'max_tokens reached inside a tool call';
          break;
        }
        if (!uses.length || !alive) break;
        // 原样放回（含 thinking 块）
        messages.push({ role: 'assistant', content: res.content as unknown as Anthropic.Beta.BetaContentBlockParam[] });
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
        for (const u of uses) {
          if (out.toolCalls >= ctx.maxToolCalls) {
            results.push({ type: 'tool_result', tool_use_id: u.id, content: LIMIT_TEXT, is_error: true });
            continue;
          }
          out.toolCalls++;
          const r = await ctx.callTool(u.name, u.input);
          results.push({ type: 'tool_result', tool_use_id: u.id, content: r.text, is_error: !r.ok });
          if (r.endTurn) { out.ended = true; out.note = r.note; }
        }
        messages.push({ role: 'user', content: results });
        if (out.ended || out.toolCalls >= ctx.maxToolCalls || ctx.signal.aborted) break;
      }
    } catch (err) {
      out.error = describeClaudeError(err);
    }
    out.costUsd = claudeCost(this.model, usage);
    if (texts.length) out.text = texts.join('\n').slice(0, 2000);
    return out;
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
  if (err instanceof Anthropic.AuthenticationError) return 'auth: 没有可用的 Anthropic 凭据（设置 ANTHROPIC_API_KEY 或运行 ant auth login）';
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
