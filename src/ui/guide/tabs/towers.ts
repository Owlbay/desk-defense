/** 图鉴 · 防御塔：列表 + 单座塔的详情页（各形态、数值、特性、分支、进化与神话能力） */
import { ABILITY_META, COMBOS, TIER_NAMES, TOWER_META, type Branch, type TowerId, type TowerInfo } from '../../../core';
import { TOWER_IDS } from '../../../core/types';
import { t } from '../../../i18n';
import { abilityIcon, towerIcon } from '../../assets';
import { h } from '../../dom';
import { G } from '../../icons';
import { icon, rich, section, stat, table, tag, unlockLabel, yesNo, type Entry, type TabContext, type TabModule } from '../kit';
import { towerSheet, type TowerSheet } from '../towerData';

const BRANCHES: Branch[] = ['A', 'B'];
/** 目标策略的名称沿用对局界面的文案（ui.game.target.*），不在图鉴里另写一份 */
const TARGET_MODES = ['first', 'last', 'strong', 'weak', 'close', 'air'] as const;
const isTower = (id: string | undefined): id is TowerId => !!id && (TOWER_IDS as string[]).includes(id);

function link(ctx: TabContext, id: TowerId | undefined, cls: string, ...children: (Node | string)[]): HTMLElement {
  return h(
    `a.${cls}`,
    {
      attrs: { href: id ? `#guide/tower/${id}` : '#guide/tower' },
      onclick: (e: Event) => (e.preventDefault(), ctx.go({ tab: 'tower', item: id })),
    },
    children,
  );
}

function grid(ctx: TabContext): HTMLElement {
  return h(
    'div.guide-tab',
    null,
    rich('p.guide-lead', t('guide.tower.intro')),
    h(
      'div.guide-grid',
      null,
      TOWER_IDS.map((id) => {
        const m = TOWER_META[id];
        return link(
          ctx,
          id,
          'guide-card.card',
          icon(towerIcon(id, 1), 'guide-ico big', 56),
          h('span.guide-card-main', null, h('strong', null, m.name), h('small.muted', null, m.role)),
          h('span.guide-card-side', null, h('span.gi', { html: G.coin, attrs: { 'aria-hidden': 'true' } }), String(m.cost)),
        );
      }),
    ),
    rich('p.muted', t('guide.tower.targets', { list: TARGET_MODES.map((m) => t(`ui.game.target.${m}`)).join(t('guide.listSep')) })),
  );
}

/** 各形态的外观 */
function forms(id: TowerId): HTMLElement {
  if (id === 'wall') {
    return h(
      'div.guide-forms',
      null,
      [1, 2, 3].map((lv) =>
        h(
          'figure.guide-form-fig',
          null,
          icon(towerIcon('wall', 1, null, lv), 'guide-ico big', 64),
          h('figcaption', null, t('guide.tower.col.level', { n: lv })),
        ),
      ),
    );
  }
  const fig = (src: string, caption: string, cls = '') =>
    h(`figure.guide-form-fig${cls}`, null, icon(src, 'guide-ico big', 64), h('figcaption', null, caption));
  return h(
    'div.guide-forms',
    null,
    fig(towerIcon(id, 1), `T1 ${TIER_NAMES[0]}`),
    fig(towerIcon(id, 2), `T2 ${TIER_NAMES[1]}`),
    fig(towerIcon(id, 3), `T3 ${TIER_NAMES[2]}`),
    BRANCHES.map((b) => fig(towerIcon(id, 4, b), `T4 ${TIER_NAMES[3]} ${b}`, `.branch-${b.toLowerCase()}`)),
    BRANCHES.map((b) => fig(towerIcon(id, 5, b), `T5 ${TIER_NAMES[4]} ${b}`, `.branch-${b.toLowerCase()}`)),
  );
}

function statsTable(sheet: TowerSheet): HTMLElement {
  const cols: { label: string; info: TowerInfo }[] =
    sheet.id === 'wall'
      ? sheet.base.map((info) => ({ label: t('guide.tower.col.level', { n: info.level }), info }))
      : [
          { label: t('guide.tower.col.level', { n: 1 }), info: sheet.base[0] },
          ...BRANCHES.flatMap((b) =>
            sheet.legend[b] ? [{ label: t('guide.tower.col.branch', { b }), info: sheet.legend[b] as TowerInfo }] : [],
          ),
        ];
  const labels: string[] = [];
  for (const c of cols) for (const s of c.info.stats) if (!labels.includes(s.label)) labels.push(s.label);
  if (!labels.length) return h('span');
  return table(
    [t('guide.tower.col.stat'), ...cols.map((c) => c.label)],
    labels.map((l) => [l, ...cols.map((c) => c.info.stats.find((s) => s.label === l)?.value ?? t('guide.none'))]),
    '.num',
  );
}

function traits(sheet: TowerSheet): HTMLElement | null {
  const info = sheet.legend.A ?? sheet.base[sheet.base.length - 1];
  const comboDescs = new Set(COMBOS.filter((c) => c.a === sheet.id || c.b === sheet.id).map((c) => c.desc));
  // Lv10 的那条就是分支能力，下面单独展示
  const list = info.traits.filter((tr) => tr.unlockLevel < 10);
  if (!list.length) return null;
  return h(
    'div.guide-rows',
    null,
    list.map((tr) =>
      h(
        'div.guide-row',
        null,
        h(
          'div.guide-row-main',
          null,
          h(
            'div.guide-row-title',
            null,
            h('strong', null, tr.name),
            tag(comboDescs.has(tr.desc) ? t('guide.tower.trait.combo') : t('guide.tower.trait.level', { n: tr.unlockLevel })),
          ),
          h('p', null, tr.desc),
        ),
      ),
    ),
  );
}

