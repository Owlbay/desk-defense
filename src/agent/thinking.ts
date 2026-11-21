/**
 * 思考等级 → 各厂商请求参数（文档 10 §13.3「思考等级」表）。纯函数、无 SDK 依赖，便于单元测试。
 *
 * Claude 原生（官方 SDK，按 claude-api 技能的 Thinking & Effort 表）：
 *   - 开启（低 / 中 / 高 / 很高 / 最高）：thinking {type:'adaptive', display:'summarized'} + output_config.effort = 等级
 *   - 无思考：
 *       Opus 5.5  不能关闭（disabled / budget_tokens 一律 400）→ adaptive + effort low，提示"不支持关闭思考，已用最低强度"
 *       Fable 5.x 思考常开（disabled 400）→ adaptive + effort low，同样提示
 *       Sonnet 5.5 disabled 会 400 → {type:'between_tools'}（只能在 effort ≤ high 时用，且不能带任何其他字段）+ effort low
 *       Haiku 5.5 → {type:'disabled'}（effort ≤ high）+ effort low
 *       其他 / 未知 Claude 模型 → adaptive + low（保守，不冒 400 的险）
 *
 * pi（@mariozechner/pi-ai）：
 *   - openai-completions：thinkingFormat deepseek / qwen 时，off = 不传 reasoning（pi 发 {thinking:{type:'disabled'}} / enable_thinking:false）；
 *     其余（通用 OpenAI 兼容）off = 不发 reasoning_effort，开启 = reasoning_effort 等级
 *   - openai-responses：off = 不发 reasoning（把 model.reasoning 置 false，避免 pi 发 effort:'none'）；开启 = reasoning.effort
 *   - anthropic-messages：pi 只认得 4.6 / 4.7 的自适应思考，对 Claude 5.x 会发 budget_tokens（400）→ 5.x 一律不发 thinking 参数
 *     （服务端默认自适应）；Haiku 5.5 的 off 例外：pi 发 {type:'disabled'} 是合法的
 *   - google-generative-ai：off = pi 发 thinkingBudget 0（Gemini 2.x）/ 最低 thinkingLevel（Gemini 3）
 */
import { t } from '../i18n';
import type { PiApi, ThinkingLevel } from './config';

export type PiThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface ClaudeThinkingPlan {
  /** undefined = 不发 thinking 参数 */
  thinking?: { type: 'adaptive'; display: 'summarized' } | { type: 'between_tools' } | { type: 'disabled' };
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** 面板 / 追踪里显示的实际设置 */
  effective: string;
  /** 给玩家的提示（例如模型不支持关闭思考） */
  note?: string;
}

const CLAUDE_NAME = (m: string): string =>
  m.includes('opus-5-5')
    ? 'Opus 5.5'
    : m.includes('fable')
      ? 'Fable 5.2'
      : m.includes('sonnet-5-5')
        ? 'Sonnet 5.5'
        : m.includes('haiku-5-5')
          ? 'Haiku 5.5'
          : m;

export function claudeThinkingPlan(model: string, level: ThinkingLevel = 'medium'): ClaudeThinkingPlan {
  if (level !== 'off') {
    return { thinking: { type: 'adaptive', display: 'summarized' }, effort: level, effective: `adaptive · effort ${level}` };
  }
  if (model.includes('sonnet-5-5'))
    return { thinking: { type: 'between_tools' }, effort: 'low', effective: t('agent.think.offEffort', { mode: 'between_tools' }) };
  if (model.includes('haiku-5-5'))
    return { thinking: { type: 'disabled' }, effort: 'low', effective: t('agent.think.offEffort', { mode: 'disabled' }) };
  return {
    thinking: { type: 'adaptive', display: 'summarized' },
    effort: 'low',
    effective: t('agent.think.cantOff'),
    note: t('agent.think.cantOffNote', { model: CLAUDE_NAME(model) }),
  };
}

export interface PiThinkingPlan {
  /** 传给 pi 的 reasoning（undefined = 关 / 不发） */
  reasoning?: PiThinkingLevel;
  /** 覆盖 model.reasoning（undefined = 不改） */
  modelReasoning?: boolean;
  effective: string;
  note?: string;
}

