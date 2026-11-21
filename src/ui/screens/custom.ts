import type { DifficultyId, DifficultyParams, MapId, RandomEventId } from '../../core/types';
import { t } from '../../i18n';
import {
  CUSTOM_FIELDS,
  type CustomField,
  decodeShare,
  encodeShare,
  type NumParamKey,
  paramValue,
  sliderValue,
  SPAWN_MODES,
} from '../../meta/custom';
import { DIFF_NAME, effectiveAutoWave, MAPS } from '../../meta/progress';
import { type App, type Screen, screenHeader } from '../App';
import { audio } from '../audio';
import { DIFFICULTY_PRESETS, eventMeta, MAP_META, RANDOM_EVENT_IDS, resolveParams } from '../coreMeta';
import { clear, copyText, h } from '../dom';
import { G } from '../icons';
import { buildRunOptions, layoutPicker, loadoutStrip, randomSeed, switchRow } from './common';
import { pop, popSelected } from './motion';

const TONE_GLYPH = { bad: G.warn, good: G.gift, neutral: G.swirl } as const;

type PresetId = DifficultyId;
const PRESETS: PresetId[] = ['easy', 'normal', 'hard', 'nightmare', 'abyss'];

function presetParams(id: PresetId, map: MapId): DifficultyParams {
  if (id === 'abyss') return resolveParams({ mode: 'custom', map, difficulty: 'abyss', abyssLevel: 1, skills: [] });
  return { ...DIFFICULTY_PRESETS[id] };
}

