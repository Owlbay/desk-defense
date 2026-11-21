/**
 * 国际化（i18n）——全项目唯一的翻译入口。纯 TS，不依赖 DOM，core / render / ui / agent 都可以用。
 *
 * 约定：
 *  - 源语言是简体中文（zh-CN）。每条文本有一个稳定的 key，按命名空间分文件：
 *      src/i18n/locales/<locale>/<ns>.ts   →   export default { 'key': '文本', ... } satisfies Dict
 *    命名空间：common（通用词）、ui（界面）、core（核心逻辑产生的提示/原因）、data（塔/敌人/技能/增益/天赋/事件/地图等名称与说明）、
 *    agent（AI 参战界面）、guide（介绍页与图鉴）。新增命名空间时在 NAMESPACES 里登记。
 *  - key 用点分层级：`ui.menu.campaign`、`data.tower.pencil.name`、`core.reason.blocked`。
 *  - 插值：`{name}`，例如 t('ui.gold.gain', { n: 5 }) → "获得 {n} 金币"。
 *  - 复数（主要给英文）：在 en 里写成 'one|other' 两段，用 `{n}` 决定，例如 '{n} wave|{n} waves'。
 *  - 缺失翻译回退：当前语言 → zh-CN → key 本身（开发环境会在控制台提示一次）。
 *  - 简体中文字典打包进主包；其他语言按需动态加载（切换语言或启动检测到时加载）。
 */

import { setSharedTranslator } from '../shared/text';

export type Locale = 'zh-CN' | 'zh-TW' | 'en' | 'ja';
export const LOCALES: { id: Locale; label: string }[] = [
  { id: 'zh-CN', label: '简体中文' },
  { id: 'zh-TW', label: '繁體中文' },
  { id: 'en', label: 'English' },
  { id: 'ja', label: '日本語' },
];
export const SOURCE_LOCALE: Locale = 'zh-CN';

export type Dict = Record<string, string>;
export type Params = Record<string, string | number>;

const NAMESPACES = ['common', 'ui', 'core', 'data', 'agent', 'guide'] as const;
export type Namespace = (typeof NAMESPACES)[number];

// 源语言字典：同步打包（import.meta.glob eager 在 Vite 与 vite-node / vitest 下都可用）
const SOURCE_MODULES = import.meta.glob<{ default: Dict }>('./locales/zh-CN/*.ts', { eager: true });
// 其他语言：按需加载
const LAZY_MODULES = import.meta.glob<{ default: Dict }>(['./locales/*/*.ts', '!./locales/zh-CN/*.ts']);

const dicts = new Map<Locale, Dict>();
dicts.set(SOURCE_LOCALE, mergeModules(SOURCE_MODULES));

let current: Locale = SOURCE_LOCALE;
const listeners = new Set<(l: Locale) => void>();
const warned = new Set<string>();

function mergeModules(mods: Record<string, { default: Dict }>): Dict {
  const out: Dict = {};
  for (const m of Object.values(mods)) Object.assign(out, m.default);
  return out;
}

/** 把浏览器语言映射到支持的语言 */
export function detectLocale(
  langs: readonly string[] = typeof navigator !== 'undefined' ? (navigator.languages ?? [navigator.language]) : [],
): Locale {
  for (const raw of langs) {
    const l = raw.toLowerCase();
    if (l.startsWith('zh')) return /tw|hk|mo|hant/.test(l) ? 'zh-TW' : 'zh-CN';
    if (l.startsWith('ja')) return 'ja';
    if (l.startsWith('en')) return 'en';
  }
  return 'en';
}

/** 兼容旧存档的 lang 值（'zh'） */
export function normalizeLocale(v: unknown): Locale | null {
  if (v === 'zh') return 'zh-CN';
  return LOCALES.some((x) => x.id === v) ? (v as Locale) : null;
}

export function getLocale(): Locale {
  return current;
}

/** 加载某语言的字典（已加载则直接返回） */
export async function loadLocale(l: Locale): Promise<void> {
  if (dicts.has(l)) return;
  const prefix = `./locales/${l}/`;
  const loaders = Object.entries(LAZY_MODULES).filter(([p]) => p.startsWith(prefix));
  const mods = await Promise.all(loaders.map(async ([p, load]) => [p, await load()] as const));
  dicts.set(l, mergeModules(Object.fromEntries(mods)));
}

/** 切换语言：先加载字典，再通知订阅者（界面据此重渲染） */
export async function setLocale(l: Locale): Promise<void> {
  await loadLocale(l);
  if (l === current) return;
  current = l;
  if (typeof document !== 'undefined') document.documentElement.lang = l;
  for (const fn of listeners) fn(l);
}

export function onLocaleChange(fn: (l: Locale) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function interpolate(s: string, p?: Params): string {
  if (!p) return s;
  // 复数：'one|other'，按 n 选择（只有含 '|' 且提供了 n 时生效）
  if (s.includes('|') && typeof p.n === 'number') {
    const [one, other] = s.split('|');
    s = p.n === 1 ? one : (other ?? one);
  }
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in p ? String(p[k]) : m));
}

/** 翻译。找不到时回退源语言，再回退 key 本身 */
export function t(key: string, params?: Params): string {
  const own = dicts.get(current)?.[key];
  if (own !== undefined) return interpolate(own, params);
  const src = dicts.get(SOURCE_LOCALE)?.[key];
  if (src === undefined && !warned.has(key)) {
    warned.add(key);
    if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) console.warn(`[i18n] 缺少 key：${key}`);
  }
  return interpolate(src ?? key, params);
}

/** 有翻译就用翻译，否则用给定的回退文本（用于逐步迁移、或玩家自定义内容） */
export function tOr(key: string, fallback: string, params?: Params): string {
  const has = dicts.get(current)?.[key] ?? dicts.get(SOURCE_LOCALE)?.[key];
  return has === undefined ? interpolate(fallback, params) : t(key, params);
}

/** 本地化的数字格式 */
export function fmtNumber(n: number, opts?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(current, opts).format(n);
}

/** 测试 / 工具用：列出源语言全部 key */
export function sourceKeys(): string[] {
  return Object.keys(dicts.get(SOURCE_LOCALE) ?? {});
}

/** 测试 / 工具用：某语言已加载的字典 */
export function dictOf(l: Locale): Dict | undefined {
  return dicts.get(l);
}

/**
 * 在指定语言下同步执行 fn（不通知订阅者、不改 <html lang>）。用于需要固定语言的场合：
 * AI 参战的提示词 / 工具结果始终用源语言（简体中文），数据文档脚本固定输出中文。
 * 目标语言字典未加载时回退源语言。fn 必须是同步的。
 */
export function withLocale<T>(l: Locale, fn: () => T): T {
  const prev = current;
  current = l;
  try {
    return fn();
  } finally {
    current = prev;
  }
}

/** 源语言（简体中文）文本，不受当前语言影响 */
export function tSource(key: string, params?: Params): string {
  return withLocale(SOURCE_LOCALE, () => t(key, params));
}

// src/shared 不能依赖本模块（Pages Functions 不经 Vite），通过注入的方式让它的文本也走 i18n
setSharedTranslator((key, fallback, params) => tOr(key, fallback, params));

export { NAMESPACES };
