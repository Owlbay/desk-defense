/**
 * 「AI 参战」设置的保存：只存不含密钥的部分（saveableConfig 的结果 + 界面选项）。
 * API Key 另行处理：默认只在内存；可选 sessionStorage（关标签页即清除）或 localStorage（不推荐，玩家显式选择）。
 */
import type { AgentModelConfig, PiApi, Preset } from '../../agent/config';
import type { RelayApi } from '../../agent/relay';
import type { DifficultyId, MapId } from '../../core/types';
import { safeStorage } from '../../meta/storage';
import type { AiRole } from './launch';

export const AI_SETUP_KEY = 'desk-defense.ai.setup.v1';
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

export interface AiSetupSaved {
  v: 1;
  tab: 'direct' | 'bridge';
  role: AiRole;
  source: AiSource;
  run: { mode: 'endless' | 'campaign'; map: MapId; difficulty: DifficultyId; abyss: number; pure: boolean; autoWave: boolean };
  /** 每个来源各自记住的模型 / 地址 */
  per: Partial<Record<AiSource, PerSource>>;
  toolMode: 'native' | 'json';
  context: 'full' | 'compact';
  effort: NonNullable<AgentModelConfig['effort']>;
  decisionMode: 'pause' | 'realtime';
  waveIntervalSec: number;
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
    context: 'full',
    effort: 'medium',
    decisionMode: 'pause',
    waveIntervalSec: 10,
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
    return { ...d, ...v, run: { ...d.run, ...(v.run ?? {}) }, per: { ...(v.per ?? {}) } };
  } catch {
    return d;
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
