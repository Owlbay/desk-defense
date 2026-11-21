/** 图鉴 · 玩法：新手入门、操作、模式、自动开波、随机事件、动态战场、进化 */
import {
  abyssParams,
  CRATE_OPTIONS,
  DIFFICULTY_PRESETS,
  MAP_META,
  RANDOM_EVENT_META,
  TIER_NAMES,
  type DifficultyParams,
  type MapId,
} from '../../../core';
import { RANDOM_EVENT_IDS } from '../../../core/types';
import { t } from '../../../i18n';
import { diffLabel } from '../../../meta/progress';
import { art, towerIcon } from '../../assets';
import { h } from '../../dom';
import { bullets, icon, items, plain, rich, section, table, tag, type Entry, type TabContext, type TabModule } from '../kit';

const SECTIONS = ['start', 'controls', 'modes', 'autowave', 'events', 'field', 'evolve'] as const;
const CONTROL_ROWS = ['build', 'place', 'cancel', 'upgrade', 'skill', 'wave', 'speed', 'pause', 'ability'] as const;
const MODES = ['campaign', 'endless', 'daily', 'custom'] as const;
const MAPS: MapId[] = ['ch1', 'ch2', 'ch3'];
const TONES = ['bad', 'good', 'neutral'] as const;

function start(): HTMLElement {
  return section(
    'start',
    t('guide.play.start.title'),
    rich('p.guide-lead', t('guide.play.start.intro')),
    bullets('guide.play.start'),
    h('h3.guide-h3', null, t('guide.play.start.tips.title')),
    bullets('guide.play.start.tips', true),
  );
}

function controls(): HTMLElement {
  return section(
    'controls',
    t('guide.play.controls.title'),
    rich('p', t('guide.play.controls.intro')),
    table(
      [t('guide.play.controls.col.action'), t('guide.play.controls.col.desktop'), t('guide.play.controls.col.touch')],
      CONTROL_ROWS.map((r) => [t(`guide.play.controls.${r}.a`), t(`guide.play.controls.${r}.d`), t(`guide.play.controls.${r}.t`)]),
    ),
    rich('p.muted', t('guide.play.controls.note')),
  );
}

function diffRow(name: string, p: DifficultyParams): string[] {
  const elite =
    p.eliteStart > 0 && p.eliteStart <= 999 ? t('guide.wave', { n: Math.round(p.eliteStart) }) : t('guide.play.modes.diff.eliteNever');
  return [name, String(p.startGold), String(p.lives), `×${Math.round(p.hpMul * 100) / 100}`, elite, String(p.interestCap)];
}

function modes(): HTMLElement {
  const presets = Object.entries(DIFFICULTY_PRESETS) as [keyof typeof DIFFICULTY_PRESETS, DifficultyParams][];
  return section(
    'modes',
    t('guide.play.modes.title'),
    rich('p', t('guide.play.modes.intro')),
    h(
      'div.guide-cards',
      null,
      MODES.map((m) =>
        h('div.guide-mini', null, h('h3.guide-h3', null, t(`guide.play.modes.${m}.name`)), rich('p', t(`guide.play.modes.${m}.desc`))),
      ),
    ),
    h('h3.guide-h3', null, t('guide.play.modes.maps.title')),
    h(
      'ul.guide-list',
      null,
      MAPS.map((id) => h('li', null, h('strong', null, MAP_META[id].name), ' — ', MAP_META[id].desc)),
    ),
    h('h3.guide-h3', null, t('guide.play.modes.diff.title')),
    table(
      ['name', 'gold', 'lives', 'hp', 'elite', 'interest'].map((c) => t(`guide.play.modes.diff.col.${c}`)),
      [...presets.map(([id, p]) => diffRow(diffLabel(id), p)), ...[1, 5, 10].map((lv) => diffRow(diffLabel('abyss', lv), abyssParams(lv)))],
    ),
    rich('p.muted', t('guide.play.modes.diff.unlock')),
    rich('p', t('guide.play.modes.seed')),
    rich('p', t('guide.play.modes.score')),
  );
}

function autowave(): HTMLElement {
  return section('autowave', t('guide.play.autowave.title'), rich('p', t('guide.play.autowave.intro')), bullets('guide.play.autowave'));
}

