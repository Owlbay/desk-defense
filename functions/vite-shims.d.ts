/**
 * 只为类型检查：服务端回放校验（functions/_lib/admin.ts → src/shared/replay-verify.ts）会引入 src/core，
 * 进而引入 src/i18n。i18n 用了 Vite 的 import.meta.glob / import.meta.env，并在运行时判断 navigator / document 是否存在。
 * Functions 的 tsconfig 只有 @cloudflare/workers-types（没有 DOM、没有 vite/client），这里补上最小声明。
 * 运行时：Workers 里 import.meta.glob 不存在，i18n 会退化为空字典（见 src/i18n/index.ts viteGlob）。
 */
interface ImportMeta {
  glob<T>(pattern: string | string[], o: { eager: true }): Record<string, T>;
  glob<T>(pattern: string | string[], o?: { eager?: false }): Record<string, () => Promise<T>>;
  readonly env?: { readonly DEV?: boolean; readonly [k: string]: unknown };
}

declare const navigator: { readonly languages?: readonly string[]; readonly language: string } | undefined;
declare const document: { readonly documentElement: { lang: string } } | undefined;
