/**
 * AI 对局的结算卡片：波数 / 得分 / token / 费用 / 决策数 / 兜底占比，上传成绩，观看回放。
 * 成绩进与真人相同的榜（无尽 / 每日 / 战役），带「AI 辅助」+ 模型标记（文档 12 §3）；
 * 与普通结算一样按「自动上传成绩」设置自动上传，名次显示在这里。
 */
import { type AgentReplay, type DuelSideReport, type TokenUsage, type TraceExport, usageTotal } from '../../agent';
import type { IWorld, RunOptions } from '../../core/types';
import { t } from '../../i18n';
import { duelRecordOf, noteDuelUpload, recordDuel } from '../../meta/duels';
import { historyEntryOf, recordHistory } from '../../meta/history';
import { getAutoUpload, getNickname, initOnline, submitDuel, submitWorldRun } from '../../meta/online';
import { AI_BOT_SHARE_FLAG, boardForOpts, boardLabel, modelTagText, publicModelName, starsFor } from '../../shared/leaderboard';
import type { App } from '../App';
import { audio } from '../audio';
import { copyText, fmtNum, h, setText } from '../dom';
import { G } from '../icons';
import { requestLeaderboardTab } from '../online/nav';
import { askNickname } from '../online/nickname';
import { outcomeView, submitText, type SubmitView } from '../online/submit';
import { botHeavyBadge } from '../online/table';
import { boardOfRun, dailyDayOfOpts } from '../online/util';
import { fmtCost, fmtTokens } from './format';
import { type AiGameOverHandlers, type AiGameOverInfo, type AiLaunch, requestAiLaunch } from './launch';
import { agentMetaOf, aiUploadPlan, duelMetaOf } from './meta';
import { openLocalReplay } from './replay';

export interface AiRunSummary {
  launch: AiLaunch;
  info: AiGameOverInfo;
  opts: RunOptions;
  world: IWorld;
  /** provider 是渠道：只在本地判断是不是内置机器人，不显示、不上传 */
  agent: { provider: string; model: string; role: string; effort?: string };
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
  /** AI 对战：双方各自的统计 */
  duel?: { attack: DuelSideReport; defend: DuelSideReport };
}

/** 模型标记文本（模型名 + 思考档位，不含渠道） */
const tagOf = (x: { model: string; effort?: string; provider?: string }): string =>
  x.provider === 'scripted' ? t('agent.setup.label.demo') : modelTagText(publicModelName(x.model) || x.model, x.effort);

