import { allDiffKeys, keyLabel, leaderKey } from '../../meta/progress';
import { dailyInfo, dayOf, parseBoard } from '../../shared/leaderboard';
import { fetchDaily } from '../../meta/online';
import { screenHeader, type App, type Screen } from '../App';
import { audio } from '../audio';
import { MAP_META } from '../coreMeta';
import { clear, copyText, fmtNum, h } from '../dom';
import { G } from '../icons';
import { takeLeaderboardRequest, type LbTab } from '../online/nav';
import { nicknameChip } from '../online/nickname';
import { onlineBoard } from '../online/table';
import { aiBoard } from '../ai/board';

/** 'ai'：AI 榜（文档 10 §13），成绩来自「AI 参战」，与真人榜完全分开 */
type Tab = LbTab | 'ai';
const TAB_NAME: Record<Tab, string> = { local: '本地', global: '全服', daily: '每日挑战', ai: 'AI 榜' };

export function leaderboardScreen(app: App): Screen {
  const p = app.store.get();
  const req = takeLeaderboardRequest();
  // 默认选中有记录的第一个难度
  const keys = allDiffKeys();
  const count = (k: string) =>
    [false, true].reduce((n, pure) => n + [false, true].reduce((m, auto) => m + (p.leaderboard[leaderKey(k, pure, auto)]?.length ?? 0), 0), 0);
  const firstKey = keys.find((k) => count(k) > 0) ?? 'normal';
  const state = {
    tab: (req?.tab ?? 'local') as Tab,
    key: firstKey,
    pure: false,
    // 默认显示有记录的开波方式（优先自动）
    auto: (p.leaderboard[leaderKey(firstKey, false, true)]?.length ?? 0) > 0 || (p.leaderboard[leaderKey(firstKey, false, false)]?.length ?? 0) === 0,
  };
  // 从结算面板跳过来：直接定位到那一局的榜
  const reqAi = !!req?.board?.startsWith('ai:');
  if (reqAi) state.tab = 'ai';
  const parsed = req?.board ? parseBoard(reqAi ? req.board.slice(3) : req.board) : null;
  if (parsed?.kind === 'endless') {
    state.key = parsed.difficulty === 'abyss' ? `abyss${parsed.abyssLevel ?? 1}` : parsed.difficulty;
    state.pure = parsed.pure;
    state.auto = parsed.auto;
  } else if (parsed?.kind === 'daily') state.tab = 'daily';

  const modeTabs = h('div.lb-mode-tabs', { attrs: { role: 'tablist', 'aria-label': '排行榜类型' } });
  const tabs = h('div.tabs.scroll-x', { attrs: { role: 'tablist' } });
  const pureSeg = h('div.seg-grid.two');
  const autoSeg = h('div.seg-grid.two');
  const filters = h('div.lb-filters', null, pureSeg, autoSeg);
  const table = h('div.board-table');
  const global = onlineBoard(app, { limit: 50 });
  const daily = onlineBoard(app, { limit: 50, emptyHint: '今天还没有人上榜，去挑战一下吧！' });
  const aiView = aiBoard(app, { limit: 50 });
  const aiNote = h('p.muted.small.ai-lb-note', null, '大模型在「AI 参战」里打出的成绩，每个模型各记一条最佳；真人成绩不在这里。');
  const dailyHead = h('div.online-bar');
  const customCard = h('section.card.section');
  const nickBar = h(
    'div.online-bar.lb-nick-bar',
    null,
    nicknameChip(() => {
      global.reload();
      daily.reload();
    }),
  );

  const filterSection = h('section.card.section', null, tabs, filters, table, global.el, aiNote, aiView.el);
  const dailySection = h('section.card.section', null, dailyHead, daily.el);

  let dailyLoaded = false;
  let globalBoard = '';
  let aiBoardShown = '';
  const showDaily = async () => {
    if (dailyLoaded) return;
    dailyLoaded = true;
    let info = dailyInfo(dayOf(Date.now()));
    paintDailyHead(info.day, MAP_META[info.map]?.name ?? info.map);
    daily.load(info.board);
    const r = await fetchDaily();
    if (r.ok && r.data.board !== info.board) {
      info = r.data;
      paintDailyHead(info.day, MAP_META[info.map]?.name ?? info.map);
      daily.load(info.board);
    }
  };
  const paintDailyHead = (day: string, map: string) => {
    clear(dailyHead);
    dailyHead.append(
      h('div', null, h('h3', null, `今日挑战 · ${map}`), h('small.muted', null, `第 ${day} 期 · 北京时间零点换期`)),
      h(
        'button.btn.small.primary',
        { attrs: { type: 'button' }, onclick: () => (audio.play('click'), app.go({ name: 'daily' })) },
        h('span.gi', { html: G.play }),
        '去挑战',
      ),
    );
  };

  const seg = (on: boolean, label: string, fn: () => void) =>
    h(
      `button.seg${on ? '.on' : ''}`,
      {
        attrs: { type: 'button', 'aria-pressed': on ? 'true' : 'false' },
        onclick: () => {
          audio.play('click');
          fn();
          render();
        },
      },
      label,
    );

  const render = () => {
    clear(modeTabs);
    for (const t of ['local', 'global', 'daily', 'ai'] as Tab[]) {
      modeTabs.appendChild(
        h(
          `button.seg${state.tab === t ? '.on' : ''}`,
          {
            attrs: { type: 'button', role: 'tab', 'aria-selected': state.tab === t ? 'true' : 'false' },
            onclick: () => {
              if (state.tab === t) return;
              audio.play('click');
              state.tab = t;
              render();
            },
          },
          TAB_NAME[t],
        ),
      );
    }
    const local = state.tab === 'local';
    filterSection.hidden = state.tab === 'daily';
    dailySection.hidden = state.tab !== 'daily';
    customCard.hidden = !local;
    nickBar.hidden = local || state.tab === 'ai';
    table.hidden = !local;
    global.el.hidden = state.tab !== 'global';
    aiView.el.hidden = aiNote.hidden = state.tab !== 'ai';
    if (state.tab === 'daily') {
      void showDaily();
      return;
    }

    clear(tabs);
    for (const k of keys) {
      const has = count(k) > 0;
      tabs.appendChild(
        h(
          `button.tab${state.key === k ? '.on' : ''}${k.startsWith('abyss') ? '.abyss' : ''}${has || !local ? '' : '.empty'}`,
          {
            attrs: { type: 'button', role: 'tab', 'aria-selected': state.key === k ? 'true' : 'false' },
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
    for (const pure of [false, true]) pureSeg.appendChild(seg(state.pure === pure, pure ? '纯净模式' : '启用天赋', () => (state.pure = pure)));
    clear(autoSeg);
    for (const auto of [true, false]) autoSeg.appendChild(seg(state.auto === auto, auto ? '自动开波' : '手动开波', () => (state.auto = auto)));

    const board = leaderKey(state.key, state.pure, state.auto);
    if (state.tab === 'ai') {
      if (board !== aiBoardShown) {
        aiBoardShown = board;
        aiView.load(board);
      }
      return;
    }
    if (!local) {
      if (board !== globalBoard) {
        globalBoard = board;
        global.load(board);
      }
      return;
    }
    clear(table);
    const list = p.leaderboard[board] ?? [];
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
            h('span', null, `${e.wave} 波`, h(`small.wave-mode${e.auto ? '.auto' : ''}`, null, e.auto ? '自动' : '手动')),
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
  customCard.append(
    h('h3', null, '自定义 · 个人最佳'),
    best ? h('p', null, `${fmtNum(best.score)} 分 · ${best.wave} 波 · ${best.date}`) : h('p.muted', null, '还没有记录'),
  );
  const el = h(
    'div.screen.leaderboard-screen',
    null,
    screenHeader(app, '排行榜'),
    h('div.screen-body', null, modeTabs, nickBar, filterSection, dailySection, customCard),
  );
  render();
  return { el };
}
