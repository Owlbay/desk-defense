import { describe, expect, it } from 'vitest';

import { BACKUP_KEY, backupSave, readBackup, restoreBackup, swapWithBackup } from '../../src/meta/backup';
import { DUELS_KEY } from '../../src/meta/duels';
import { HISTORY_KEY } from '../../src/meta/history';
import { loadProfile, PROFILE_CORRUPT_KEY, PROFILE_KEY } from '../../src/meta/profile';
import { memoryStorage } from '../../src/meta/storage';

describe('存档备份', () => {
  it('没有存档时不写备份', () => {
    const kv = memoryStorage();
    expect(backupSave('0.3.0', kv)).toBe(false);
    expect(kv.get(BACKUP_KEY)).toBeNull();
  });

  it('备份后能原样恢复', () => {
    const kv = memoryStorage();
    kv.set(PROFILE_KEY, '{"v":1,"currency":{"star":7,"ink":3}}');
    kv.set(HISTORY_KEY, '[]');
    expect(backupSave('0.3.0', kv, 123)).toBe(true);
    expect(readBackup(kv)).toMatchObject({ version: '0.3.0', savedAt: 123 });
    kv.set(PROFILE_KEY, 'broken');
    expect(restoreBackup(kv)).toBe(true);
    expect(kv.get(PROFILE_KEY)).toBe('{"v":1,"currency":{"star":7,"ink":3}}');
    expect(loadProfile(kv).currency.star).toBe(7);
  });

  it('坏掉的备份不会被当成有效备份', () => {
    const kv = memoryStorage();
    kv.set(BACKUP_KEY, '{oops');
    expect(readBackup(kv)).toBeNull();
    expect(restoreBackup(kv)).toBe(false);
  });

  it('读不了的存档原文另存一份，不被默认存档覆盖', () => {
    const kv = memoryStorage();
    kv.set(PROFILE_KEY, '{"v":1,"currency":');
    expect(loadProfile(kv).currency.star).toBe(0);
    expect(kv.get(PROFILE_CORRUPT_KEY)).toBe('{"v":1,"currency":');
  });

  it('从备份恢复是互换：再恢复一次就撤销', () => {
    const kv = memoryStorage();
    kv.set(PROFILE_KEY, 'old');
    backupSave('0.3.0', kv, 1);
    kv.set(PROFILE_KEY, 'new');
    kv.set(DUELS_KEY, 'duels');
    expect(swapWithBackup('0.3.1', kv, 2)).toBe(true);
    expect(kv.get(PROFILE_KEY)).toBe('old');
    expect(kv.get(DUELS_KEY)).toBeNull();
    expect(readBackup(kv)).toMatchObject({ version: '0.3.1', savedAt: 2 });
    expect(swapWithBackup('0.3.1', kv, 3)).toBe(true);
    expect(kv.get(PROFILE_KEY)).toBe('new');
    expect(kv.get(DUELS_KEY)).toBe('duels');
  });

  it('没有备份时不动存档', () => {
    const kv = memoryStorage();
    kv.set(PROFILE_KEY, 'cur');
    expect(swapWithBackup('0.3.1', kv)).toBe(false);
    expect(kv.get(PROFILE_KEY)).toBe('cur');
  });
});
