/**
 * 结算面板里的排行榜区（文档 12 §6）：
 *  - 每局都先记进「我的记录」（本设备最近 N 局，含不排名的自定义模式）；
 *  - 无尽 / 每日挑战 / 战役：缺省「自动上传成绩」，不用填昵称（没设过就用默认昵称）；
 *    关掉自动上传时给一个「上传成绩」按钮；
 *  - AI 辅助（用过「让 AI 替我玩」）的对局照常上传，带「AI 辅助」标记；
 *  - 自定义模式不排名，只说明一句。
 * 全部异步，不阻塞结算界面；同一局重建面板（例如切换语言）不会重复上传 / 重复记录。
 */
import { fmtNumber, t } from '../../i18n';
import { isAiAssisted } from '../../meta/aiAssist';
import { historyEntryOf, recordHistory } from '../../meta/history';
import { getAutoUpload, getNickname, initOnline, type SubmitOutcome, submitWorldRun } from '../../meta/online';
import { boardLabel, CUSTOM_BOARD, isAiEffort, starsFor } from '../../shared/leaderboard';
import { audio } from '../audio';
import { h, setText } from '../dom';
import type { GameCtx } from '../hud/context';
import { G } from '../icons';
import { requestLeaderboardTab } from './nav';
import { askNickname } from './nickname';
import { aiModelText } from './table';
import { boardOfRun, dailyDayOfOpts, isEligibleRun } from './util';

export type SubmitView =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'done'; rank: number; total: number; improved: boolean; pending: boolean }
  | { kind: 'queued'; message: string }
  | { kind: 'rejected'; message: string }
  | { kind: 'unavailable' };

/** 状态文案（纯函数，便于单测） */
export function submitText(v: SubmitView): { text: string; tone: '' | 'good' | 'warn' } {
  switch (v.kind) {
    case 'idle':
      return { text: t('ui.online.notUploaded'), tone: '' };
    case 'sending':
      return { text: t('ui.online.submitting'), tone: '' };
    case 'done':
      return {
        text: v.improved
          ? t('ui.online.submitted', { rank: fmtNumber(v.rank) })
          : t('ui.online.submittedNoBest', { rank: fmtNumber(v.rank) }),
        tone: 'good',
      };
    case 'queued':
      return { text: t('ui.online.queued'), tone: '' };
    case 'rejected':
      return { text: v.message || t('ui.online.uploadFailed'), tone: 'warn' };
    case 'unavailable':
      return { text: t('ui.online.unavailableShort'), tone: 'warn' };
  }
}

export function outcomeView(o: SubmitOutcome): SubmitView {
  if (o.kind === 'ok')
    return { kind: 'done', rank: o.res.rank, total: o.res.total, improved: o.res.improved, pending: o.res.status === 'pending' };
  if (o.kind === 'queued') return { kind: 'queued', message: o.message };
  return { kind: 'rejected', message: o.message };
}

/** 同一局只记一次「我的记录」、只上传一次（面板可能因切换语言等原因重建） */
const recorded = new WeakSet<object>();
const uploads = new WeakMap<object, Promise<SubmitView>>();

function recordRun(ctx: GameCtx, wavesSurvived: number, ranked: boolean, day: string | null): void {
  const w = ctx.world as object;
  if (recorded.has(w)) return;
  recorded.add(w);
  try {
    const st = ctx.world.state;
    const won = st.phase === 'won';
    recordHistory(
      historyEntryOf(
        ctx.opts,
        {
          wave: wavesSurvived,
          score: st.score,
          won,
          stars: ctx.opts.mode === 'campaign' && won ? starsFor(st.lives, Math.max(st.lives, st.maxLives)) : 0,
          ai: isAiAssisted(ctx.aiAssist),
          ranked,
          daily: day,
          seed: st.seed,
        },
        Date.now(),
      ),
      ctx.app.store.get(),
    );
  } catch (e) {
    console.warn('[online] history failed', e);
  }
}

/**
 * 结算界面钩子：返回要插进结算卡片的元素。
 */
