/**
 * 全服榜表格：名次 / 昵称（我 / AI 辅助 / 兜底多 / 待验证标记）/ 详情（难度 + 波数，或战役评星）/ 得分 / 回放。
 * 自己的名次不在前 N 名里时追加一行「我的名次」。
 */
import { fmtNumber, t } from '../../i18n';
import { fetchLeaderboard, initOnline } from '../../meta/online';
import { diffLabel } from '../../meta/progress';
import { AI_BOT_SHARE_FLAG, type LeaderboardResponse, type LeaderRow, parseBoard } from '../../shared/leaderboard';
import type { App } from '../App';
import { audio } from '../audio';
import { MAP_META } from '../coreMeta';
import { clear, h } from '../dom';
import { G } from '../icons';
import { openReplay } from './replay';
import { fmtTime } from './util';

export function stateBox(kind: 'loading' | 'empty' | 'error' | 'off', title: string, hint?: string, action?: HTMLElement): HTMLElement {
  return h(
    `div.online-state.${kind}`,
    { attrs: { role: kind === 'error' || kind === 'off' ? 'status' : null } },
    h('p', null, title),
    hint ? h('small.muted', null, hint) : null,
    action ?? null,
  );
}

function statusBadge(r: LeaderRow): HTMLElement | null {
  if (r.status === 'pending') return h('span.badge.pending', { title: t('ui.online.pendingTip') }, t('ui.online.pending'));
  if (r.status === 'rejected') return h('span.badge.rejected', { title: t('ui.online.rejectedTip') }, t('ui.online.rejected'));
  return null;
}

/** 「AI 辅助」标记；AI 参战的成绩再带模型名 */
export function aiBadge(r: Pick<LeaderRow, 'ai' | 'aiModel' | 'agent'>): HTMLElement | null {
  if (!r.ai) return null;
  const model = r.agent?.model ?? r.aiModel;
  return h(
    'span.badge.lb-ai-badge',
    { title: model ? t('ui.lb.aiTip', { model }) : t('ui.lb.aiTipNoModel') },
    t('ui.lb.ai'),
    r.agent ? h('small.lb-ai-model', null, r.agent.model) : null,
  );
}

/** 「兜底多」：AI 辅助局里兜底机器人决策占比超过 20%（照常排名，只是标注；docs/10 §18-6） */
export function botHeavyBadge(r: Pick<LeaderRow, 'botHeavy'>): HTMLElement | null {
  if (!r.botHeavy) return null;
  return h(
    'span.badge.pending.lb-bot-badge',
    { title: t('ui.lb.botHeavyTip', { limit: Math.round(AI_BOT_SHARE_FLAG * 100) }) },
    t('ui.lb.botHeavy'),
  );
}

/** 战役评星 ★★☆；失败显示「第 N 波」 */
function starsEl(r: LeaderRow): HTMLElement {
  if (!r.won) return h('span.lb-fail', null, t('ui.lb.failedAt', { n: r.wave }));
  return h(
    'span.lb-stars',
    { attrs: { 'aria-label': t('ui.lb.stars', { n: r.stars }) } },
    [1, 2, 3].map((i) => h(`span.lb-star${i <= r.stars ? '.on' : ''}`, { html: G.star })),
  );
}

const diffTag = (r: LeaderRow): HTMLElement => h(`span.lb-diff.d-${r.difficulty}`, null, diffLabel(r.difficulty, r.abyssLevel ?? 1));

function detailEl(r: LeaderRow, kind: 'endless' | 'daily' | 'campaign'): HTMLElement {
  if (kind === 'campaign') return h('span.detail', null, starsEl(r), diffTag(r));
  if (kind === 'daily') return h('span.detail', null, t('ui.online.waves', { n: r.wave }));
  return h('span.detail', null, diffTag(r), h('span.lb-wave', null, t('ui.online.waves', { n: r.wave })));
}

