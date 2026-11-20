/**
 * 每日挑战（docs/12）：今天的地图 + 难度 + 种子，北京时间零点换期。
 * 固定纯净模式 + 自动开波，技能等级按 1 级；成绩进入 daily:<日期> 榜。
 */
import { fetchDaily } from '../../meta/online';
import { diffLabel, resolveLoadout } from '../../meta/progress';
import { dailyInfo, dailyRunOptions, dayOf, type DailyInfo, type LeaderboardResponse } from '../../shared/leaderboard';
import { screenHeader, type App, type Screen } from '../App';
import { audio } from '../audio';
import { MAP_META } from '../coreMeta';
import { clear, copyText, fmtNum, h, setText } from '../dom';
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
    emptyHint: '今天还没有人上榜，第一个就是你！',
    onLoaded: (d) => paintBest(d),
  });

  const stat = (label: string, value: string) => h('div', null, h('small.muted', null, label), h('b', null, value));
  function paintBest(d: LeaderboardResponse | null): void {
    clear(bestBox);
    const me = d?.me ?? null;
    bestBox.append(
      stat('我的最佳', me ? `${fmtNum(me.score)} 分` : '—'),
      stat('波数', me ? `${me.wave} 波` : '—'),
      stat('名次', me ? `${me.rank} / ${fmtNum(d?.total ?? 0)}` : d ? `共 ${fmtNum(d.total)} 人` : '—'),
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
          h('small.muted', null, `第 ${info.day} 期`),
          h('h2', null, `${mapName} · ${diffLabel(info.difficulty, info.abyssLevel ?? 1)}`),
          h(
            'div.daily-meta',
            null,
            h('span.badge', null, '纯净模式'),
            h('span.badge', null, '自动开波'),
            h('span.badge', null, '技能 Lv1'),
            h(
              'button.seed-btn',
              {
                attrs: { type: 'button' },
                title: '复制种子',
                onclick: async () => {
                  const ok = await copyText(info.seed);
                  app.toast(ok ? `种子 ${info.seed} 已复制` : '复制失败', ok ? 'good' : 'warn');
                },
              },
              `种子 ${info.seed}`,
            ),
          ),
        ),
        h('div.daily-count', { attrs: { title: '北京时间零点换新挑战' } }, h('small.muted', null, '距下一期'), countEl),
      ),
    );
    layoutBox.replaceChildren(layoutThumb(info.map, info.seed));
    setText(srcNote, source === 'local' ? '在线功能暂不可用：挑战内容由本地推算，成绩会在联网后上传。' : '');
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
    '开始挑战',
  );

  const el = h(
    'div.screen.daily-screen',
    null,
    screenHeader(app, '每日挑战'),
    h(
      'div.screen-body',
      null,
      h('section.card.section', null, heroBox, layoutBox, srcNote),
      h(
        'section.card.section',
        null,
        h('h3', null, '规则'),
        h(
          'ul.daily-rules',
          null,
          h('li', null, '每天北京时间零点换一期，所有人同一张地图、同一个种子。'),
          h('li', null, '固定纯净模式（不带天赋）、自动开波，技能按 1 级计算。'),
          h('li', null, '可以反复挑战，排行榜只保留你的最好成绩。'),
        ),
        bestBox,
      ),
      loadoutStrip(app, { name: 'daily' }),
      h('div.start-bar', null, startBtn),
      h('section.card.section', null, h('div.online-bar', null, h('h3', null, '今日排行'), nicknameChip(() => list.reload()), h('button.btn.small', { attrs: { type: 'button' }, onclick: () => (audio.play('click'), list.reload()) }, h('span.gi', { html: G.refresh }), '刷新')), list.el),
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
