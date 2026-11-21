/**
 * Agent 模型配置（文档 10 §8）——CLI、MCP、桥接器与之后的网页 UI 共用同一份结构。
 *
 * provider：
 *   claude-native  官方 @anthropic-ai/sdk（推荐的 Claude 路径：自适应思考 + effort、提示缓存、拒答回退）
 *   pi             @mariozechner/pi-ai 多厂商适配（anthropic-messages / openai-completions / openai-responses / google-generative-ai），
 *                  覆盖 OpenAI 兼容的本地服务（Ollama / LM Studio / llama.cpp / vLLM）
 *   bridge         浏览器 → 本机桥接器（scripts/agent-bridge.ts）的 WebSocket，由桥接器在 Node 里调用模型
 *   scripted       内置确定性策略（离线 / 测试 / 演示）
 *
 * apiKey 默认绝不持久化：saveableConfig() 会去掉它；浏览器端只放内存（可选 sessionStorage，由 UI 决定）。
 */
import type { AgentRole, DecisionMode } from './types';
import { t, type Params } from '../i18n';

export type ProviderKind = 'claude-native' | 'pi' | 'bridge' | 'scripted';
export type PiApi = 'anthropic-messages' | 'openai-completions' | 'openai-responses' | 'google-generative-ai';
export type Preset =
  'anthropic' | 'openai' | 'google' | 'openrouter' | 'deepseek' | 'ollama' | 'lmstudio' | 'llamacpp' | 'vllm' | 'relay' | 'custom';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** 思考等级：off = 无思考（Opus 5.5 / Fable 5.2 不能关，自动改用最低强度）；xhigh / max 只对 Claude 开放 */
export type ThinkingLevel = 'off' | Effort;
export const THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];
export const THINKING_LABEL: Record<ThinkingLevel, string> = {
  off: '无思考',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高',
};

/**
 * 上下文模式（省流 / 均衡 / 完整）——一处开关映射到观测粒度、决策门控、决策频率、历史压缩阈值、单次输出上限。
 * 显式填写的 decision.waveIntervalSec / maxOutputTokens / maxToolCallsPerDecision 优先于模式缺省值。
 */
export type ContextMode = 'saver' | 'balanced' | 'full';
export const CONTEXT_MODE_LABEL: Record<ContextMode, string> = { saver: '省流', balanced: '均衡', full: '完整' };

export interface ContextModeSpec {
  /** delta = 首次完整、之后只发变化；full = 每次完整观测 */
  observation: 'delta' | 'full';
  /** 地形没变时每隔几次决策重发一次地图（0 = 只在地形变化时发） */
  mapEvery: number;
  /** 地图行用游程编码（RLE） */
  rleMap: boolean;
  /** 决策门控：aggressive = 钱不够明显的新动作 / 没有危险就不叫模型；normal = 没有买得起的有用动作才跳过；off = 从不跳过 */
  gating: 'aggressive' | 'normal' | 'off';
  /** 波次中定期决策间隔（秒） */
  waveIntervalSec: number;
  /** 决策内历史超过这么多字符后，把较早的工具结果压成一行摘要 */
  compactChars: number;
  maxOutputTokens: number;
  maxToolCalls: number;
  /** 设置面板里的估算（每波折算 token；来自 scripts/agent-tokens.ts 的离线模型，思考等级 低） */
  estTokensPerWave: number;
  /** 一句话说明 */
  desc: string;
}

export const CONTEXT_MODES: Record<ContextMode, ContextModeSpec> = {
  saver: {
    observation: 'delta',
    mapEvery: 0,
    rleMap: true,
    gating: 'aggressive',
    waveIntervalSec: 30,
    compactChars: 6_000,
    maxOutputTokens: 4096,
    maxToolCalls: 6,
    estTokensPerWave: 5_000,
    desc: '只发变化的字段、地图只在地形变化时发；钱不够做新动作且没有危险时不叫模型。适合本机小模型 / 省钱。',
  },
  balanced: {
    observation: 'delta',
    mapEvery: 4,
    rleMap: false,
    gating: 'normal',
    waveIntervalSec: 15,
    compactChars: 16_000,
    maxOutputTokens: 8192,
    maxToolCalls: 8,
    estTokensPerWave: 5_500,
    desc: '首次完整、之后增量；每 4 次决策重发地图；没有买得起的有用动作时跳过。云端模型推荐。',
  },
  full: {
    observation: 'full',
    mapEvery: 1,
    rleMap: false,
    gating: 'off',
    waveIntervalSec: 10,
    compactChars: 40_000,
    maxOutputTokens: 16_000,
    maxToolCalls: 12,
    estTokensPerWave: 11_000,
    desc: '每次完整观测 + 地图，每个决策点都叫模型。最稳，也最贵。',
  },
};