function branchCard(id: TowerId, b: Branch, info: TowerInfo): HTMLElement {
  const br = info.branches?.[b];
  const ab = ABILITY_META[`${id}_${b.toLowerCase()}`];
  return h(
    `div.guide-branch.branch-${b.toLowerCase()}`,
    null,
    h(
      'div.guide-branch-head',
      null,
      icon(towerIcon(id, 4, b), 'guide-ico big', 56),
      h('div', null, h('span.guide-kicker', null, t('guide.tower.branch', { b })), h('h4.guide-h4', null, br?.name ?? '')),
    ),
    h('p', null, br?.desc ?? ''),
    info.evoTraits.length
      ? h(
          'ul.guide-list.tight',
          null,
          info.evoTraits.map((tr) => h('li', null, h('strong', null, tr.name), ' — ', tr.desc)),
        )
      : null,
    ab
      ? h(
          'div.guide-ability',
          null,
          icon(abilityIcon(id, b), 'guide-ico', 44),
          h(
            'div.guide-row-main',
            null,
            h('span.guide-kicker', null, t('guide.tower.mythic', { form: ab.form })),
            h(
              'div.guide-row-title',
              null,
              h('strong', null, `${t('guide.tower.ability')} · ${ab.name}`),
              tag(ab.chargeWaves ? t('guide.tower.ability.charge', { n: ab.chargeWaves }) : t('guide.tower.ability.cd', { n: ab.cd })),
            ),
            h('p', null, ab.desc),
          ),
          icon(towerIcon(id, 5, b), 'guide-ico big', 56),
        )
      : null,
  );
}

function detail(ctx: TabContext, id: TowerId): HTMLElement {
  const m = TOWER_META[id];
  const sheet = towerSheet(id);
  const i = TOWER_IDS.indexOf(id);
  const prev = TOWER_IDS[(i - 1 + TOWER_IDS.length) % TOWER_IDS.length];
  const next = TOWER_IDS[(i + 1) % TOWER_IDS.length];

  const head = h(
    'header.guide-detail-head.card',
    { data: { item: id }, attrs: { id: `guide-${id}`, tabindex: '-1' } },
    icon(towerIcon(id, 1), 'guide-ico hero', 88),
    h(
      'div.guide-detail-main',
      null,
      h('h2.guide-h1', null, m.name),
      h('p.guide-role', null, m.role),
      h('p', null, m.desc),
      h(
        'div.guide-stats',
        null,
        stat(t('guide.tower.cost'), String(m.cost)),
        stat(t('guide.tower.ground'), yesNo(m.hitsGround)),
        stat(t('guide.tower.air'), yesNo(m.hitsAir)),
        stat(t('guide.tower.unlock'), unlockLabel(m.unlock)),
      ),
    ),
  );

  const body: (HTMLElement | null)[] = [
    section(`${id}-forms`, id === 'wall' ? t('guide.tower.forms.wall') : t('guide.tower.forms'), forms(id)),
  ];
  if (!sheet) body.push(h('p.muted', null, t('guide.tower.computeFail')));
  else {
    body.push(
      section(
        `${id}-stats`,
        t('guide.tower.stats'),
        statsTable(sheet),
        h('p.muted', null, t('guide.tower.stats.note')),
        sheet.legendCost ? h('p.muted', null, t('guide.tower.legendCost', { n: sheet.legendCost })) : null,
      ),
    );
    const tr = traits(sheet);
    if (tr) body.push(section(`${id}-traits`, t('guide.tower.traits'), tr));
    const legends = BRANCHES.filter((b) => sheet.legend[b]);
    if (legends.length) {
      body.push(
        section(
          `${id}-branches`,
          t('guide.tower.branches'),
          h(
            'div.guide-branches',
            null,
            legends.map((b) => branchCard(id, b, sheet.legend[b] as TowerInfo)),
          ),
        ),
      );
    }
  }

  const nav = h(
    'nav.guide-pager',
    { attrs: { 'aria-label': t('guide.tab.tower') } },
    link(ctx, prev, 'btn.small', `‹ ${TOWER_META[prev].name}`),
    link(ctx, undefined, 'btn.small', t('guide.backToList')),
    link(ctx, next, 'btn.small', `${TOWER_META[next].name} ›`),
  );
  return h(
    'div.guide-tab.guide-detail',
    null,
    link(ctx, undefined, 'guide-back', h('span.gi', { html: G.back, attrs: { 'aria-hidden': 'true' } }), t('guide.backToList')),
    head,
    body,
    nav,
  );
}

export const towerTab: TabModule = {
  entries(): Entry[] {
    return TOWER_IDS.map((id) => {
      const m = TOWER_META[id];
      const abilities = BRANCHES.map((b) => ABILITY_META[`${id}_${b.toLowerCase()}`]).filter(Boolean);
      return {
        tab: 'tower',
        id,
        title: m.name,
        text: [m.role, m.desc, ...abilities.flatMap((a) => [a.form, a.name, a.desc])].join(' '),
        icon: towerIcon(id, 1),
      };
    });
  },
  render(ctx: TabContext): HTMLElement {
    return isTower(ctx.item) ? detail(ctx, ctx.item) : grid(ctx);
  },
};
