import type { DifficultyId, MapId, TowerId } from '../../core/types';
import { campaignDiffUnlocked, campaignStars, chapterCleared, chapterUnlocked, effectiveAutoWave, MAPS } from '../../meta/progress';
import { screenHeader, type App, type Screen } from '../App';
import { towerIcon } from '../assets';
import { audio } from '../audio';
import { MAP_META, TOWER_META } from '../coreMeta';
import { h, img } from '../dom';
import { G } from '../icons';
import { buildRunOptions, loadoutStrip, starRow, switchRow } from './common';

const NEW_TOWERS: Record<MapId, TowerId[]> = {
  ch1: ['wall', 'pencil', 'glue', 'stapler', 'lamp'],
  ch2: ['compass', 'eraser', 'ruler'],
  ch3: ['pen', 'calculator', 'piggy'],
};

const CH_TINT: Record<MapId, string> = { ch1: '#F2C14E', ch2: '#9BD1E5', ch3: '#F28AA0' };

export function campaignScreen(app: App): Screen {
  const p = app.store.get();

  const start = (map: MapId, d: DifficultyId) => {
    audio.play('select');
    app.go({ name: 'game', opts: buildRunOptions(app.store.get(), { mode: 'campaign', map, difficulty: d }) });
  };

  const cards = MAPS.map((map, i) => {
    const unlocked = chapterUnlocked(p, map);
    const meta = MAP_META[map];
    const diffBtn = (d: DifficultyId, label: string) => {
      const ok = campaignDiffUnlocked(p, map, d);
      const stars = campaignStars(p, map, d);
      return h(
        `button.diff-btn.${d}${ok ? '' : '.locked'}`,
        {
          onclick: () => {
            if (!ok) {
              audio.play('error');
              app.toast(unlocked ? '先通关本章普通难度' : '先通关上一章', 'warn');
              return;
            }
            start(map, d);
          },
          attrs: { 'aria-disabled': ok ? null : 'true' },
        },
        h('span.diff-name', null, label),
        ok ? starRow(stars) : h('span.gi', { html: G.lock }),
      );
    };
    const wave = p.campaignWave[map] ?? 0;
    return h(
      `article.chapter-card.card${unlocked ? '' : '.locked'}`,
      { style: `--tint:${CH_TINT[map]}` },
      h(
        'div.chapter-head',
        null,
        h('span.chapter-no', null, `第${['一', '二', '三'][i]}章`),
        chapterCleared(p, map) ? h('span.badge.good', null, '已通关') : wave > 0 ? h('span.badge', null, `最远 ${wave} 波`) : null,
      ),
      h('h2.chapter-name', null, meta?.name ?? map),
      h('p.chapter-desc.muted', null, meta?.desc ?? ''),
      h(
        'div.chapter-towers',
        null,
        h('small.muted', null, '新塔'),
        NEW_TOWERS[map].map((t) => h('span.mini-tower', { title: TOWER_META[t]?.name ?? t }, img(towerIcon(t), 'ico'))),
      ),
      unlocked
        ? h('div.chapter-diffs', null, diffBtn('normal', '普通'), diffBtn('hard', '困难'))
        : h('div.chapter-lock', null, h('span.gi', { html: G.lock }), '通关上一章后解锁'),
    );
  });

  const autoSw = switchRow(
    '自动开波',
    p.settings.autoWave === null ? '第一波由你开始，之后按倒计时自动开波（未通关第一章时默认手动）' : '第一波由你开始，之后按倒计时自动开波',
    p.settings.autoWave ?? effectiveAutoWave(p, 'campaign', 'ch2', 'normal'),
    (v) => app.store.update((pp) => (pp.settings.autoWave = v)),
  );
  const fixedSw = switchRow('固定布局', '桌上的杂物每局都摆在同一个位置', p.settings.fixedLayout, (v) => app.store.update((pp) => (pp.settings.fixedLayout = v)));

  const el = h(
    'div.screen.campaign-screen',
    null,
    screenHeader(app, '战役'),
    h('div.screen-body', null, h('div.chapter-list', null, cards), h('section.card.section.run-options', null, autoSw.el, fixedSw.el), h('p.muted.center', null, '剩余生命 ≥90% 得 3 星，≥50% 得 2 星，通关得 1 星。星星可以在书包里兑换天赋。'), loadoutStrip(app, { name: 'campaign' })),
  );
  return { el };
}
