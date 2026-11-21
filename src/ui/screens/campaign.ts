import type { DifficultyId, MapId, TowerId } from '../../core/types';
import { t } from '../../i18n';
import { campaignDiffUnlocked, campaignStars, chapterCleared, chapterUnlocked, effectiveAutoWave, MAPS } from '../../meta/progress';
import { type App, type Screen, screenHeader } from '../App';
import { towerIcon } from '../assets';
import { audio } from '../audio';
import { MAP_META, TOWER_META } from '../coreMeta';
import { h, img } from '../dom';
import { G } from '../icons';
import { buildRunOptions, loadoutStrip, starRow, switchRow } from './common';
import { burst, motionOK } from './motion';

/** 上次在战役页看到的星数：赢了一局回来时，新得的星星依次弹出 */
const SEEN_KEY = 'dd.ui.seenStars';
function loadSeen(): Record<string, number> | null {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' ? (v as Record<string, number>) : null;
  } catch {
    return null;
  }
}
function saveSeen(v: Record<string, number>): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(v));
  } catch {
    /* 存不了就算了，只是少播一次动画 */
  }
}

const NEW_TOWERS: Record<MapId, TowerId[]> = {
  ch1: ['wall', 'pencil', 'glue', 'stapler', 'swatter', 'lamp'],
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

  const seen = loadSeen();
  const nowSeen: Record<string, number> = {};
  let earnedBtn: HTMLElement | null = null;

  const cards = MAPS.map((map, i) => {
    const unlocked = chapterUnlocked(p, map);
    const meta = MAP_META[map];
    const diffBtn = (d: DifficultyId, label: string) => {
      const ok = campaignDiffUnlocked(p, map, d);
      const stars = campaignStars(p, map, d);
      const key = `${map}.${d}`;
      nowSeen[key] = stars;
      // 第一次进战役页（没有记录）不演出，只对比上一次看到的星数
      const before = seen ? Math.min(stars, Number(seen[key]) || 0) : stars;
      const b = h(
        `button.diff-btn.${d}${ok ? '' : '.locked'}`,
        {
          onclick: () => {
            if (!ok) {
              audio.play('error');
              app.toast(unlocked ? t('ui.campaign.needNormal') : t('ui.campaign.needPrev'), 'warn');
              return;
            }
            start(map, d);
          },
          attrs: { 'aria-disabled': ok ? null : 'true' },
        },
        h('span.diff-name', null, label),
        ok ? starRow(stars, 3, before) : h('span.gi', { html: G.lock }),
      );
      if (ok && stars > before) {
        b.classList.add('earned');
        earnedBtn ??= b;
      }
      return b;
    };
    const wave = p.campaignWave[map] ?? 0;
    return h(
      `article.chapter-card.card${unlocked ? '' : '.locked'}`,
      { style: `--tint:${CH_TINT[map]}` },
      h(
        'div.chapter-head',
        null,
        h('span.chapter-no', null, t('ui.campaign.chapterNo', { n: i + 1 })),
        chapterCleared(p, map)
          ? h('span.badge.good', null, t('ui.campaign.cleared'))
          : wave > 0
            ? h('span.badge', null, t('ui.campaign.bestWave', { n: wave }))
            : null,
      ),
      h('h2.chapter-name', null, meta?.name ?? map),
      h('p.chapter-desc.muted', null, meta?.desc ?? ''),
      h(
        'div.chapter-towers',
        null,
        h('small.muted', null, t('ui.campaign.newTowers')),
        NEW_TOWERS[map].map((t) => h('span.mini-tower', { title: TOWER_META[t]?.name ?? t }, img(towerIcon(t), 'ico'))),
      ),
      unlocked
        ? h('div.chapter-diffs', null, diffBtn('normal', t('ui.campaign.normal')), diffBtn('hard', t('ui.campaign.hard')))
        : h('div.chapter-lock', null, h('span.gi', { html: G.lock }), t('ui.campaign.unlockPrev')),
    );
  });

  const autoSw = switchRow(
    t('ui.campaign.autoWave'),
    p.settings.autoWave === null ? t('ui.campaign.autoWaveHintDefault') : t('ui.campaign.autoWaveHint'),
    p.settings.autoWave ?? effectiveAutoWave(p, 'campaign', 'ch2', 'normal'),
    (v) => app.store.update((pp) => (pp.settings.autoWave = v)),
  );
  const fixedSw = switchRow(t('ui.campaign.fixedLayout'), t('ui.campaign.fixedLayoutHint'), p.settings.fixedLayout, (v) =>
    app.store.update((pp) => (pp.settings.fixedLayout = v)),
  );

  const el = h(
    'div.screen.campaign-screen',
    null,
    screenHeader(app, t('ui.campaign.title')),
    h(
      'div.screen-body',
      null,
      h('div.chapter-list', null, cards),
      h('section.card.section.run-options', null, autoSw.el, fixedSw.el),
      h('p.muted.center', null, t('ui.campaign.starRule')),
      loadoutStrip(app, { name: 'campaign' }),
    ),
  );
  saveSeen(nowSeen);
  // 新得星的那张卡片滚到可见处，最后一颗星落定时撒一把纸屑
  const target = earnedBtn as HTMLElement | null;
  let timer = 0;
  if (target) {
    requestAnimationFrame(() => target.scrollIntoView({ block: 'center', behavior: motionOK() ? 'smooth' : 'auto' }));
    const n = target.querySelectorAll('.star.earn').length;
    timer = window.setTimeout(
      () => {
        const stars = target.querySelector<HTMLElement>('.stars');
        if (stars) burst(stars, 10, 40);
        audio.play('upgrade');
      },
      520 + n * 180,
    );
  }
  return { el, destroy: () => clearTimeout(timer) };
}
