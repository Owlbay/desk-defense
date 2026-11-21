/**
 * 保存的 AI 模型设置（AiSetupSaved，不含 Key）→ 模型配置（AgentModelConfig）。纯函数，无 DOM。
 *
 * 「AI 参战」设置页、设置里的「AI 助手」、对局里的 AI 按钮共用这一份：同一份保存的配置在哪里都一样。
 * Key 按玩家选的存放方式读取（store.readKey），只随配置传给模型服务商。
 */
import {
  type AgentModelConfig,
  normalizeRelayBase,
  parseRelayUrl,
  type PiApi,
  type Preset,
  PRESETS,
  type RelayApi,
  validateConfigIssues,
} from '../../agent';
import { t, tOr } from '../../i18n';
import type { BridgeConn } from './bridge-state';
import type { AiRole } from './launch';
import { type AiSetupSaved, type AiSource, type PerSource, readKey } from './store';

export const SOURCE_ORDER: AiSource[] = [
  'demo',
  'relay',
  'claude',
  'openai',
  'google',
  'openrouter',
  'deepseek',
  'ollama',
  'lmstudio',
  'llamacpp',
  'vllm',
  'anthropic',
  'custom',
];

export const isPreset = (s: AiSource): s is Preset => s !== 'demo' && s !== 'claude';
export const isLocal = (s: AiSource): boolean => isPreset(s) && PRESETS[s].local;
/** 服务商预设的名称：src/agent 里是中文，这里按 id 取本地化文字（没有翻译时用原文） */
export const presetLabel = (s: Preset): string => tOr(`agent.setup.preset.${s}`, PRESETS[s].label);

export const perOf = (st: AiSetupSaved, s: AiSource = st.source): PerSource => (st.per[s] ??= {});
export const modelOf = (st: AiSetupSaved, s: AiSource = st.source): string =>
  s === 'demo' ? 'scripted-v1' : (st.per[s]?.model ?? (s === 'claude' ? 'claude-sonnet-5-5' : PRESETS[s as Preset].defaultModel));
export const baseUrlOf = (st: AiSetupSaved, s: AiSource = st.source): string =>
  isPreset(s) ? (st.per[s]?.baseUrl ?? PRESETS[s].baseUrl) : '';
export const apiOf = (st: AiSetupSaved, s: AiSource = st.source): PiApi | undefined =>
  isPreset(s) ? (st.per[s]?.api ?? PRESETS[s].api) : undefined;

// ── 中转服务 ──
export const relayMode = (st: AiSetupSaved): 'auto' | RelayApi => st.per.relay?.relayApi ?? 'auto';
/** 检测缓存的键：规范化地址 + 模型（换了就要重新检测） */
export const relayFor = (st: AiSetupSaved): string => {
  const u = parseRelayUrl(baseUrlOf(st, 'relay'));
  return u ? `${u.origin}${u.root}|${modelOf(st, 'relay').trim()}` : '';
};
export const relayDetected = (st: AiSetupSaved): RelayApi | undefined => {
  const d = st.per.relay?.detected;
  return d && d.for === relayFor(st) ? d.api : undefined;
};
/** 实际使用的接口：手动选择 > 检测结果 > Chat Completions（尚未检测时的占位） */
export const relayApiNow = (st: AiSetupSaved): RelayApi => {
  const m = relayMode(st);
  return m !== 'auto' ? m : (relayDetected(st) ?? 'openai-completions');
};
export const relayNeedsDetect = (st: AiSetupSaved): boolean =>
  st.tab === 'direct' && st.source === 'relay' && relayMode(st) === 'auto' && !relayDetected(st);

/**
 * 某个角色用的决策方式：AI 参战设置页里由玩家选（decisionMode 原样）；
 * 对局里启用的 AI 军师总是实时（不替玩家暂停游戏）、决策间隔至少 20 秒。
 */
export function decisionFor(
  st: AiSetupSaved,
  role: AiRole,
  perRole = false,
): { mode: 'pause' | 'realtime'; waveIntervalSec: number | null } {
  if (perRole && role === 'advisor') return { mode: 'realtime', waveIntervalSec: Math.max(20, st.waveIntervalSec ?? 20) };
  return { mode: st.decisionMode, waveIntervalSec: st.waveIntervalSec };
}

export interface BuildOpts {
  role: AiRole;
  bridge?: BridgeConn | null;
  /** 按角色决定决策方式（对局中启用 AI 时 true；AI 参战设置页 false：用表单里的选择） */
  perRole?: boolean;
}

