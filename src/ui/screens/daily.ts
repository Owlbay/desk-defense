/**
 * 每日挑战（docs/12）：今天的地图 + 难度 + 种子，北京时间零点换期。
 * 固定纯净模式 + 自动开波，技能等级按 1 级；成绩进入 daily:<日期> 榜。
 */
import { fetchDaily } from '../../meta/online';
import { diffLabel, resolveLoadout } from '../../meta/progress';
import { dailyInfo, dailyRunOptions, dayOf, type DailyInfo, type LeaderboardResponse } from '../../shared/leaderboard';
import { fmtNumber, t } from '../../i18n';
import { screenHeader, type App, type Screen } from '../App';
import { audio } from '../audio';
import { MAP_META } from '../coreMeta';
import { clear, copyText, h, setText } from '../dom';
import { G } from '../icons';
import { nicknameChip } from '../online/nickname';
import { onlineBoard } from '../online/table';
import { fmtCountdown, msUntilNextDay } from '../online/util';
import { layoutThumb, loadoutStrip, unlockedSkills } from './common';

export function dailyScreen(app: App): Screen {
  let info: DailyInfo = dailyInfo(dayOf(Date.now()));
  let source: 'server' | 'local' = 'local';

  const heroBox = h('div.daily-hero-host');
  const layoutBox = h('div.layout-host');
  const countEl = h('b', { attrs: { 'aria-live': 'off' } }, fmtCountdown(msUntilNextDay(Date.now())));
  const bestBox = h('div.daily-best');
  const srcNote = h('small.muted');
  const list = onlineBoard(app, {
    limit: 20,
    emptyHint: t('ui.daily.empty'),
    onLoaded: (d) => paintBest(d),
  });

  const stat = (label: string, value: string) => h('div', null, h('small.muted', null, label), h('b', null, value));
  function paintBest(d: LeaderboardResponse | null): void {
    clear(bestBox);
    const me = d?.me ?? null;
    bestBox.append(
      stat(t('ui.daily.myBest'), me ? t('ui.daily.points', { n: me.score, score: fmtNumber(me.score) }) : '—'),
      stat(t('ui.daily.wave'), me ? t('ui.daily.waves', { n: me.wave }) : '—'),
      stat(
        t('ui.daily.rank'),
        me
          ? `${fmtNumber(me.rank)} / ${fmtNumber(d?.total ?? 0)}`
          : d
            ? t('ui.daily.players', { n: d.total, total: fmtNumber(d.total) })
            : '—',
      ),
    );
  }
  paintBest(null);

  const paintInfo = () => {
    clear(heroBox);
    const mapName = MAP_META[info.map]?.name ?? info.map;
    heroBox.appendChild(
      h(
        'div.daily-hero',
        null,
        h(
          'div',
          null,
          h('small.muted', null, t('ui.daily.issue', { day: info.day })),
          h('h2', null, `${mapName} · ${diffLabel(info.difficulty, info.abyssLevel ?? 1)}`),
          h(
            'div.daily-meta',
            null,
            h('span.badge', null, t('ui.daily.badgePure')),
            h('span.badge', null, t('ui.daily.badgeAuto')),
            h('span.badge', null, t('ui.daily.badgeLv1')),
            h(
              'button.seed-btn',
              {
                attrs: { type: 'button' },
                title: t('ui.daily.copySeed'),
                onclick: async () => {
                  const ok = await copyText(info.seed);
                  app.toast(ok ? t('ui.daily.seedCopied', { seed: info.seed }) : t('ui.daily.copyFailed'), ok ? 'good' : 'warn');
                },
              },
              t('ui.daily.seed', { seed: info.seed }),
            ),
          ),
        ),
        h('div.daily-count', { attrs: { title: t('ui.daily.resetTip') } }, h('small.muted', null, t('ui.daily.nextIn')), countEl),
      ),
    );
    layoutBox.replaceChildren(layoutThumb(info.map, info.seed));
    setText(srcNote, source === 'local' ? t('ui.daily.offlineNote') : '');
    el.dataset.difficulty = info.difficulty;
  };

  const load = async () => {
    const r = await fetchDaily();
    if (destroyed) return;
    if (r.ok) {
      info = r.data;
      source = r.source ?? 'server';
    }
    paintInfo();
    list.load(info.board);
  };

  const startBtn = h(
    'button.btn.primary.big',
    {
      attrs: { type: 'button' },
      onclick: () => {
        audio.play('select');
        const p = app.store.get();
        const skills = resolveLoadout(p, unlockedSkills(p), true);
        app.go({ name: 'game', userSeed: true, opts: dailyRunOptions(info, skills) });
      },
    },
    h('span.gi', { html: G.play }),
    t('ui.daily.start'),
  );

  const el = h(
    'div.screen.daily-screen',
    null,
    screenHeader(app, t('ui.daily.title')),
    h(
      'div.screen-body',
      null,
      h('section.card.section', null, heroBox, layoutBox, srcNote),
      h(
        'section.card.section',
        null,
        h('h3', null, t('ui.daily.rules')),
        h(
          'ul.daily-rules',
          null,
          h('li', null, t('ui.daily.rule1')),
          h('li', null, t('ui.daily.rule2')),
          h('li', null, t('ui.daily.rule3')),
        ),
        bestBox,
      ),
      loadoutStrip(app, { name: 'daily' }),
      h('div.start-bar', null, startBtn),
      h(
        'section.card.section',
        null,
        h(
          'div.online-bar',
          null,
          h('h3', null, t('ui.daily.todayBoard')),
          nicknameChip(() => list.reload()),
          h(
            'button.btn.small',
            { attrs: { type: 'button' }, onclick: () => (audio.play('click'), list.reload()) },
            h('span.gi', { html: G.refresh }),
            t('ui.daily.refresh'),
          ),
        ),
        list.el,
      ),
    ),
  );

  let destroyed = false;
  let lastDay = info.day;
  const timer = window.setInterval(() => {
    const now = Date.now();
    setText(countEl, fmtCountdown(msUntilNextDay(now)));
    const d = dayOf(now);
    if (d !== lastDay) {
      lastDay = d;
      info = dailyInfo(d);
      void load();
    }
  }, 1000);

  paintInfo();
  void load();
  return {
    el,
    destroy() {
      destroyed = true;
      clearInterval(timer);
    },
  };
}
