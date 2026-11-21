/**
 * 模型目录（文档 10 §8.6）：每个模型支持的思考档位与价格，数据来自 modelinfo.dev 的快照（./modelinfo.data.json，
 * 由 `npx vite-node scripts/sync-modelinfo.ts` 生成）。纯函数、无 SDK 依赖；只被 AI 分包引用。
 *
 *  - lookupModel(id)：精确 id → 服务商模型 id / 别名 → 去掉厂商前缀（deepseek/、anthropic.、us.…）、日期后缀、[1m] 等再试；
 *    大小写、"." 与 "-" 不敏感。查不到 = null（界面显示通用档位、"价格未知"）。
 *  - thinkingSupport(id)：这个模型可选的思考等级（含"无思考"时带 off）；未收录的模型沿用旧的通用档位。
 *  - clampThinking：把我们的等级落到模型支持的档位上（就近，平局取较低档 = 更省）。
 *  - priceOf / usageCost / estimateWaveCost：手填价格 > 目录价格；缓存读 / 写没公布时按输入价计（保守）。
 */
import type { Effort, ThinkingLevel } from './config';
import DATA from './modelinfo.data.json';
import type { TokenUsage } from './types';

/** 美元 / 百万 token；cr / cw = 缓存读 / 写（null / 缺省 = 按输入价） */
export interface ModelPrice {
  in: number;
  out: number;
  cr?: number | null;
  cw?: number | null;
}

export interface ModelInfo {
  id: string;
  name: string;
  vendor: string;
  context?: number;
  maxOut?: number;
  /** 公布的思考档位（minimal…max）；[] = 支持思考但没公布档位；null = 不支持思考 */
  efforts: string[] | null;
  /** 能否关闭思考 */
  off?: boolean;
  price: ModelPrice | null;
  aliases?: string[];
}

interface Snapshot {
  source: string;
  url: string;
  note: string;
  date: string;
  count: number;
  models: ModelInfo[];
}

const SNAP = DATA as Snapshot;

/** 数据来源与快照日期（界面上标注"数据来自 modelinfo.dev"） */
export const MODELINFO_SOURCE = { name: SNAP.source, url: SNAP.url, date: SNAP.date, count: SNAP.count } as const;

/** 规范化：小写、"." / "_" / 空格 → "-" */
const canon = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[._\s]+/g, '-');

let INDEX: Map<string, ModelInfo> | null = null;
function index(): Map<string, ModelInfo> {
  if (INDEX) return INDEX;
  const m = new Map<string, ModelInfo>();
  // 先放全部正式 id，再放别名：一个模型的 id 永远不会被另一个模型的别名抢走
  for (const x of SNAP.models) if (!m.has(canon(x.id))) m.set(canon(x.id), x);
  for (const x of SNAP.models) for (const a of x.aliases ?? []) if (!m.has(canon(a))) m.set(canon(a), x);
  INDEX = m;
  return m;
}

const REGION_RE = /^(us|eu|apac|ap|global|in|jp|au|ca)\./;
const VENDOR_DOT_RE = /^(anthropic|openai|google|meta|amazon|mistral|deepseek|qwen|moonshotai|zai|cohere|minimax)\./;
const DATE_RE = /-(\d{4}-\d{2}-\d{2}|\d{8}|\d{6}|\d{4})$/;

/** 一个用户填写的模型名 → 依次尝试的候选写法 */
export function modelIdCandidates(id: string): string[] {
  const out: string[] = [];
  const add = (s: string): void => {
    const c = canon(s);
    if (c && !out.includes(c)) out.push(c);
  };
  let s = id.trim().toLowerCase();
  if (!s) return out;
  add(s);
  s = s.replace(/\[[^\]]*\]$/, ''); // claude-opus-5-5[1m]
  add(s);
  s = s.replace(/@.*$/, ''); // Vertex：claude-x@20250101
  add(s);
  if (s.includes('/')) {
    s = s.slice(s.lastIndexOf('/') + 1); // deepseek/deepseek-flash、openrouter 的 vendor/model
    add(s);
  }
  s = s.replace(REGION_RE, '');
  add(s);
  s = s.replace(VENDOR_DOT_RE, ''); // anthropic.claude-…（Bedrock）
  add(s);
  if (s.includes(':')) {
    add(s.replace(/:/g, '-')); // Ollama：qwen3:8b → qwen3-8b
    s = s.replace(/:.*$/, ''); // OpenRouter：…:free / :thinking
    add(s);
  }
  for (let i = 0; i < 3; i++) {
    const t = s.replace(/-(latest|thinking|nothinking|non-thinking|reasoning)$/, '').replace(DATE_RE, '');
    if (t === s) break;
    s = t;
    add(s);
  }
  return out;
}

/** 查模型；查不到返回 null */
export function lookupModel(id: string | undefined | null): ModelInfo | null {
  if (!id) return null;
  const idx = index();
  for (const c of modelIdCandidates(id)) {
    const hit = idx.get(c);
    if (hit) return hit;
  }
  return null;
}

