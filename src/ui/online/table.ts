/**
 * 全服榜表格：名次 / 昵称 / 波数 / 得分 / 回放；未校验的成绩带「待验证」标记；
 * 自己的名次不在前 N 名里时追加一行「我的名次」。
 */
import { fetchLeaderboard, initOnline } from '../../meta/online';
import type { LeaderboardResponse, LeaderRow } from '../../shared/leaderboard';
import type { App } from '../App';
import { audio } from '../audio';
import { MAP_META } from '../coreMeta';
import { clear, h } from '../dom';
import { fmtNumber, t } from '../../i18n';
import { G } from '../icons';
import { openReplay } from './replay';
import { fmtTime } from './util';

export function stateBox(kind: 'loading' | 'empty' | 'error' | 'off', title: string, hint?: string, action?: HTMLElement): HTMLElement {
  return h(`div.online-state.${kind}`, { attrs: { role: kind === 'error' || kind === 'off' ? 'status' : null } }, h('p', null, title), hint ? h('small.muted', null, hint) : null, action ?? null);
}

function statusBadge(r: LeaderRow): HTMLElement | null {
  if (r.status === 'pending') return h('span.badge.pending', { title: t('ui.online.pendingTip') }, t('ui.online.pending'));
  if (r.status === 'rejected') return h('span.badge.rejected', { title: t('ui.online.rejectedTip') }, t('ui.online.rejected'));
  return null;
}

function rowEl(app: App, r: LeaderRow, i: number, me: boolean): HTMLElement {
  return h(
    `div.olb-row${r.rank <= 3 ? `.top${r.rank}` : ''}${me ? '.me' : ''}`,
    { style: `--i:${Math.min(i, 12)}`, title: t('ui.online.rowTip', { map: MAP_META[r.map]?.name ?? r.map, n: r.kills, kills: fmtNumber(Math.round(r.kills)), time: fmtTime(r.createdAt) }) },
    h('span.rank', null, r.rank <= 3 ? h('span.gi', { html: r.rank === 1 ? G.crown : G.trophy }) : String(r.rank)),
    h('span.name', null, h('span', null, r.nickname), me ? h('span.badge.me-tag', null, t('ui.online.me')) : null, statusBadge(r)),
    h('span.wave', null, t('ui.online.waves', { n: r.wave })),
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

/** 只渲染表格（纯 DOM，便于复用） */
export function leaderTable(app: App, data: LeaderboardResponse, myId?: string | null): HTMLElement {
  const table = h('div.olb-table', { attrs: { role: 'table', 'aria-label': t('ui.online.globalBoard') } });
  table.appendChild(
    h('div.olb-row.olb-head', { attrs: { role: 'row' } }, h('span', null, '#'), h('span', null, t('ui.online.col.nick')), h('span.wave', null, t('ui.online.col.wave')), h('span.score', null, t('ui.online.col.score')), h('span', null, t('ui.online.col.replay'))),
  );
  const meId = myId ?? data.me?.id ?? null;
  data.rows.forEach((r, i) => table.appendChild(rowEl(app, r, i, !!meId && r.id === meId)));
  const me = data.me;
  if (me && !data.rows.some((r) => r.id === me.id)) {
    table.appendChild(h('div.olb-gap', { attrs: { 'aria-hidden': 'true' } }, '···'));
    table.appendChild(rowEl(app, me, data.rows.length, true));
  }
  if (data.total > data.rows.length) table.appendChild(h('small.muted.olb-total', null, t('ui.online.totalRuns', { n: data.total, total: fmtNumber(data.total) })));
  return table;
}

export interface OnlineBoardView {
  el: HTMLElement;
  load(board: string): void;
  reload(): void;
}

/** 带加载 / 空 / 离线状态的全服榜 */
export function onlineBoard(app: App, o: { limit?: number; emptyHint?: string; onLoaded?: (d: LeaderboardResponse | null) => void } = {}): OnlineBoardView {
  const el = h('div.olb-host', { attrs: { 'aria-live': 'polite' } });
  let board = '';
  let seq = 0;
  const load = (b: string) => {
    board = b;
    const my = ++seq;
    clear(el);
    el.appendChild(stateBox('loading', t('ui.online.loading')));
    void (async () => {
      await initOnline();
      const r = await fetchLeaderboard(board, { limit: o.limit ?? 50, around: true });
      if (my !== seq || !el.isConnected) return;
      clear(el);
      const retry = h('button.btn.small', { attrs: { type: 'button' }, onclick: () => (audio.play('click'), load(board)) }, h('span.gi', { html: G.refresh }), t('ui.online.retry'));
      if (!r.ok) {
        o.onLoaded?.(null);
        if (r.status === 'unavailable') el.appendChild(stateBox('off', t('ui.online.unavailable'), t('ui.online.unavailableHint')));
        else if (r.status === 'offline') el.appendChild(stateBox('off', t('ui.online.offline'), t('ui.online.offlineHint'), retry));
        else el.appendChild(stateBox('error', t('ui.online.loadFailed'), r.message, retry));
        return;
      }
      o.onLoaded?.(r.data);
      if (r.data.rows.length === 0) {
        el.appendChild(stateBox('empty', t('ui.online.emptyBoard'), o.emptyHint ?? t('ui.online.emptyHint')));
        return;
      }
      el.appendChild(leaderTable(app, r.data, r.data.me?.id ?? null));
    })();
  };
  return { el, load, reload: () => board && load(board) };
}
