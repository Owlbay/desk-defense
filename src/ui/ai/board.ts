/**
 * 排行榜页面的「AI 榜」：每行带模型 / 服务商徽章、决策模式，兜底机器人占比过高的成绩有标注。
 * 只依赖在线排行榜客户端，不引用 Agent 代码（随首屏包加载）。
 */
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
    a.mode === 'realtime' ? h('span.badge', { title: '实时模式：游戏不等模型' }, '实时') : null,
    a.provider !== 'scripted' && a.botAssisted ? h('span.badge.ai-bot-badge', { title: `内置机器人代做了 ${pct}% 的决策` }, `机器人代打 ${pct}%`) : null,
    r.status === 'pending' ? h('span.badge.pending', { title: '成绩已收到，回放校验还没完成' }, '待验证') : null,
  ];
}

function rowEl(app: App, r: LeaderRow, i: number): HTMLElement {
  const model = r.agent?.model ?? '未知模型';
  return h(
    `div.olb-row.ai-olb-row${r.rank <= 3 ? `.top${r.rank}` : ''}`,
    { style: `--i:${Math.min(i, 12)}`, title: `${MAP_META[r.map]?.name ?? r.map} · ${fmtNum(r.kills)} 击杀 · ${fmtTime(r.createdAt)}` },
    h('span.rank', null, r.rank <= 3 ? h('span.gi', { html: r.rank === 1 ? G.crown : G.trophy }) : String(r.rank)),
    h('span.name.ai-name', null, h('span.ai-model', null, model), h('span.ai-row-badges', null, badges(r)), h('small.muted.ai-owner', null, `由 ${r.nickname} 提交`)),
    h('span.wave', null, `${r.wave} 波`),
    h('span.score', null, fmtNum(r.score)),
    h(
      'button.btn.olb-replay',
      {
        attrs: { type: 'button', 'aria-label': `观看 ${model} 的回放` },
        title: '观看回放',
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
  const table = h('div.olb-table.ai-olb-table', { attrs: { role: 'table', 'aria-label': 'AI 排行榜' } });
  table.appendChild(
    h('div.olb-row.olb-head', { attrs: { role: 'row' } }, h('span', null, '#'), h('span', null, '模型'), h('span.wave', null, '波数'), h('span.score', null, '得分'), h('span', null, '回放')),
  );
  data.rows.forEach((r, i) => table.appendChild(rowEl(app, r, i)));
  if (data.total > data.rows.length) table.appendChild(h('small.muted.olb-total', null, `共 ${fmtNum(data.total)} 条成绩`));
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
    el.appendChild(stateBox('loading', '正在加载…'));
    void (async () => {
      await initOnline();
      const r = await fetchLeaderboard(board, { limit: o.limit ?? 50 });
      if (my !== seq || !el.isConnected) return;
      clear(el);
      const retry = h('button.btn.small', { attrs: { type: 'button' }, onclick: () => (audio.play('click'), load(humanBoard)) }, h('span.gi', { html: G.refresh }), '重试');
      if (!r.ok) {
        if (r.status === 'unavailable') el.appendChild(stateBox('off', '在线功能暂不可用', 'AI 榜需要联网。'));
        else if (r.status === 'offline') el.appendChild(stateBox('off', '网络未连接', '联网后再来看看。', retry));
        else el.appendChild(stateBox('error', '加载失败', r.message, retry));
        return;
      }
      if (r.data.rows.length === 0) {
        el.appendChild(
          stateBox(
            'empty',
            '这个 AI 榜还没有成绩',
            '在「AI 参战」里让模型打一局无尽，结算时提交就能上榜。',
            h('button.btn.small.primary', { attrs: { type: 'button' }, onclick: () => (audio.play('click'), app.go({ name: 'ai' })) }, h('span.gi', { html: G.bolt }), '去 AI 参战'),
          ),
        );
        return;
      }
      el.appendChild(aiLeaderTable(app, r.data));
    })();
  };
  return { el, load };
}
