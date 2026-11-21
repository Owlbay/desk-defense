/** 图鉴 · 精英词缀 */
import { AFFIX_IDS } from '../../../config/enemies';
import { AFFIX_META } from '../../../core';
import { t } from '../../../i18n';
import { affixIcon } from '../../assets';
import { h } from '../../dom';
import { bullets, icon, rich, type Entry, type TabContext, type TabModule } from '../kit';

export const affixTab: TabModule = {
  entries(): Entry[] {
    return AFFIX_IDS.map((id) => ({
      tab: 'affix',
      id,
      title: AFFIX_META[id].name,
      text: `${AFFIX_META[id].desc} ${t(`guide.affix.${id}.counter`)}`,
      icon: affixIcon(id),
    }));
  },
  render(_ctx: TabContext): HTMLElement {
    return h(
      'div.guide-tab',
      null,
      rich('p.guide-lead', t('guide.affix.intro')),
      h(
        'div.guide-rows.card',
        null,
        AFFIX_IDS.map((id) =>
          h(
            'div.guide-row',
            { data: { item: id }, attrs: { id: `guide-${id}`, tabindex: '-1' } },
            icon(affixIcon(id), 'guide-ico', 40),
            h(
              'div.guide-row-main',
              null,
              h('div.guide-row-title', null, h('strong', null, AFFIX_META[id].name)),
              h('p', null, AFFIX_META[id].desc),
              h('p.guide-counter', null, h('span.guide-kicker', null, t('guide.affix.counter')), ' ', t(`guide.affix.${id}.counter`)),
            ),
          ),
        ),
      ),
      bullets('guide.affix.note'),
    );
  },
};