/** AI 对战：双方各一行（模型 · 档位 / 决策 / token / 费用 / 错误）+ 出题次数 */
function duelSides(s: AiRunSummary): HTMLElement | null {
  const d = s.duel;
  if (!d) return null;
  const plans = s.world.log.filter((e) => e.cmd.type === 'overrideWave').length;
  const row = (side: 'attack' | 'defend', x: DuelSideReport) =>
    h(
      'div.ai-duel-side',
      null,
      h(`span.badge.ai-side.${side}`, null, t(`agent.duel.side.${side}`)),
      h('b.ai-duel-model', null, tagOf(x)),
      h(
        'small.muted',
        null,
        t('ui.duel.sideStats', {
          decisions: fmtNum(x.decisions),
          fallback: fmtNum(x.fallback),
          tokens: fmtTokens(usageTotal(x.usage)),
          cost: fmtCost(x.costUsd),
          errors: x.errors.length,
        }),
      ),
    );
  return h(
    'div.ai-duel-sides',
    null,
    row('attack', d.attack),
    row('defend', d.defend),
    h('small.muted', null, t('ui.duel.plansLine', { n: plans })),
  );
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
  const stat = (label: string, value: string, title?: string) =>
    h('div.go-stat', { style: `--i:${k++}`, title }, h('span.muted', null, label), h('b', null, value));

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
      t('agent.report.tokensTip', {
        input: fmtNum(s.usage.inputTokens),
        output: fmtNum(s.usage.outputTokens),
        cacheRead: fmtNum(s.usage.cacheReadTokens),
        cacheWrite: fmtNum(s.usage.cacheWriteTokens),
        n: s.usage.requests,
      }),
    ),
    stat(t('agent.report.cost'), fmtCost(s.costUsd), t('agent.report.costTip')),
    stat(
      t('agent.report.decisions'),
      fmtNum(s.decisions),
      t('agent.report.toolCalls', { n: s.toolCalls }) + (s.errors ? ` · ${t('agent.report.errors', { n: s.errors })}` : ''),
    ),
    isPlayer
      ? stat(t('agent.report.botShare'), `${botPct}%`, t('agent.report.botShareTip'))
      : stat(t('agent.report.adopted'), `${s.suggestions} / ${s.adopted}`),
  );

  const badges = h(
    'div.ai-report-badges',
    null,
    h('span.badge.ai-model-badge', null, s.launch.label),
    h('span.badge', null, s.mode === 'pause' ? t('agent.report.modePause') : t('agent.report.modeRealtime')),
    s.switchedToBot
      ? h('span.badge.ai-bot-badge', null, t('agent.report.switchedToBot'))
      : flagged && isPlayer
        ? h('span.badge.ai-bot-badge', { title: t('agent.report.botPctTip', { pct: botPct }) }, t('agent.report.botHeavy'))
        : null,
    s.takenOver ? h('span.badge.pending', null, t('agent.report.takenOver')) : null,
  );

  // ── 排行榜（与普通结算同一套：无尽 / 每日 / 战役；按「自动上传成绩」设置自动上传，不弹昵称框）──
  const online = onlinePanel(app, s);

  const replayBtn = s.replay
    ? h(
        'button.btn.big',
        {
          attrs: { type: 'button' },
          onclick: () => {
            audio.play('click');
            const r = s.replay!;
            openLocalReplay(
              app,
              { opts: { ...r.opts, seed: r.opts.seed ?? st.seed }, log: r.log, tick: st.tick },
              {
                title: t('agent.report.replayTitle', { name: s.launch.label }),
                subtitle: campaign ? t('agent.report.campaign') : boardLabel(boardForOpts(s.opts, null)),
                wave: s.info.wavesSurvived,
                score: Math.round(s.info.score),
                trace: s.trace,
              },
            );
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
      h(
        'div.go-head',
        null,
        h('span.go-ico', { html: s.info.won ? G.crown : G.skull }),
        h('h2', null, title),
        h(
          'p.muted',
          null,
          `${s.agent.role === 'duel' ? t('agent.duel.role') : isPlayer ? t('agent.report.rolePlayer') : t('agent.report.roleAdvisor')} · ${sub} · ${t('agent.report.time', { time: fmtDuration(s.seconds) })}`,
        ),
      ),
      badges,
      duelSides(s),
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
        h(
          'button.btn.big',
          { attrs: { type: 'button' }, onclick: () => (audio.play('click'), app.go({ name: 'ai' })) },
          h('span.gi', { html: G.sliders }),
          t('agent.report.changeModel'),
        ),
        h('button.btn.big', { attrs: { type: 'button' }, onclick: hd.menu }, h('span.gi', { html: G.back }), t('agent.report.menu')),
      ),
      h(
        'p.muted.small.center',
        null,
        `${t('agent.report.seed', { seed: st.seed })} `,
        h(
          'button.seed-btn',
          {
            attrs: { type: 'button' },
            title: t('agent.report.copySeed'),
            onclick: async () => app.toast((await copyText(st.seed)) ? t('agent.report.seedCopied') : t('agent.report.copyFailed'), 'info'),
          },
          t('agent.report.copy'),
        ),
      ),
    ),
  );
}

/** 同一局只上传一次、只记一次「我的记录」（结算卡片可能重建） */
const uploads = new WeakMap<object, Promise<SubmitView>>();
const recorded = new WeakSet<object>();
/** AI 对战：本局在本地记录里的 id（上传成功后补名次） */
const duelIds = new WeakMap<object, string>();

