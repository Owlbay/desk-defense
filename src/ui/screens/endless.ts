import type { DifficultyId, MapId } from '../../core/types';
import {
  ABYSS_MAX,
  bestWave,
  chapterCleared,
  diffKey,
  DIFF_NAME,
  difficultyUnlocked,
  INK_FACTOR,
  MAPS,
  maxAbyssLevel,
  roman,
  unlockHint,
} from '../../meta/progress';
import { screenHeader, type App, type Screen } from '../App';
import { audio } from '../audio';
import { DIFFICULTY_PRESETS, MAP_META, resolveParams } from '../coreMeta';
import { clear, h } from '../dom';
import { G } from '../icons';
import { buildRunOptions, loadoutStrip } from './common';

const DIFF_ORDER: DifficultyId[] = ['easy', 'normal', 'hard', 'nightmare', 'abyss'];
const DIFF_BLURB: Record<DifficultyId, string> = {
  easy: '敌人更弱，金币更多',
  normal: '标准体验',
  hard: '精英从第 20 波出现',
  nightmare: '精英成群，生命只有 10',
  abyss: '紫黑深渊，十个等级',
};

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
  };

  const mapBox = h('div.seg-grid.maps');
  const diffBox = h('div.diff-grid');
  const abyssBox = h('div.abyss-box');
  const infoBox = h('div.endless-info');

  const renderAll = () => {
    clear(mapBox);
    for (const m of MAPS) {
      const ok = maps.includes(m);
      mapBox.appendChild(
        h(
          `button.seg${state.map === m ? '.on' : ''}${ok ? '' : '.locked'}`,
          {
            onclick: () => {
              if (!ok) return audio.play('error'), app.toast('通关该章战役后可选', 'warn');
              audio.play('click');
              state.map = m;
              renderAll();
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
              if (!ok) return audio.play('error'), app.toast(`解锁条件：${unlockHint(d, 1)}`, 'warn');
              audio.play('click');
              state.diff = d;
              renderAll();
            },
          },
          h('span.diff-title', null, DIFF_NAME[d]),
          h('small', null, ok ? DIFF_BLURB[d] : unlockHint(d, 1)),
          ok ? h('span.diff-meta', null, bw > 0 ? `最佳 ${bw} 波` : '尚无记录', ` · 墨水 ×${INK_FACTOR[d]}`) : h('span.gi.lock', { html: G.lock }),
        ),
      );
    }
    clear(abyssBox);
    if (state.diff === 'abyss') {
      const row = h('div.abyss-levels');
      for (let i = 1; i <= ABYSS_MAX; i++) {
        const ok = i <= abyssMax;
        row.appendChild(
          h(
            `button.abyss-lv${state.abyss === i ? '.on' : ''}${ok ? '' : '.locked'}`,
            {
              title: ok ? `魔境 ${roman(i)} · 最佳 ${bestWave(p, `abyss${i}`)} 波` : unlockHint('abyss', i),
              onclick: () => {
                if (!ok) return audio.play('error'), app.toast(`解锁条件：${unlockHint('abyss', i)}`, 'warn');
                audio.play('click');
                state.abyss = i;
                renderAll();
              },
            },
            roman(i),
          ),
        );
      }
      abyssBox.appendChild(h('div.abyss-panel', null, h('div.label', null, '魔境等级'), row));
    }
    // 参数预览
    clear(infoBox);
    try {
      const params =
        state.diff === 'abyss'
          ? resolveParams({ mode: 'endless', map: state.map, difficulty: 'abyss', abyssLevel: state.abyss, skills: [] })
          : DIFFICULTY_PRESETS[state.diff];
      const lines: [string, string][] = [
        ['初始金币', String(params.startGold)],
        ['生命', String(params.lives)],
        ['敌人生命', `×${params.hpMul.toFixed(2)}`],
        ['精英', params.eliteStart > 999 || params.eliteStart <= 0 ? '不出现' : `第 ${Math.round(params.eliteStart)} 波起`],
        ['得分', `×${params.scoreMul}`],
      ];
      infoBox.appendChild(h('dl.param-list', null, lines.map(([a, b]) => h('div', null, h('dt', null, a), h('dd', null, b)))));
    } catch {
      /* core 未就绪时不显示 */
    }
    el.dataset.difficulty = state.diff;
  };

  const seedInput = h<HTMLInputElement>('input.input', {
    attrs: { type: 'text', placeholder: '留空随机', maxlength: 24, inputmode: 'text', autocomplete: 'off', spellcheck: 'false' },
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
        const seed = seedInput.value.trim();
        app.go({
          name: 'game',
          userSeed: !!seed,
          opts: buildRunOptions(app.store.get(), {
            mode: 'endless',
            map: state.map,
            difficulty: state.diff,
            abyssLevel: state.abyss,
            seed,
            pure: state.pure,
          }),
        });
      },
    },
    h('span.gi', { html: G.play }),
    '开始无尽',
  );

  const el = h(
    'div.screen.endless-screen',
    null,
    screenHeader(app, '无尽模式'),
    h(
      'div.screen-body',
      null,
      h('section.card.section', null, h('h3', null, '地图'), mapBox),
      h('section.card.section', null, h('h3', null, '难度'), diffBox, abyssBox, infoBox),
      h(
        'section.card.section',
        null,
        h('h3', null, '选项'),
        h('label.field', null, h('span', null, '随机种子'), seedInput),
        h(
          'label.switch-row',
          null,
          h('span', null, h('b', null, '纯净模式'), h('small.muted', null, '关闭所有永久天赋，成绩进入纯净排行榜')),
          h('span.switch', null, pureToggle, h('span.knob')),
        ),
      ),
      loadoutStrip(app, { name: 'endless' }),
      h('div.start-bar', null, startBtn),
    ),
  );
  renderAll();
  return { el };
}
