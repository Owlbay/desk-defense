/**
 * 排行榜（文档 12 §3 / §7）：三张全服榜 + 独立的 AI 对战榜，选择尽量少。
 *  - 无尽：所有无尽成绩一张榜（得分已含难度倍率），每行标难度 / 魔境等级 / 波数；
 *  - 每日：今天（可切到昨天）；
 *  - 战役：每章一张（第一章 / 第二章 / 第三章），按评星 → 得分排；
 *  - AI 对战：进攻方模型 vs 防守方模型，独立一张（./online/duels.ts），行上是双方模型 + 思考档位；
 * 顶部一行：昵称 · 自动上传成绩 · 隐藏 AI 辅助；榜单上方固定「我的最佳」；底部「我的记录」（本设备最近 N 局）。
 */
import type { MapId } from '../../core/types';
import { fmtNumber, t } from '../../i18n';
import { type HistoryEntry, readHistory } from '../../meta/history';
import { getAutoUpload, setAutoUpload } from '../../meta/online';
import { diffLabel } from '../../meta/progress';
import {
  campaignBoardKey,
  dailyBoardKey,
  dailyInfo,
  dayOf,
  type DuelBoardResponse,
  ENDLESS_BOARD,
  type LeaderboardResponse,
  MAPS,
  modelTagText,
} from '../../shared/leaderboard';
import { type App, type Screen, screenHeader } from '../App';
import { audio } from '../audio';
import { MAP_META } from '../coreMeta';
import { append, clear, h, setText } from '../dom';
import { G } from '../icons';
import { duelBoard, openDuelDetail } from '../online/duels';
import { type LbTab, takeLeaderboardRequest } from '../online/nav';
import { nicknameChip } from '../online/nickname';
import { onlineBoard } from '../online/table';
import { fmtTime } from '../online/util';

const HIDE_AI_KEY = 'desk-defense.lb.hideAi.v1';

function loadHideAi(): boolean {
  try {
    return localStorage.getItem(HIDE_AI_KEY) === '1';
  } catch {
    return false;
  }
}
function saveHideAi(v: boolean): void {
  try {
    if (v) localStorage.setItem(HIDE_AI_KEY, '1');
    else localStorage.removeItem(HIDE_AI_KEY);
  } catch {
    /* ignore */
  }
}

/** 开关行（与设置页同款 .switch-row） */
function switchRow(label: string, hint: string, on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const input = h<HTMLInputElement>('input', { attrs: { type: 'checkbox' } });
  input.checked = on;
  input.onchange = () => {
    audio.play('click');
    onChange(input.checked);
  };
  return h(
    'label.switch-row',
    null,
    h('span', null, h('b', null, label), h('small.muted', null, hint)),
    h('span.switch', null, input, h('span.knob')),
  );
}

function seg(on: boolean, label: string, onclick: () => void, role = 'tab'): HTMLElement {
  return h(
    `button.seg${on ? '.on' : ''}`,
    {
      attrs: { type: 'button', role, [role === 'tab' ? 'aria-selected' : 'aria-pressed']: on ? 'true' : 'false' },
      onclick: () => {
        if (on) return;
        audio.play('click');
        onclick();
      },
    },
    label,
  );
}

const mapName = (m: MapId): string => MAP_META[m]?.name ?? m;

