/**
 * 安全的键值存储：优先使用 localStorage，任何读写异常都吞掉，
 * 不可用时退化为内存存储（游戏照常运行，只是不保存）。
 */
export interface KV {
  get(key: string): string | null;
  set(key: string, value: string): boolean;
  remove(key: string): void;
  /** 是否真正持久化 */
  readonly persistent: boolean;
}

export function memoryStorage(): KV {
  const m = new Map<string, string>();
  return {
    persistent: false,
    get: (k) => (m.has(k) ? (m.get(k) as string) : null),
    set: (k, v) => {
      m.set(k, v);
      return true;
    },
    remove: (k) => {
      m.delete(k);
    },
  };
}

export function safeStorage(): KV {
  let ls: Storage | null;
  try {
    ls = typeof localStorage !== 'undefined' ? localStorage : null;
    if (ls) {
      const probe = '__dd_probe__';
      ls.setItem(probe, '1');
      ls.removeItem(probe);
    }
  } catch {
    ls = null;
  }
  if (!ls) return memoryStorage();
  const fallback = memoryStorage();
  const store = ls;
  return {
    persistent: true,
    get(k) {
      try {
        const v = store.getItem(k);
        return v ?? fallback.get(k);
      } catch {
        return fallback.get(k);
      }
    },
    set(k, v) {
      fallback.set(k, v);
      try {
        store.setItem(k, v);
        return true;
      } catch {
        return false;
      }
    },
    remove(k) {
      fallback.remove(k);
      try {
        store.removeItem(k);
      } catch {
        /* ignore */
      }
    },
  };
}
