import { allDiffKeys, keyLabel, leaderKey, leaderView } from '../../meta/progress';
import { dailyInfo, dayOf, parseBoard } from '../../shared/leaderboard';
import { fetchDaily } from '../../meta/online';
import { fmtNumber, t } from '../../i18n';
import { fmtDay } from '../online/util';
import { screenHeader, type App, type Screen } from '../App';
import { audio } from '../audio';
import { MAP_META } from '../coreMeta';
import { clear, copyText, h } from '../dom';
import { G } from '../icons';
import { takeLeaderboardRequest, type LbTab } from '../online/nav';
import { nicknameChip } from '../online/nickname';
import { onlineBoard } from '../online/table';
import { aiBoard } from '../ai/board';

/** 'ai'：AI 榜（文档 10 §13），成绩来自「AI 参战」，与真人榜完全分开 */
type Tab = LbTab | 'ai';
const tabName = (tab: Tab): string => t(`ui.leaderboard.tab.${tab}`);

export function leaderboardScreen(app: App): Screen {
  const p = app.store.get();
  const req = takeLeaderboardRequest();
  // 默认选中有记录的第一个难度
  const keys = allDiffKeys();
  const count = (k: string) =>
    [false, true].reduce(
      (n, pure) => n + [false, true].reduce((m, auto) => m + (p.leaderboard[leaderKey(k, pure, auto)]?.length ?? 0), 0),
      0,
    );
  const firstKey = keys.find((k) => count(k) > 0) ?? 'normal';
  const state = {
    tab: (req?.tab ?? 'local') as Tab,
    key: firstKey,
    pure: false,
    // 默认显示有记录的开波方式（优先自动）
    auto:
      (p.leaderboard[leaderKey(firstKey, false, true)]?.length ?? 0) > 0 ||
      (p.leaderboard[leaderKey(firstKey, false, false)]?.length ?? 0) === 0,
    /** 本地榜：显示 AI 协助（「让 AI 替我玩」）的成绩（默认不显示） */
    showAi: false,
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

  const modeTabs = h('div.lb-mode-tabs', { attrs: { role: 'tablist', 'aria-label': t('ui.leaderboard.typeLabel') } });
  const tabs = h('div.tabs.scroll-x', { attrs: { role: 'tablist' } });
  const pureSeg = h('div.seg-grid.two');
  const autoSeg = h('div.seg-grid.two');
  const filters = h('div.lb-filters', null, pureSeg, autoSeg);
  const table = h('div.board-table');
  // 本地榜：AI 协助的成绩默认隐藏，有这类成绩时给一个开关
  const aiToggleInput = h<HTMLInputElement>('input', { attrs: { type: 'checkbox' } });
  aiToggleInput.onchange = () => {
    audio.play('click');
    state.showAi = aiToggleInput.checked;
    render();
  };
  const aiToggle = h(
    'label.switch-row.lb-ai-toggle',
    null,
    h('span', null, h('b', null, t('ui.assist.lbShow')), h('small.muted', null, t('ui.assist.lbShowHint'))),
    h('span.switch', null, aiToggleInput, h('span.knob')),
  );
  const global = onlineBoard(app, { limit: 50 });
  const daily = onlineBoard(app, { limit: 50, emptyHint: t('ui.leaderboard.dailyEmpty') });
  const aiView = aiBoard(app, { limit: 50 });
  const aiNote = h('p.muted.small.ai-lb-note', null, t('ui.leaderboard.aiNote'));
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

  const filterSection = h('section.card.section', null, tabs, filters, aiToggle, table, global.el, aiNote, aiView.el);
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
      h('div', null, h('h3', null, t('ui.leaderboard.dailyTitle', { map })), h('small.muted', null, t('ui.leaderboard.dailySub', { day }))),
      h(
        'button.btn.small.primary',
        { attrs: { type: 'button' }, onclick: () => (audio.play('click'), app.go({ name: 'daily' })) },
        h('span.gi', { html: G.play }),
        t('ui.leaderboard.goChallenge'),
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
    for (const tab of ['local', 'global', 'daily', 'ai'] as Tab[]) {
      modeTabs.appendChild(
        h(
          `button.seg${state.tab === tab ? '.on' : ''}`,
          {
            attrs: { type: 'button', role: 'tab', 'aria-selected': state.tab === tab ? 'true' : 'false' },
            onclick: () => {
              if (state.tab === tab) return;
              audio.play('click');
              state.tab = tab;
              render();
            },
          },
          tabName(tab),
        ),
      );
    }
    const local = state.tab === 'local';
    filterSection.hidden = state.tab === 'daily';
    dailySection.hidden = state.tab !== 'daily';
    customCard.hidden = !local;
    nickBar.hidden = local || state.tab === 'ai';
    table.hidden = !local;
    aiToggle.hidden = true;
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
    for (const pure of [false, true])
      pureSeg.appendChild(
        seg(state.pure === pure, pure ? t('ui.leaderboard.pure') : t('ui.leaderboard.talents'), () => (state.pure = pure)),
      );
    clear(autoSeg);
    for (const auto of [true, false])
      autoSeg.appendChild(
        seg(state.auto === auto, auto ? t('ui.leaderboard.autoWave') : t('ui.leaderboard.manualWave'), () => (state.auto = auto)),
      );

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
    const all = p.leaderboard[board] ?? [];
    const hiddenAi = all.filter((e) => e.ai).length;
    aiToggle.hidden = !hiddenAi;
    aiToggleInput.checked = state.showAi;
    const list = leaderView(all, state.showAi);
    if (list.length === 0) {
      table.appendChild(
        h('div.empty-state', null, h('p', null, t('ui.leaderboard.noRecord')), h('small.muted', null, t('ui.leaderboard.noRecordHint'))),
      );
    } else {
      table.appendChild(
        h(
          'div.lb-row.lb-head',
          null,
          h('span', null, '#'),
          h('span', null, t('ui.leaderboard.col.score')),
          h('span', null, t('ui.leaderboard.col.wave')),
          h('span.hide-narrow', null, t('ui.leaderboard.col.map')),
          h('span.hide-narrow', null, t('ui.leaderboard.col.date')),
          h('span', null, t('ui.leaderboard.col.seed')),
        ),
      );
      list.forEach((e, i) => {
        table.appendChild(
          h(
            `div.lb-row${i < 3 ? `.top${i + 1}` : ''}`,
            null,
            h('span.rank', null, String(i + 1)),
            h(
              'span.score',
              null,
              fmtNumber(Math.round(e.score)),
              e.ai ? h('small.badge.ai-assist-badge', { title: t('ui.assist.badgeTip') }, t('ui.assist.badge')) : null,
            ),
            h(
              'span',
              null,
              t('ui.leaderboard.waves', { n: e.wave }),
              h(`small.wave-mode${e.auto ? '.auto' : ''}`, null, e.auto ? t('ui.leaderboard.auto') : t('ui.leaderboard.manual')),
            ),
            h('span.hide-narrow', null, MAP_META[e.map]?.name ?? e.map),
            h('span.hide-narrow.muted', null, fmtDay(e.date)),
            h(
              'button.seed-btn',
              {
                title: t('ui.leaderboard.copySeed'),
                onclick: async () => {
                  const ok = await copyText(e.seed);
                  app.toast(ok ? t('ui.leaderboard.seedCopied', { seed: e.seed }) : t('ui.leaderboard.copyFailed'), ok ? 'good' : 'warn');
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
    h('h3', null, t('ui.leaderboard.customBest')),
    best
      ? h('p', null, t('ui.leaderboard.customBestLine', { score: fmtNumber(best.score), wave: best.wave, date: fmtDay(best.date) }))
      : h('p.muted', null, t('ui.leaderboard.noRecord')),
  );
  const el = h(
    'div.screen.leaderboard-screen',
    null,
    screenHeader(app, t('ui.leaderboard.title')),
    h('div.screen-body', null, modeTabs, nickBar, filterSection, dailySection, customCard),
  );
  render();
  return { el };
}
