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

export const CUSTOM_FIELDS: CustomField[] = [
  { key: 'startGold', label: '初始金币', hint: '开局持有的金币', min: 50, max: 600, step: 10, fmt: int },
  { key: 'lives', label: '初始生命', hint: '漏怪扣除的生命', min: 1, max: 60, step: 1, fmt: int },
  { key: 'hpMul', label: '生命倍率', hint: '敌人生命的基础倍率', min: 0.3, max: 6, step: 0.05, fmt: x(2) },
  { key: 'hpLinear', label: '生命线性成长', hint: '每波生命线性增加', min: 0, max: 0.6, step: 0.01, fmt: pct(0) },
  { key: 'hpExp', label: '生命指数成长', hint: '每波生命乘以该值', min: 1, max: 1.12, step: 0.001, fmt: x(3) },
  { key: 'countMul', label: '数量倍率', hint: '每波敌人数量的基础倍率', min: 0.3, max: 3, step: 0.05, fmt: x(2) },
  { key: 'countGrowth', label: '数量成长', hint: '每波数量线性增加', min: 0, max: 0.3, step: 0.005, fmt: pct(1) },
  { key: 'speedMul', label: '速度倍率', hint: '敌人移动速度', min: 0.5, max: 1.6, step: 0.01, fmt: x(2) },
  { key: 'armorStep', label: '护甲间隔', hint: '每隔多少波护甲 +1', min: 3, max: 40, step: 1, fmt: (v) => `${Math.round(v)} 波` },
  { key: 'rewardMul', label: '赏金倍率', hint: '击杀获得的金币', min: 0.3, max: 2.5, step: 0.05, fmt: x(2) },
  { key: 'xpMul', label: '经验倍率', hint: '塔获得的经验', min: 0.3, max: 2.5, step: 0.05, fmt: x(2) },
  {
    key: 'eliteStart',
    label: '精英出现波',
    hint: '精英从第几波开始出现',
    min: 1,
    max: 101,
    step: 1,
    offAt: 101,
    fmt: (v) => (v >= 101 || v > 999 || v <= 0 ? '不出现' : `第 ${Math.round(v)} 波`),
  },
  { key: 'eliteRate', label: '精英概率增长', hint: '每波精英概率增加', min: 0, max: 0.03, step: 0.001, fmt: pct(1) },
  { key: 'eliteCap', label: '精英概率上限', hint: '精英概率最多到多少', min: 0, max: 0.9, step: 0.01, fmt: pct(0) },
  { key: 'maxAffix', label: '词缀上限', hint: '每个精英最多几条词缀', min: 0, max: 4, step: 1, fmt: int },
  { key: 'bossHpMul', label: 'Boss 生命倍率', hint: 'Boss 额外生命倍率', min: 0.3, max: 5, step: 0.05, fmt: x(2) },
  { key: 'skillCdMul', label: '技能冷却倍率', hint: '主动技能的冷却时间', min: 0.4, max: 2.5, step: 0.02, fmt: x(2) },
  { key: 'interestCap', label: '利息上限', hint: '每波利息最多多少金币', min: 0, max: 80, step: 1, fmt: int },
  { key: 'scoreMul', label: '得分倍率', hint: '仅影响个人最佳', min: 0, max: 6, step: 0.1, fmt: x(1) },
  // ── 文档 09：动态战场 ──
  { key: 'maxActiveSpawners', group: 'dyn', label: '出生点上限', hint: '同时开放的出生点（含空降）', min: 1, max: 4, step: 1, fmt: int },
  { key: 'maxDrops', group: 'dyn', label: '空降点上限', hint: '同时存在的空降出生点，0 为不空降', min: 0, max: 3, step: 1, fmt: (v) => (v <= 0 ? '无' : int(v)) },
  { key: 'dropWarn', group: 'dyn', label: '空降预警', hint: '空降落地前的预警时间', min: 2, max: 8, step: 0.5, fmt: (v) => `${v.toFixed(1)} 秒` },
  { key: 'eventRate', group: 'dyn', label: '事件频率', hint: '随机事件的频率倍率，0 为关闭', min: 0, max: 3, step: 0.1, fmt: (v) => (v <= 0 ? '关闭' : `×${v.toFixed(1)}`) },
  { key: 'eventHostile', group: 'dyn', label: '坏事件比例', hint: '负面事件所占的比例', min: 0, max: 1, step: 0.05, fmt: pct(0) },
  { key: 'waveGap', group: 'dyn', label: '开波倒计时', hint: '自动开波：本波刷完到下一波', min: 3, max: 30, step: 1, fmt: (v) => `${Math.round(v)} 秒` },
  { key: 'waveMax', group: 'dyn', label: '每波上限时间', hint: '自动开波：超时强制开下一波', min: 20, max: 120, step: 5, fmt: (v) => `${Math.round(v)} 秒` },
];

/** 出怪策略（自定义模式可选；fixed 只用于战役编排） */
export const SPAWN_MODES: { id: SpawnMode; name: string; hint: string }[] = [
  { id: 'roundRobin', name: '轮流', hint: '在开放的出生点之间轮流' },
  { id: 'random', name: '随机', hint: '每个敌人随机挑一个出生点' },
  { id: 'split', name: '包夹', hint: '同一组平均分到各出生点' },
  { id: 'focus', name: '突袭', hint: '整组从同一个随机出生点出来' },
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
  if (!s) return { ok: false, reason: '请先粘贴分享码' };
  if (s.startsWith(SHARE_PREFIX)) s = s.slice(SHARE_PREFIX.length);
  let obj: unknown;
  try {
    obj = JSON.parse(fromBase64(s));
  } catch {
    return { ok: false, reason: '分享码格式不正确' };
  }
  if (!obj || typeof obj !== 'object') return { ok: false, reason: '分享码内容无效' };
  const o = obj as Record<string, unknown>;
  // 兼容直接编码参数对象的分享码
  const rawParams = (o.p && typeof o.p === 'object' ? o.p : o) as Record<string, unknown>;
  const hits = CUSTOM_FIELDS.filter((f) => typeof rawParams[f.key] === 'number').length;
  if (hits === 0) return { ok: false, reason: '分享码里没有难度参数' };
  const value: SharePayload = { params: sanitizeParams(rawParams, base) };
  if (typeof o.m === 'string' && /^ch[123]$/.test(o.m)) value.map = o.m as MapId;
  if (typeof o.b === 'string') value.base = o.b as DifficultyId;
  if (o.e !== undefined) value.events = sanitizeEvents(o.e);
  if (o.a === 0 || o.a === 1 || typeof o.a === 'boolean') value.autoWave = !!o.a;
  return { ok: true, value };
}
