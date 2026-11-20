import { allDiffKeys, keyLabel, leaderKey } from '../../meta/progress';
import { screenHeader, type App, type Screen } from '../App';
import { audio } from '../audio';
import { MAP_META } from '../coreMeta';
import { clear, copyText, fmtNum, h } from '../dom';

export function leaderboardScreen(app: App): Screen {
  const p = app.store.get();
  // 默认选中有记录的第一个难度
  const keys = allDiffKeys();
  const state = {
    key: keys.find((k) => (p.leaderboard[k]?.length ?? 0) > 0) ?? 'normal',
    pure: false,
  };
  const tabs = h('div.tabs.scroll-x', { attrs: { role: 'tablist' } });
  const pureSeg = h('div.seg-grid.two');
  const table = h('div.board-table');

  const render = () => {
    clear(tabs);
    for (const k of keys) {
      const has = (p.leaderboard[k]?.length ?? 0) + (p.leaderboard[`${k}:pure`]?.length ?? 0) > 0;
      tabs.appendChild(
        h(
          `button.tab${state.key === k ? '.on' : ''}${k.startsWith('abyss') ? '.abyss' : ''}${has ? '' : '.empty'}`,
          {
            attrs: { role: 'tab', 'aria-selected': state.key === k ? 'true' : 'false' },
            onclick: () => {
              audio.play('click');
              state.key = k;
              render();
            },
          },
          keyLabel(k),
        ),
      );
    }
    clear(pureSeg);
    for (const pure of [false, true]) {
      pureSeg.appendChild(
        h(
          `button.seg${state.pure === pure ? '.on' : ''}`,
          {
            onclick: () => {
              audio.play('click');
              state.pure = pure;
              render();
            },
          },
          pure ? '纯净模式' : '启用天赋',
        ),
      );
    }
    clear(table);
    const list = p.leaderboard[leaderKey(state.key, state.pure)] ?? [];
    if (list.length === 0) {
      table.appendChild(h('div.empty-state', null, h('p', null, '还没有记录'), h('small.muted', null, '在无尽模式里撑过几波，成绩就会出现在这里。')));
    } else {
      table.appendChild(
        h(
          'div.lb-row.lb-head',
          null,
          h('span', null, '#'),
          h('span', null, '得分'),
          h('span', null, '波数'),
          h('span.hide-narrow', null, '地图'),
          h('span.hide-narrow', null, '日期'),
          h('span', null, '种子'),
        ),
      );
      list.forEach((e, i) => {
        table.appendChild(
          h(
            `div.lb-row${i < 3 ? `.top${i + 1}` : ''}`,
            null,
            h('span.rank', null, String(i + 1)),
            h('span.score', null, fmtNum(e.score)),
            h('span', null, `${e.wave} 波`),
            h('span.hide-narrow', null, MAP_META[e.map]?.name ?? e.map),
            h('span.hide-narrow.muted', null, e.date),
            h(
              'button.seed-btn',
              {
                title: '复制种子',
                onclick: async () => {
                  const ok = await copyText(e.seed);
                  app.toast(ok ? `种子 ${e.seed} 已复制` : '复制失败', ok ? 'good' : 'warn');
                },
              },
              e.seed || '—',
            ),
          ),
        );
      });
    }
  };

  const best = p.customBest;
  const el = h(
    'div.screen.leaderboard-screen',
    null,
    screenHeader(app, '排行榜'),
    h(
      'div.screen-body',
      null,
      h('section.card.section', null, tabs, pureSeg, table),
      h(
        'section.card.section',
        null,
        h('h3', null, '自定义 · 个人最佳'),
        best ? h('p', null, `${fmtNum(best.score)} 分 · ${best.wave} 波 · ${best.date}`) : h('p.muted', null, '还没有记录'),
      ),
    ),
  );
  render();
  return { el };
}
