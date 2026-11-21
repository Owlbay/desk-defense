/**
 * 排行榜页面的「AI 榜」：每行带模型 / 服务商徽章、决策模式，兜底机器人占比过高的成绩有标注。
 * 只依赖在线排行榜客户端，不引用 Agent 代码（随首屏包加载）。
 */
import { t } from '../../i18n';
import { fetchLeaderboard, initOnline } from '../../meta/online';
import type { LeaderboardResponse, LeaderRow } from '../../shared/leaderboard';
import type { App } from '../App';
import { audio } from '../audio';
import { MAP_META } from '../coreMeta';
import { clear, fmtNum, h } from '../dom';
import { G } from '../icons';
import { openReplay } from '../online/replay';
import { stateBox } from '../online/table';
import { fmtTime } from '../online/util';
import { providerLabel } from './format';

function badges(r: LeaderRow): (HTMLElement | null)[] {
  const a = r.agent;
  if (!a) return [];
  const pct = Math.round(a.botShare * 100);
  return [
    h('span.badge.ai-provider-badge', null, providerLabel(a.provider)),
    a.mode === 'realtime' ? h('span.badge', { title: t('agent.board.realtimeTip') }, t('agent.board.realtime')) : null,
    a.provider !== 'scripted' && a.botAssisted
      ? h('span.badge.ai-bot-badge', { title: t('agent.board.botTip', { pct }) }, t('agent.board.bot', { pct }))
      : null,
    r.status === 'pending' ? h('span.badge.pending', { title: t('agent.board.pendingTip') }, t('agent.board.pending')) : null,
  ];
}

function rowEl(app: App, r: LeaderRow, i: number): HTMLElement {
  const model = r.agent?.model ?? t('agent.board.unknownModel');
  return h(
    `div.olb-row.ai-olb-row${r.rank <= 3 ? `.top${r.rank}` : ''}`,
    {
      style: `--i:${Math.min(i, 12)}`,
      title: t('agent.board.rowTip', { map: MAP_META[r.map]?.name ?? r.map, kills: fmtNum(r.kills), time: fmtTime(r.createdAt) }),
    },
    h('span.rank', null, r.rank <= 3 ? h('span.gi', { html: r.rank === 1 ? G.crown : G.trophy }) : String(r.rank)),
    h(
      'span.name.ai-name',
      null,
      h('span.ai-model', null, model),
      h('span.ai-row-badges', null, badges(r)),
      h('small.muted.ai-owner', null, t('agent.board.submittedBy', { name: r.nickname })),
    ),
    h('span.wave', null, t('agent.board.waves', { n: r.wave })),
    h('span.score', null, fmtNum(r.score)),
    h(
      'button.btn.olb-replay',
      {
        attrs: { type: 'button', 'aria-label': t('agent.board.watchModel', { model }) },
        title: t('agent.board.watch'),
        onclick: () => {
          audio.play('click');
          openReplay(app, r.id, model);
        },
      },
      h('span.gi', { html: G.play }),
    ),
  );
}

export function aiLeaderTable(app: App, data: LeaderboardResponse): HTMLElement {
  const table = h('div.olb-table.ai-olb-table', { attrs: { role: 'table', 'aria-label': t('agent.board.title') } });
  table.appendChild(
    h(
      'div.olb-row.olb-head',
      { attrs: { role: 'row' } },
      h('span', null, '#'),
      h('span', null, t('agent.board.colModel')),
      h('span.wave', null, t('agent.board.colWave')),
      h('span.score', null, t('agent.board.colScore')),
      h('span', null, t('agent.board.colReplay')),
    ),
  );
  data.rows.forEach((r, i) => table.appendChild(rowEl(app, r, i)));
  if (data.total > data.rows.length)
    table.appendChild(h('small.muted.olb-total', null, t('agent.board.total', { n: data.total, count: fmtNum(data.total) })));
  return table;
}

export interface AiBoardView {
  el: HTMLElement;
  /** humanBoard：真人榜键（'normal:auto' …），内部自动加 ai: 前缀 */
  load(humanBoard: string): void;
}

export function aiBoard(app: App, o: { limit?: number } = {}): AiBoardView {
  const el = h('div.olb-host.ai-olb-host', { attrs: { 'aria-live': 'polite' } });
  let seq = 0;
  const load = (humanBoard: string): void => {
    const board = humanBoard.startsWith('ai:') ? humanBoard : `ai:${humanBoard}`;
    const my = ++seq;
    clear(el);
    el.appendChild(stateBox('loading', t('agent.board.loading')));
    void (async () => {
      await initOnline();
      const r = await fetchLeaderboard(board, { limit: o.limit ?? 50 });
      if (my !== seq || !el.isConnected) return;
      clear(el);
      const retry = h(
        'button.btn.small',
        { attrs: { type: 'button' }, onclick: () => (audio.play('click'), load(humanBoard)) },
        h('span.gi', { html: G.refresh }),
        t('agent.board.retry'),
      );
      if (!r.ok) {
        if (r.status === 'unavailable') el.appendChild(stateBox('off', t('agent.board.unavailable'), t('agent.board.unavailableHint')));
        else if (r.status === 'offline') el.appendChild(stateBox('off', t('agent.board.offline'), t('agent.board.offlineHint'), retry));
        else el.appendChild(stateBox('error', t('agent.board.failed'), r.message, retry));
        return;
      }
      if (r.data.rows.length === 0) {
        el.appendChild(
          stateBox(
            'empty',
            t('agent.board.empty'),
            t('agent.board.emptyHint'),
            h(
              'button.btn.small.primary',
              { attrs: { type: 'button' }, onclick: () => (audio.play('click'), app.go({ name: 'ai' })) },
              h('span.gi', { html: G.bolt }),
              t('agent.board.goAi'),
            ),
          ),
        );
        return;
      }
      el.appendChild(aiLeaderTable(app, r.data));
    })();
  };
  return { el, load };
}