export interface AgentModelConfig {
  provider: ProviderKind;
  /** pi：厂商预设，自动填 api / baseUrl */
  preset?: Preset;
  api?: PiApi;
  baseUrl?: string;
  model: string;
  /** 只在内存里；saveableConfig() 会删掉 */
  apiKey?: string;
  /** native = 模型原生工具调用；json = 让模型输出 JSON 动作列表（不擅长工具调用的小模型） */
  toolMode?: 'native' | 'json';
  /** 旧字段：思考强度（= thinking 的非 off 取值）；新代码用 thinking */
  effort?: Effort;
  /** 思考等级（缺省：中转 低、本机模型 无思考、其他 中）。各厂商的映射见 ./thinking.ts */
  thinking?: ThinkingLevel;
  /** 上下文模式（缺省：本机模型 省流，其他 均衡） */
  contextMode?: ContextMode;
  /** 部分 OpenAI 兼容模型可用；Claude 新模型不接受非默认采样参数，claude-native 会忽略 */
  temperature?: number;
  /** 旧字段：full → contextMode 完整，compact → 省流（contextMode 优先） */
  contextBudget?: 'full' | 'compact';
  /** 每次决策最多的工具调用次数（默认 12） */
  maxToolCallsPerDecision?: number;
  /** 单次模型回复的最大输出 token（默认 claude 16000、其他 4096） */
  maxOutputTokens?: number;
  role?: AgentRole;
  /**
   * 打法辅助（文档 10 §19，缺省开）：act 里的高层意图（maze / build_near / upgrade_best / anti_air / spend / save，由确定性规划器挑格子）、
   * 被拒放置自动挪位、每次决策附战报 / 威胁估算 / 克制 / 闲置金币提醒、提示词的打法要点与开局。false = 旧版（评测基线）。
   */
  assist?: boolean;
  decision?: {
    mode?: DecisionMode;
    /** 波次中每隔多少秒决策（默认 10；小模型建议 20～30） */
    waveIntervalSec?: number;
    /** realtime：每次模型请求让世界前进多少游戏秒；'measured' = 用实测耗时（不确定性，回放仍以日志为准） */
    realtimeLatencySec?: number | 'measured';
  };
  budget?: {
    /** 整局折算 token 上限（新输入 + 输出 + 缓存写×1.25 + 缓存读×0.1，见 types.ts BUDGET_WEIGHTS），超出后余下决策全部由内置机器人接管 */
    tokens?: number;
    /** 整局费用上限（美元，估算） */
    usd?: number;
    /**
     * 超出预算时：soft（默认）= ≥70% 省流、≥90% 再关思考并减少决策点、≥100% 压缩上下文后以最省模式继续（不交给机器人）；
     * hard = 用完后交给内置机器人；ask = 用完时暂停并询问（继续 / 追加 50 万 / 交给机器人）。
     */
    mode?: 'soft' | 'hard' | 'ask';
  };
  /** pi：SDK 层的自动重试次数（缺省用 SDK 默认值 2）；中转服务接口探测时设为 0，失败立刻试下一种接口 */
  maxRetries?: number;
  /** 单次决策超时（毫秒，默认 90000）；超时本次由内置机器人兜底 */
  decisionTimeoutMs?: number;
  /** provider = bridge */
  bridge?: { url: string; code: string };
  /** claude-native：拒答时服务端回退（opus-5-5 / sonnet-5-5 / fable-5-2 默认开） */
  refusalFallback?: boolean;
  /** 浏览器直连托管 API（BYO key）：claude-native 需要 dangerouslyAllowBrowser */
  browser?: boolean;
}

