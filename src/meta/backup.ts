/**
 * 升级前的存档备份：换版本时把进度、历史战绩、对战记录原样复制一份到 BACKUP_KEY（只留最近一份）。
 * 在线升级只替换 Service Worker 缓存里的页面和脚本，不会动 localStorage；这份备份是额外的保险，
 * 万一新版本读坏了存档，还能从备份恢复（restoreBackup）。
 *
 * 不备份 AI 设置（里面可能有玩家的模型密钥，不复制第二份）。
 */
import { DUELS_KEY } from './duels';
import { HISTORY_KEY } from './history';
import { PROFILE_KEY } from './profile';
import { type KV, safeStorage } from './storage';

export const BACKUP_KEY = 'desk-defense.backup.v1';

const KEYS = [PROFILE_KEY, HISTORY_KEY, DUELS_KEY] as const;

export interface Backup {
  /** 备份时的游戏版本 */
  version: string;
  savedAt: number;
  data: Partial<Record<(typeof KEYS)[number], string>>;
}

export function readBackup(kv: KV = safeStorage()): Backup | null {
  try {
    const raw = kv.get(BACKUP_KEY);
    if (!raw) return null;
    const b = JSON.parse(raw) as Backup;
    if (!b || typeof b.version !== 'string' || typeof b.data !== 'object' || !b.data) return null;
    return b;
  } catch {
    return null;
  }
}

/** 备份当前存档；没有任何存档时不写。返回是否写成功（空间不够等失败不影响游戏） */
export function backupSave(version: string, kv: KV = safeStorage(), now = Date.now()): boolean {
  const data: Backup['data'] = {};
  for (const k of KEYS) {
    const v = kv.get(k);
    if (v) data[k] = v;
  }
  if (!Object.keys(data).length) return false;
  try {
    return kv.set(BACKUP_KEY, JSON.stringify({ version, savedAt: now, data } satisfies Backup));
  } catch {
    return false;
  }
}

/**
 * 用备份和当前存档互换：备份写回成当前存档，当前存档变成新的备份（标记为 currentVersion）。
 * 所以恢复之后再恢复一次就是撤销。备份里没有的项（比如备份之后才有的对战记录）会从当前存档移除，留在新备份里。
 * 返回是否恢复了。
 */
export function swapWithBackup(currentVersion: string, kv: KV = safeStorage(), now = Date.now()): boolean {
  const b = readBackup(kv);
  if (!b || !KEYS.some((k) => typeof b.data[k] === 'string')) return false;
  const cur: Backup['data'] = {};
  for (const k of KEYS) {
    const v = kv.get(k);
    if (v) cur[k] = v;
  }
  for (const k of KEYS) {
    const v = b.data[k];
    if (typeof v === 'string') kv.set(k, v);
    else kv.remove(k);
  }
  if (Object.keys(cur).length) kv.set(BACKUP_KEY, JSON.stringify({ version: currentVersion, savedAt: now, data: cur } satisfies Backup));
  else kv.remove(BACKUP_KEY);
  return true;
}

/** 从备份恢复（覆盖当前存档，备份保留）；返回是否恢复了 */
export function restoreBackup(kv: KV = safeStorage()): boolean {
  const b = readBackup(kv);
  if (!b) return false;
  let any = false;
  for (const k of KEYS) {
    const v = b.data[k];
    if (typeof v === 'string') any = kv.set(k, v) || any;
  }
  return any;
}
