/**
 * 界面语言的选择与保存。
 *
 * 语言写在存档 settings.lang（Locale id；旧存档的 'zh' 视为简体中文）。另外在独立的键里镜像一份，
 * 这样即使存档解析暂时不保留 lang（或玩家清除了存档），语言选择也不会丢。
 */
import { detectLocale, normalizeLocale, type Locale } from '../i18n';
import type { ProfileStore } from '../meta/profile';

export const LANG_KEY = 'desk-defense.lang';

/**
 * 启动时用的语言：存档里选过的 > 镜像键 > 浏览器语言。
 * 旧存档的 'zh' 是以前唯一的默认值（当时没有语言选项），不算玩家的选择：中文浏览器照样检测为 zh-CN。
 */
export function resolveLocale(store: ProfileStore): Locale {
  const raw: unknown = store.get().settings.lang;
  return (raw === 'zh' ? null : normalizeLocale(raw)) ?? normalizeLocale(store.kv.get(LANG_KEY)) ?? detectLocale();
}

/** 保存语言选择（存档 + 镜像键） */
export function rememberLocale(store: ProfileStore, l: Locale): void {
  store.update((p) => {
    (p.settings as { lang: unknown }).lang = l;
  });
  store.kv.set(LANG_KEY, l);
}
