/**
 * AI 对战（进攻方模型 vs 防守方模型）的界面：
 *  - 排行榜页的「AI 对战」页签：独立的全服对战榜（GET /api/duels），每行显示双方模型 + 思考档位、地图 / 难度、波数 / 结果；
 *  - 「我的记录」里对战条目的详情：双方的决策数 / 兜底 / 用量 / 花费 / 错误、每波的出题内容、结果、本地回放。
 * 只显示模型名 + 思考档位，不显示渠道 / 服务商。
 */
import { usageTotal } from '../../agent/types';
import type { AttackGroup, RunOptions } from '../../core/types';
import { fmtNumber, t } from '../../i18n';
import { type DuelRecord, type DuelSideRecord, getDuel } from '../../meta/duels';
import { fetchDuel, fetchDuelBoard, initOnline } from '../../meta/online';
import { diffLabel } from '../../meta/progress';
import { AI_BOT_SHARE_FLAG, type DuelBoardResponse, type DuelRow } from '../../shared/leaderboard';
import { fmtCost, fmtTokens } from '../ai/format';
import type { App } from '../App';
import { audio } from '../audio';
import { AFFIX_META, ENEMY_META, MAP_META } from '../coreMeta';
import { clear, fmtNum, h } from '../dom';
import { G } from '../icons';
import { duelSideText, duelVsText } from './model-tag';
import { stateBox } from './table';
import { fmtTime } from './util';

/** 一方的标记文本：模型 · 档位（内置机器人显示「离线演示」） */
export { duelSideText, duelVsText } from './model-tag';

const sideTag = (side: 'attack' | 'defend', text: string, botHeavy?: boolean): HTMLElement =>
  h(
    `span.lb-duel-side.${side}`,
    { title: botHeavy ? t('ui.lb.botHeavyTip', { limit: Math.round(AI_BOT_SHARE_FLAG * 100) }) : undefined },
    h('b', null, t(`agent.duel.side.${side}`)),
    h('span', null, text),
    botHeavy ? h('small.lb-duel-bot', null, t('ui.lb.botHeavy')) : null,
  );

/** 结果：战役通关 / 撑过 N 波 */
function resultText(r: { mode: string; won: boolean; wave: number; stars?: number }): string {
  if (r.mode === 'campaign' && r.won) return t('ui.duel.resultWon', { n: r.stars ?? 1 });
  return t('ui.duel.resultFell', { n: r.wave });
}

function duelRowEl(app: App, r: DuelRow, i: number, me: boolean): HTMLElement {
  return h(
    `div.olb-row.lb-duel-row${r.rank <= 3 ? `.top${r.rank}` : ''}${me ? '.me' : ''}`,
    {
      attrs: { role: 'row' },
      style: `--i:${Math.min(i, 12)}`,
      title: t('ui.duel.rowTip', {
        map: MAP_META[r.map]?.name ?? r.map,
        kills: fmtNumber(Math.round(r.kills)),
        plans: r.plans,
        time: fmtTime(r.createdAt),
      }),
    },
    h('span.rank', null, r.rank <= 3 ? h('span.gi', { html: r.rank === 1 ? G.crown : G.trophy }) : String(r.rank)),
    h(
      'span.name.lb-duel-name',
      null,
      h('span.lb-duel-nick', null, h('span', null, r.nickname), me ? h('span.badge.me-tag', null, t('ui.online.me')) : null),
      h(
        'span.lb-duel-vs',
        null,
        sideTag('attack', duelSideText(r.attacker), r.attacker.botHeavy),
        sideTag('defend', duelSideText(r.defender), r.defender.botHeavy),
      ),
    ),
    h(
      'span.detail.lb-duel-detail',
      null,
      h(`span.lb-diff.d-${r.difficulty}`, null, diffLabel(r.difficulty, r.abyssLevel ?? 1)),
      h('span.lb-wave', null, resultText(r)),
    ),
    h('span.score', null, fmtNumber(Math.round(r.score))),
    h(
      'button.btn.olb-replay',
      {
        attrs: { type: 'button', 'aria-label': t('ui.online.watchReplayOf', { name: r.nickname }) },
        title: t('ui.online.watchReplay'),
        onclick: () => {
          audio.play('click');
          void openOnlineDuelReplay(app, r);
        },
      },
      h('span.gi', { html: G.play }),
    ),
  );
}

