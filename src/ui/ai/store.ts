/**
 * 「AI 参战」设置的保存：只存不含密钥的部分（saveableConfig 的结果 + 界面选项）。
 * API Key 另行处理：默认只在内存；可选 sessionStorage（关标签页即清除）或 localStorage（不推荐，玩家显式选择）。
 */
import type { AgentModelConfig, ContextMode, PiApi, Preset, ThinkingLevel } from '../../agent/config';
import type { RelayApi } from '../../agent/relay';
import type { DifficultyId, MapId } from '../../core/types';
import { safeStorage } from '../../meta/storage';
import type { AiRole } from './launch';

export const AI_SETUP_KEY = 'desk-defense.ai.setup.v1';
/** AI 对战（文档 10 §2.3）：进攻方模型的设置（与上面同形，只用模型相关字段） */
export const AI_DUEL_ATTACKER_KEY = 'desk-defense.ai.duel-attacker.v1';
const KEY_PREFIX = 'desk-defense.ai.key.';
/** 模型渠道（多渠道多模型）：防守方 / 进攻方的设置共用这一份列表 */
export const AI_CHANNELS_KEY = 'desk-defense.ai.channels.v1';

/** 模型来源：离线演示 / Claude 官方 SDK / pi 的各个预设 */
export type AiSource = 'demo' | 'claude' | Preset;
export type KeyMode = 'memory' | 'session' | 'local';

export interface PerSource {
  model?: string;
  baseUrl?: string;
  api?: PiApi;
  /** 中转服务：接口类型（默认 auto = 自动检测） */
  relayApi?: 'auto' | RelayApi;
  /** 中转服务：上次自动检测的结果（不含 Key）。for = 规范化地址 + '|' + 模型，换地址 / 模型后失效 */
  detected?: { api: RelayApi; for: string };
}

/**
 * 渠道：一个服务地址 + 一把 Key + 若干收藏的模型（例如「packyapi 中转」下面挂 deepseek-flash、deepseek-v4-pro）。
 * id 也是 Key 的存放键（readKey(id)）；从旧设置迁移来的渠道 id = 来源名，旧 Key 原样可用。
 * 不含 Key；per 里不存 model（当前用哪个模型由各自的设置 st.per[source].model 决定）。
 */
export interface AiChannel {
  id: string;
  /** 玩家起的名字；空 = 显示服务商名称 */
  name: string;
  source: Exclude<AiSource, 'demo'>;
  per: Omit<PerSource, 'model'>;
  /** 收藏的模型（按添加顺序） */
  models: string[];
}