export interface PresetInfo {
  label: string;
  api: PiApi;
  baseUrl: string;
  /** 是否本机服务（不需要 key；浏览器直连需要 CORS） */
  local: boolean;
  defaultModel: string;
  /** 环境变量名（Node 端 pi 自动读取，仅供提示） */
  envKey?: string;
  notes?: string;
}

export const PRESETS: Record<Preset, PresetInfo> = {
  anthropic: {
    label: 'Anthropic',
    api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    local: false,
    defaultModel: 'claude-opus-5-5',
    envKey: 'ANTHROPIC_API_KEY',
  },
  openai: {
    label: 'OpenAI',
    api: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    local: false,
    defaultModel: 'gpt-5-mini',
    envKey: 'OPENAI_API_KEY',
  },
  google: {
    label: 'Google Gemini',
    api: 'google-generative-ai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    local: false,
    defaultModel: 'gemini-2.5-flash',
    envKey: 'GEMINI_API_KEY',
  },
  openrouter: {
    label: 'OpenRouter',
    api: 'openai-completions',
    baseUrl: 'https://openrouter.ai/api/v1',
    local: false,
    defaultModel: 'anthropic/claude-sonnet-4',
    envKey: 'OPENROUTER_API_KEY',
  },
  deepseek: {
    label: 'DeepSeek',
    api: 'openai-completions',
    baseUrl: 'https://api.deepseek.com',
    local: false,
    defaultModel: 'deepseek-chat',
    envKey: 'DEEPSEEK_API_KEY',
  },
  ollama: {
    label: 'Ollama（本机）',
    api: 'openai-completions',
    baseUrl: 'http://localhost:11434/v1',
    local: true,
    defaultModel: 'qwen3:8b',
    notes: '浏览器直连需 OLLAMA_ORIGINS',
  },
  lmstudio: {
    label: 'LM Studio（本机）',
    api: 'openai-completions',
    baseUrl: 'http://localhost:1234/v1',
    local: true,
    defaultModel: 'qwen3-8b',
    notes: '浏览器直连需在 Server 设置里打开 Enable CORS',
  },
  llamacpp: {
    label: 'llama.cpp server（本机）',
    api: 'openai-completions',
    baseUrl: 'http://localhost:8080/v1',
    local: true,
    defaultModel: 'local',
    notes: '启动参数加 --jinja 以启用工具调用',
  },
  vllm: {
    label: 'vLLM（本机）',
    api: 'openai-completions',
    baseUrl: 'http://localhost:8000/v1',
    local: true,
    defaultModel: 'Qwen/Qwen3-8B',
    notes: '需 --enable-auto-tool-choice --tool-call-parser hermes',
  },
  relay: {
    label: '中转服务（OpenAI / Anthropic 兼容）',
    api: 'openai-completions',
    baseUrl: '',
    local: false,
    defaultModel: '',
    notes: '填中转站给你的地址和 Key 即可；请求由浏览器直接发给中转站（不经我们的服务器），中转站必须允许跨域（CORS）',
  },
  custom: { label: '自定义', api: 'openai-completions', baseUrl: 'http://localhost:8000/v1', local: false, defaultModel: '' },
};

export const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'] as const;

export const DEFAULT_CONFIG: AgentModelConfig = {
  provider: 'claude-native',
  model: 'claude-opus-5-5',
  toolMode: 'native',
  role: 'player',
  decision: { mode: 'pause', realtimeLatencySec: 3 },
  decisionTimeoutMs: 90_000,
};

