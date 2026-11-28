import { afterAll, describe, expect, it } from 'vitest';

import { dictOf, loadLocale, type Locale, setLocale } from '../../src/i18n';
import { contextSummary, FEEDBACK_ISSUES_URL, feedbackContext, feedbackCopyText, routeLabel } from '../../src/meta/feedback';
import { FEEDBACK_KINDS } from '../../src/shared/feedback';

const LOCALES: Locale[] = ['zh-CN', 'zh-TW', 'en', 'ja'];
const CJK = /[㐀-鿿豈-﫿぀-ヿ]/;

afterAll(async () => {
  await setLocale('zh-CN');
});

describe('feedback helpers', () => {
  it('route label carries the game mode / map / difficulty', () => {
    expect(routeLabel({ name: 'settings' })).toBe('settings');
    expect(routeLabel({ name: 'game', opts: { mode: 'endless', map: 'ch2', difficulty: 'normal' } })).toBe('game/endless/ch2/normal');
    expect(routeLabel({ name: 'game', opts: { mode: 'campaign', map: 'ch1', difficulty: 'abyss', abyssLevel: 3 } })).toBe(
      'game/campaign/ch1/abyss3',
    );
    expect(routeLabel(null)).toBe('');
  });

  it('context only holds version / locale / screen / route / UA', () => {
    const c = feedbackContext({ name: 'menu' }, { width: 390.4, height: 844, dpr: 3, ua: 'UA\nX' });
    expect(Object.keys(c).sort()).toEqual(['locale', 'route', 'screen', 'ua', 'version']);
    expect(c.screen).toBe('390x844@3');
    expect(c.route).toBe('menu');
    expect(c.ua).toBe('UA X');
    expect(feedbackContext(null, { width: 800, height: 600, dpr: 1, ua: '' }).screen).toBe('800x600');
    expect(contextSummary({ ...c, ua: 'u'.repeat(100) }, 10)).toMatch(/u{10}…$/);
  });

  it('copy text is localized and includes the attached info', async () => {
    const c = feedbackContext({ name: 'settings' }, { width: 375, height: 667, dpr: 2, ua: 'TestUA' });
    await setLocale('en');
    const s = feedbackCopyText({ kind: 'idea', text: ' more maps ', contact: 'me@example.com' }, c);
    expect(s).toContain('[Idea]');
    expect(s).toContain('more maps');
    expect(s).toContain('me@example.com');
    expect(s).toContain('375x667@2');
    expect(s).toContain('UA: TestUA');
    expect(CJK.test(s)).toBe(false);
    expect(feedbackCopyText({ kind: 'bug', text: 'x' }, c)).not.toContain('Contact');
    expect(FEEDBACK_ISSUES_URL).toMatch(/^https:\/\/github\.com\/.+\/issues$/);
  });

  it('every ui.feedback key exists in all four locales', async () => {
    for (const l of LOCALES) await loadLocale(l);
    const src = Object.keys(dictOf('zh-CN')!).filter((k) => k.startsWith('ui.feedback.'));
    for (const k of FEEDBACK_KINDS) expect(src).toContain(`ui.feedback.kind.${k}`);
    expect(src.length).toBeGreaterThan(15);
    for (const l of LOCALES) {
      const d = dictOf(l)!;
      for (const k of src) expect(d[k], `${l} ${k}`).toBeTruthy();
    }
  });
});