/** 对战榜表格 */
export function duelTable(app: App, data: DuelBoardResponse): HTMLElement {
  const table = h('div.olb-table.k-duel', { attrs: { role: 'table', 'aria-label': t('ui.duel.board') } });
  table.appendChild(
    h(
      'div.olb-row.olb-head',
      { attrs: { role: 'row' } },
      h('span', null, '#'),
      h('span', null, t('ui.duel.col.matchup')),
      h('span.detail', null, t('ui.duel.col.result')),
      h('span.score', null, t('ui.online.col.score')),
      h('span', null, t('ui.online.col.replay')),
    ),
  );
  const meId = data.me?.id ?? null;
  data.rows.forEach((r, i) => table.appendChild(duelRowEl(app, r, i, !!meId && r.id === meId)));
  const me = data.me;
  if (me && !data.rows.some((r) => r.id === me.id)) {
    table.appendChild(h('div.olb-gap', { attrs: { 'aria-hidden': 'true' } }, '···'));
    table.appendChild(duelRowEl(app, me, data.rows.length, true));
  }
  if (data.total > data.rows.length)
    table.appendChild(h('small.muted.olb-total', null, t('ui.online.totalRuns', { n: data.total, total: fmtNumber(data.total) })));
  return table;
}

/** 带加载 / 空 / 离线状态的对战榜 */
export function duelBoard(
  app: App,
  o: { limit?: number; onLoaded?: (d: DuelBoardResponse | null) => void } = {},
): { el: HTMLElement; load(): void } {
  const el = h('div.olb-host', { attrs: { 'aria-live': 'polite' } });
  let seq = 0;
  const load = (): void => {
    const my = ++seq;
    clear(el);
    el.appendChild(stateBox('loading', t('ui.online.loading')));
    void (async () => {
      await initOnline();
      const r = await fetchDuelBoard({ limit: o.limit ?? 50, around: true });
      if (my !== seq || !el.isConnected) return;
      clear(el);
      const retry = h(
        'button.btn.small',
        { attrs: { type: 'button' }, onclick: () => (audio.play('click'), load()) },
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
      if (!r.data.rows.length) {
        el.appendChild(stateBox('empty', t('ui.online.emptyBoard'), t('ui.duel.emptyHint')));
        return;
      }
      el.appendChild(duelTable(app, r.data));
    })();
  };
  return { el, load };
}

// ───────────── 回放 ─────────────

async function replay(
  app: App,
  run: { opts: RunOptions; seed: string; log: { tick: number; cmd: import('../../core/types').Command }[]; tick: number },
  title: string,
  subtitle: string,
  wave: number,
  score: number,
): Promise<void> {
  try {
    const m = await import('../ai/replay');
    m.openLocalReplay(
      app,
      { opts: { ...run.opts, seed: run.opts.seed ?? run.seed }, log: run.log, tick: run.tick },
      { title, subtitle, wave, score },
    );
  } catch (e) {
    console.warn('[duel] replay failed', e);
    app.toast(t('ui.duel.replayFailed'), 'warn');
  }
}

async function openOnlineDuelReplay(app: App, r: DuelRow): Promise<void> {
  const d = await fetchDuel(r.id);
  if (!d.ok) {
    app.toast(d.message || t('ui.duel.replayFailed'), 'warn');
    return;
  }
  await replay(
    app,
    { opts: d.data.opts, seed: d.data.seed, log: d.data.log, tick: d.data.result.ticks },
    t('ui.duel.replayTitle', { vs: duelVsText(d.data.attacker, d.data.defender) }),
    r.nickname,
    d.data.result.wave,
    d.data.result.score,
  );
}

// ───────────── 本地详情 ─────────────

function planText(groups: readonly AttackGroup[]): string {
  return groups
    .filter((g) => g && typeof g.enemy === 'string')
    .map((g) => {
      const affixes = Array.isArray(g.affixes) && g.affixes.length ? `[${g.affixes.map((a) => AFFIX_META[a]?.name ?? a).join('+')}]` : '';
      return `${ENEMY_META[g.enemy]?.name ?? g.enemy}×${g.count}${affixes}`;
    })
    .join(t('ui.duel.listSep'));
}

function sideBlock(side: 'attack' | 'defend', s: DuelSideRecord): HTMLElement {
  const cell = (label: string, value: string) => h('div.go-stat', null, h('span.muted', null, label), h('b', null, value));
  return h(
    `section.lb-duel-detail-side.${side}`,
    null,
    h('h4', null, sideTag(side, duelSideText(s))),
    h(
      'div.go-stats',
      null,
      cell(t('ui.duel.stat.decisions'), fmtNum(s.decisions)),
      cell(t('ui.duel.stat.fallback'), fmtNum(s.fallback)),
      cell(t('ui.duel.stat.tokens'), fmtTokens(usageTotal(s.usage))),
      cell(t('ui.duel.stat.cost'), fmtCost(s.costUsd)),
      cell(t('ui.duel.stat.requests'), fmtNum(s.usage.requests)),
      cell(t('ui.duel.stat.errors'), fmtNum(s.errorCount)),
    ),
    s.errors.length
      ? h(
          'details.lb-duel-errors',
          null,
          h('summary', null, t('ui.duel.errorsTitle', { n: s.errorCount })),
          h(
            'ul',
            null,
            s.errors.map((e) => h('li', null, e)),
          ),
        )
      : null,
  );
}

/** 「我的记录」里一局 AI 对战的完整数据（本地） */
export function openDuelDetail(app: App, id: string): void {
  const d: DuelRecord | null = getDuel(id);
  if (!d) {
    app.toast(t('ui.duel.missing'), 'info');
    return;
  }
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const close = (): void => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    opener?.focus?.();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    e.preventDefault();
    audio.play('click');
    close();
  };
  const mode =
    d.opts.mode === 'campaign' ? t('ui.lb.hist.campaign', { map: MAP_META[d.opts.map]?.name ?? d.opts.map }) : t('ui.lb.hist.endless');
  const result = resultText({ mode: d.opts.mode, won: d.result.won, wave: d.result.wavesSurvived, stars: d.result.stars });
  const plans = h(
    'ol.lb-duel-plans',
    null,
    d.plans.map((p) => h('li', null, h('b', null, t('ui.duel.planWave', { n: p.wave })), ' ', planText(p.groups))),
  );
  const dialog = h(
    'div.dialog.card.lb-duel-dialog',
    { attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': t('ui.duel.detailTitle') } },
    h('h2', null, t('ui.duel.detailTitle')),
    h('p.lb-duel-vs-line', null, sideTag('attack', duelSideText(d.attacker)), sideTag('defend', duelSideText(d.defender))),
    h(
      'p.muted',
      null,
      `${mode} · ${diffLabel(d.opts.difficulty, d.opts.abyssLevel ?? 1)} · ${result} · ${t('ui.duel.scoreLine', { score: fmtNum(d.result.score), kills: fmtNum(d.result.kills) })}`,
    ),
    h(
      'p.muted.small',
      null,
      `${fmtTime(d.at)} · ${t('ui.duel.seed', { seed: d.seed })}`,
      d.takenOver ? ` · ${t('ui.duel.takenOver')}` : '',
      d.switchedToBot ? ` · ${t('agent.report.switchedToBot')}` : '',
      ` · ${d.upload ? t('ui.duel.uploaded', { rank: fmtNumber(d.upload.rank), total: fmtNumber(d.upload.total) }) : t('ui.duel.notUploaded')}`,
    ),
    sideBlock('attack', d.attacker),
    sideBlock('defend', d.defender),
    h('h3', null, t('ui.duel.plansTitle', { n: d.plans.length })),
    d.plans.length ? plans : h('p.muted.small', null, t('ui.duel.noPlans')),
    h(
      'div.go-actions',
      null,
      d.replay
        ? h(
            'button.btn.primary',
            {
              attrs: { type: 'button' },
              onclick: () => {
                audio.play('click');
                close();
                void replay(
                  app,
                  { opts: d.opts, seed: d.seed, log: d.replay!.log, tick: d.replay!.tick },
                  t('ui.duel.replayTitle', { vs: duelVsText(d.attacker, d.defender) }),
                  mode,
                  d.result.wavesSurvived,
                  d.result.score,
                );
              },
            },
            h('span.gi', { html: G.eye }),
            t('ui.duel.watchReplay'),
          )
        : h('small.muted', null, t('ui.duel.noReplay')),
      h('button.btn', { attrs: { type: 'button' }, onclick: () => (audio.play('click'), close()) }, t('ui.duel.close')),
    ),
  );
  const overlay = h(
    'div.overlay.lb-duel-overlay',
    {
      onclick: (e: Event) => {
        if (e.target === overlay) {
          audio.play('click');
          close();
        }
      },
    },
    dialog,
  );
  document.addEventListener('keydown', onKey, true);
  ((document.querySelector('.app') as HTMLElement | null) ?? document.body).appendChild(overlay);
  setTimeout(() => (dialog.querySelector('button') as HTMLElement | null)?.focus(), 30);
}
