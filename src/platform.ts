/**
 * 运行平台探测（文档 07 §2.3）：同一份 dist/ 既跑在浏览器里，也被 Capacitor（iOS / Android）和 Tauri（桌面）原生壳加载。
 * 原生壳里：不注册 Service Worker（应用更新走商店 / 安装包），排行榜 API 要用绝对地址指向线上站点。
 */
export type NativeShell = 'capacitor' | 'tauri';

/** 线上站点：原生壳里页面的 origin 是 capacitor://localhost / tauri://localhost 等，相对路径 /api 找不到后端 */
export const PRODUCTION_ORIGIN = 'https://jjjj.games';

interface ShellGlobals {
  Capacitor?: { isNativePlatform?: () => boolean };
  __TAURI_INTERNALS__?: unknown;
}

export function nativeShell(): NativeShell | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as ShellGlobals;
  if (w.Capacitor?.isNativePlatform?.()) return 'capacitor';
  if (w.__TAURI_INTERNALS__ !== undefined) return 'tauri';
  return null;
}

/** 排行榜等 /api 请求的前缀：网页版同源（空串），原生壳指向线上站点 */
export function apiBaseUrl(): string {
  return nativeShell() ? PRODUCTION_ORIGIN : '';
}
