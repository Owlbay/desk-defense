import { describe, expect, it } from 'vitest';

import { detectLocale, getLocale, normalizeLocale, setLocale, t } from '../src/i18n';

describe('i18n', () => {
  it('detects locales', () => {
    expect(detectLocale(['zh-CN'])).toBe('zh-CN');
    expect(detectLocale(['zh-TW'])).toBe('zh-TW');
    expect(detectLocale(['zh-Hant-HK'])).toBe('zh-TW');
    expect(detectLocale(['ja-JP'])).toBe('ja');
    expect(detectLocale(['en-US'])).toBe('en');
    expect(detectLocale(['fr-FR'])).toBe('en');
    expect(normalizeLocale('zh')).toBe('zh-CN');
    expect(normalizeLocale('xx')).toBeNull();
  });
  it('translates with fallback and interpolation', async () => {
    expect(t('common.ok')).toBe('确定');
    await setLocale('en');
    expect(getLocale()).toBe('en');
    expect(t('common.ok')).toBe('OK');
    expect(t('missing.key')).toBe('missing.key');
    await setLocale('zh-CN');
  });
});
