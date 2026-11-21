/**
 * AI 对局的结算卡片：波数 / 得分 / token / 费用 / 决策数 / 兜底占比，提交 AI 榜，观看回放。
 * 带 AI 标记的成绩只能进 `ai:` 榜（文档 10 §13），这里没有「提交到全服榜」。
 */
import { usageTotal, type AgentReplay, type TokenUsage, type TraceExport } from '../../agent';
import type { IWorld, RunOptions } from '../../core/types';
import { getNickname, initOnline, submitWorldRun } from '../../meta/online';
import { AI_BOARD_PREFIX, AI_BOT_SHARE_FLAG, boardForOpts, boardLabel } from '../../shared/leaderboard';
import { t } from '../../i18n';
import type { App } from '../App';
import { audio } from '../audio';
import { copyText, fmtNum, h, setText } from '../dom';
import { G } from '../icons';
import { requestLeaderboardTab } from '../online/nav';
import { askNickname, ensureNickname } from '../online/nickname';
import { outcomeView, submitText, type SubmitView } from '../online/submit';
import { fmtCost, fmtTokens } from './format';
import { agentMetaOf, aiBoardBlocker } from './meta';
import { requestAiLaunch, type AiGameOverHandlers, type AiGameOverInfo, type AiLaunch } from './launch';
import { openLocalReplay } from './replay';

export interface AiRunSummary {
  launch: AiLaunch;
  info: AiGameOverInfo;
  opts: RunOptions;
  world: IWorld;
  agent: { provider: string; model: string; role: string };
  mode: 'pause' | 'realtime';
  usage: TokenUsage;
  costUsd: number;
  decisions: number;
  /** 兜底机器人决策占比 0..1 */
  botShare: number;
  toolCalls: number;
  errors: number;
  suggestions: number;
  adopted: number;
  takenOver: boolean;
  switchedToBot: boolean;
  replay: AgentReplay | null;
  seconds: number;
  /** 思路与请求记录（已脱敏、封顶），回放时在旁边显示 */
  trace?: TraceExport;
}

const fmtDuration = (sec: number): string =>
  sec >= 3600
    ? t('agent.report.durHM', { h: Math.floor(sec / 3600), m: Math.floor((sec % 3600) / 60) })
    : sec >= 60
      ? t('agent.report.durMS', { m: Math.floor(sec / 60), s: sec % 60 })
      : t('agent.report.durS', { n: sec });

