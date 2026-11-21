import { t } from '../i18n';
import { localize } from '../config/text';
import { RANDOM_EVENT_IDS, type DifficultyId, type DifficultyParams, type MapId, type RandomEventId, type SpawnMode } from '../core/types';

/** DifficultyParams 里数值型的字段 */
export type NumParamKey = { [K in keyof DifficultyParams]: DifficultyParams[K] extends number ? K : never }[keyof DifficultyParams];

/** 自定义模式的滑块定义（文档 04 §6） */
export interface CustomField {
  key: NumParamKey;
  /** 分组：基础成长 / 动态战场（文档 09） */
  group?: 'dyn';
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  /** 显示格式 */
  fmt: (v: number) => string;
  /** 精英开始波：滑到最大值表示"不出现" */
  offAt?: number;
}

const x = (d: number) => (v: number) => `×${v.toFixed(d)}`;
const pct = (d: number) => (v: number) => `${(v * 100).toFixed(d)}%`;
const int = (v: number) => String(Math.round(v));

export const ELITE_OFF = 1000;

/** 滑块：标签 / 说明走 i18n（core.custom.<key>.label / hint） */
const field = (f: Omit<CustomField, 'label' | 'hint'>): CustomField => localize(f, `core.custom.${f.key}`, ['label', 'hint'] as const);
const spawnMode = (id: SpawnMode) => localize({ id }, `core.spawnMode.${id}`, ['name', 'hint'] as const);

export const CUSTOM_FIELDS: CustomField[] = [
  field({ key: 'startGold', min: 50, max: 600, step: 10, fmt: int }),
  field({ key: 'lives', min: 1, max: 60, step: 1, fmt: int }),
  field({ key: 'hpMul', min: 0.3, max: 6, step: 0.05, fmt: x(2) }),
  field({ key: 'hpLinear', min: 0, max: 0.6, step: 0.01, fmt: pct(0) }),
  field({ key: 'hpExp', min: 1, max: 1.12, step: 0.001, fmt: x(3) }),
  field({ key: 'countMul', min: 0.3, max: 3, step: 0.05, fmt: x(2) }),
  field({ key: 'countGrowth', min: 0, max: 0.3, step: 0.005, fmt: pct(1) }),
  field({ key: 'speedMul', min: 0.5, max: 1.6, step: 0.01, fmt: x(2) }),
  field({ key: 'armorStep', min: 3, max: 40, step: 1, fmt: (v) => t('core.custom.fmt.waves', { n: Math.round(v) }) }),
  field({ key: 'rewardMul', min: 0.3, max: 2.5, step: 0.05, fmt: x(2) }),
  field({ key: 'xpMul', min: 0.3, max: 2.5, step: 0.05, fmt: x(2) }),
  field({
    key: 'eliteStart',
    min: 1,
    max: 101,
    step: 1,
    offAt: 101,
    fmt: (v) => (v >= 101 || v > 999 || v <= 0 ? t('core.custom.fmt.never') : t('core.custom.fmt.waveNo', { n: Math.round(v) })),
  }),
  field({ key: 'eliteRate', min: 0, max: 0.03, step: 0.001, fmt: pct(1) }),
  field({ key: 'eliteCap', min: 0, max: 0.9, step: 0.01, fmt: pct(0) }),
  field({ key: 'maxAffix', min: 0, max: 4, step: 1, fmt: int }),
  field({ key: 'bossHpMul', min: 0.3, max: 5, step: 0.05, fmt: x(2) }),
  field({ key: 'skillCdMul', min: 0.4, max: 2.5, step: 0.02, fmt: x(2) }),
  field({ key: 'interestCap', min: 0, max: 80, step: 1, fmt: int }),
  field({ key: 'scoreMul', min: 0, max: 6, step: 0.1, fmt: x(1) }),
  // ── 文档 09：动态战场 ──
  field({ key: 'maxActiveSpawners', group: 'dyn', min: 1, max: 4, step: 1, fmt: int }),
  field({ key: 'maxDrops', group: 'dyn', min: 0, max: 3, step: 1, fmt: (v) => (v <= 0 ? t('core.custom.fmt.none') : int(v)) }),
  field({ key: 'dropWarn', group: 'dyn', min: 2, max: 8, step: 0.5, fmt: (v) => t('core.custom.fmt.seconds', { n: v.toFixed(1) }) }),
  field({ key: 'eventRate', group: 'dyn', min: 0, max: 3, step: 0.1, fmt: (v) => (v <= 0 ? t('core.custom.fmt.off') : `×${v.toFixed(1)}`) }),
  field({ key: 'eventHostile', group: 'dyn', min: 0, max: 1, step: 0.05, fmt: pct(0) }),
  field({ key: 'waveGap', group: 'dyn', min: 3, max: 30, step: 1, fmt: (v) => t('core.custom.fmt.seconds', { n: Math.round(v) }) }),
  field({ key: 'waveMax', group: 'dyn', min: 20, max: 120, step: 5, fmt: (v) => t('core.custom.fmt.seconds', { n: Math.round(v) }) }),
];

