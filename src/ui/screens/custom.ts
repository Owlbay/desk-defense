import type { DifficultyId, DifficultyParams, MapId, RandomEventId } from '../../core/types';
import { CUSTOM_FIELDS, decodeShare, encodeShare, paramValue, sliderValue, SPAWN_MODES, type CustomField, type NumParamKey } from '../../meta/custom';
import { DIFF_NAME, effectiveAutoWave, MAPS } from '../../meta/progress';
import { screenHeader, type App, type Screen } from '../App';
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
      pp.lastCustom = { map: state.map, base: state.base, params: { ...state.params }, events: { ...state.events }, autoWave: state.autoWave };
    });

  const presetBox = h('div.seg-grid.presets');
  const mapBox = h('div.seg-grid.maps');
  const sliderBox = h('div.slider-list');
  const dynBox = h('div.slider-list');
  const spawnModeBox = h('div.seg-grid.spawn-modes');
  const eventBox = h('div.event-toggles');
  const codeOut = h<HTMLTextAreaElement>('textarea.input.code', { attrs: { readonly: true, rows: 2, 'aria-label': '分享码' } });
  const codeIn = h<HTMLTextAreaElement>('textarea.input.code', { attrs: { rows: 2, placeholder: '粘贴朋友发来的分享码', 'aria-label': '导入分享码' } });
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
          id === 'abyss' ? '魔境 I' : DIFF_NAME[id],
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
    attrs: { type: 'text', placeholder: '留空随机', maxlength: 24, autocomplete: 'off', spellcheck: 'false' },
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
  const autoSw = switchRow('自动开波', '第一波由你开始，之后按倒计时自动开波', state.autoWave, (v) => {
    state.autoWave = v;
    updateCode();
    persist();
  });

  const el = h(
    'div.screen.custom-screen',
    null,
    screenHeader(app, '自定义'),
    h(
      'div.screen-body',
      null,
      h('section.card.section', null, h('h3', null, '从预设开始'), presetBox, h('h3', null, '地图'), mapBox, layout.el),
      h('section.card.section', null, h('h3', null, '成长比例'), sliderBox),
      h(
        'section.card.section',
        null,
        h('h3', null, '动态战场'),
        h('div.field-label', null, h('b', null, '出怪方式'), h('small.muted', null, '每组敌人从哪个出生点出来')),
        spawnModeBox,
        dynBox,
        autoSw.el,
        h('h3', null, '随机事件'),
        h('p.muted.small', null, '点一下关闭 / 开启单个事件。事件频率为 0 时全部关闭。'),
        eventBox,
      ),
      h(
        'section.card.section',
        null,
        h('h3', null, '分享码'),
        h('div.code-row', null, codeOut, h(
          'button.btn.icon-text',
          {
            onclick: async () => {
              const ok = await copyText(codeOut.value);
              audio.play(ok ? 'select' : 'error');
              app.toast(ok ? '分享码已复制' : '复制失败，请手动选中复制', ok ? 'good' : 'warn');
              if (!ok) codeOut.select();
            },
          },
          h('span.gi', { html: G.copy }),
          '复制',
        )),
        h('div.code-row', null, codeIn, h(
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
              importMsg.textContent = '已导入';
              importMsg.className = 'form-msg good';
            },
          },
          '导入',
        )),
        importMsg,
      ),
      h('section.card.section', null, h('label.field', null, h('span', null, '随机种子'), seedInput), h('p.muted', null, '自定义成绩不进排行榜，只记录个人最佳。墨水按所选预设的系数结算。')),
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
          '开始自定义',
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