export function reportCard(app: App, s: AiRunSummary, hd: AiGameOverHandlers): HTMLElement {
  const st = s.world.state;
  const isPlayer = s.agent.role === 'player';
  const campaign = s.opts.mode === 'campaign';
  const total = usageTotal(s.usage);
  const botPct = Math.round(s.botShare * 100);
  const scripted = s.switchedToBot || s.agent.provider === 'scripted';
  const flagged = !scripted && s.botShare > AI_BOT_SHARE_FLAG;
  const title = s.info.won ? t('agent.report.won') : t('agent.report.lost');
  const sub = campaign
    ? s.info.won
      ? t('agent.report.subAll', { n: st.totalWaves })
      : t('agent.report.subFell', { wave: s.info.wave, total: st.totalWaves })
    : t('agent.report.subSurvived', { n: s.info.wavesSurvived });

  let k = 0;
  const stat = (label: string, value: string, title?: string) => h('div.go-stat', { style: `--i:${k++}`, title }, h('span.muted', null, label), h('b', null, value));

  const stats = h(
    'div.go-stats.ai-report-stats',
    null,
    stat(t('agent.report.waves'), String(s.info.wavesSurvived)),
    stat(t('agent.report.score'), fmtNum(s.info.score)),
    stat(t('agent.report.kills'), fmtNum(st.stats.kills)),
    stat(t('agent.report.lives'), `${st.lives}/${st.maxLives}`),
    stat(
      t('agent.report.tokens'),
      fmtTokens(total),
      t('agent.report.tokensTip', { input: fmtNum(s.usage.inputTokens), output: fmtNum(s.usage.outputTokens), cacheRead: fmtNum(s.usage.cacheReadTokens), cacheWrite: fmtNum(s.usage.cacheWriteTokens), n: s.usage.requests }),
    ),
    stat(t('agent.report.cost'), fmtCost(s.costUsd), t('agent.report.costTip')),
    stat(t('agent.report.decisions'), fmtNum(s.decisions), t('agent.report.toolCalls', { n: s.toolCalls }) + (s.errors ? ` · ${t('agent.report.errors', { n: s.errors })}` : '')),
    isPlayer ? stat(t('agent.report.botShare'), `${botPct}%`, t('agent.report.botShareTip')) : stat(t('agent.report.adopted'), `${s.suggestions} / ${s.adopted}`),
  );

  const badges = h(
    'div.ai-report-badges',
    null,
    h('span.badge.ai-model-badge', null, s.launch.label),
    h('span.badge', null, s.mode === 'pause' ? t('agent.report.modePause') : t('agent.report.modeRealtime')),
    s.switchedToBot ? h('span.badge.ai-bot-badge', null, t('agent.report.switchedToBot')) : flagged && isPlayer ? h('span.badge.ai-bot-badge', { title: t('agent.report.botPctTip', { pct: botPct }) }, t('agent.report.botHeavy')) : null,
    s.takenOver ? h('span.badge.pending', null, t('agent.report.takenOver')) : null,
  );

  // ── AI 榜 ──
  const blocker = aiBoardBlocker(s);
  const board = AI_BOARD_PREFIX + boardForOpts(s.opts, null);
  let online: HTMLElement;
  if (blocker) {
    online = h('div.online-submit.ai-submit', null, h('div.os-line', null, h('span.muted', null, blocker)));
  } else {
    const status = h('span.os-status', { attrs: { role: 'status', 'aria-live': 'polite' } });
    const nick = h('b.nick-name');
    const paintNick = (): void => setText(nick, getNickname() || t('agent.report.nickUnset'));
    let view: SubmitView = { kind: 'idle' };
    const submitBtn = h<HTMLButtonElement>('button.btn.small.primary', { attrs: { type: 'button' } }, h('span.gi', { html: G.up }), t('agent.report.submit'));
    const paint = (): void => {
      const st = submitText(view);
      setText(status, st.text);
      status.className = `os-status${st.tone ? ` ${st.tone}` : ''}`;
      submitBtn.hidden = !(view.kind === 'idle' || view.kind === 'rejected');
    };
    let busy = false;
    submitBtn.onclick = async () => {
      if (busy) return;
      busy = true;
      audio.play('click');
      try {
        const os = await initOnline();
        if (os.status === 'unavailable') {
          view = { kind: 'unavailable' };
          return;
        }
        const n = await ensureNickname();
        if (!n) return;
        paintNick();
        view = { kind: 'sending' };
        paint();
        view = outcomeView(await submitWorldRun(s.world as Parameters<typeof submitWorldRun>[0], { wavesSurvived: s.info.wavesSurvived, agent: agentMetaOf(s) }));
        if (view.kind === 'done') audio.play('select');
      } catch (e) {
        console.warn('[ai] submit failed', e);
        view = { kind: 'rejected', message: t('agent.report.uploadFailed') };
      } finally {
        busy = false;
        paint();
      }
    };
    const viewBtn = h(
      'button.btn.small',
      {
        attrs: { type: 'button' },
        onclick: () => {
          audio.play('click');
          requestLeaderboardTab('global', board);
          app.go({ name: 'leaderboard' });
        },
      },
      h('span.gi', { html: G.trophy }),
      t('agent.report.viewBoard'),
    );
    const nickBtn = h('button.btn.small', { attrs: { type: 'button', 'aria-label': t('agent.report.editNick') }, onclick: async () => (audio.play('click'), (await askNickname()) && paintNick()) }, t('agent.report.rename'));
    online = h(
      'div.online-submit.ai-submit',
      null,
      h('div.os-line', null, h('span', null, boardLabel(board)), status),
      h('div.os-line', null, h('span.online-nick', null, h('span.muted.small', null, t('agent.report.nick')), nick, nickBtn), h('span.os-actions', null, submitBtn, viewBtn)),
      scripted
        ? h('p.muted.small', null, t('agent.report.scriptedNote'))
        : flagged
          ? h('p.muted.small', null, t('agent.report.flaggedNote', { pct: botPct, limit: Math.round(AI_BOT_SHARE_FLAG * 100) }))
          : null,
    );
    paintNick();
    paint();
    void initOnline().then((os) => {
      if (os.status === 'unavailable' && view.kind === 'idle') {
        view = { kind: 'unavailable' };
        paint();
      }
    });
  }

  const replayBtn = s.replay
    ? h(
        'button.btn.big',
        {
          attrs: { type: 'button' },
          onclick: () => {
            audio.play('click');
            const r = s.replay!;
            openLocalReplay(app, { opts: { ...r.opts, seed: r.opts.seed ?? st.seed }, log: r.log, tick: st.tick }, { title: t('agent.report.replayTitle', { name: s.launch.label }), subtitle: campaign ? t('agent.report.campaign') : boardLabel(boardForOpts(s.opts, null)), wave: s.info.wavesSurvived, score: Math.round(s.info.score), trace: s.trace });
          },
        },
        h('span.gi', { html: G.eye }),
        t('agent.report.watchReplay'),
      )
    : null;

  return h(
    `div.overlay.gameover-overlay.ai-report-overlay.${s.info.won ? 'won' : 'lost'}`,
    null,
    h(
      'div.dialog.card.gameover.ai-report',
      { attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': t('agent.report.aria') } },
      h('div.go-head', null, h('span.go-ico', { html: s.info.won ? G.crown : G.skull }), h('h2', null, title), h('p.muted', null, `${isPlayer ? t('agent.report.rolePlayer') : t('agent.report.roleAdvisor')} · ${sub} · ${t('agent.report.time', { time: fmtDuration(s.seconds) })}`)),
      badges,
      stats,
      online,
      isPlayer ? h('p.muted.small.center', null, t('agent.report.noRewards')) : null,
      h(
        'div.go-actions',
        null,
        h(
          'button.btn.primary.big',
          {
            attrs: { type: 'button' },
            onclick: () => {
              // 沿用同一套模型配置再开一局
              requestAiLaunch(s.launch);
              hd.again();
            },
          },
          h('span.gi', { html: G.refresh }),
          t('agent.report.again'),
        ),
        replayBtn,
        h('button.btn.big', { attrs: { type: 'button' }, onclick: () => (audio.play('click'), app.go({ name: 'ai' })) }, h('span.gi', { html: G.sliders }), t('agent.report.changeModel')),
        h('button.btn.big', { attrs: { type: 'button' }, onclick: hd.menu }, h('span.gi', { html: G.back }), t('agent.report.menu')),
      ),
      h(
        'p.muted.small.center',
        null,
        `${t('agent.report.seed', { seed: st.seed })} `,
        h('button.seed-btn', { attrs: { type: 'button' }, title: t('agent.report.copySeed'), onclick: async () => app.toast((await copyText(st.seed)) ? t('agent.report.seedCopied') : t('agent.report.copyFailed'), 'info') }, t('agent.report.copy')),
      ),
    ),
  );
}