/** 出怪策略（自定义模式可选；fixed 只用于战役编排） */
export const SPAWN_MODES: { id: SpawnMode; name: string; hint: string }[] = [
  spawnMode('roundRobin'),
  spawnMode('random'),
  spawnMode('split'),
  spawnMode('focus'),
];
const SPAWN_MODE_IDS: SpawnMode[] = ['fixed', 'roundRobin', 'random', 'split', 'focus'];
export const isSpawnMode = (v: unknown): v is SpawnMode => typeof v === 'string' && (SPAWN_MODE_IDS as string[]).includes(v);

const roundTo = (v: number, step: number) => {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  return Number((Math.round(v / step) * step).toFixed(decimals + 1));
};

/** 参数 → 滑块值 */
export function sliderValue(f: CustomField, v: number): number {
  if (f.offAt !== undefined && (v > 999 || v <= 0)) return f.offAt;
  return Math.max(f.min, Math.min(f.max, v));
}

/** 滑块值 → 参数 */
export function paramValue(f: CustomField, v: number): number {
  if (f.offAt !== undefined && v >= f.offAt) return ELITE_OFF;
  return roundTo(Math.max(f.min, Math.min(f.max, v)), f.step);
}

/** 把任意输入整理成合法参数（缺失项用 base 补齐） */
export function sanitizeParams(raw: Partial<Record<string, unknown>>, base: DifficultyParams): DifficultyParams {
  const out = { ...base };
  for (const f of CUSTOM_FIELDS) {
    const v = raw[f.key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    out[f.key] = paramValue(f, sliderValue(f, v));
  }
  if (isSpawnMode(raw.spawnMode)) out.spawnMode = raw.spawnMode;
  return out;
}

/** 只保留合法的事件 id，并只记录被关闭（false）的事件 */
export function sanitizeEvents(raw: unknown): Partial<Record<RandomEventId, boolean>> {
  const out: Partial<Record<RandomEventId, boolean>> = {};
  if (Array.isArray(raw)) {
    for (const id of raw) if ((RANDOM_EVENT_IDS as unknown[]).includes(id)) out[id as RandomEventId] = false;
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) if ((RANDOM_EVENT_IDS as string[]).includes(k) && v === false) out[k as RandomEventId] = false;
  }
  return out;
}

// ───────────── 分享码（Base64 JSON） ─────────────

export interface SharePayload {
  params: DifficultyParams;
  map?: MapId;
  base?: DifficultyId;
  /** 被关闭的随机事件（值为 false） */
  events?: Partial<Record<RandomEventId, boolean>>;
  /** 自动开波 */
  autoWave?: boolean;
}

function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export const SHARE_PREFIX = 'DD1:';

export function encodeShare(p: SharePayload): string {
  const body: Record<string, unknown> = { v: 1, p: p.params };
  if (p.map) body.m = p.map;
  if (p.base) body.b = p.base;
  const off = p.events ? RANDOM_EVENT_IDS.filter((id) => p.events?.[id] === false) : [];
  if (off.length) body.e = off;
  if (typeof p.autoWave === 'boolean') body.a = p.autoWave ? 1 : 0;
  return SHARE_PREFIX + toBase64(JSON.stringify(body));
}

export type DecodeResult = { ok: true; value: SharePayload } | { ok: false; reason: string };

export function decodeShare(code: string, base: DifficultyParams): DecodeResult {
  let s = code.trim().replace(/\s+/g, '');
  if (!s) return { ok: false, reason: t('core.share.pasteFirst') };
  if (s.startsWith(SHARE_PREFIX)) s = s.slice(SHARE_PREFIX.length);
  let obj: unknown;
  try {
    obj = JSON.parse(fromBase64(s));
  } catch {
    return { ok: false, reason: t('core.share.badFormat') };
  }
  if (!obj || typeof obj !== 'object') return { ok: false, reason: t('core.share.badContent') };
  const o = obj as Record<string, unknown>;
  // 兼容直接编码参数对象的分享码
  const rawParams = (o.p && typeof o.p === 'object' ? o.p : o) as Record<string, unknown>;
  const hits = CUSTOM_FIELDS.filter((f) => typeof rawParams[f.key] === 'number').length;
  if (hits === 0) return { ok: false, reason: t('core.share.noParams') };
  const value: SharePayload = { params: sanitizeParams(rawParams, base) };
  if (typeof o.m === 'string' && /^ch[123]$/.test(o.m)) value.map = o.m as MapId;
  if (typeof o.b === 'string') value.base = o.b as DifficultyId;
  if (o.e !== undefined) value.events = sanitizeEvents(o.e);
  if (o.a === 0 || o.a === 1 || typeof o.a === 'boolean') value.autoWave = !!o.a;
  return { ok: true, value };
}