export function loadChannels(): AiChannel[] {
  try {
    const raw = safeStorage().get(AI_CHANNELS_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    if (!Array.isArray(v)) return [];
    return v
      .filter((c): c is AiChannel => !!c && typeof c === 'object' && typeof c.id === 'string' && typeof c.source === 'string')
      .map((c) => ({
        id: c.id,
        name: typeof c.name === 'string' ? c.name : '',
        source: c.source,
        per: c.per && typeof c.per === 'object' ? { ...c.per } : {},
        models: Array.isArray(c.models) ? c.models.filter((m): m is string => typeof m === 'string' && !!m.trim()) : [],
      }));
  } catch {
    return [];
  }
}

export function saveChannels(list: readonly AiChannel[]): void {
  try {
    safeStorage().set(AI_CHANNELS_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

export type AiSetupKind = 'defend' | 'attack' | 'duel';

export interface AiSetupSaved {
  v: 1;
  tab: 'direct' | 'bridge';
  role: AiRole;
  /**
   * 「AI 参战」页选的玩法：defend = AI 防守（role：AI 玩家 / 军师）；attack = AI 出题（AI 进攻、你防守）；
   * duel = AI 对战（进攻方模型 vs 防守方模型）。旧设置没有这个字段，按 defend。
   */
  kind?: AiSetupKind;
  source: AiSource;
  /** 当前用的渠道 id（AI_CHANNELS_KEY 里的）；没有 = 旧式「按来源」 */
  channel?: string;
  run: { mode: 'endless' | 'campaign'; map: MapId; difficulty: DifficultyId; abyss: number; pure: boolean; autoWave: boolean };
  /** 每个来源各自记住的模型 / 地址 */
  per: Partial<Record<AiSource, PerSource>>;
  toolMode: 'native' | 'json';
  /** 上下文模式；auto = 本机模型 省流、其他 均衡 */
  contextMode: ContextMode | 'auto';
  /** 思考等级；auto = 中转 低、本机 无思考、其他 中。按模型记住的等级见 thinkingByModel（没记过的模型用这个） */
  thinking: ThinkingLevel | 'auto';
  /** 每个模型各自记住的思考等级（键 = 小写模型名，见 model-config.ts modelKey） */
  thinkingByModel?: Record<string, ThinkingLevel | 'auto'>;
  /** 手填价格（美元 / 百万 token），按模型记住；优先于模型目录（modelinfo.dev） */
  priceByModel?: Record<string, { in: number; out: number; cr?: number; cw?: number }>;
  /** 超出预算时：soft 压缩后继续（默认）/ hard 交给机器人 / ask 暂停并询问 */
  budgetMode: 'soft' | 'hard' | 'ask';
  /** 旧版本保存的字段（读取时迁移） */
  context?: 'full' | 'compact';
  effort?: NonNullable<AgentModelConfig['effort']>;
  decisionMode: 'pause' | 'realtime';
  /** 波次中决策间隔（秒）；null = 按上下文模式（省流 30 / 均衡 15 / 完整 10） */
  waveIntervalSec: number | null;
  budgetTokens: number | null;
  budgetUsd: number | null;
  keyMode: KeyMode;
  bridgeUrl: string;
  /** 上一次开局用的配置（saveableConfig 之后，不含 Key / 配对码），便于排查 */
  lastConfig?: AgentModelConfig;
  /** 中心策略（文档 10 §20）：auto = 让模型选；locked = 不让模型改；notes = 玩家原话 */
  doctrine?: { preset: import('../../agent/doctrine').DoctrinePreset | 'auto'; locked: boolean; notes?: string };
}

export function defaultSetup(): AiSetupSaved {
  return {
    v: 1,
    tab: 'direct',
    role: 'player',
    source: 'demo',
    run: { mode: 'endless', map: 'ch1', difficulty: 'normal', abyss: 1, pure: true, autoWave: true },
    per: {},
    toolMode: 'native',
    contextMode: 'auto',
    thinking: 'auto',
    budgetMode: 'soft',
    decisionMode: 'pause',
    waveIntervalSec: null,
    budgetTokens: 1_000_000,
    budgetUsd: null,
    keyMode: 'memory',
    bridgeUrl: 'ws://127.0.0.1:8787',
  };
}

export function loadSetup(): AiSetupSaved {
  const d = defaultSetup();
  try {
    const raw = safeStorage().get(AI_SETUP_KEY);
    if (!raw) return d;
    const v = JSON.parse(raw) as Partial<AiSetupSaved> | null;
    if (!v || typeof v !== 'object' || v.v !== 1) return d;
    const out: AiSetupSaved = { ...d, ...v, run: { ...d.run, ...(v.run ?? {}) }, per: { ...(v.per ?? {}) } };
    // 迁移旧字段：context compact → 省流；effort → 思考等级（旧版没有"自动"，只迁移非默认值）
    if (v.contextMode === undefined && v.context === 'compact') out.contextMode = 'saver';
    if (v.thinking === undefined && v.effort && v.effort !== 'medium') out.thinking = v.effort;
    // 旧版默认 10 秒：迁移为"按模式"
    if (v.contextMode === undefined && v.waveIntervalSec === 10) out.waveIntervalSec = null;
    delete out.context;
    delete out.effort;
    // 上下文模式不再让玩家选（预算分级会自动收紧）：一律自动
    out.contextMode = 'auto';
    return out;
  } catch {
    return d;
  }
}

/** AI 对战：进攻方模型的设置（没保存过时默认离线演示） */
export function loadAttackerSetup(): AiSetupSaved {
  const d: AiSetupSaved = { ...defaultSetup(), role: 'advisor', source: 'demo', decisionMode: 'pause' };
  try {
    const raw = safeStorage().get(AI_DUEL_ATTACKER_KEY);
    if (!raw) return d;
    const v = JSON.parse(raw) as Partial<AiSetupSaved> | null;
    if (!v || typeof v !== 'object' || v.v !== 1) return d;
    return { ...d, ...v, run: d.run, per: { ...(v.per ?? {}) }, decisionMode: 'pause', contextMode: 'auto' };
  } catch {
    return d;
  }
}

export function saveAttackerSetup(s: AiSetupSaved): void {
  try {
    const clean = JSON.parse(JSON.stringify(s)) as AiSetupSaved;
    delete clean.lastConfig;
    safeStorage().set(AI_DUEL_ATTACKER_KEY, JSON.stringify(clean));
  } catch {
    /* ignore */
  }
}

/** 玩家是否保存过模型设置（从没打开过设置时，对局里的 AI 按钮先问要不要用离线演示） */
export function hasSavedSetup(): boolean {
  try {
    return !!safeStorage().get(AI_SETUP_KEY);
  } catch {
    return false;
  }
}

export function saveSetup(s: AiSetupSaved): void {
  try {
    // 双保险：即使调用方传错，也绝不把 Key / 配对码写进去
    const clean = JSON.parse(JSON.stringify(s)) as AiSetupSaved;
    if (clean.lastConfig) {
      delete (clean.lastConfig as Partial<AgentModelConfig>).apiKey;
      if (clean.lastConfig.bridge) clean.lastConfig.bridge.code = '';
    }
    safeStorage().set(AI_SETUP_KEY, JSON.stringify(clean));
  } catch {
    /* ignore */
  }
}

// ───────────── API Key ─────────────

const mem = new Map<string, string>();
const ss = (): Storage | null => {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null;
  }
};
const ls = (): Storage | null => {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
};

/** 读取某个来源 / 渠道的 Key：内存 → sessionStorage → localStorage */
export function readKey(source: string): string {
  const m = mem.get(source);
  if (m) return m;
  try {
    return ss()?.getItem(KEY_PREFIX + source) ?? ls()?.getItem(KEY_PREFIX + source) ?? '';
  } catch {
    return '';
  }
}

/** 这个来源的 Key 目前存在哪（用于恢复界面上的选项） */
export function keyModeOf(source: string): KeyMode | null {
  try {
    if (ls()?.getItem(KEY_PREFIX + source)) return 'local';
    if (ss()?.getItem(KEY_PREFIX + source)) return 'session';
  } catch {
    /* ignore */
  }
  return mem.has(source) ? 'memory' : null;
}

/** 按玩家选择的方式保存 Key；其它位置的旧副本一律清掉 */
export function writeKey(source: string, key: string, mode: KeyMode): void {
  const k = KEY_PREFIX + source;
  if (key) mem.set(source, key);
  else mem.delete(source);
  try {
    if (mode === 'session' && key) ss()?.setItem(k, key);
    else ss()?.removeItem(k);
  } catch {
    /* 隐私模式等 */
  }
  try {
    if (mode === 'local' && key) ls()?.setItem(k, key);
    else ls()?.removeItem(k);
  } catch {
    /* ignore */
  }
}

export function forgetKey(source: string): void {
  writeKey(source, '', 'memory');
}