/** 补齐缺省值（预设 → api / baseUrl / model；小模型默认更低频） */
export function resolveConfig(c: Partial<AgentModelConfig>): AgentModelConfig {
  const out: AgentModelConfig = {
    ...DEFAULT_CONFIG,
    ...c,
    decision: { ...DEFAULT_CONFIG.decision, ...c.decision },
    budget: { ...c.budget },
  } as AgentModelConfig;
  if (out.provider === 'pi') {
    const p = PRESETS[out.preset ?? 'custom'];
    out.preset = out.preset ?? 'custom';
    out.api = out.api ?? p.api;
    out.baseUrl = out.baseUrl ?? p.baseUrl;
    if (!c.model) out.model = p.defaultModel;
    if (p.local && c.decision?.waveIntervalSec === undefined) out.decision!.waveIntervalSec = 20;
    // 推理模型的开局决策可能超过 3 分钟（实测 deepseek-flash 开局约 180 秒）；暂停模式下等待不影响局势，放宽到 5 分钟
    if (out.preset === 'relay' && c.decisionTimeoutMs === undefined) out.decisionTimeoutMs = 300_000;
  }
  if (out.provider === 'scripted' && !c.model) out.model = 'scripted-v1';
  const local = isLocalConfig(out);
  // 上下文模式：显式 > 旧 contextBudget > 本机省流 / 其他均衡
  out.contextMode =
    c.contextMode ?? (c.contextBudget === 'compact' ? 'saver' : c.contextBudget === 'full' ? 'full' : local ? 'saver' : 'balanced');
  const spec = CONTEXT_MODES[out.contextMode];
  if (out.decision!.waveIntervalSec === undefined) out.decision!.waveIntervalSec = spec.waveIntervalSec;
  if (out.maxToolCallsPerDecision === undefined) out.maxToolCallsPerDecision = spec.maxToolCalls;
  // 思考等级：显式 thinking > 旧 effort > 中转 低（推理模型默认把输出全花在思考上）/ 本机 无思考 / 其他 中
  out.thinking = c.thinking ?? c.effort ?? (out.preset === 'relay' && out.provider === 'pi' ? 'low' : local ? 'off' : 'medium');
  out.effort = out.thinking === 'off' ? undefined : out.thinking;
  if (out.effort === undefined) delete out.effort;
  return out;
}

/** CLI：--context saver|balanced|full|省流|均衡|完整（旧值 compact → 省流） */
export function parseContextMode(v: string | undefined): ContextMode | undefined {
  if (!v) return undefined;
  const m: Record<string, ContextMode> = {
    saver: 'saver',
    compact: 'saver',
    省流: 'saver',
    balanced: 'balanced',
    均衡: 'balanced',
    full: 'full',
    完整: 'full',
  };
  return m[v.trim().toLowerCase()] ?? m[v.trim()];
}

/** CLI：--thinking off|low|medium|high|xhigh|max（none / 无思考 = off） */
export function parseThinking(v: string | undefined): ThinkingLevel | undefined {
  if (!v) return undefined;
  const x = v.trim().toLowerCase();
  if (x === 'none' || x === '无思考' || x === 'false' || x === '0') return 'off';
  return (THINKING_LEVELS as string[]).includes(x) ? (x as ThinkingLevel) : undefined;
}

/** 本机模型（Ollama / LM Studio / llama.cpp / vLLM） */
export function isLocalConfig(c: Partial<AgentModelConfig>): boolean {
  return c.provider === 'pi' && !!PRESETS[c.preset ?? 'custom']?.local;
}

/** 模式缺省值 + 显式配置 → 本局实际使用的上下文设置 */
export function contextSpec(c: AgentModelConfig): ContextModeSpec {
  const base = CONTEXT_MODES[c.contextMode ?? 'balanced'];
  return {
    ...base,
    maxOutputTokens: c.maxOutputTokens ?? base.maxOutputTokens,
    maxToolCalls: c.maxToolCallsPerDecision ?? base.maxToolCalls,
    waveIntervalSec: c.decision?.waveIntervalSec ?? base.waveIntervalSec,
  };
}

/** 一条配置错误：code 与语言无关（界面按 code 过滤 / 替换），text 是当前语言的说明 */
export interface ConfigIssue {
  code: string;
  text: string;
}

