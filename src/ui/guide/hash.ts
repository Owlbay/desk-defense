/** 图鉴深链的解析（纯函数，不依赖 DOM / 界面代码，外壳和测试都用它） */

const HASH_RE = /^#\/?guide(?:\/(.*))?$/;

/** '#guide/tower/pencil' → 'tower/pencil'；'#guide' → ''；不是图鉴深链返回 null */
export function parseGuideHash(hash: string): string | null {
  const m = HASH_RE.exec(hash);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1] ?? '');
  } catch {
    return m[1] ?? '';
  }
}
