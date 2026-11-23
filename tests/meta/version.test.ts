import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LOCALES } from '../../src/i18n';
import { CHANGELOG, compareVersions, entriesBetween, notesOf, parseRemoteVersion } from '../../src/meta/version';

const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as { version: string };

describe('版本号', () => {
  it('compareVersions 按数字比较', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.3', '1.3.0')).toBeLessThan(0);
  });

  it('entriesBetween 取 (from, to] 区间', () => {
    const list = [
      { version: '0.3.0', date: '', notes: { 'zh-CN': ['c'] } },
      { version: '0.2.0', date: '', notes: { 'zh-CN': ['b'] } },
      { version: '0.1.0', date: '', notes: { 'zh-CN': ['a'] } },
    ];
    expect(entriesBetween(list, '0.1.0', '0.3.0').map((e) => e.version)).toEqual(['0.3.0', '0.2.0']);
  });

  it('notesOf 缺语言时回退简体中文', () => {
    expect(notesOf({ notes: { 'zh-CN': ['中'] } }, 'ja')).toEqual(['中']);
  });

  it('parseRemoteVersion 拒绝坏数据', () => {
    expect(parseRemoteVersion(null)).toBeNull();
    expect(parseRemoteVersion({ version: 'abc' })).toBeNull();
    expect(parseRemoteVersion({ version: '1.0.0', changelog: [{ version: '1.0.0' }, 3] })?.changelog).toEqual([]);
  });
});

describe('更新日志 changelog.json', () => {
  it('从新到旧排列、版本号不重复', () => {
    for (let i = 1; i < CHANGELOG.length; i++) {
      expect(compareVersions(CHANGELOG[i - 1].version, CHANGELOG[i].version)).toBeGreaterThan(0);
    }
  });

  it('最新条目不比 package.json 的版本旧（发版后两者相等）', () => {
    expect(compareVersions(CHANGELOG[0].version, pkg.version)).toBeGreaterThanOrEqual(0);
    expect(CHANGELOG.some((e) => e.version === pkg.version) || compareVersions(CHANGELOG[0].version, pkg.version) > 0).toBe(true);
  });

  it('每个条目都有日期和简体中文；写了的其他语言条数一致', () => {
    for (const e of CHANGELOG) {
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.notes['zh-CN'].length).toBeGreaterThan(0);
      for (const l of LOCALES) {
        const n = e.notes[l.id];
        if (n) expect(n.length, `${e.version} ${l.id}`).toBe(e.notes['zh-CN'].length);
      }
    }
  });
});
