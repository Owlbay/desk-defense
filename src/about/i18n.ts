/**
 * 介绍页（/about）的轻量翻译：只取命名空间 guide 的 `guide.about.*`，不引入 src/i18n（那会把全部简体中文字典和游戏文本带进来）。
 * 字典文件、key 与 `{name}` 插值格式都与 src/i18n 相同，翻译只有一份。
 *
 * 简体中文直接写在 about.html 里（搜索引擎和没开 JS 的访客看到的就是它），所以这里只按需加载其它三种语言；
 * 切回简体中文时恢复页面最初的文字。tests/about.test.ts 校验 about.html 与 zh-CN 字典一致。
 */
import type { Dict, Locale } from '../i18n';

export const ABOUT_LOCALES: readonly Locale[] = ['zh-CN', 'zh-TW', 'en', 'ja'];
export const SOURCE: Locale = 'zh-CN';
/** 游戏保存语言选择的镜像键（src/ui/locale.ts 的 LANG_KEY） */
export const LANG_KEY = 'desk-defense.lang';

const LOADERS = import.meta.glob<{ default: Dict }>(['../i18n/locales/*/guide.ts', '!../i18n/locales/zh-CN/guide.ts']);

export function normalize(v: unknown): Locale | null {
  if (v === 'zh') return SOURCE;
  return typeof v === 'string' ? (ABOUT_LOCALES.find((l) => l.toLowerCase() === v.toLowerCase()) ?? null) : null;
}

/** 浏览器语言 → 支持的语言（规则同 src/i18n 的 detectLocale） */
export function detect(langs: readonly string[]): Locale {
  for (const raw of langs) {
    const l = raw.toLowerCase();
    if (l.startsWith('zh')) return /tw|hk|mo|hant/.test(l) ? 'zh-TW' : SOURCE;
    if (l.startsWith('ja')) return 'ja';
    if (l.startsWith('en')) return 'en';
  }
  return 'en';
}

/** ?lang= > 在游戏里选过的语言 > 浏览器语言 */
export function pickLocale(search: string, stored: string | null, langs: readonly string[]): Locale {
  let fromUrl: string | null = null;
  try {
    fromUrl = new URLSearchParams(search).get('lang');
  } catch {
    /* 忽略畸形的查询串 */
  }
  return normalize(fromUrl) ?? normalize(stored) ?? detect(langs);
}

/** 加载某语言的 guide 字典；简体中文返回 null（文字就在页面里） */
export async function loadDict(l: Locale): Promise<Dict | null> {
  if (l === SOURCE) return null;
  const load = LOADERS[`../i18n/locales/${l}/guide.ts`];
  return load ? (await load()).default : null;
}
