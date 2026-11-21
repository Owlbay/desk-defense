/**
 * src/shared 的文本钩子。src/shared 同时被 Pages Functions（Cloudflare，非 Vite 构建）引用，
 * 不能直接 import i18n（它依赖 import.meta.glob）。这里放一个可注入的翻译函数：
 *  - 浏览器 / 测试：src/i18n 加载时调用 setSharedTranslator，把 key 交给 i18n（tOr）；
 *  - Functions：没人注册，直接用 fallback（简体中文源文本）并插值。
 * fallback 必须与 zh-CN 词典里同 key 的文本一致（tests/i18n-data.test.ts 校验）。
 */
export type SharedParams = Record<string, string | number>;
export type SharedTranslator = (key: string, fallback: string, params?: SharedParams) => string;

function interpolate(s: string, p?: SharedParams): string {
  if (!p) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in p ? String(p[k]) : m));
}

let translator: SharedTranslator = (_key, fallback, params) => interpolate(fallback, params);

export function setSharedTranslator(fn: SharedTranslator): void {
  translator = fn;
}

/** 取 key 的翻译；未注册翻译器时返回插值后的 fallback */
export function st(key: string, fallback: string, params?: SharedParams): string {
  return translator(key, fallback, params);
}

/** 记录所有 st() 用到的 key → fallback（测试用来校验与 zh-CN 词典一致） */
export const SHARED_FALLBACKS: Record<string, string> = {};
export function stDef(key: string, fallback: string): (params?: SharedParams) => string {
  SHARED_FALLBACKS[key] = fallback;
  return (params) => st(key, fallback, params);
}
