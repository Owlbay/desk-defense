import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { detect, normalize, pickLocale } from '../../src/about/i18n';
import en from '../../src/i18n/locales/en/guide';
import ja from '../../src/i18n/locales/ja/guide';
import zhCN from '../../src/i18n/locales/zh-CN/guide';
import zhTW from '../../src/i18n/locales/zh-TW/guide';

const dicts: Record<string, Record<string, string>> = { 'zh-TW': zhTW, en, ja };
const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('guide 命名空间（图鉴 + 介绍页）', () => {
  it('四种语言的 key 完全一致', () => {
    const keys = Object.keys(zhCN).sort();
    for (const [l, d] of Object.entries(dicts)) expect(Object.keys(d).sort(), l).toEqual(keys);
  });

  it('译文保留占位符与加粗标记', () => {
    for (const [l, d] of Object.entries(dicts)) {
      for (const [k, src] of Object.entries(zhCN as Record<string, string>)) {
        // 英文的 'one|other' 复数写法两段各带一份占位符：取第一段比较
        const text = l === 'en' ? d[k].split('|')[0] : d[k];
        expect(placeholders(text), `${l} ${k}`).toEqual(placeholders(src));
        expect((d[k].match(/\*\*/g) ?? []).length % 2, `${l} ${k} 加粗标记要成对`).toBe(0);
        expect(d[k].trim().length, `${l} ${k} 不能为空`).toBeGreaterThan(0);
      }
    }
  });

  it('编号列表连续（.1 .2 .3… 中间不断号）', () => {
    const keys = new Set(Object.keys(zhCN));
    for (const k of keys) {
      const m = /^(.*)\.(\d+)$/.exec(k);
      if (m && Number(m[2]) > 1) expect(keys.has(`${m[1]}.${Number(m[2]) - 1}`), k).toBe(true);
    }
  });
});

describe('介绍页 about.html', () => {
  const html = readFileSync(new URL('../../about.html', import.meta.url), 'utf8');
  const src = zhCN as Record<string, string>;

  it('页面里的简体中文与 zh-CN 字典一致', () => {
    const texts = [...html.matchAll(/<(\w+)\b[^>]*\sdata-i18n="([^"]+)"[^>]*>([^<]*)<\/\1>/g)];
    expect(texts.length).toBeGreaterThan(50);
    for (const [, , key, text] of texts) expect(text.trim(), key).toBe(src[key]);
    // 每个 data-i18n 都被上面的正则覆盖到（元素里不能再嵌套标签）
    expect(texts.length).toBe([...html.matchAll(/\sdata-i18n="/g)].length);
  });

  it('属性上的文字（aria-label、meta content）与 zh-CN 字典一致', () => {
    const tags = [...html.matchAll(/<[^>]*\sdata-i18n-attr="([^"]+)"[^>]*>/g)];
    expect(tags.length).toBeGreaterThan(5);
    for (const [tag, spec] of tags) {
      for (const pair of spec.split(';')) {
        const [attr, key] = pair.split(':').map((s) => s.trim());
        const value = new RegExp(`\\s${attr}="([^"]*)"`).exec(tag)?.[1];
        expect(value, `${key} @${attr}`).toBe(src[key]);
      }
    }
  });

  it('用到的 key 在每种语言里都有', () => {
    const used = new Set([...html.matchAll(/guide\.about\.[\w.]+/g)].map((m) => m[0]));
    for (const k of used) for (const [l, d] of Object.entries(dicts)) expect(d[k], `${l} ${k}`).toBeTruthy();
  });

  it('语言选择：?lang= > 游戏里选过的 > 浏览器语言', () => {
    expect(pickLocale('?lang=ja', 'en', ['zh-CN'])).toBe('ja');
    expect(pickLocale('?lang=zh-tw', null, ['en-US'])).toBe('zh-TW');
    expect(pickLocale('?lang=xx', 'en', ['zh-CN'])).toBe('en');
    expect(pickLocale('', null, ['zh-Hant-HK'])).toBe('zh-TW');
    expect(pickLocale('', null, ['fr-FR'])).toBe('en');
    expect(normalize('zh')).toBe('zh-CN');
    expect(detect(['ja-JP', 'en'])).toBe('ja');
  });
});