/** 校验配置；返回错误（code + 当前语言文本；空 = 可用） */
export function validateConfigIssues(c: Partial<AgentModelConfig>): ConfigIssue[] {
  const e: ConfigIssue[] = [];
  const add = (code: string, params?: Params) => e.push({ code, text: t(`agent.cfg.err.${code}`, params) });
  const oneOf = (field: string, values: string) => e.push({ code: `oneOf:${field}`, text: t('agent.cfg.err.oneOf', { field, values }) });
  const kinds: ProviderKind[] = ['claude-native', 'pi', 'bridge', 'scripted'];
  if (!c.provider || !kinds.includes(c.provider)) add('provider', { kinds: kinds.join(' / ') });
  if (c.provider !== 'scripted' && c.provider !== 'bridge' && !c.model) add('noModel');
  if (c.provider === 'claude-native' && c.model && !c.model.startsWith('claude-')) add('claudeOnly');
  if (c.preset && !(c.preset in PRESETS)) add('preset', { v: c.preset });
  if (c.api && !['anthropic-messages', 'openai-completions', 'openai-responses', 'google-generative-ai'].includes(c.api))
    add('api', { v: c.api });
  if (c.baseUrl) {
    try {
      const u = new URL(c.baseUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') add('urlProto');
    } catch {
      add('badUrl');
    }
  }
  if (c.provider === 'pi' && c.preset === 'custom' && !c.baseUrl) add('customUrl');
  if (c.provider === 'pi' && c.preset === 'relay') {
    if (!c.baseUrl) add('relayUrl');
    if (c.api === 'google-generative-ai') add('relayApi');
  }
  if (c.provider === 'bridge') {
    if (!c.bridge?.url) add('bridgeUrl');
    else if (!/^wss?:\/\//.test(c.bridge.url)) add('bridgeProto');
    if (!c.bridge?.code) add('bridgeCode');
  }
  if (c.effort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(c.effort)) oneOf('effort', 'low / medium / high / xhigh / max');
  if (c.thinking && !THINKING_LEVELS.includes(c.thinking)) oneOf('thinking', 'off / low / medium / high / xhigh / max');
  if (c.contextMode && !(c.contextMode in CONTEXT_MODES)) oneOf('contextMode', 'saver / balanced / full');
  if (c.toolMode && c.toolMode !== 'native' && c.toolMode !== 'json') oneOf('toolMode', 'native / json');
  if (c.maxToolCallsPerDecision !== undefined && (c.maxToolCallsPerDecision < 1 || c.maxToolCallsPerDecision > 64)) {
    e.push({ code: 'range:maxToolCallsPerDecision', text: t('agent.cfg.err.range', { field: 'maxToolCallsPerDecision', range: '1..64' }) });
  }
  if (c.decision?.mode && c.decision.mode !== 'pause' && c.decision.mode !== 'realtime') oneOf('decision.mode', 'pause / realtime');
  if (c.decision?.waveIntervalSec !== undefined && c.decision.waveIntervalSec < 0) {
    e.push({ code: 'negative:waveIntervalSec', text: t('agent.cfg.err.negative', { field: 'waveIntervalSec' }) });
  }
  if (c.budget?.tokens !== undefined && c.budget.tokens <= 0)
    e.push({ code: 'positive:budget.tokens', text: t('agent.cfg.err.positive', { field: 'budget.tokens' }) });
  if (c.budget?.mode && !['soft', 'hard', 'ask'].includes(c.budget.mode)) oneOf('budget.mode', 'soft / hard / ask');
  if (c.temperature !== undefined && (c.temperature < 0 || c.temperature > 2))
    e.push({ code: 'range:temperature', text: t('agent.cfg.err.range', { field: 'temperature', range: '0..2' }) });
  return e;
}

/** 校验配置；返回当前语言的错误列表（空 = 可用） */
export function validateConfig(c: Partial<AgentModelConfig>): string[] {
  return validateConfigIssues(c).map((x) => x.text);
}

/** 「配置有误：…」异常文本（当前语言） */
export function configErrorMessage(errs: readonly string[]): string {
  return t('agent.cfg.invalid', { errs: errs.join(t('agent.cfg.sep')) });
}

/** 可以保存（localStorage / 文件）的配置：去掉 apiKey 与配对码 */
export function saveableConfig(c: AgentModelConfig): AgentModelConfig {
  const { apiKey: _k, ...rest } = c;
  void _k;
  if (rest.bridge) rest.bridge = { url: rest.bridge.url, code: '' };
  return rest;
}

/** 报告 / 排行榜上的 agent 标记 */
export function agentTag(c: AgentModelConfig): { provider: string; model: string } {
  const provider = c.provider === 'pi' ? `pi:${c.preset ?? 'custom'}` : c.provider;
  return { provider, model: c.model };
}
