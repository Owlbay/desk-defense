/**
 * 浅色 / 深色主题。
 *
 *   setTheme('system' | 'light' | 'dark')   设置偏好（'system' = 跟随系统）
 *   getTheme()                              当前偏好
 *   getResolvedTheme()                      实际生效的 'light' | 'dark'
 *   onThemeChange(fn)                       实际主题变化时回调（切换偏好，或跟随系统时系统变了）
 *
 * 做的事：
 *   - 在 <html> 上写 data-theme="light|dark"（跟随系统时去掉这个属性，由 CSS 的 prefers-color-scheme 接管，见 styles/tokens.css）
 *   - 更新 <meta name="theme-color"> 和 <meta name="color-scheme">（浏览器地址栏 / 状态栏颜色）
 *   - 通知棋盘换成夜晚的桌面（render/palette.ts 的 setBoardTheme）
 *   - 把偏好另存一份到 localStorage（dd.theme），下次启动时在读存档之前就能套上，避免闪一下
 *
 * 真正的设置项存在存档里（settings.theme），由 applySettings 调 setTheme 生效。
 */
import { setBoardTheme } from '../render/palette';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_MODES: readonly ThemeMode[] = ['system', 'light', 'dark'];

/** 地址栏 / 状态栏颜色 = 桌面底色（与 tokens.css 的 --bg 一致） */
const THEME_COLOR: Record<ResolvedTheme, string> = { light: '#E8D5B5', dark: '#2A211C' };
const STORE_KEY = 'dd.theme';
const FADE_MS = 200;

let mode: ThemeMode = 'system';
let resolved: ResolvedTheme = 'light';
let installed = false;
let fadeTimer = 0;
const subs = new Set<(t: ResolvedTheme, mode: ThemeMode) => void>();

export function normalizeTheme(v: unknown): ThemeMode {
  return v === 'light' || v === 'dark' ? v : 'system';
}

function systemDark(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

function reducedMotion(): boolean {
  if (typeof document === 'undefined') return true;
  if (document.documentElement.classList.contains('reduce-motion')) return true;
  try {
    return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function setMeta(name: string, content: string): void {
  let el = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.name = name;
    document.head.appendChild(el);
  }
  if (el.content !== content) el.content = content;
}

/** 把当前偏好落到页面上；animate = 是否播 150ms 的颜色过渡 */
function apply(animate: boolean): void {
  const next: ResolvedTheme = mode === 'system' ? (systemDark() ? 'dark' : 'light') : mode;
  const changed = next !== resolved;
  resolved = next;
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    if (changed && animate && !reducedMotion()) {
      root.classList.add('theme-fade');
      window.clearTimeout(fadeTimer);
      fadeTimer = window.setTimeout(() => root.classList.remove('theme-fade'), FADE_MS);
    }
    if (mode === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', mode);
    setMeta('theme-color', THEME_COLOR[next]);
    setMeta('color-scheme', mode === 'system' ? 'light dark' : mode);
  }
  setBoardTheme(next);
  if (changed) for (const fn of [...subs]) fn(next, mode);
}

/** 监听系统深浅色变化（只装一次） */
function install(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  try {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (mode === 'system') apply(true);
    };
    if (mq?.addEventListener) mq.addEventListener('change', onChange);
    else mq?.addListener?.(onChange);
  } catch {
    /* 不支持 matchMedia：只能手动切换 */
  }
}

export function getTheme(): ThemeMode {
  return mode;
}

export function getResolvedTheme(): ResolvedTheme {
  return resolved;
}

/** 设置主题偏好并立即生效。重复设置同一个值没有副作用（applySettings 每次都会调） */
export function setTheme(next: ThemeMode): void {
  const m = normalizeTheme(next);
  install();
  if (m === mode) return;
  mode = m;
  try {
    localStorage.setItem(STORE_KEY, m);
  } catch {
    /* 隐私模式等：忽略 */
  }
  apply(true);
}

/** 实际主题（light / dark）变化时回调；返回取消订阅函数 */
export function onThemeChange(fn: (theme: ResolvedTheme, mode: ThemeMode) => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

// 模块加载时先按上次的偏好套一遍（此时存档还没读），避免启动时闪一下浅色
if (typeof document !== 'undefined') {
  try {
    mode = normalizeTheme(localStorage.getItem(STORE_KEY));
  } catch {
    mode = 'system';
  }
  install();
  apply(false);
}
