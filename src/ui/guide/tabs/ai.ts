/** 图鉴 · AI 参战：两种角色、三种接入方式 */
import { t } from '../../../i18n';
import { h } from '../../dom';
import { bullets, items, plain, rich, section, type Entry, type TabContext, type TabModule } from '../kit';

const WAYS = ['relay', 'local', 'bridge'] as const;

export const aiTab: TabModule = {
  entries(): Entry[] {
    return [
      { tab: 'ai', id: 'modes', title: t('guide.ai.modes.title'), text: [t('guide.ai.intro'), ...items('guide.ai.modes')].map(plain).join(' ') },
      ...WAYS.map((w): Entry => ({ tab: 'ai', id: w, title: t(`guide.ai.${w}.name`), text: t(`guide.ai.${w}.desc`) })),
      { tab: 'ai', id: 'tips', title: `${t('guide.tab.ai')} · ${t('guide.ai.tips.title')}`, text: items('guide.ai.tips').map(plain).join(' ') },
    ];
  },
  render(ctx: TabContext): HTMLElement {
    return h(
      'div.guide-tab',
      null,
      rich('p.guide-lead', t('guide.ai.intro')),
      section('modes', t('guide.ai.modes.title'), bullets('guide.ai.modes')),
      section(
        'setup',
        t('guide.ai.setup.title'),
        h(
          'div.guide-cards',
          null,
          WAYS.map((w) => h('div.guide-mini', { data: { item: w }, attrs: { id: `guide-${w}`, tabindex: '-1' } }, h('h3.guide-h3', null, t(`guide.ai.${w}.name`)), rich('p', t(`guide.ai.${w}.desc`)))),
        ),
        rich('p.muted', t('guide.ai.demo')),
        h('button.btn.primary', { attrs: { type: 'button' }, onclick: () => ctx.openRoute('ai') }, t('guide.ai.open')),
      ),
      section('tips', t('guide.ai.tips.title'), bullets('guide.ai.tips')),
    );
  },
};
