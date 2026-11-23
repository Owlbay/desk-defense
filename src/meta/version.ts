/**
 * 版本号与更新日志（纯数据，不依赖 DOM）。
 *
 * - 当前版本来自 package.json（构建时由 vite.config.ts 注入 __APP_VERSION__；测试 / Node 脚本里没有注入时为 0.0.0）。
 * - 更新日志在 src/meta/changelog.json，最新的在最前；由 `npm run release` 写入，同时用于 GitHub Release 和游戏内展示。
 */
import raw from './changelog.json';

export interface ChangelogEntry {
  version: string;
  /** YYYY-MM-DD */
  date: string;
  /** 各语言的更新条目；缺的语言回退到简体中文 */
  notes: Partial<Record<string, string[]>> & { 'zh-CN': string[] };
}

declare const __APP_VERSION__: string | undefined;

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

export const CHANGELOG: readonly ChangelogEntry[] = raw as ChangelogEntry[];

/** 语义化版本比较：a < b 返回负数，相等 0，a > b 正数（只比较 x.y.z 数字部分） */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[.-]/);
  const pb = b.replace(/^v/, '').split(/[.-]/);
  for (let i = 0; i < 3; i++) {
    const d = (Number(pa[i]) || 0) - (Number(pb[i]) || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 某个版本在指定语言下的更新条目（缺失时回退简体中文） */
export function notesOf(e: Pick<ChangelogEntry, 'notes'>, locale: string): string[] {
  return e.notes[locale] ?? e.notes['zh-CN'] ?? [];
}

/** 版本区间 (from, to] 内的日志条目（新的在前） */
export function entriesBetween(list: readonly ChangelogEntry[], from: string, to: string): ChangelogEntry[] {
  return list.filter((e) => compareVersions(e.version, from) > 0 && compareVersions(e.version, to) <= 0);
}

/** 服务器上的 version.json（构建时生成） */
export interface RemoteVersion {
  version: string;
  date?: string;
  /** 最近若干个版本的日志（新的在前） */
  changelog?: ChangelogEntry[];
}

export function parseRemoteVersion(x: unknown): RemoteVersion | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (typeof o.version !== 'string' || !/^\d+\.\d+\.\d+/.test(o.version)) return null;
  const changelog = Array.isArray(o.changelog)
    ? (o.changelog as unknown[]).filter(
        (e): e is ChangelogEntry =>
          !!e &&
          typeof e === 'object' &&
          typeof (e as ChangelogEntry).version === 'string' &&
          !!(e as ChangelogEntry).notes &&
          Array.isArray((e as ChangelogEntry).notes['zh-CN']),
      )
    : undefined;
  return { version: o.version, date: typeof o.date === 'string' ? o.date : undefined, changelog };
}
