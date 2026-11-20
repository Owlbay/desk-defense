/**
 * AI 对局的结算卡片：波数 / 得分 / token / 费用 / 决策数 / 兜底占比，提交 AI 榜，观看回放。
 * 带 AI 标记的成绩只能进 `ai:` 榜（文档 10 §13），这里没有「提交到全服榜」。
 */
import { usageTotal, type AgentReplay, type TokenUsage } from '../../agent';
import type { IWorld, RunOptions } from '../../core/types';
import { getNickname, initOnline, submitWorldRun } from '../../meta/online';
import { AI_BOARD_PREFIX, AI_BOT_SHARE_FLAG, boardForOpts, boardLabel } from '../../shared/leaderboard';
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
}

const fmtDuration = (sec: number): string => (sec >= 3600 ? `${Math.floor(sec / 3600)} 小时 ${Math.floor((sec % 3600) / 60)} 分` : sec >= 60 ? `${Math.floor(sec / 60)} 分 ${sec % 60} 秒` : `${sec} 秒`);

export function reportCard(app: App, s: AiRunSummary, hd: AiGameOverHandlers): HTMLElement {
  const st = s.world.state;
  const isPlayer = s.agent.role === 'player';
  const campaign = s.opts.mode === 'campaign';
  const total = usageTotal(s.usage);
  const botPct = Math.round(s.botShare * 100);
  const scripted = s.switchedToBot || s.agent.provider === 'scripted';
  const flagged = !scripted && s.botShare > AI_BOT_SHARE_FLAG;
  const title = s.info.won ? '防线守住了！' : '防线被突破';
  const sub = campaign ? (s.info.won ? `撑过全部 ${st.totalWaves} 波` : `倒在第 ${s.info.wave} / ${st.totalWaves} 波`) : `撑过 ${s.info.wavesSurvived} 波`;

  let k = 0;
  const stat = (label: string, value: string, title?: string) => h('div.go-stat', { style: `--i:${k++}`, title }, h('span.muted', null, label), h('b', null, value));

  const stats = h(
    'div.go-stats.ai-report-stats',
    null,
    stat('波数', String(s.info.wavesSurvived)),
    stat('得分', fmtNum(s.info.score)),
    stat('击杀', fmtNum(st.stats.kills)),
    stat('剩余生命', `${st.lives}/${st.maxLives}`),
    stat('token', fmtTokens(total), `输入 ${fmtNum(s.usage.inputTokens)} · 输出 ${fmtNum(s.usage.outputTokens)} · 缓存读 ${fmtNum(s.usage.cacheReadTokens)} · 缓存写 ${fmtNum(s.usage.cacheWriteTokens)} · ${s.usage.requests} 次请求`),
    stat('费用（估算）', fmtCost(s.costUsd), '按公开价格估算，以服务商账单为准'),
    stat('决策', fmtNum(s.decisions), `${fmtNum(s.toolCalls)} 次工具调用${s.errors ? ` · ${s.errors} 次出错` : ''}`),
    isPlayer ? stat('机器人代做', `${botPct}%`, '模型超时 / 出错 / 预算用完时由内置机器人代做的决策占比') : stat('建议 / 采纳', `${s.suggestions} / ${s.adopted}`),
  );

  const badges = h(
    'div.ai-report-badges',
    null,
    h('span.badge.ai-model-badge', null, s.launch.label),
    h('span.badge', null, s.mode === 'pause' ? '暂停等待' : '实时'),
    s.switchedToBot ? h('span.badge.ai-bot-badge', null, '已改用内置策略') : flagged && isPlayer ? h('span.badge.ai-bot-badge', { title: `机器人代做了 ${botPct}% 的决策` }, '机器人代打较多') : null,
    s.takenOver ? h('span.badge.pending', null, '中途接管') : null,
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
    const paintNick = (): void => setText(nick, getNickname() || '未设置');
    let view: SubmitView = { kind: 'idle' };
    const submitBtn = h<HTMLButtonElement>('button.btn.small.primary', { attrs: { type: 'button' } }, h('span.gi', { html: G.up }), '提交到 AI 榜');
    const paint = (): void => {
      const t = submitText(view);
      setText(status, t.text);
      status.className = `os-status${t.tone ? ` ${t.tone}` : ''}`;
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
        view = { kind: 'rejected', message: '上传失败' };
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
      '查看 AI 榜',
    );
    const nickBtn = h('button.btn.small', { attrs: { type: 'button', 'aria-label': '修改昵称' }, onclick: async () => (audio.play('click'), (await askNickname()) && paintNick()) }, '改名');
    online = h(
      'div.online-submit.ai-submit',
      null,
      h('div.os-line', null, h('span', null, boardLabel(board)), status),
      h('div.os-line', null, h('span.online-nick', null, h('span.muted.small', null, '昵称'), nick, nickBtn), h('span.os-actions', null, submitBtn, viewBtn)),
      scripted
        ? h('p.muted.small', null, '这局由内置策略完成，上榜后会标注为“内置策略”。')
        : flagged
          ? h('p.muted.small', null, `机器人代做了 ${botPct}% 的决策（超过 ${Math.round(AI_BOT_SHARE_FLAG * 100)}%），上榜后会带“机器人代打”标记。`)
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
            openLocalReplay(app, { opts: { ...r.opts, seed: r.opts.seed ?? st.seed }, log: r.log, tick: st.tick }, { title: `${s.launch.label} 的回放`, subtitle: campaign ? '战役' : boardLabel(boardForOpts(s.opts, null)), wave: s.info.wavesSurvived, score: Math.round(s.info.score) });
          },
        },
        h('span.gi', { html: G.eye }),
        '观看回放',
      )
    : null;

  return h(
    `div.overlay.gameover-overlay.ai-report-overlay.${s.info.won ? 'won' : 'lost'}`,
    null,
    h(
      'div.dialog.card.gameover.ai-report',
      { attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'AI 对局报告' } },
      h('div.go-head', null, h('span.go-ico', { html: s.info.won ? G.crown : G.skull }), h('h2', null, title), h('p.muted', null, `${isPlayer ? 'AI 玩家' : '你 + AI 军师'} · ${sub} · 用时 ${fmtDuration(s.seconds)}`)),
      badges,
      stats,
      online,
      isPlayer ? h('p.muted.small.center', null, 'AI 代打的对局不发放墨水 / 星星，也不进本地排行榜。') : null,
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
          '再来一局',
        ),
        replayBtn,
        h('button.btn.big', { attrs: { type: 'button' }, onclick: () => (audio.play('click'), app.go({ name: 'ai' })) }, h('span.gi', { html: G.sliders }), '换模型 / 设置'),
        h('button.btn.big', { attrs: { type: 'button' }, onclick: hd.menu }, h('span.gi', { html: G.back }), '返回菜单'),
      ),
      h(
        'p.muted.small.center',
        null,
        `种子 ${st.seed} `,
        h('button.seed-btn', { attrs: { type: 'button' }, title: '复制种子', onclick: async () => app.toast((await copyText(st.seed)) ? '种子已复制' : '复制失败', 'info') }, '复制'),
      ),
    ),
  );
}