function events(): HTMLElement {
  const byTone = (tone: (typeof TONES)[number]) =>
    RANDOM_EVENT_IDS.filter((id) => RANDOM_EVENT_META[id].tone === tone).map((id) => {
      const m = RANDOM_EVENT_META[id];
      const warn = m.warn === 'drop' ? t('guide.play.events.warnDrop') : m.warn > 0 ? t('guide.play.events.warn', { n: m.warn }) : '';
      return h(
        `div.guide-row.g-tone-${tone}`,
        { data: { item: `event-${id}` }, attrs: { id: `guide-event-${id}` } },
        icon(art(`events/${id}`), 'guide-ico', 40),
        h(
          'div.guide-row-main',
          null,
          h(
            'div.guide-row-title',
            null,
            h('strong', null, m.name),
            tag(t('guide.play.events.minWave', { n: m.minWave })),
            warn ? tag(warn) : null,
          ),
          h('p', null, m.desc),
        ),
      );
    });
  return section(
    'events',
    t('guide.play.events.title'),
    rich('p', t('guide.play.events.intro')),
    TONES.map((tone) => [
      h(`h3.guide-h3.g-tone-${tone}`, null, t(`guide.play.events.tone.${tone}`)),
      h('div.guide-rows', null, byTone(tone)),
    ]),
    h('h3.guide-h3', null, t('guide.play.events.crate.title')),
    h(
      'ul.guide-list',
      null,
      CRATE_OPTIONS.map((c) => h('li', null, h('strong', null, c.name), ' — ', c.desc)),
    ),
    rich('p.muted', t('guide.play.events.tip')),
  );
}

function field(): HTMLElement {
  return section('field', t('guide.play.field.title'), rich('p', t('guide.play.field.intro')), bullets('guide.play.field'));
}

function evolve(): HTMLElement {
  const forms: [string, string][] = [
    [towerIcon('pencil', 1), ''],
    [towerIcon('pencil', 2), ''],
    [towerIcon('pencil', 3), ''],
    [towerIcon('pencil', 4, 'A'), towerIcon('pencil', 4, 'B')],
    [towerIcon('pencil', 5, 'A'), towerIcon('pencil', 5, 'B')],
  ];
  return section(
    'evolve',
    t('guide.play.evolve.title'),
    rich('p', t('guide.play.evolve.intro')),
    table(
      [t('guide.play.evolve.col.form'), t('guide.play.evolve.col.level'), t('guide.play.evolve.col.gain')],
      forms.map(([a, b], i) => [
        h('span.guide-form', null, icon(a, 'guide-ico', 36), b ? icon(b, 'guide-ico', 36) : null, h('span', null, TIER_NAMES[i] ?? '')),
        t(`guide.play.evolve.lv.${i + 1}`),
        t(`guide.play.evolve.gain.${i + 1}`),
      ]),
    ),
    bullets('guide.play.evolve'),
  );
}

const RENDER: Record<(typeof SECTIONS)[number], () => HTMLElement> = { start, controls, modes, autowave, events, field, evolve };

export const playTab: TabModule = {
  entries(): Entry[] {
    const out: Entry[] = SECTIONS.map((id) => ({
      tab: 'play',
      id,
      title: t(`guide.play.${id}.title`),
      text: [t(`guide.play.${id}.intro`), ...items(`guide.play.${id}`)].map(plain).join(' '),
    }));
    for (const id of RANDOM_EVENT_IDS) {
      const m = RANDOM_EVENT_META[id];
      out.push({ tab: 'play', id: `event-${id}`, title: m.name, text: m.desc, icon: art(`events/${id}`) });
    }
    return out;
  },
  render(ctx: TabContext): HTMLElement {
    const toc = h(
      'nav.guide-toc',
      { attrs: { 'aria-label': t('guide.toc') } },
      SECTIONS.map((id) =>
        h(
          'a.guide-toc-link',
          { attrs: { href: `#guide/play/${id}` }, onclick: (e: Event) => (e.preventDefault(), ctx.go({ tab: 'play', item: id })) },
          t(`guide.play.${id}.title`),
        ),
      ),
    );
    return h(
      'div.guide-tab',
      null,
      toc,
      SECTIONS.map((id) => RENDER[id]()),
    );
  },
};
