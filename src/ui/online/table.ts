/**
 * 全服榜表格：名次 / 昵称 / 波数 / 得分 / 回放；未校验的成绩带「待验证」标记；
 * 自己的名次不在前 N 名里时追加一行「我的名次」。
 */
import { fetchLeaderboard, initOnline } from '../../meta/online';
import type { LeaderboardResponse, LeaderRow } from '../../shared/leaderboard';
import type { App } from '../App';
import { audio } from '../audio';
import { MAP_META } from '../coreMeta';
import { clear, fmtNum, h } from '../dom';
import { G } from '../icons';
import { openReplay } from './replay';
import { fmtTime } from './util';

export function stateBox(kind: 'loading' | 'empty' | 'error' | 'off', title: string, hint?: string, action?: HTMLElement): HTMLElement {
  return h(`div.online-state.${kind}`, { attrs: { role: kind === 'error' || kind === 'off' ? 'status' : null } }, h('p', null, title), hint ? h('small.muted', null, hint) : null, action ?? null);
}

function statusBadge(r: LeaderRow): HTMLElement | null {
  if (r.status === 'pending') return h('span.badge.pending', { title: '成绩已收到，回放校验还没完成' }, '待验证');
  if (r.status === 'rejected') return h('span.badge.rejected', { title: '回放校验未通过' }, '未通过');
  return null;
}

function rowEl(app: App, r: LeaderRow, i: number, me: boolean): HTMLElement {
  return h(
    `div.olb-row${r.rank <= 3 ? `.top${r.rank}` : ''}${me ? '.me' : ''}`,
    { style: `--i:${Math.min(i, 12)}`, title: `${MAP_META[r.map]?.name ?? r.map} · ${fmtNum(r.kills)} 击杀 · ${fmtTime(r.createdAt)}` },
    h('span.rank', null, r.rank <= 3 ? h('span.gi', { html: r.rank === 1 ? G.crown : G.trophy }) : String(r.rank)),
    h('span.name', null, h('span', null, r.nickname), me ? h('span.badge.me-tag', null, '我') : null, statusBadge(r)),
    h('span.wave', null, `${r.wave} 波`),
    h('span.score', null, fmtNum(r.score)),
    h(
      'button.btn.olb-replay',
      {
        attrs: { type: 'button', 'aria-label': `观看 ${r.nickname} 的回放` },
        title: '观看回放',
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
  const table = h('div.olb-table', { attrs: { role: 'table', 'aria-label': '全服排行榜' } });
  table.appendChild(
    h('div.olb-row.olb-head', { attrs: { role: 'row' } }, h('span', null, '#'), h('span', null, '昵称'), h('span.wave', null, '波数'), h('span.score', null, '得分'), h('span', null, '回放')),
  );
  const meId = myId ?? data.me?.id ?? null;
  data.rows.forEach((r, i) => table.appendChild(rowEl(app, r, i, !!meId && r.id === meId)));
  const me = data.me;
  if (me && !data.rows.some((r) => r.id === me.id)) {
    table.appendChild(h('div.olb-gap', { attrs: { 'aria-hidden': 'true' } }, '···'));
    table.appendChild(rowEl(app, me, data.rows.length, true));
  }
  if (data.total > data.rows.length) table.appendChild(h('small.muted.olb-total', null, `共 ${fmtNum(data.total)} 条成绩`));
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
    el.appendChild(stateBox('loading', '正在加载…'));
    void (async () => {
      await initOnline();
      const r = await fetchLeaderboard(board, { limit: o.limit ?? 50, around: true });
      if (my !== seq || !el.isConnected) return;
      clear(el);
      const retry = h('button.btn.small', { attrs: { type: 'button' }, onclick: () => (audio.play('click'), load(board)) }, h('span.gi', { html: G.refresh }), '重试');
      if (!r.ok) {
        o.onLoaded?.(null);
        if (r.status === 'unavailable') el.appendChild(stateBox('off', '在线功能暂不可用', '本地排行榜不受影响。'));
        else if (r.status === 'offline') el.appendChild(stateBox('off', '网络未连接', '联网后再来看看。', retry));
        else el.appendChild(stateBox('error', '加载失败', r.message, retry));
        return;
      }
      o.onLoaded?.(r.data);
      if (r.data.rows.length === 0) {
        el.appendChild(stateBox('empty', '这个榜还没有成绩', o.emptyHint ?? '在无尽模式里打一局，结算时上传成绩就能上榜。'));
        return;
      }
      el.appendChild(leaderTable(app, r.data, r.data.me?.id ?? null));
    })();
  };
  return { el, load, reload: () => board && load(board) };
}
