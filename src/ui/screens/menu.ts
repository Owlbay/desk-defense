import type { RunOptions } from '../../core/types';
import { chapterCleared, customUnlocked, diffLabel, endlessUnlocked } from '../../meta/progress';
import { currencyChips, type App, type Screen } from '../App';
import { towerIcon } from '../assets';
import { audio } from '../audio';
import { MAP_META } from '../coreMeta';
import { h, img } from '../dom';
import { G } from '../icons';

const MODE_NAME = { campaign: '战役', endless: '无尽', custom: '自定义' } as const;

export function runSummary(opts: RunOptions): string {
  const map = MAP_META[opts.map]?.name ?? opts.map;
  const diff = opts.mode === 'custom' ? '自定义' : diffLabel(opts.difficulty, opts.abyssLevel ?? 1);
  return `${MODE_NAME[opts.mode]} · ${map} · ${diff}`;
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
      { onclick: () => (audio.play('error'), app.toast(`${label}：${hint}`, 'warn')), attrs: { 'aria-disabled': 'true' } },
      h('span.gi', { html: glyph }),
      h('span.menu-label', null, label, h('small', null, hint)),
      h('span.gi.lock', { html: G.lock }),
    );

  const btn = (label: string, glyph: string, onclick: () => void, sub?: string, cls = '') =>
    h(`button.menu-btn${cls}`, { onclick }, h('span.gi', { html: glyph }), h('span.menu-label', null, label, sub ? h('small', null, sub) : null));

  const endlessOk = endlessUnlocked(p);
  const clearedCount = (['ch1', 'ch2', 'ch3'] as const).filter((m) => chapterCleared(p, m)).length;

  const parade = h(
    'div.parade',
    { attrs: { 'aria-hidden': 'true' } },
    (['wall', 'pencil', 'stapler', 'glue', 'lamp', 'compass', 'pen'] as const).map((id, i) =>
      h('span.parade-item', { style: `--i:${i}` }, img(towerIcon(id, id === 'pen' ? 3 : id === 'lamp' ? 2 : 1), 'ico')),
    ),
  );

  const el = h(
    'div.screen.menu-screen',
    null,
    h('div.menu-top', null, currencyChips(app.store)),
    h(
      'div.menu-hero',
      null,
      h('div.logo', null, h('span.logo-zh', null, '书桌防线'), h('span.logo-en', null, 'DESK DEFENSE')),
      parade,
    ),
    h(
      'nav.menu-card.card',
      null,
      mid
        ? btn(
            '继续游戏',
            G.play,
            () => {
              audio.play('select');
              app.go({ name: 'game', opts: mid.opts, resume: mid });
            },
            `${runSummary(mid.opts)} · 第 ${mid.wave} 波后`,
            '.primary.continue',
          )
        : null,
      btn('战役', G.book, go({ name: 'campaign' }), `已通关 ${clearedCount} / 3 章`),
      endlessOk ? btn('无尽', G.infinity, go({ name: 'endless' }), '撑得越久，墨水越多') : lockedBtn('无尽', G.infinity, '通关战役第一章解锁'),
      customUnlocked(p) ? btn('自定义', G.sliders, go({ name: 'custom' }), '拖动滑块，自己定难度') : lockedBtn('自定义', G.sliders, '通关战役第一章解锁'),
      h(
        'div.menu-grid',
        null,
        btn('书包', G.bag, go({ name: 'talents' }), '永久天赋'),
        btn('技能', G.bolt, go({ name: 'skills' }), '带入与升级'),
        btn('排行榜', G.trophy, go({ name: 'leaderboard' }), '本地前 10'),
        btn('设置', G.gear, go({ name: 'settings' }), '画质与声音'),
      ),
    ),
    h('footer.menu-foot.muted', null, app.store.kv.persistent ? '进度自动保存在本机' : '当前浏览器无法保存进度（隐私模式？）'),
  );
  return { el };
}
