/** 图鉴 · 组合技与流派 */
import { COMBOS, TOWER_META, type TowerId } from '../../../core';
import { t } from '../../../i18n';
import { towerIcon } from '../../assets';
import { h } from '../../dom';
import { bullets, type Entry, icon, plain, rich, section, type TabContext, type TabModule } from '../kit';

/** 每套流派的代表塔（只用来配图） */
const ARCHETYPES: { id: string; towers: TowerId[] }[] = [
  { id: 'maze', towers: ['wall', 'stapler', 'compass', 'glue'] },
  { id: 'grow', towers: ['calculator', 'pencil', 'lamp'] },
  { id: 'armor', towers: ['eraser', 'lamp', 'pen', 'stapler'] },
  { id: 'eco', towers: ['piggy', 'calculator'] },
  { id: 'air', towers: ['swatter', 'lamp', 'ruler'] },
  { id: 'rush', towers: ['pencil', 'stapler', 'glue'] },
  { id: 'mythic', towers: ['glue', 'lamp', 'swatter', 'piggy'] },
  { id: 'line', towers: ['ruler', 'compass'] },
  { id: 'prism', towers: ['lamp'] },
];
const PARTS = ['core', 'how', 'weak'] as const;

export const comboTab: TabModule = {
  entries(): Entry[] {
    return [
      ...COMBOS.map((c): Entry => ({
        tab: 'combo',
        id: `combo-${c.a}-${c.b}`,
        title: c.name,
        text: `${TOWER_META[c.a].name} ${TOWER_META[c.b].name} ${c.desc}`,
        icon: towerIcon(c.a, 1),
      })),
      ...ARCHETYPES.map((a): Entry => ({
        tab: 'combo',
        id: `arch-${a.id}`,
        title: t(`guide.arch.${a.id}.name`),
        text: PARTS.map((p) => plain(t(`guide.arch.${a.id}.${p}`))).join(' '),
        icon: towerIcon(a.towers[0], 1),
      })),
    ];
  },
  render(ctx: TabContext): HTMLElement {
    const towerLink = (id: TowerId) =>
      h(
        'a.guide-pair-tower',
        { attrs: { href: `#guide/tower/${id}` }, onclick: (e: Event) => (e.preventDefault(), ctx.go({ tab: 'tower', item: id })) },
        icon(towerIcon(id, 1), 'guide-ico', 44),
        h('span', null, TOWER_META[id].name),
      );
    return h(
      'div.guide-tab',
      null,
      section(
        'combos',
        t('guide.combo.section.combos'),
        rich('p', t('guide.combo.intro')),
        h(
          'div.guide-rows',
          null,
          COMBOS.map((c) =>
            h(
              'div.guide-row.combo',
              { data: { item: `combo-${c.a}-${c.b}` }, attrs: { id: `guide-combo-${c.a}-${c.b}`, tabindex: '-1' } },
              h('div.guide-pair', null, towerLink(c.a), h('span.guide-plus', { attrs: { 'aria-hidden': 'true' } }, '+'), towerLink(c.b)),
              h('div.guide-row-main', null, h('div.guide-row-title', null, h('strong', null, c.name)), h('p', null, c.desc)),
            ),
          ),
        ),
        rich('p', t('guide.combo.vuln')),
      ),
      section('wall', t('guide.combo.section.wall'), bullets('guide.combo.wall')),
      h('h2.guide-h2.bare', null, t('guide.combo.section.archetypes')),
      h(
        'div.guide-entities',
        null,
        ARCHETYPES.map((a) =>
          h(
            'article.guide-entity.card',
            { data: { item: `arch-${a.id}` }, attrs: { id: `guide-arch-${a.id}`, tabindex: '-1' } },
            h(
              'div.guide-entity-head',
              null,
              h('div.guide-entity-title', null, h('h3.guide-h3', null, t(`guide.arch.${a.id}.name`))),
              h(
                'div.guide-arch-icons',
                { attrs: { 'aria-hidden': 'true' } },
                a.towers.map((id) => icon(towerIcon(id, 1), 'guide-ico', 36)),
              ),
            ),
            h(
              'dl.guide-dl',
              null,
              PARTS.map((p) => [h('dt', null, t(`guide.arch.${p}`)), rich('dd', t(`guide.arch.${a.id}.${p}`))]),
            ),
          ),
        ),
      ),
    );
  },
};