function onlinePanel(app: App, s: AiRunSummary): HTMLElement {
  const st = s.world.state;
  const opts: RunOptions = { ...s.opts, seed: s.opts.seed ?? st.seed };
  const plan = aiUploadPlan({ ...s, opts });
  const ranked = plan.kind !== 'skip';
  const day = ranked ? dailyDayOfOpts(opts) : null;
  const world = s.world as object;
  const ai = plan.kind === 'agent' || plan.kind === 'assist';
  let duelId: string | null = null;
  if (!recorded.has(world)) {
    recorded.add(world);
    try {
      const won = st.phase === 'won';
      const stars = opts.mode === 'campaign' && won ? starsFor(st.lives, Math.max(st.lives, st.maxLives)) : 0;
      // AI 对战：完整数据记本地（双方模型 / 档位 / 用量 / 费用 / 错误 / 出题 / 回放）
      if (s.duel) {
        const rec = duelRecordOf(
          {
            opts,
            seed: st.seed,
            result: {
              wave: s.info.wave,
              wavesSurvived: s.info.wavesSurvived,
              score: Math.round(s.info.score),
              kills: st.stats.kills,
              lives: st.lives,
              maxLives: st.maxLives,
              won,
              stars,
              ticks: st.tick,
            },
            seconds: s.seconds,
            attack: s.duel.attack,
            defend: s.duel.defend,
            log: s.world.log,
            takenOver: s.takenOver,
            switchedToBot: s.switchedToBot,
          },
          Date.now(),
        );
        recordDuel(rec);
        duelId = rec.id;
        duelIds.set(world, rec.id);
      }
      recordHistory(
        historyEntryOf(
          opts,
          {
            wave: s.info.wavesSurvived,
            score: s.info.score,
            won,
            stars,
            ai,
            ranked,
            daily: day,
            seed: st.seed,
            ...(s.duel && duelId
              ? {
                  duel: {
                    id: duelId,
                    attacker: tagOf({ ...s.duel.attack, effort: undefined }),
                    defender: tagOf({ ...s.duel.defend, effort: undefined }),
                    ...(s.duel.attack.effort && s.duel.attack.provider !== 'scripted' ? { atkEffort: s.duel.attack.effort } : {}),
                    ...(s.duel.defend.effort && s.duel.defend.provider !== 'scripted' ? { defEffort: s.duel.defend.effort } : {}),
                  },
                }
              : {}),
          },
          Date.now(),
        ),
        app.store.get(),
      );
    } catch (e) {
      console.warn('[ai] history failed', e);
    }
  }
  if (plan.kind === 'skip') return h('div.online-submit.ai-submit', null, h('div.os-line', null, h('span.muted', null, plan.reason)));

  const duel = plan.kind === 'duel';
  const board = boardOfRun(opts);
  const scripted = s.switchedToBot || s.agent.provider === 'scripted';
  const botPct = Math.round(s.botShare * 100);
  const flagged = !scripted && s.botShare > AI_BOT_SHARE_FLAG;
  const status = h('span.os-status', { attrs: { role: 'status', 'aria-live': 'polite' } });
  const nick = h('b.nick-name');
  const paintNick = (): void => setText(nick, getNickname());
  let view: SubmitView = { kind: 'idle' };
  const submitBtn = h<HTMLButtonElement>(
    'button.btn.small.primary',
    { attrs: { type: 'button' } },
    h('span.gi', { html: G.up }),
    t('agent.report.submit'),
  );
  const paint = (): void => {
    const x = submitText(view);
    setText(status, x.text);
    status.className = `os-status${x.tone ? ` ${x.tone}` : ''}`;
    submitBtn.hidden = !(view.kind === 'idle' || view.kind === 'rejected');
  };
  const upload = (): Promise<SubmitView> => {
    const prev = uploads.get(world);
    if (prev) return prev;
    const p = (async (): Promise<SubmitView> => {
      try {
        const os = await initOnline();
        if (os.status === 'unavailable') return { kind: 'unavailable' };
        // AI 对战：上传到独立的对战榜（只带双方模型名 + 思考档位 + 统计）
        if (duel && s.duel) {
          const out = await submitDuel(s.world as Parameters<typeof submitDuel>[0], {
            wavesSurvived: s.info.wavesSurvived,
            duel: duelMetaOf(s.duel, {
              plans: s.world.log.filter((e) => e.cmd.type === 'overrideWave').length,
              switchedToBot: s.switchedToBot,
            }),
          });
          const id = duelIds.get(world);
          if (out.kind === 'ok' && id) noteDuelUpload(id, { rank: out.res.rank, total: out.res.total });
          return outcomeView(out);
        }
        return outcomeView(
          await submitWorldRun(s.world as Parameters<typeof submitWorldRun>[0], {
            wavesSurvived: s.info.wavesSurvived,
            dailyDay: day,
            ...(plan.kind === 'agent' ? { agent: agentMetaOf(s) } : {}),
            // 中途接管的局：照样记下 AI 操作期间的兜底占比（> 20% 榜上标「兜底多」，docs/10 §18-6）
            ...(plan.kind === 'assist'
              ? {
                  // 只带模型名 + 思考档位（launch.label 里有渠道名，不上传）
                  aiAssist: {
                    player: true,
                    advisor: false,
                    model: s.agent.model,
                    ...(s.agent.effort && s.agent.provider !== 'scripted' ? { effort: s.agent.effort } : {}),
                  },
                  ...(scripted ? {} : { aiBotShare: s.botShare }),
                }
              : {}),
          }),
        );
      } catch (e) {
        console.warn('[ai] submit failed', e);
        return { kind: 'rejected', message: t('agent.report.uploadFailed') };
      }
    })();
    uploads.set(world, p);
    void p.then((v) => {
      if (v.kind === 'rejected' || v.kind === 'unavailable') uploads.delete(world);
    });
    return p;
  };
  const run = async (): Promise<void> => {
    view = { kind: 'sending' };
    paint();
    view = await upload();
    if (view.kind === 'done') audio.play('select');
    paint();
  };
  submitBtn.onclick = () => {
    audio.play('click');
    void run();
  };
  const viewBtn = h(
    'button.btn.small',
    {
      attrs: { type: 'button' },
      onclick: () => {
        audio.play('click');
        if (duel) {
          requestLeaderboardTab('duel');
          app.go({ name: 'leaderboard' });
        } else if (day) app.go({ name: 'daily' });
        else {
          requestLeaderboardTab('endless', board);
          app.go({ name: 'leaderboard' });
        }
      },
    },
    h('span.gi', { html: G.trophy }),
    t('agent.report.viewBoard'),
  );
  const nickBtn = h(
    'button.btn.small',
    {
      attrs: { type: 'button', 'aria-label': t('agent.report.editNick') },
      onclick: async () => (audio.play('click'), (await askNickname()) && paintNick()),
    },
    t('agent.report.rename'),
  );
  const panel = h(
    'div.online-submit.ai-submit',
    null,
    h(
      'div.os-line',
      null,
      h(
        'span.os-board',
        null,
        duel ? t('ui.duel.board') : boardLabel(board),
        ai ? h('span.badge.lb-ai-badge', null, t('ui.lb.ai')) : null,
        plan.kind === 'agent' ? h('span.badge.ai-model-badge', null, tagOf(s.agent)) : null,
        duel && s.duel
          ? h('span.badge.ai-model-badge', null, t('ui.duel.vs', { attacker: tagOf(s.duel.attack), defender: tagOf(s.duel.defend) }))
          : null,
        (plan.kind === 'agent' || plan.kind === 'assist') && flagged ? botHeavyBadge({ botHeavy: true }) : null,
      ),
      status,
    ),
    h(
      'div.os-line',
      null,
      h('span.online-nick', null, h('span.muted.small', null, t('agent.report.nick')), nick, nickBtn),
      h('span.os-actions', null, submitBtn, viewBtn),
    ),
    duel
      ? h('p.muted.small', null, t('ui.duel.uploadNote'))
      : plan.kind === 'human'
        ? h('p.muted.small', null, t('agent.report.advisorNote'))
        : plan.kind === 'assist'
          ? h('p.muted.small', null, t('agent.report.takenOverNote'))
          : scripted
            ? h('p.muted.small', null, t('agent.report.scriptedNote'))
            : flagged
              ? h('p.muted.small', null, t('agent.report.flaggedNote', { pct: botPct, limit: Math.round(AI_BOT_SHARE_FLAG * 100) }))
              : null,
    getAutoUpload() ? null : h('p.muted.small', null, t('ui.lb.autoOffNote')),
  );
  paintNick();
  paint();
  if (getAutoUpload() || uploads.has(world)) void run();
  else
    void initOnline().then((os) => {
      if (os.status === 'unavailable' && view.kind === 'idle') {
        view = { kind: 'unavailable' };
        paint();
      }
    });
  return panel;
}
