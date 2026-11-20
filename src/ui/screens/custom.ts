import type { DifficultyId, DifficultyParams, MapId } from '../../core/types';
import { CUSTOM_FIELDS, decodeShare, encodeShare, paramValue, sliderValue } from '../../meta/custom';
import { DIFF_NAME, MAPS } from '../../meta/progress';
import { screenHeader, type App, type Screen } from '../App';
import { audio } from '../audio';
import { DIFFICULTY_PRESETS, MAP_META, resolveParams } from '../coreMeta';
import { clear, copyText, h } from '../dom';
import { G } from '../icons';
import { buildRunOptions, loadoutStrip } from './common';

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
  };

  const persist = () =>
    app.store.update((pp) => {
      pp.lastCustom = { map: state.map, base: state.base, params: { ...state.params } };
    });

  const presetBox = h('div.seg-grid.presets');
  const mapBox = h('div.seg-grid.maps');
  const sliderBox = h('div.slider-list');
  const codeOut = h<HTMLTextAreaElement>('textarea.input.code', { attrs: { readonly: true, rows: 2, 'aria-label': '分享码' } });
  const codeIn = h<HTMLTextAreaElement>('textarea.input.code', { attrs: { rows: 2, placeholder: '粘贴朋友发来的分享码', 'aria-label': '导入分享码' } });
  const importMsg = h('small.form-msg');

  const updateCode = () => {
    codeOut.value = encodeShare({ params: state.params, map: state.map, base: state.base });
  };

  const sliderRows = new Map<keyof DifficultyParams, { input: HTMLInputElement; out: HTMLElement }>();

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
              renderPresets();
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

  for (const f of CUSTOM_FIELDS) {
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
    sliderBox.appendChild(
      h('label.slider-row', null, h('span.slider-label', null, h('b', null, f.label), h('small.muted', null, f.hint)), out, input),
    );
  }

  const seedInput = h<HTMLInputElement>('input.input', {
    attrs: { type: 'text', placeholder: '留空随机', maxlength: 24, autocomplete: 'off', spellcheck: 'false' },
  });

  const el = h(
    'div.screen.custom-screen',
    null,
    screenHeader(app, '自定义'),
    h(
      'div.screen-body',
      null,
      h('section.card.section', null, h('h3', null, '从预设开始'), presetBox, h('h3', null, '地图'), mapBox),
      h('section.card.section', null, h('h3', null, '成长比例'), sliderBox),
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
              syncSliders();
              renderPresets();
              renderMaps();
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
              const seed = seedInput.value.trim();
              app.go({
                name: 'game',
                userSeed: !!seed,
                opts: buildRunOptions(app.store.get(), {
                  mode: 'custom',
                  map: state.map,
                  difficulty: state.base,
                  abyssLevel: 1,
                  custom: { ...state.params },
                  seed,
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
  updateCode();
  return { el };
}
