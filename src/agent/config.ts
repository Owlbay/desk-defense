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

export type ProviderKind = 'claude-native' | 'pi' | 'bridge' | 'scripted';
export type PiApi = 'anthropic-messages' | 'openai-completions' | 'openai-responses' | 'google-generative-ai';
export type Preset =
  | 'anthropic' | 'openai' | 'google' | 'openrouter' | 'deepseek'
  | 'ollama' | 'lmstudio' | 'llamacpp' | 'vllm' | 'custom';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

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
  effort?: Effort;
  /** 部分 OpenAI 兼容模型可用；Claude 新模型不接受非默认采样参数，claude-native 会忽略 */
  temperature?: number;
  /** full = 完整观测（JSON + 地图）；compact = 去掉地图与次要字段（小模型 / 小上下文） */
  contextBudget?: 'full' | 'compact';
  /** 每次决策最多的工具调用次数（默认 12） */
  maxToolCallsPerDecision?: number;
  /** 单次模型回复的最大输出 token（默认 claude 16000、其他 4096） */
  maxOutputTokens?: number;
  role?: AgentRole;
  decision?: {
    mode?: DecisionMode;
    /** 波次中每隔多少秒决策（默认 10；小模型建议 20～30） */
    waveIntervalSec?: number;
    /** realtime：每次模型请求让世界前进多少游戏秒；'measured' = 用实测耗时（不确定性，回放仍以日志为准） */
    realtimeLatencySec?: number | 'measured';
  };
  budget?: {
    /** 整局 token 上限（输入 + 输出 + 缓存读写），超出后余下决策全部由内置机器人接管 */
    tokens?: number;
    /** 整局费用上限（美元，估算） */
    usd?: number;
  };
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
  anthropic: { label: 'Anthropic', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', local: false, defaultModel: 'claude-opus-5-5', envKey: 'ANTHROPIC_API_KEY' },
  openai: { label: 'OpenAI', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', local: false, defaultModel: 'gpt-5-mini', envKey: 'OPENAI_API_KEY' },
  google: { label: 'Google Gemini', api: 'google-generative-ai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', local: false, defaultModel: 'gemini-2.5-flash', envKey: 'GEMINI_API_KEY' },
  openrouter: { label: 'OpenRouter', api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', local: false, defaultModel: 'anthropic/claude-sonnet-4', envKey: 'OPENROUTER_API_KEY' },
  deepseek: { label: 'DeepSeek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com', local: false, defaultModel: 'deepseek-chat', envKey: 'DEEPSEEK_API_KEY' },
  ollama: { label: 'Ollama（本机）', api: 'openai-completions', baseUrl: 'http://localhost:11434/v1', local: true, defaultModel: 'qwen3:8b', notes: '浏览器直连需 OLLAMA_ORIGINS' },
  lmstudio: { label: 'LM Studio（本机）', api: 'openai-completions', baseUrl: 'http://localhost:1234/v1', local: true, defaultModel: 'qwen3-8b', notes: '浏览器直连需在 Server 设置里打开 Enable CORS' },
  llamacpp: { label: 'llama.cpp server（本机）', api: 'openai-completions', baseUrl: 'http://localhost:8080/v1', local: true, defaultModel: 'local', notes: '启动参数加 --jinja 以启用工具调用' },
  vllm: { label: 'vLLM（本机）', api: 'openai-completions', baseUrl: 'http://localhost:8000/v1', local: true, defaultModel: 'Qwen/Qwen3-8B', notes: '需 --enable-auto-tool-choice --tool-call-parser hermes' },
  custom: { label: '自定义', api: 'openai-completions', baseUrl: 'http://localhost:8000/v1', local: false, defaultModel: '' },
};

export const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'] as const;

export const DEFAULT_CONFIG: AgentModelConfig = {
  provider: 'claude-native',
  model: 'claude-opus-5-5',
  effort: 'medium',
  toolMode: 'native',
  contextBudget: 'full',
  maxToolCallsPerDecision: 12,
  role: 'player',
  decision: { mode: 'pause', waveIntervalSec: 10, realtimeLatencySec: 3 },
  decisionTimeoutMs: 90_000,
};

/** 补齐缺省值（预设 → api / baseUrl / model；小模型默认更低频） */
export function resolveConfig(c: Partial<AgentModelConfig>): AgentModelConfig {
  const out: AgentModelConfig = { ...DEFAULT_CONFIG, ...c, decision: { ...DEFAULT_CONFIG.decision, ...c.decision }, budget: { ...c.budget } } as AgentModelConfig;
  if (out.provider === 'pi') {
    const p = PRESETS[out.preset ?? 'custom'];
    out.preset = out.preset ?? 'custom';
    out.api = out.api ?? p.api;
    out.baseUrl = out.baseUrl ?? p.baseUrl;
    if (!c.model) out.model = p.defaultModel;
    if (p.local && c.decision?.waveIntervalSec === undefined) out.decision!.waveIntervalSec = 20;
  }
  if (out.provider === 'scripted' && !c.model) out.model = 'scripted-v1';
  return out;
}

/** 校验配置；返回中文错误列表（空 = 可用） */
export function validateConfig(c: Partial<AgentModelConfig>): string[] {
  const e: string[] = [];
  const kinds: ProviderKind[] = ['claude-native', 'pi', 'bridge', 'scripted'];
  if (!c.provider || !kinds.includes(c.provider)) e.push(`provider 必须是 ${kinds.join(' / ')}`);
  if (c.provider !== 'scripted' && c.provider !== 'bridge' && !c.model) e.push('缺少 model');
  if (c.provider === 'claude-native' && c.model && !c.model.startsWith('claude-')) e.push('claude-native 只支持 claude-* 模型');
  if (c.preset && !(c.preset in PRESETS)) e.push(`未知预设 ${c.preset}`);
  if (c.api && !['anthropic-messages', 'openai-completions', 'openai-responses', 'google-generative-ai'].includes(c.api)) e.push(`未知 api ${c.api}`);
  if (c.baseUrl) {
    try {
      const u = new URL(c.baseUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') e.push('baseUrl 必须是 http(s)');
    } catch {
      e.push('baseUrl 不是合法 URL');
    }
  }
  if (c.provider === 'pi' && c.preset === 'custom' && !c.baseUrl) e.push('自定义预设需要 baseUrl');
  if (c.provider === 'bridge') {
    if (!c.bridge?.url) e.push('bridge 需要 url（ws://127.0.0.1:端口）');
    else if (!/^wss?:\/\//.test(c.bridge.url)) e.push('bridge url 必须是 ws:// 或 wss://');
    if (!c.bridge?.code) e.push('bridge 需要配对码');
  }
  if (c.effort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(c.effort)) e.push('effort 取值 low / medium / high / xhigh / max');
  if (c.toolMode && c.toolMode !== 'native' && c.toolMode !== 'json') e.push('toolMode 取值 native / json');
  if (c.maxToolCallsPerDecision !== undefined && (c.maxToolCallsPerDecision < 1 || c.maxToolCallsPerDecision > 64)) e.push('maxToolCallsPerDecision 范围 1..64');
  if (c.decision?.mode && c.decision.mode !== 'pause' && c.decision.mode !== 'realtime') e.push('decision.mode 取值 pause / realtime');
  if (c.decision?.waveIntervalSec !== undefined && c.decision.waveIntervalSec < 0) e.push('waveIntervalSec 不能为负');
  if (c.budget?.tokens !== undefined && c.budget.tokens <= 0) e.push('budget.tokens 必须为正');
  if (c.temperature !== undefined && (c.temperature < 0 || c.temperature > 2)) e.push('temperature 范围 0..2');
  return e;
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