function rowEl(app: App, r: LeaderRow, i: number, me: boolean, kind: 'endless' | 'daily' | 'campaign'): HTMLElement {
  return h(
    `div.olb-row${r.rank <= 3 ? `.top${r.rank}` : ''}${me ? '.me' : ''}${r.ai ? '.is-ai' : ''}`,
    {
      attrs: { role: 'row' },
      style: `--i:${Math.min(i, 12)}`,
      title: t('ui.online.rowTip', {
        map: MAP_META[r.map]?.name ?? r.map,
        n: r.kills,
        kills: fmtNumber(Math.round(r.kills)),
        time: fmtTime(r.createdAt),
      }),
    },
    h('span.rank', null, r.rank <= 3 ? h('span.gi', { html: r.rank === 1 ? G.crown : G.trophy }) : String(r.rank)),
    h(
      'span.name',
      null,
      h('span', null, r.nickname),
      me ? h('span.badge.me-tag', null, t('ui.online.me')) : null,
      aiBadge(r),
      botHeavyBadge(r),
      statusBadge(r),
    ),
    detailEl(r, kind),
    h('span.score', null, fmtNumber(Math.round(r.score))),
    h(
      'button.btn.olb-replay',
      {
        attrs: { type: 'button', 'aria-label': t('ui.online.watchReplayOf', { name: r.nickname }) },
        title: t('ui.online.watchReplay'),
        onclick: () => {
          audio.play('click');
          openReplay(app, r.id, r.nickname);
        },
      },
      h('span.gi', { html: G.play }),
    ),
  );
}

const kindOf = (board: string): 'endless' | 'daily' | 'campaign' => parseBoard(board)?.kind ?? 'endless';

/** 只渲染表格（纯 DOM，便于复用） */
export function leaderTable(app: App, data: LeaderboardResponse, myId?: string | null): HTMLElement {
  const kind = kindOf(data.board);
  const table = h(`div.olb-table.k-${kind}`, { attrs: { role: 'table', 'aria-label': t('ui.online.globalBoard') } });
  table.appendChild(
    h(
      'div.olb-row.olb-head',
      { attrs: { role: 'row' } },
      h('span', null, '#'),
      h('span', null, t('ui.online.col.nick')),
      h(
        'span.detail',
        null,
        kind === 'campaign' ? t('ui.lb.col.result') : kind === 'daily' ? t('ui.online.col.wave') : t('ui.lb.col.diffWave'),
      ),
      h('span.score', null, t('ui.online.col.score')),
      h('span', null, t('ui.online.col.replay')),
    ),
  );
  const meId = myId ?? data.me?.id ?? null;
  data.rows.forEach((r, i) => table.appendChild(rowEl(app, r, i, !!meId && r.id === meId, kind)));
  const me = data.me;
  if (me && !data.rows.some((r) => r.id === me.id)) {
    table.appendChild(h('div.olb-gap', { attrs: { 'aria-hidden': 'true' } }, '···'));
    table.appendChild(rowEl(app, me, data.rows.length, true, kind));
  }
  if (data.total > data.rows.length)
    table.appendChild(h('small.muted.olb-total', null, t('ui.online.totalRuns', { n: data.total, total: fmtNumber(data.total) })));
  return table;
}

export interface OnlineBoardView {
  el: HTMLElement;
  load(board: string, o?: { hideAi?: boolean }): void;
  reload(): void;
}

/** 带加载 / 空 / 离线状态的全服榜 */
export function onlineBoard(
  app: App,
  o: { limit?: number; emptyHint?: string; onLoaded?: (d: LeaderboardResponse | null) => void } = {},
): OnlineBoardView {
  const el = h('div.olb-host', { attrs: { 'aria-live': 'polite' } });
  let board = '';
  let hideAi = false;
  let seq = 0;
  const load = (b: string, lo?: { hideAi?: boolean }) => {
    board = b;
    if (lo && lo.hideAi !== undefined) hideAi = lo.hideAi;
    const my = ++seq;
    clear(el);
    el.appendChild(stateBox('loading', t('ui.online.loading')));
    void (async () => {
      await initOnline();
      const r = await fetchLeaderboard(board, { limit: o.limit ?? 50, around: true, hideAi });
      if (my !== seq || !el.isConnected) return;
      clear(el);
      const retry = h(
        'button.btn.small',
        { attrs: { type: 'button' }, onclick: () => (audio.play('click'), load(board)) },
        h('span.gi', { html: G.refresh }),
        t('ui.online.retry'),
      );
      if (!r.ok) {
        o.onLoaded?.(null);
        if (r.status === 'unavailable') el.appendChild(stateBox('off', t('ui.online.unavailable'), t('ui.lb.unavailableHint')));
        else if (r.status === 'offline') el.appendChild(stateBox('off', t('ui.online.offline'), t('ui.online.offlineHint'), retry));
        else el.appendChild(stateBox('error', t('ui.online.loadFailed'), r.message, retry));
        return;
      }
      o.onLoaded?.(r.data);
      if (r.data.rows.length === 0) {
        el.appendChild(stateBox('empty', t('ui.online.emptyBoard'), o.emptyHint ?? t('ui.lb.emptyHint')));
        return;
      }
      el.appendChild(leaderTable(app, r.data, r.data.me?.id ?? null));
    })();
  };
  return { el, load, reload: () => board && load(board) };
}
