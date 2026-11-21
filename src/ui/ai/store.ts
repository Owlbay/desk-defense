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
  run: { mode: 'endless' | 'campaign'; map: MapId; difficulty: DifficultyId; abyss: number; pure: boolean; autoWave: boolean };
  /** 每个来源各自记住的模型 / 地址 */
  per: Partial<Record<AiSource, PerSource>>;
  toolMode: 'native' | 'json';
  /** 上下文模式；auto = 本机模型 省流、其他 均衡 */
  contextMode: ContextMode | 'auto';
  /** 思考等级；auto = 中转 低、本机 无思考、其他 中 */
  thinking: ThinkingLevel | 'auto';
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
    return { ...d, ...v, run: d.run, per: { ...(v.per ?? {}) }, decisionMode: 'pause' };
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

/** 读取某个来源的 Key：内存 → sessionStorage → localStorage */
export function readKey(source: AiSource): string {
  const m = mem.get(source);
  if (m) return m;
  try {
    return ss()?.getItem(KEY_PREFIX + source) ?? ls()?.getItem(KEY_PREFIX + source) ?? '';
  } catch {
    return '';
  }
}

/** 这个来源的 Key 目前存在哪（用于恢复界面上的选项） */
export function keyModeOf(source: AiSource): KeyMode | null {
  try {
    if (ls()?.getItem(KEY_PREFIX + source)) return 'local';
    if (ss()?.getItem(KEY_PREFIX + source)) return 'session';
  } catch {
    /* ignore */
  }
  return mem.has(source) ? 'memory' : null;
}

/** 按玩家选择的方式保存 Key；其它位置的旧副本一律清掉 */
export function writeKey(source: AiSource, key: string, mode: KeyMode): void {
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

export function forgetKey(source: AiSource): void {
  writeKey(source, '', 'memory');
}