const PI_LEVEL: Record<Exclude<ThinkingLevel, 'off'>, PiThinkingLevel> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'xhigh',
};

const isClaude5 = (id: string): boolean =>
  /claude-(opus|sonnet|haiku|fable|mythos)-5/.test(id) || /(opus|sonnet|haiku)-5[-.]/.test(id) || id.includes('fable');

export function piThinkingPlan(
  api: PiApi,
  modelId: string,
  level: ThinkingLevel,
  o: { thinkingFormat?: string; reasoningModel?: boolean } = {},
): PiThinkingPlan {
  const on = level !== 'off';
  const lv = on ? PI_LEVEL[level] : undefined;
  const id = modelId.toLowerCase();
  switch (api) {
    case 'openai-completions': {
      const fmt = o.thinkingFormat;
      if (fmt === 'deepseek')
        return on ? { reasoning: lv, effective: `thinking enabled · reasoning_effort ${lv}` } : { effective: 'thinking {type:"disabled"}' };
      if (fmt === 'qwen')
        return on ? { reasoning: lv, effective: `enable_thinking true（${lv}）` } : { effective: 'enable_thinking false' };
      if (o.reasoningModel === false) return { effective: t('agent.think.noParam') };
      return on
        ? { reasoning: lv, effective: `reasoning_effort ${lv}` }
        : { effective: t('agent.think.notSent', { param: 'reasoning_effort' }) };
    }
    case 'openai-responses':
      if (o.reasoningModel === false) return { modelReasoning: false, effective: t('agent.think.nonReasoning') };
      return on
        ? { reasoning: lv, modelReasoning: true, effective: `reasoning.effort ${lv}` }
        : { modelReasoning: false, effective: t('agent.think.notSent', { param: 'reasoning' }) };
    case 'anthropic-messages':
      if (isClaude5(id)) {
        if (!on && id.includes('haiku')) return { modelReasoning: true, effective: 'thinking {type:"disabled"}' };
        return {
          modelReasoning: false,
          effective: t('agent.think.serverDefault'),
          note: on ? t('agent.think.piNoEffort') : t('agent.think.piCantOff', { model: CLAUDE_NAME(id) }),
        };
      }
      return on
        ? { reasoning: lv, modelReasoning: true, effective: `thinking ${lv}` }
        : { modelReasoning: o.reasoningModel, effective: 'thinking {type:"disabled"}' };
    case 'google-generative-ai':
      return on ? { reasoning: lv, effective: `thinking ${lv}` } : { effective: t('agent.think.googleOff') };
    default:
      // 其他 pi 接口（测试用 faux 等）：照 pi 的通用 reasoning 语义
      return on ? { reasoning: lv, effective: `reasoning ${lv}` } : { effective: 'reasoning off' };
  }
}

/**
 * 决策内对话历史里是否保留模型的思考 / 推理内容（下一次请求时回传）。
 *  - anthropic-messages：必须原样回传（签名 + 保留思考的历史校验），保留；
 *  - openai-responses：推理条目与 function_call 绑定，pi 带加密推理回传，保留；
 *  - google：thoughtSignature 绑定在函数调用上，保留；
 *  - openai-completions + deepseek：思考模式下同一轮工具调用需回传 reasoning_content，保留；
 *  - 其余 openai-completions（qwen / 本机 / 通用中转）：推理内容回传只是白花输入 token，去掉。
 * 跨决策永远不带历史（每次决策都是新对话），所以推理内容不会跨决策累积。
 */
export function keepThinkingInHistory(api: PiApi, thinkingFormat?: string): boolean {
  if (api !== 'openai-completions') return true;
  return thinkingFormat === 'deepseek';
}

/**
 * 决策内是否允许把较早的工具结果压成摘要（改写历史）。
 * Anthropic 的保留思考会校验历史逐字节不变（新账号强制，改写即 400），所以 anthropic-messages 不改写；
 * Claude 原生适配器改用服务端 context editing（clear_tool_uses），它不算改写历史。
 */
export function mayCompactHistory(api: PiApi): boolean {
  return api !== 'anthropic-messages';
}