export function onlineSubmitPanel(ctx: GameCtx, wavesSurvived: number): HTMLElement | null {
  try {
    // 战役 / 随机种子的对局：路由里的 opts 不带种子，以 world 实际用的为准
    const opts = { ...ctx.opts, seed: ctx.opts.seed ?? ctx.world.state.seed };
    const ranked = isEligibleRun(opts);
    const day = ranked ? dailyDayOfOpts(opts) : null;
    recordRun(ctx, wavesSurvived, ranked, day);
    if (!ranked) {
      return h(
        'div.online-submit.lb-custom-note',
        { attrs: { role: 'note' } },
        h('div.os-line', null, h('span', null, boardLabel(CUSTOM_BOARD))),
        h('p.muted.small', null, t('ui.lb.customNote')),
      );
    }
    const board = boardOfRun(opts);
    const assisted = isAiAssisted(ctx.aiAssist);
    const assistText = aiModelText({
      aiModel: ctx.aiAssist?.model,
      aiEffort: isAiEffort(ctx.aiAssist?.effort) ? ctx.aiAssist.effort : undefined,
    });
    const world = ctx.world as object;
    const status = h('span.os-status', { attrs: { role: 'status', 'aria-live': 'polite' } });
    const nick = h('b.nick-name');
    const submitBtn = h<HTMLButtonElement>(
      'button.btn.small.primary',
      { attrs: { type: 'button' } },
      h('span.gi', { html: G.up }),
      t('ui.online.upload'),
    );
    const viewBtn = h(
      'button.btn.small',
      {
        attrs: { type: 'button' },
        onclick: () => {
          audio.play('click');
          if (day) ctx.app.go({ name: 'daily' });
          else {
            requestLeaderboardTab('endless', board);
            ctx.app.go({ name: 'leaderboard' });
          }
        },
      },
      h('span.gi', { html: G.trophy }),
      day ? t('ui.online.viewDaily') : t('ui.lb.viewBoard'),
    );
    const nickBtn = h(
      'button.btn.small',
      {
        attrs: { type: 'button', 'aria-label': t('ui.online.editNick') },
        onclick: async () => {
          audio.play('click');
          const n = await askNickname();
          if (n) paintNick();
        },
      },
      t('ui.online.rename'),
    );

    let view: SubmitView = { kind: 'idle' };
    const paint = () => {
      const st = submitText(view);
      setText(status, st.text);
      status.className = `os-status${st.tone ? ` ${st.tone}` : ''}`;
      submitBtn.hidden = !(view.kind === 'idle' || view.kind === 'rejected');
    };
    const paintNick = () => setText(nick, getNickname());

    const upload = (): Promise<SubmitView> => {
      const prev = uploads.get(world);
      if (prev) return prev;
      const p = (async (): Promise<SubmitView> => {
        try {
          const st = await initOnline();
          if (st.status === 'unavailable') return { kind: 'unavailable' };
          return outcomeView(
            await submitWorldRun(ctx.world as Parameters<typeof submitWorldRun>[0], {
              wavesSurvived,
              dailyDay: day,
              aiAssist: ctx.aiAssist,
            }),
          );
        } catch (e) {
          console.warn('[online] submit failed', e);
          return { kind: 'rejected', message: t('ui.online.uploadFailed') };
        }
      })();
      uploads.set(world, p);
      // 失败（被拒 / 不可用）后允许再点一次「上传成绩」重试
      void p.then((v) => {
        if (v.kind === 'rejected' || v.kind === 'unavailable') uploads.delete(world);
      });
      return p;
    };
    const run = async () => {
      view = { kind: 'sending' };
      paint();
      view = await upload();
      if (!panel.isConnected) return;
      if (view.kind === 'done' || view.kind === 'queued') audio.play(view.kind === 'done' ? 'select' : 'click');
      paint();
    };
    submitBtn.onclick = () => {
      audio.play('click');
      void run();
    };

    const panel = h(
      'div.online-submit',
      null,
      h(
        'div.os-line',
        null,
        h(
          'span.os-board',
          null,
          boardLabel(board),
          // AI 辅助：带模型名 + 思考档位（不含渠道）
          assisted
            ? h(
                'span.badge.lb-ai-badge',
                { title: assistText },
                t('ui.lb.ai'),
                assistText ? h('small.lb-ai-model', null, assistText) : null,
              )
            : null,
        ),
        status,
      ),
      h(
        'div.os-line',
        null,
        h('span.online-nick', null, h('span.muted.small', null, t('ui.online.nick')), nick, nickBtn),
        h('span.os-actions', null, submitBtn, viewBtn),
      ),
      assisted ? h('p.muted.small', null, t('ui.lb.aiSubmitNote')) : null,
      getAutoUpload() ? null : h('p.muted.small', null, t('ui.lb.autoOffNote')),
    );
    paintNick();
    paint();
    // 自动上传（缺省开启）；已经上传过的这一局（面板重建）直接显示结果
    if (getAutoUpload() || uploads.has(world)) void run();
    else
      void initOnline().then((st) => {
        if (st.status === 'unavailable' && view.kind === 'idle') {
          view = { kind: 'unavailable' };
          paint();
        }
      });
    return panel;
  } catch (e) {
    console.warn('[online] panel failed', e);
    return null;
  }
}

/** 兼容「挂载」写法 */
export function mountOnlineSubmit(container: HTMLElement, ctx: GameCtx, wavesSurvived?: number): void {
  const st = ctx.world.state;
  const el = onlineSubmitPanel(ctx, wavesSurvived ?? (st.phase === 'won' ? st.wave : Math.max(0, st.wave - 1)));
  if (el) container.appendChild(el);
}