/** 表单 / 保存的设置 → 模型配置（含按存放方式读取的 Key） */
export function buildModelConfig(st: AiSetupSaved, o: BuildOpts): Partial<AgentModelConfig> {
  const dec = decisionFor(st, o.role, o.perRole);
  const common: Partial<AgentModelConfig> = {
    role: o.role,
    toolMode: st.toolMode,
    ...(st.contextMode !== 'auto' ? { contextMode: st.contextMode } : {}),
    ...(st.thinking !== 'auto' ? { thinking: st.thinking } : {}),
    decision: { mode: dec.mode, ...(dec.waveIntervalSec !== null ? { waveIntervalSec: dec.waveIntervalSec } : {}) },
    budget: {
      ...(st.budgetTokens ? { tokens: st.budgetTokens } : {}),
      ...(st.budgetUsd ? { usd: st.budgetUsd } : {}),
      mode: st.budgetMode,
    },
  };
  if (st.tab === 'bridge') {
    const b = o.bridge;
    return {
      ...common,
      provider: 'bridge',
      model: b?.provider.model ?? 'bridge',
      bridge: { url: b?.url ?? st.bridgeUrl, code: b?.code ?? '' },
    };
  }
  const s = st.source;
  if (s === 'demo') return { ...common, provider: 'scripted', model: 'scripted-v1' };
  const key = readKey(s).trim();
  if (s === 'claude')
    return { ...common, provider: 'claude-native', model: modelOf(st, s).trim(), browser: true, ...(key ? { apiKey: key } : {}) };
  if (s === 'relay') {
    // 中转服务一律走 pi（不走 Claude 官方 SDK 适配器）；地址按接口类型规范化
    const api = relayApiNow(st);
    const raw = baseUrlOf(st, s).trim();
    return {
      ...common,
      provider: 'pi',
      preset: 'relay',
      api,
      baseUrl: raw ? normalizeRelayBase(raw, api) : '',
      model: modelOf(st, s).trim(),
      browser: true,
      ...(key ? { apiKey: key } : {}),
    };
  }
  return {
    ...common,
    provider: 'pi',
    preset: s,
    api: apiOf(st, s),
    baseUrl: baseUrlOf(st, s).trim(),
    model: modelOf(st, s).trim(),
    browser: true,
    // 本机服务不需要 Key，但 OpenAI 兼容客户端要求非空
    apiKey: key || (PRESETS[s].local ? 'local' : undefined),
  };
}

/** 表单层面的校验（在 validateConfig 之外补上“需要 Key”等） */
export function modelConfigErrors(st: AiSetupSaved, cfg: Partial<AgentModelConfig>, bridge: BridgeConn | null | undefined): string[] {
  const issues = validateConfigIssues(cfg);
  if (st.tab === 'bridge') {
    if (!bridge?.alive) return [t('agent.setup.err.noBridge')];
    return issues.filter((e) => e.code !== 'bridgeCode').map((e) => e.text);
  }
  const drop = new Set<string>();
  const s = st.source;
  const extra: string[] = [];
  if (s !== 'demo' && !isLocal(s) && s !== 'custom' && !readKey(s).trim()) extra.push(t('agent.setup.err.needKey'));
  if (s === 'relay') {
    const raw = baseUrlOf(st, s).trim();
    drop.add('badUrl');
    if (raw && !parseRelayUrl(raw)) extra.push(t('agent.setup.err.badUrl'));
    if (!modelOf(st, s).trim()) {
      drop.add('noModel');
      extra.push(t('agent.setup.err.needModel'));
    }
  }
  return [...issues.filter((e) => !drop.has(e.code)).map((e) => e.text), ...extra];
}

/** 界面上显示的模型名，例如「Claude · claude-sonnet-5-5」 */
export function sourceLabelOf(st: AiSetupSaved, bridge: BridgeConn | null | undefined): string {
  if (st.tab === 'bridge')
    return bridge?.alive ? t('agent.setup.label.bridge', { model: bridge.provider.model }) : t('agent.setup.label.bridgeOff');
  const s = st.source;
  if (s === 'demo') return t('agent.setup.label.demo');
  return `${s === 'claude' ? 'Claude' : presetLabel(s).replace(/\s*[（(].*[）)]/, '')} · ${modelOf(st, s) || t('agent.setup.label.noModel')}`;
}