export function customScreen(app: App): Screen {
  const p = app.store.get();
  const last = p.lastCustom;
  const state = {
    map: (last?.map ?? 'ch1') as MapId,
    base: (last?.base ?? 'normal') as PresetId,
    params: last?.params ? { ...presetParams(last.base, last.map), ...last.params } : presetParams('normal', 'ch1'),
    events: { ...(last?.events ?? {}) } as Partial<Record<RandomEventId, boolean>>,
    autoWave: last?.autoWave ?? effectiveAutoWave(p, 'custom', last?.map ?? 'ch1', last?.base ?? 'normal'),
    layoutSeed: randomSeed(),
    rerolled: false,
  };

  const persist = () =>
    app.store.update((pp) => {
      pp.lastCustom = {
        map: state.map,
        base: state.base,
        params: { ...state.params },
        events: { ...state.events },
        autoWave: state.autoWave,
      };
    });

  const presetBox = h('div.seg-grid.presets');
  const mapBox = h('div.seg-grid.maps');
  const sliderBox = h('div.slider-list');
  const dynBox = h('div.slider-list');
  const spawnModeBox = h('div.seg-grid.spawn-modes');
  const eventBox = h('div.event-toggles');
  const codeOut = h<HTMLTextAreaElement>('textarea.input.code', {
    attrs: { readonly: true, rows: 2, 'aria-label': t('ui.custom.shareCode') },
  });
  const codeIn = h<HTMLTextAreaElement>('textarea.input.code', {
    attrs: { rows: 2, placeholder: t('ui.custom.pastePlaceholder'), 'aria-label': t('ui.custom.importAria') },
  });
  const importMsg = h('small.form-msg');

  const updateCode = () => {
    codeOut.value = encodeShare({ params: state.params, map: state.map, base: state.base, events: state.events, autoWave: state.autoWave });
  };

  const sliderRows = new Map<NumParamKey, { input: HTMLInputElement; out: HTMLElement }>();

  const renderSpawnModes = () => {
    clear(spawnModeBox);
    for (const m of SPAWN_MODES) {
      spawnModeBox.appendChild(
        h(
          `button.seg${state.params.spawnMode === m.id ? '.on' : ''}`,
          {
            title: m.hint,
            onclick: () => {
              audio.play('click');
              state.params = { ...state.params, spawnMode: m.id };
              renderSpawnModes();
              popSelected(spawnModeBox);
              updateCode();
              persist();
            },
          },
          m.name,
        ),
      );
    }
  };

  const renderEvents = () => {
    clear(eventBox);
    for (const id of RANDOM_EVENT_IDS) {
      const meta = eventMeta(id);
      const on = state.events[id] !== false;
      eventBox.appendChild(
        h(
          `button.event-toggle.tone-${meta.tone}${on ? '.on' : ''}`,
          {
            title: meta.desc,
            attrs: { 'aria-pressed': on ? 'true' : 'false' },
            onclick: () => {
              audio.play('click');
              if (on) state.events[id] = false;
              else delete state.events[id];
              const idx = RANDOM_EVENT_IDS.indexOf(id);
              renderEvents();
              const again = eventBox.children[idx] as HTMLElement | undefined;
              again?.focus({ preventScroll: true });
              pop(again, 1.05);
              updateCode();
              persist();
            },
          },
          h('span.gi', { html: TONE_GLYPH[meta.tone] }),
          h('span', null, meta.name),
          on ? h('span.gi.ev-check', { html: G.check }) : null,
        ),
      );
    }
  };

  const renderPresets = () => {
    clear(presetBox);
    for (const id of PRESETS) {
      presetBox.appendChild(
        h(
          `button.seg.${id}${state.base === id ? '.on' : ''}`,
          {
            onclick: () => {
              audio.play('click');
              state.base = id;
              state.params = presetParams(id, state.map);
              syncSliders();
              renderSpawnModes();
              renderPresets();
              popSelected(presetBox);
              updateCode();
              persist();
            },
          },
          id === 'abyss' ? t('ui.custom.abyss1') : DIFF_NAME[id],
        ),
      );
    }
  };

  const renderMaps = () => {
    clear(mapBox);
    for (const m of MAPS) {
      mapBox.appendChild(
        h(
          `button.seg${state.map === m ? '.on' : ''}`,
          {
            onclick: () => {
              audio.play('click');
              state.map = m;
              renderMaps();
              popSelected(mapBox);
              layout.refresh();
              updateCode();
              persist();
            },
          },
          MAP_META[m]?.name ?? m,
        ),
      );
    }
  };

  const syncSliders = () => {
    for (const f of CUSTOM_FIELDS) {
      const r = sliderRows.get(f.key);
      if (!r) continue;
      const sv = sliderValue(f, state.params[f.key]);
      r.input.value = String(sv);
      r.out.textContent = f.fmt(f.offAt !== undefined && state.params[f.key] > 999 ? f.offAt : state.params[f.key]);
      r.input.style.setProperty('--fill', `${((sv - f.min) / (f.max - f.min)) * 100}%`);
    }
  };

  const addSlider = (f: CustomField, box: HTMLElement) => {
    const input = h<HTMLInputElement>('input.range', {
      attrs: { type: 'range', min: f.min, max: f.max, step: f.step, 'aria-label': f.label },
    });
    const out = h('output.slider-val');
    input.addEventListener('input', () => {
      const v = Number(input.value);
      state.params = { ...state.params, [f.key]: paramValue(f, v) };
      out.textContent = f.fmt(f.offAt !== undefined && v >= f.offAt ? f.offAt : v);
      input.style.setProperty('--fill', `${((v - f.min) / (f.max - f.min)) * 100}%`);
      updateCode();
    });
    input.addEventListener('change', persist);
    sliderRows.set(f.key, { input, out });
    box.appendChild(
      h('label.slider-row', null, h('span.slider-label', null, h('b', null, f.label), h('small.muted', null, f.hint)), out, input),
    );
  };
  for (const f of CUSTOM_FIELDS) addSlider(f, f.group === 'dyn' ? dynBox : sliderBox);

  const seedInput = h<HTMLInputElement>('input.input', {
    attrs: { type: 'text', placeholder: t('ui.custom.seedPlaceholder'), maxlength: 24, autocomplete: 'off', spellcheck: 'false' },
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
  const autoSw = switchRow(t('ui.custom.autoWave'), t('ui.custom.autoWaveHint'), state.autoWave, (v) => {
    state.autoWave = v;
    updateCode();
    persist();
  });

  const el = h(
    'div.screen.custom-screen',
    null,
    screenHeader(app, t('ui.custom.title')),
    h(
      'div.screen-body',
      null,
      h(
        'section.card.section',
        null,
        h('h3', null, t('ui.custom.preset')),
        presetBox,
        h('h3', null, t('ui.custom.map')),
        mapBox,
        layout.el,
      ),
      h('section.card.section', null, h('h3', null, t('ui.custom.growth')), sliderBox),
      h(
        'section.card.section',
        null,
        h('h3', null, t('ui.custom.dynamic')),
        h('div.field-label', null, h('b', null, t('ui.custom.spawnMode')), h('small.muted', null, t('ui.custom.spawnModeHint'))),
        spawnModeBox,
        dynBox,
        autoSw.el,
        h('h3', null, t('ui.custom.events')),
        h('p.muted.small', null, t('ui.custom.eventsHint')),
        eventBox,
      ),
      h(
        'section.card.section',
        null,
        h('h3', null, t('ui.custom.shareCode')),
        h(
          'div.code-row',
          null,
          codeOut,
          h(
            'button.btn.icon-text',
            {
              onclick: async () => {
                const ok = await copyText(codeOut.value);
                audio.play(ok ? 'select' : 'error');
                app.toast(ok ? t('ui.custom.copied') : t('ui.custom.copyFailed'), ok ? 'good' : 'warn');
                if (!ok) codeOut.select();
              },
            },
            h('span.gi', { html: G.copy }),
            t('ui.custom.copy'),
          ),
        ),
        h(
          'div.code-row',
          null,
          codeIn,
          h(
            'button.btn.icon-text',
            {
              onclick: () => {
                const r = decodeShare(codeIn.value, presetParams('normal', state.map));
                if (!r.ok) {
                  audio.play('error');
                  importMsg.textContent = r.reason;
                  importMsg.className = 'form-msg bad';
                  return;
                }
                audio.play('select');
                state.params = r.value.params;
                if (r.value.map) state.map = r.value.map;
                if (r.value.base && PRESETS.includes(r.value.base)) state.base = r.value.base;
                state.events = { ...(r.value.events ?? {}) };
                if (r.value.autoWave !== undefined) {
                  state.autoWave = r.value.autoWave;
                  autoSw.input.checked = state.autoWave;
                }
                syncSliders();
                renderPresets();
                renderMaps();
                renderSpawnModes();
                renderEvents();
                layout.refresh();
                updateCode();
                persist();
                importMsg.textContent = t('ui.custom.imported');
                importMsg.className = 'form-msg good';
              },
            },
            t('ui.custom.import'),
          ),
        ),
        importMsg,
      ),
      h(
        'section.card.section',
        null,
        h('label.field', null, h('span', null, t('ui.custom.seed')), seedInput),
        h('p.muted', null, t('ui.custom.footHint')),
      ),
      loadoutStrip(app, { name: 'custom' }),
      h(
        'div.start-bar',
        null,
        h(
          'button.btn.primary.big',
          {
            onclick: () => {
              audio.play('select');
              persist();
              const typed = seedInput.value.trim();
              const seed = runSeed();
              app.go({
                name: 'game',
                userSeed: !!typed || state.rerolled,
                opts: buildRunOptions(app.store.get(), {
                  mode: 'custom',
                  map: state.map,
                  difficulty: state.base,
                  abyssLevel: 1,
                  custom: { ...state.params },
                  seed,
                  autoWave: state.autoWave,
                  events: { ...state.events },
                }),
              });
            },
          },
          h('span.gi', { html: G.play }),
          t('ui.custom.start'),
        ),
      ),
    ),
  );
  renderPresets();
  renderMaps();
  syncSliders();
  renderSpawnModes();
  renderEvents();
  updateCode();
  return { el };
}
