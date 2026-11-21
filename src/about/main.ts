/**
 * 介绍页（/about）的脚本：语言切换（?lang= / 游戏里的选择 / 浏览器语言）与浅色 / 深色切换。
 * 页面内容是静态 HTML，这里不渲染任何东西，也不加载游戏代码。
 */
import type { Dict, Locale } from '../i18n';
import { LANG_KEY, loadDict, pickLocale, SOURCE } from './i18n';

type ThemeMode = 'system' | 'light' | 'dark';
/** 与游戏共用（src/ui/theme.ts 的 STORE_KEY） */
const THEME_KEY = 'dd.theme';
const THEME_COLOR = { light: '#E8D5B5', dark: '#2A211C' } as const;
const OG_LOCALE: Record<Locale, string> = { 'zh-CN': 'zh_CN', 'zh-TW': 'zh_TW', en: 'en_US', ja: 'ja_JP' };

const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* 隐私模式：只在本次访问生效 */
    }
  },
};

// ───────────── 语言 ─────────────

interface Slot {
  el: Element;
  key: string;
  /** null = 文本内容；否则是属性名 */
  attr: string | null;
  source: string;
}

/** 页面上所有带翻译的位置，连同它们最初的简体中文（切回简体时恢复） */
function collectSlots(): Slot[] {
  const slots: Slot[] = [];
  for (const el of document.querySelectorAll('[data-i18n]')) {
    slots.push({ el, key: el.getAttribute('data-i18n') ?? '', attr: null, source: el.textContent ?? '' });
  }
  for (const el of document.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of (el.getAttribute('data-i18n-attr') ?? '').split(';')) {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && key) slots.push({ el, key, attr, source: el.getAttribute(attr) ?? '' });
    }
  }
  return slots;
}

const slots = collectSlots();
const sourceText = new Map(slots.map((s) => [s.key, s.source]));
let locale: Locale = SOURCE;
let dict: Dict | null = null;

const tr = (key: string): string => dict?.[key] ?? sourceText.get(key) ?? key;

function applyLocale(): void {
  for (const s of slots) {
    const text = dict?.[s.key] ?? s.source;
    if (s.attr) s.el.setAttribute(s.attr, text);
    else if (s.el.textContent !== text) s.el.textContent = text;
  }
  document.documentElement.lang = locale;
  document.querySelector('meta[property="og:locale"]')?.setAttribute('content', OG_LOCALE[locale]);
  renderTheme();
}

async function setLocale(next: Locale): Promise<void> {
  let d: Dict | null = null;
  try {
    d = await loadDict(next);
  } catch (e) {
    console.error('[about] 语言包加载失败', e);
    return; // 保持当前语言
  }
  locale = next;
  dict = d;
  applyLocale();
}

// ───────────── 外观 ─────────────

const themeBtn = document.querySelector<HTMLButtonElement>('#theme');
const themeLabel = document.querySelector<HTMLElement>('#theme-label');
const darkQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
const readTheme = (): ThemeMode => {
  const v = store.get(THEME_KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
};
let theme = readTheme();

function renderTheme(): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  const dark = theme === 'dark' || (theme === 'system' && !!darkQuery?.matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[dark ? 'dark' : 'light']);
  if (!themeBtn) return;
  themeBtn.hidden = false;
  themeBtn.dataset.mode = theme;
  const label = `${tr('guide.about.theme.label')}: ${tr(`guide.about.theme.${theme === 'system' ? 'auto' : theme}`)}`;
  themeBtn.title = label;
  if (themeLabel) themeLabel.textContent = label;
}

themeBtn?.addEventListener('click', () => {
  theme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
  store.set(THEME_KEY, theme);
  renderTheme();
});
darkQuery?.addEventListener?.('change', renderTheme);

// ───────────── 启动 ─────────────

const select = document.querySelector<HTMLSelectElement>('#lang');
const initial = pickLocale(location.search, store.get(LANG_KEY), navigator.languages ?? [navigator.language]);
if (select) {
  select.value = initial;
  select.addEventListener('change', () => {
    const next = select.value as Locale;
    // 记下来：进游戏时沿用同一种语言；地址也带上 ?lang=，方便分享
    store.set(LANG_KEY, next);
    try {
      const url = new URL(location.href);
      url.searchParams.set('lang', next);
      history.replaceState(null, '', url);
    } catch {
      /* 改不了地址也不影响切换 */
    }
    void setLocale(next);
  });
}
renderTheme();
if (initial !== SOURCE) void setLocale(initial);
