/** 图鉴 · 常见问题与快捷键 */
import { TOWER_META, type TowerId } from '../../../core';
import { t } from '../../../i18n';
import { h } from '../../dom';
import { rich, section, table, type Entry, type TabContext, type TabModule } from '../kit';

const QUESTIONS = ['save', 'offline', 'resume', 'place', 'air', 'idle', 'cooldown', 'branch', 'autowave', 'friend', 'perf', 'lang'] as const;
/** 数字键 → 塔（与对局内塔栏顺序一致） */
const BUILD_KEYS: [string, TowerId][] = [
  ['1', 'wall'], ['2', 'pencil'], ['3', 'stapler'], ['4', 'glue'], ['5', 'lamp'], ['6', 'compass'],
  ['7', 'eraser'], ['8', 'ruler'], ['9', 'pen'], ['0', 'calculator'], ['-', 'piggy'], ['=', 'swatter'],
];

const keys = (...ks: string[]): HTMLElement => h('span.guide-keys', null, ks.map((k) => h('kbd', null, k)));

export const faqTab: TabModule = {
  entries(): Entry[] {
    return [
      ...QUESTIONS.map((q): Entry => ({ tab: 'faq', id: q, title: t(`guide.faq.${q}.q`), text: t(`guide.faq.${q}.a`) })),
      { tab: 'faq', id: 'shortcuts', title: t('guide.faq.shortcuts.title'), text: '' },
    ];
  },
  render(ctx: TabContext): HTMLElement {
    const s = (k: string) => t(`guide.faq.shortcuts.${k}`);
    return h(
      'div.guide-tab',
      null,
      h(
        'div.guide-faq',
        null,
        QUESTIONS.map((q) => {
          const d = h<HTMLDetailsElement>(
            'details.guide-qa.card',
            { data: { item: q }, attrs: { id: `guide-${q}` } },
            h('summary', null, t(`guide.faq.${q}.q`)),
            rich('p', t(`guide.faq.${q}.a`)),
          );
          if (ctx.item === q) d.open = true;
          return d;
        }),
      ),
      section(
        'shortcuts',
        s('title'),
        table(
          [s('col.key'), s('col.action')],
          [
            ...BUILD_KEYS.map(([k, id]) => [keys(k), t('guide.faq.shortcuts.build', { name: TOWER_META[id].name })]),
            [keys('Q', 'W', 'E', 'R'), s('skills')],
            [keys('T'), s('axis')],
            [keys(s('key.space')), s('space')],
            [keys('F'), s('speed')],
            [keys('P'), s('pause')],
            [keys('U'), s('upgrade')],
            [keys('S'), s('sell')],
            [keys('A'), s('ability')],
            [keys('Esc', s('key.rightClick')), s('esc')],
          ],
        ),
      ),
      // 介绍页是独立页面（/about）：在新标签页打开，不打断当前页面
      h('p.guide-more', null, h('a', { attrs: { href: './about.html', target: '_blank', rel: 'noopener' } }, t('guide.about.link'))),
    );
  },
};