// ───────────────────────── 思考档位 ─────────────────────────

const ON_LEVELS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const isClaude = (id: string): boolean => /(^|[/.])claude-/i.test(id);
/** 这些模型目录里没写"可关闭"，但我们的适配器知道怎么关（thinking.ts）：Sonnet 5.5 between_tools、Haiku 5.5 disabled、
 *  DeepSeek {thinking:{type:'disabled'}}、Qwen enable_thinking:false */
const KNOWN_OFF = /sonnet-5-5|haiku-5-5|deepseek|qwen/i;

export interface ThinkingSupport {
  /** 目录里查到了这个模型 */
  known: boolean;
  /** 支持思考 */
  reasoning: boolean;
  /** 可选的等级（能关时含 off，顺序从低到高） */
  levels: ThinkingLevel[];
  /** 目录里的原始档位（minimal / none 等我们不单独提供的档位也在内） */
  efforts: string[];
}

/** 通用档位（未收录的模型，沿用旧行为：Claude 有 很高 / 最高） */
export function genericLevels(model: string): ThinkingLevel[] {
  return isClaude(model) ? ['off', ...ON_LEVELS] : ['off', 'low', 'medium', 'high'];
}

export function thinkingSupport(model: string, info: ModelInfo | null = lookupModel(model)): ThinkingSupport {
  if (!info) return { known: false, reasoning: true, levels: genericLevels(model), efforts: [] };
  if (info.efforts === null) return { known: true, reasoning: false, levels: ['off'], efforts: [] };
  let on: ThinkingLevel[] = ON_LEVELS.filter((l) => info.efforts!.includes(l));
  // 只公布了 minimal（或没公布档位）：按通用 低 / 中 / 高 发送
  if (!on.length) on = info.efforts.includes('minimal') && info.efforts.length === 1 ? ['low'] : ['low', 'medium', 'high'];
  const off = !!info.off || KNOWN_OFF.test(info.id);
  return { known: true, reasoning: true, levels: off ? ['off', ...on] : on, efforts: info.efforts };
}

const ORDER: ThinkingLevel[] = ['off', ...ON_LEVELS];

/**
 * 把等级落到可选档位上：有就原样；off 不可选 → 最低档；否则取最近的档位（平局取较低档）。
 * levels 为空（不该发生）时原样返回。
 */
export function clampThinking(level: ThinkingLevel, levels: readonly ThinkingLevel[]): ThinkingLevel {
  if (!levels.length || levels.includes(level)) return level;
  const on = levels.filter((l) => l !== 'off');
  if (!on.length) return 'off';
  if (level === 'off') return on[0];
  const i = ORDER.indexOf(level);
  let best = on[0];
  let dist = Infinity;
  for (const l of on) {
    const d = Math.abs(ORDER.indexOf(l) - i);
    if (d < dist) {
      dist = d;
      best = l;
    }
  }
  return best;
}

// ───────────────────────── 价格 ─────────────────────────

/** 价格：手填 > 目录；都没有 = null */
export function priceOf(model: string, override?: ModelPrice | null): ModelPrice | null {
  if (override && override.in >= 0 && override.out >= 0 && (override.in > 0 || override.out > 0)) return override;
  return lookupModel(model)?.price ?? null;
}

/** pi 的 Model.cost 形状（美元 / 百万 token）；缓存读 / 写没公布时按输入价 */
export function piCost(p: ModelPrice): { input: number; output: number; cacheRead: number; cacheWrite: number } {
  return { input: p.in, output: p.out, cacheRead: p.cr ?? p.in, cacheWrite: p.cw ?? p.in };
}

/** 一段用量的费用（美元） */
export function usageCost(u: TokenUsage, p: ModelPrice): number {
  const c = piCost(p);
  return (u.inputTokens * c.input + u.outputTokens * c.output + u.cacheReadTokens * c.cacheRead + u.cacheWriteTokens * c.cacheWrite) / 1e6;
}

/**
 * 每波折算 token（CONTEXT_MODES.estTokensPerWave）→ 大约多少美元。
 * 折算 token 的构成取自离线 token 模型（scripts/token-model.ts，思考"低"）：约 15% 新输入、75% 输出、
 * 其余是缓存读（按 ×0.1 折算，所以原始缓存读 ≈ 折算总数的 1 倍）。
 */
export const WAVE_SPLIT = { input: 0.15, output: 0.75, cacheRead: 1.0 } as const;
export function estimateWaveCost(weightedTokens: number, p: ModelPrice): number {
  const c = piCost(p);
  const w = weightedTokens;
  return (w * WAVE_SPLIT.input * c.input + w * WAVE_SPLIT.output * c.output + w * WAVE_SPLIT.cacheRead * c.cacheRead) / 1e6;
}