/** 「我的记录」一行（AI 对战条目带双方模型 + 档位和「详情」按钮） */
function historyRow(app: App, e: HistoryEntry): HTMLElement {
  const mode =
    e.mode === 'campaign'
      ? t('ui.lb.hist.campaign', { map: mapName(e.map) })
      : e.daily
        ? t('ui.lb.hist.daily', { day: e.daily })
        : e.mode === 'custom'
          ? t('ui.lb.hist.custom')
          : t('ui.lb.hist.endless');
  const result =
    e.mode === 'campaign'
      ? e.won
        ? t('ui.lb.stars', { n: e.stars ?? 1 })
        : t('ui.lb.failedAt', { n: e.wave })
      : t('ui.online.waves', { n: e.wave });
  return h(
    'div.lb-hist-row',
    null,
    h(
      'span.lb-hist-main',
      null,
      h('b', null, mode),
      h(
        'small.muted',
        null,
        e.mode === 'custom' ? '' : `${diffLabel(e.difficulty, e.abyssLevel ?? 1)} · `,
        result,
        e.at > 0 ? ` · ${fmtTime(e.at)}` : '',
      ),
      e.duel
        ? h(
            'small.lb-hist-duel',
            null,
            t('ui.duel.vs', {
              attacker: modelTagText(e.duel.attacker, e.duel.atkEffort),
              defender: modelTagText(e.duel.defender, e.duel.defEffort),
            }),
          )
        : null,
    ),
    h(
      'span.lb-hist-tags',
      null,
      e.duel ? h('span.badge.lb-ai-badge', null, t('agent.duel.badge')) : null,
      e.ai ? h('span.badge.lb-ai-badge', null, t('ui.lb.ai')) : null,
      e.ranked ? null : h('span.badge.lb-unranked', null, t('ui.lb.unranked')),
      e.duel
        ? h(
            'button.btn.small.lb-hist-more',
            {
              attrs: { type: 'button' },
              onclick: () => {
                audio.play('click');
                openDuelDetail(app, e.duel!.id);
              },
            },
            t('ui.duel.details'),
          )
        : null,
    ),
    h('span.lb-hist-score', null, fmtNumber(Math.round(e.score))),
  );
}

