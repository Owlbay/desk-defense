import type { DifficultyId, MapId } from '../../core/types';
import {
  ABYSS_MAX,
  bestWave,
  chapterCleared,
  diffKey,
  DIFF_NAME,
  difficultyUnlocked,
  effectiveAutoWave,
  INK_FACTOR,
  MAPS,
  maxAbyssLevel,
  roman,
  unlockHint,
} from '../../meta/progress';
import { fmtNumber, t } from '../../i18n';
import { screenHeader, type App, type Screen } from '../App';
import { audio } from '../audio';
import { DIFFICULTY_PRESETS, MAP_META, resolveParams } from '../coreMeta';
import { clear, h } from '../dom';
import { G } from '../icons';
import { buildRunOptions, layoutPicker, loadoutStrip, randomSeed, switchRow } from './common';
import { popSelected } from './motion';

const DIFF_ORDER: DifficultyId[] = ['easy', 'normal', 'hard', 'nightmare', 'abyss'];
const diffBlurb = (d: DifficultyId): string => t(`ui.endless.blurb.${d}`);

export function endlessScreen(app: App): Screen {
  const p = app.store.get();
  const maps = MAPS.filter((m) => chapterCleared(p, m));
  const last = p.lastEndless;
  const abyssMax = maxAbyssLevel(p);
  const state = {
    map: (last && maps.includes(last.map) ? last.map : maps[0] ?? 'ch1') as MapId,
    diff: (last && difficultyUnlocked(p, last.difficulty, last.abyssLevel) ? last.difficulty : 'normal') as DifficultyId,
    abyss: Math.max(1, Math.min(abyssMax || 1, last?.abyssLevel ?? abyssMax ?? 1)),
    pure: last?.pure ?? false,
    /** 布局缩略图使用的种子（未手动填写种子时） */
    layoutSeed: randomSeed(),
    rerolled: false,
  };
  const autoWaveNow = () => effectiveAutoWave(app.store.get(), 'endless', state.map, state.diff);

  const mapBox = h('div.seg-grid.maps');
  const diffBox = h('div.diff-grid');
  const abyssBox = h('div.abyss-box');
  const infoBox = h('div.endless-info');

  let lastDiff: DifficultyId | null = null;
  const renderAll = () => {
    clear(mapBox);
    for (const m of MAPS) {
      const ok = maps.includes(m);
      mapBox.appendChild(
        h(
          `button.seg${state.map === m ? '.on' : ''}${ok ? '' : '.locked'}`,
          {
            onclick: () => {
              if (!ok) return audio.play('error'), app.toast(t('ui.endless.mapLocked'), 'warn');
              audio.play('click');
              state.map = m;
              renderAll();
              popSelected(mapBox);
              layout.refresh();
            },
          },
          ok ? null : h('span.gi', { html: G.lock }),
          MAP_META[m]?.name ?? m,
        ),
      );
    }
    clear(diffBox);
    for (const d of DIFF_ORDER) {
      const ok = d === 'abyss' ? abyssMax > 0 : difficultyUnlocked(p, d);
      const k = d === 'abyss' ? diffKey('abyss', state.abyss) : d;
      const bw = bestWave(p, k);
      diffBox.appendChild(
        h(
          `button.diff-card.${d}${state.diff === d ? '.on' : ''}${ok ? '' : '.locked'}`,
          {
            onclick: () => {
              if (!ok) return audio.play('error'), app.toast(t('ui.endless.unlockCond', { hint: unlockHint(d, 1) }), 'warn');
              audio.play('click');
              state.diff = d;
              renderAll();
              popSelected(diffBox);
            },
          },
          h('span.diff-title', null, DIFF_NAME[d]),
          h('small', null, ok ? diffBlurb(d) : unlockHint(d, 1)),
          ok ? h('span.diff-meta', null, bw > 0 ? t('ui.endless.bestWave', { n: bw }) : t('ui.endless.noRecord'), ` · ${t('ui.endless.inkMul', { x: INK_FACTOR[d] })}`) : h('span.gi.lock', { html: G.lock }),
        ),
      );
    }
    clear(abyssBox);
    if (state.diff === 'abyss') {
      abyssBox.classList.toggle('reveal', lastDiff !== 'abyss' && lastDiff !== null);
      const row = h('div.abyss-levels');
      for (let i = 1; i <= ABYSS_MAX; i++) {
        const ok = i <= abyssMax;
        row.appendChild(
          h(
            `button.abyss-lv${state.abyss === i ? '.on' : ''}${ok ? '' : '.locked'}`,
            {
              title: ok ? t('ui.endless.abyssTip', { lv: roman(i), n: bestWave(p, `abyss${i}`) }) : unlockHint('abyss', i),
              onclick: () => {
                if (!ok) return audio.play('error'), app.toast(t('ui.endless.unlockCond', { hint: unlockHint('abyss', i) }), 'warn');
                audio.play('click');
                state.abyss = i;
                renderAll();
                popSelected(abyssBox);
              },
            },
            roman(i),
          ),
        );
      }
      abyssBox.appendChild(h('div.abyss-panel', null, h('div.label', null, t('ui.endless.abyssLevel')), row));
    }
    // 参数预览
    clear(infoBox);
    try {
      const params =
        state.diff === 'abyss'
          ? resolveParams({ mode: 'endless', map: state.map, difficulty: 'abyss', abyssLevel: state.abyss, skills: [] })
          : DIFFICULTY_PRESETS[state.diff];
      const lines: [string, string][] = [
        [t('ui.endless.param.gold'), fmtNumber(params.startGold)],
        [t('ui.endless.param.lives'), fmtNumber(params.lives)],
        [t('ui.endless.param.hp'), `×${fmtNumber(params.hpMul, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`],
        [t('ui.endless.param.elite'), params.eliteStart > 999 || params.eliteStart <= 0 ? t('ui.endless.param.eliteNone') : t('ui.endless.param.eliteFrom', { n: Math.round(params.eliteStart) })],
        [t('ui.endless.param.score'), `×${fmtNumber(params.scoreMul)}`],
      ];
      infoBox.appendChild(h('dl.param-list', null, lines.map(([a, b]) => h('div', null, h('dt', null, a), h('dd', null, b)))));
    } catch {
      /* core 未就绪时不显示 */
    }
    lastDiff = state.diff;
    el.dataset.difficulty = state.diff;
    autoSw.input.checked = autoWaveNow();
  };

  const seedInput = h<HTMLInputElement>('input.input', {
    attrs: { type: 'text', placeholder: t('ui.endless.seedPlaceholder'), maxlength: 24, inputmode: 'text', autocomplete: 'off', spellcheck: 'false' },
  });
  const runSeed = () => seedInput.value.trim() || state.layoutSeed;
  const layout = layoutPicker({
    map: () => state.map,
    seed: runSeed,
    onReroll: () => {
      state.layoutSeed = randomSeed();
      state.rerolled = true;
      seedInput.value = '';
    },
  });
  let seedTimer = 0;
  seedInput.addEventListener('input', () => {
    clearTimeout(seedTimer);
    seedTimer = window.setTimeout(() => layout.refresh(), 250);
  });
  const autoSw = switchRow(t('ui.endless.autoWave'), t('ui.endless.autoWaveHint'), true, (v) => {
    app.store.update((pp) => (pp.settings.autoWave = v));
  });
  const pureToggle = h<HTMLInputElement>('input', { attrs: { type: 'checkbox' } });
  pureToggle.checked = state.pure;
  pureToggle.onchange = () => {
    state.pure = pureToggle.checked;
    audio.play('click');
  };

  const startBtn = h(
    'button.btn.primary.big',
    {
      onclick: () => {
        audio.play('select');
        app.store.update((pp) => {
          pp.lastEndless = { map: state.map, difficulty: state.diff, abyssLevel: state.abyss, pure: state.pure };
        });
        const typed = seedInput.value.trim();
        const seed = runSeed();
        app.go({
          name: 'game',
          userSeed: !!typed || state.rerolled,
          opts: buildRunOptions(app.store.get(), {
            mode: 'endless',
            map: state.map,
            difficulty: state.diff,
            abyssLevel: state.abyss,
            seed,
            pure: state.pure,
            autoWave: autoSw.input.checked,
          }),
        });
      },
    },
    h('span.gi', { html: G.play }),
    t('ui.endless.start'),
  );

  const el = h(
    'div.screen.endless-screen',
    null,
    screenHeader(app, t('ui.endless.title')),
    h(
      'div.screen-body',
      null,
      h('section.card.section', null, h('h3', null, t('ui.endless.map')), mapBox, layout.el),
      h('section.card.section', null, h('h3', null, t('ui.endless.difficulty')), diffBox, abyssBox, infoBox),
      h(
        'section.card.section',
        null,
        h('h3', null, t('ui.endless.options')),
        h('label.field', null, h('span', null, t('ui.endless.seed')), seedInput),
        h(
          'label.switch-row',
          null,
          h('span', null, h('b', null, t('ui.endless.pure')), h('small.muted', null, t('ui.endless.pureHint'))),
          h('span.switch', null, pureToggle, h('span.knob')),
        ),
        autoSw.el,
      ),
      loadoutStrip(app, { name: 'endless' }),
      h('div.start-bar', null, startBtn),
    ),
  );
  renderAll();
  return { el };
}
