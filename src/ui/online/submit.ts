/**
 * 结算面板里的「全服排行榜」区：昵称、上传状态、查看全服榜。
 * 只对无尽（非自定义）与每日挑战显示；全部异步，不阻塞结算界面。
 */
import { isAiAssisted } from '../../meta/aiAssist';
import { getNickname, initOnline, submitWorldRun, type SubmitOutcome } from '../../meta/online';
import { boardLabel } from '../../shared/leaderboard';
import { fmtNumber, t } from '../../i18n';
import { audio } from '../audio';
import { h, setText } from '../dom';
import { G } from '../icons';
import type { GameCtx } from '../hud/context';
import { askNickname, ensureNickname } from './nickname';
import { requestLeaderboardTab } from './nav';
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
          ? t(v.pending ? 'ui.online.submittedPending' : 'ui.online.submitted', { rank: fmtNumber(v.rank) })
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
  if (o.kind === 'ok') return { kind: 'done', rank: o.res.rank, total: o.res.total, improved: o.res.improved, pending: o.res.status === 'pending' };
  if (o.kind === 'queued') return { kind: 'queued', message: o.message };
  return { kind: 'rejected', message: o.message };
}

/**
 * 结算界面钩子：返回要插进结算卡片的元素；不符合条件的对局返回 null。
 */
export function onlineSubmitPanel(ctx: GameCtx, wavesSurvived: number): HTMLElement | null {
  try {
    if (!isEligibleRun(ctx.opts)) return null;
    const day = dailyDayOfOpts(ctx.opts);
    // 公平性：用过「让 AI 替我玩」的对局不上传（说明原因，不显示上传按钮）
    if (isAiAssisted(ctx.aiAssist)) return aiAssistNote(!!day);
    const board = boardOfRun(ctx.opts);
    const status = h('span.os-status', { attrs: { role: 'status', 'aria-live': 'polite' } });
    const nick = h('b.nick-name');
    const submitBtn = h<HTMLButtonElement>('button.btn.small.primary', { attrs: { type: 'button' } }, h('span.gi', { html: G.up }), t('ui.online.upload'));
    const viewBtn = h(
      'button.btn.small',
      {
        attrs: { type: 'button' },
        onclick: () => {
          audio.play('click');
          if (day) ctx.app.go({ name: 'daily' });
          else {
            requestLeaderboardTab('global', board);
            ctx.app.go({ name: 'leaderboard' });
          }
        },
      },
      h('span.gi', { html: G.trophy }),
      day ? t('ui.online.viewDaily') : t('ui.online.viewGlobal'),
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
      submitBtn.disabled = false;
    };
    const paintNick = () => setText(nick, getNickname() || t('ui.online.notSet'));

    let busy = false;
    const doSubmit = async (interactive: boolean) => {
      if (busy) return;
      busy = true;
      try {
        const st = await initOnline();
        if (st.status === 'unavailable') {
          view = { kind: 'unavailable' };
          return;
        }
        const n = interactive ? await ensureNickname() : getNickname();
        if (!n) {
          view = { kind: 'idle' };
          return;
        }
        paintNick();
        view = { kind: 'sending' };
        paint();
        view = outcomeView(await submitWorldRun(ctx.world as Parameters<typeof submitWorldRun>[0], { wavesSurvived, dailyDay: day, aiAssist: ctx.aiAssist }));
        if (view.kind === 'done' || view.kind === 'queued') audio.play(view.kind === 'done' ? 'select' : 'click');
      } catch (e) {
        console.warn('[online] submit failed', e);
        view = { kind: 'rejected', message: t('ui.online.uploadFailed') };
      } finally {
        busy = false;
        paint();
      }
    };
    submitBtn.onclick = () => {
      audio.play('click');
      void doSubmit(true);
    };

    const panel = h(
      'div.online-submit',
      null,
      h('div.os-line', null, h('span', null, day ? null : h('span.muted.small', null, t('ui.online.globalPrefix')), boardLabel(board)), status),
      h('div.os-line', null, h('span.online-nick', null, h('span.muted.small', null, t('ui.online.nick')), nick, nickBtn), h('span.os-actions', null, submitBtn, viewBtn)),
    );
    paintNick();
    paint();
    // 已有昵称：自动上传；没有昵称：等玩家点「上传成绩」再问
    if (getNickname()) void doSubmit(false);
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

/** AI 协助的对局：结算面板里替代上传区的说明 */
export function aiAssistNote(daily: boolean): HTMLElement {
  return h(
    'div.online-submit.ai-assist-note',
    { attrs: { role: 'note' } },
    h('div.os-line', null, h('span.badge.ai-assist-badge', null, t('ui.assist.badge')), h('b', null, daily ? t('ui.assist.notUploadedDaily') : t('ui.assist.notUploaded'))),
    h('p.muted.small', null, t('ui.assist.notUploadedWhy')),
  );
}

/** 兼容「挂载」写法 */
export function mountOnlineSubmit(container: HTMLElement, ctx: GameCtx, wavesSurvived?: number): void {
  const st = ctx.world.state;
  const el = onlineSubmitPanel(ctx, wavesSurvived ?? (st.phase === 'won' ? st.wave : Math.max(0, st.wave - 1)));
  if (el) container.appendChild(el);
}