export function leaderboardScreen(app: App): Screen {
  const req = takeLeaderboardRequest();
  const today = dayOf(Date.now());
  const yesterday = dayOf(Date.now() - 86_400_000);
  const state = {
    tab: (req?.tab ?? 'endless') as LbTab,
    daily: req?.day === yesterday ? yesterday : today,
    map: (req?.map ?? 'ch1') as MapId,
    hideAi: loadHideAi(),
  };

  const tabs = h('div.lb-mode-tabs', { attrs: { role: 'tablist', 'aria-label': t('ui.leaderboard.typeLabel') } });
  const sub = h('div.lb-sub');
  const note = h('p.muted.small.lb-note');
  const myBest = h('div.lb-my-best', { attrs: { 'aria-live': 'polite' } });
  const paintMine = (d: LeaderboardResponse | null) => {
    clear(myBest);
    const me = d?.me ?? null;
    myBest.append(
      h('span.lb-my-label', null, h('span.gi', { html: G.trophy }), t('ui.lb.myBest')),
      me
        ? h(
            'span.lb-my-value',
            null,
            t('ui.lb.myBestLine', { rank: fmtNumber(me.rank), total: fmtNumber(d?.total ?? 0), score: fmtNumber(me.score) }),
            me.ai ? h('span.badge.lb-ai-badge', null, t('ui.lb.ai')) : null,
          )
        : h('span.lb-my-value.muted', null, d ? t('ui.lb.myBestNone') : '—'),
    );
  };
  paintMine(null);
  const board = onlineBoard(app, { limit: 50, onLoaded: paintMine });
  const paintDuelMine = (d: DuelBoardResponse | null) => {
    clear(myBest);
    const me = d?.me ?? null;
    myBest.append(
      h('span.lb-my-label', null, h('span.gi', { html: G.trophy }), t('ui.lb.myBest')),
      me
        ? h('span.lb-my-value', null, t('ui.duel.myBestLine', { rank: fmtNumber(me.rank), total: fmtNumber(d?.total ?? 0), n: me.wave }))
        : h('span.lb-my-value.muted', null, d ? t('ui.duel.myBestNone') : '—'),
    );
  };
  const duels = duelBoard(app, { limit: 50, onLoaded: paintDuelMine });
  const boardHost = h('div.lb-board-host', null, board.el);

  const boardKey = (): string =>
    state.tab === 'daily' ? dailyBoardKey(state.daily) : state.tab === 'campaign' ? campaignBoardKey(state.map) : ENDLESS_BOARD;

  const load = () => {
    paintMine(null);
    if (state.tab === 'duel') {
      if (boardHost.firstChild !== duels.el) boardHost.replaceChildren(duels.el);
      duels.load();
      return;
    }
    if (boardHost.firstChild !== board.el) boardHost.replaceChildren(board.el);
    board.load(boardKey(), { hideAi: state.hideAi });
  };

  const render = () => {
    clear(tabs);
    for (const tab of ['endless', 'daily', 'campaign', 'duel'] as LbTab[])
      tabs.appendChild(
        seg(state.tab === tab, tab === 'duel' ? t('ui.duel.tab') : t(`ui.lb.tab.${tab}`), () => {
          state.tab = tab;
          render();
        }),
      );
    clear(sub);
    if (state.tab === 'daily') {
      const info = dailyInfo(state.daily);
      append(sub, [
        h(
          'div.seg-grid.two.lb-sub-seg',
          { attrs: { role: 'group' } },
          seg(state.daily === today, t('ui.lb.today'), () => ((state.daily = today), render()), 'button'),
          seg(state.daily === yesterday, t('ui.lb.yesterday'), () => ((state.daily = yesterday), render()), 'button'),
        ),
        state.daily === today
          ? h(
              'button.btn.small.primary',
              { attrs: { type: 'button' }, onclick: () => (audio.play('click'), app.go({ name: 'daily' })) },
              h('span.gi', { html: G.play }),
              t('ui.leaderboard.goChallenge'),
            )
          : null,
      ]);
      setText(
        note,
        t('ui.lb.dailyNote', { day: info.day, map: mapName(info.map), diff: diffLabel(info.difficulty, info.abyssLevel ?? 1) }),
      );
    } else if (state.tab === 'campaign') {
      sub.append(
        h(
          'div.seg-grid.lb-sub-seg.lb-maps',
          { attrs: { role: 'group' } },
          MAPS.map((m) => seg(state.map === m, mapName(m), () => ((state.map = m), render()), 'button')),
        ),
      );
      setText(note, t('ui.lb.campaignNote'));
    } else if (state.tab === 'duel') setText(note, t('ui.duel.note'));
    else setText(note, t('ui.lb.endlessNote'));
    sub.hidden = sub.childElementCount === 0;
    load();
  };

  const settings = h(
    'section.card.section.lb-settings',
    null,
    h(
      'div.online-bar',
      null,
      nicknameChip(() => load()),
    ),
    h(
      'div.lb-switches',
      null,
      switchRow(t('ui.lb.autoUpload'), t('ui.lb.autoUploadHint'), getAutoUpload(), (v) => setAutoUpload(v)),
      switchRow(t('ui.lb.hideAi'), t('ui.lb.hideAiHint'), state.hideAi, (v) => {
        state.hideAi = v;
        saveHideAi(v);
        load();
      }),
    ),
  );

  const history = readHistory(app.store.get());
  const historyCard = h(
    'section.card.section.lb-history',
    null,
    h('h3', null, t('ui.lb.history')),
    history.length ? h('p.muted.small', null, t('ui.lb.historyHint', { n: history.length })) : null,
    history.length
      ? h(
          'div.lb-hist',
          null,
          history.map((e) => historyRow(app, e)),
        )
      : h('div.empty-state', null, h('p', null, t('ui.leaderboard.noRecord')), h('small.muted', null, t('ui.lb.historyEmpty'))),
  );

  const el = h(
    'div.screen.leaderboard-screen',
    null,
    screenHeader(app, t('ui.leaderboard.title')),
    h('div.screen-body', null, tabs, h('section.card.section.lb-board', null, sub, note, myBest, boardHost), settings, historyCard),
  );
  render();
  return { el };
}
