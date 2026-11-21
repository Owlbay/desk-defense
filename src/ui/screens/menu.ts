import type { RunOptions } from '../../core/types';
import { getLocale, t } from '../../i18n';
import { chapterCleared, customUnlocked, diffLabel, endlessUnlocked } from '../../meta/progress';
import { AI_GLYPH } from '../ai/icon';
import { type App, currencyChips, type Screen } from '../App';
import { towerIcon } from '../assets';
import { audio } from '../audio';
import { MAP_META } from '../coreMeta';
import { h, img } from '../dom';
import { G } from '../icons';

const modeName = (m: RunOptions['mode']): string => t(`ui.menu.mode.${m}`);

export function runSummary(opts: RunOptions): string {
  const map = MAP_META[opts.map]?.name ?? opts.map;
  const diff = opts.mode === 'custom' ? t('ui.menu.mode.custom') : diffLabel(opts.difficulty, opts.abyssLevel ?? 1);
  const wave = opts.autoWave === true ? t('ui.menu.autoWave') : opts.autoWave === false ? t('ui.menu.manualWave') : '';
  return [modeName(opts.mode), map, diff, wave].filter(Boolean).join(' · ');
}

export function menuScreen(app: App): Screen {
  const p = app.store.get();
  const mid = p.midRun;
  const go = (r: Parameters<App['go']>[0]) => () => {
    audio.play('click');
    app.go(r);
  };

  const lockedBtn = (label: string, glyph: string, hint: string) =>
    h(
      'button.menu-btn.locked',
      {
        onclick: () => (audio.play('error'), app.toast(t('ui.menu.lockedToast', { label, hint }), 'warn')),
        attrs: { 'aria-disabled': 'true' },
      },
      h('span.gi', { html: glyph }),
      h('span.menu-label', null, label, h('small', null, hint)),
      h('span.gi.lock', { html: G.lock }),
    );

  const btn = (label: string, glyph: string, onclick: () => void, sub?: string, cls = '') =>
    h(
      `button.menu-btn${cls}`,
      { onclick },
      h('span.gi', { html: glyph }),
      h('span.menu-label', null, label, sub ? h('small', null, sub) : null),
    );

  const endlessOk = endlessUnlocked(p);
  const clearedCount = (['ch1', 'ch2', 'ch3'] as const).filter((m) => chapterCleared(p, m)).length;

  const parade = h(
    'div.parade',
    { attrs: { 'aria-hidden': 'true' } },
    (['wall', 'pencil', 'stapler', 'glue', 'swatter', 'lamp', 'compass', 'pen'] as const).map((id, i) =>
      h('span.parade-item', { style: `--i:${i}` }, img(towerIcon(id, id === 'pen' ? 3 : id === 'lamp' ? 2 : 1), 'ico')),
    ),
  );

  // 背景环境：缓慢漂移的桌面木纹 + 几粒橡皮屑（纯 transform / opacity，标签页隐藏时暂停）
  const CRUMBS: [number, number, number, number][] = [
    // 左 %, 上 %, 尺寸 px, 周期 s
    [8, 22, 7, 17],
    [86, 16, 9, 21],
    [18, 68, 6, 19],
    [74, 58, 8, 23],
    [48, 84, 6, 18],
    [92, 78, 7, 20],
  ];
  const ambience = h(
    'div.menu-ambience',
    { attrs: { 'aria-hidden': 'true' } },
    h('span.amb-grain'),
    CRUMBS.map(([x, y, size, dur], i) =>
      h(`span.crumb.c${i % 3}`, { style: `left:${x}%;top:${y}%;width:${size}px;height:${size}px;--dur:${dur}s;--i:${i}` }),
    ),
  );

  const dailyBtn = endlessOk
    ? btn(
        t('ui.menu.daily'),
        G.target,
        () => {
          audio.play('click');
          app.go({ name: 'daily' });
          if (app.route.name !== 'daily') app.toast(t('ui.menu.dailySoon'), 'info');
        },
        t('ui.menu.dailySub'),
        '.daily',
      )
    : lockedBtn(t('ui.menu.daily'), G.target, t('ui.menu.unlockCh1'));
  if (endlessOk) dailyBtn.appendChild(h('span.badge.today', null, t('ui.menu.today')));

  const el = h(
    'div.screen.menu-screen',
    null,
    ambience,
    h('div.menu-top', null, currencyChips(app.store)),
    h(
      'div.menu-hero',
      null,
      h(
        'div.logo',
        null,
        // 标题逐字落下；读屏只读整词
        h(
          'span.logo-zh',
          {
            attrs: { role: 'img', 'aria-label': t('ui.menu.logo') },
          },
          [...t('ui.menu.logo')].map((ch, i) =>
            h('span.logo-ch', { style: `--i:${i}`, attrs: { 'aria-hidden': 'true' } }, ch === ' ' ? '\u00a0' : ch),
          ),
        ),
        // 英文界面里主标题已是英文，不再重复副标题
        getLocale() === 'en' ? null : h('span.logo-en', null, 'DESK DEFENSE'),
      ),
      parade,
    ),
    h(
      'nav.menu-card.card',
      null,
      mid
        ? btn(
            t('ui.menu.continue'),
            G.play,
            () => {
              audio.play('select');
              app.go({ name: 'game', opts: mid.opts, resume: mid });
            },
            t('ui.menu.continueSub', { summary: runSummary(mid.opts), n: mid.wave }),
            '.primary.continue',
          )
        : null,
      btn(t('ui.menu.mode.campaign'), G.book, go({ name: 'campaign' }), t('ui.menu.campaignSub', { n: clearedCount, total: 3 })),
      endlessOk
        ? btn(t('ui.menu.mode.endless'), G.infinity, go({ name: 'endless' }), t('ui.menu.endlessSub'))
        : lockedBtn(t('ui.menu.mode.endless'), G.infinity, t('ui.menu.unlockCh1')),
      dailyBtn,
      customUnlocked(p)
        ? btn(t('ui.menu.mode.custom'), G.sliders, go({ name: 'custom' }), t('ui.menu.customSub'))
        : lockedBtn(t('ui.menu.mode.custom'), G.sliders, t('ui.menu.unlockCh1')),
      btn(t('ui.menu.ai'), AI_GLYPH, go({ name: 'ai' }), t('ui.menu.aiSub'), '.ai-entry'),
      btn(t('guide.menu.label'), G.list, go({ name: 'guide' }), t('guide.menu.sub'), '.guide-entry'),
      h(
        'div.menu-grid',
        null,
        btn(t('ui.menu.talents'), G.bag, go({ name: 'talents' }), t('ui.menu.talentsSub')),
        btn(t('ui.menu.skills'), G.bolt, go({ name: 'skills' }), t('ui.menu.skillsSub')),
        btn(t('ui.menu.leaderboard'), G.trophy, go({ name: 'leaderboard' }), t('ui.lb.menuSub')),
        btn(t('ui.menu.settings'), G.gear, go({ name: 'settings' }), t('ui.menu.settingsSub')),
      ),
    ),
    h('footer.menu-foot.muted', null, app.store.kv.persistent ? t('ui.menu.savedLocal') : t('ui.menu.noSave')),
  );
  return { el };
}
