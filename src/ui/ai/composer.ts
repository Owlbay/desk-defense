/**
 * 「给 AI 下指令」（AI 侧栏底部，各页签共用）：输入框 + 快捷短语 + 长期方针。
 *
 *  - Enter 发送，Shift+Enter 换行；输入框聚焦时点棋盘：空地插入 "(x,y)"，塔插入 "#uid"；
 *  - 「这一次」：进入下一次决策（立即触发，波次中也会；暂停模式下游戏会停下等 AI），处理完标记完成并显示 AI 的回应；
 *  - 「一直」：长期方针，钉成可移除的小标签（最多 5 条），本局每次决策都带上；
 *  - 指令只是给 AI 的游戏请求：发给模型的是纯文本（去控制字符、截断），模型能做的仍只有游戏里的操作。
 */
import {
  INSTRUCTION_MAX_CHARS,
  type InstructionKind,
  type InstructionQueue,
  type PlayerInstruction,
  STANDING_MAX,
} from '../../agent/instructions';
import { ui } from '../../game/UiStore';
import { onLocaleChange, t } from '../../i18n';
import { audio } from '../audio';
import { h, setText } from '../dom';
import { G } from '../icons';

/** 快捷短语（文案 key；发送的是当前语言的文字，离线演示四种语言的关键词都认） */
export const QUICK_KEYS = ['antiAir', 'boss', 'save', 'maze', 'aoe', 'reclaim', 'holdRight', 'startWave'] as const;

export interface ComposerOptions {
  queue: InstructionQueue;
  role: 'player' | 'advisor';
  /** 当前游戏时间（秒） */
  now: () => number;
  /** 发送了一条（让宿主立即触发决策 / 打开侧栏等） */
  onSend?: (item: PlayerInstruction) => void;
  toast: (text: string, tone?: 'info' | 'warn') => void;
}

export interface ComposerHandle {
  readonly el: HTMLElement;
  focus(): void;
  /** 对局结束 / AI 停了：禁用输入 */
  setEnabled(on: boolean): void;
  destroy(): void;
}

const RECENT_MAX = 3;

export function mountComposer(o: ComposerOptions): ComposerHandle {
  const { queue } = o;
  let kind: InstructionKind = 'once';
  let enabled = true;
  let destroyed = false;

  const input = h<HTMLTextAreaElement>('textarea.input.ic-input', {
    attrs: { rows: 1, maxlength: INSTRUCTION_MAX_CHARS, enterkeyhint: 'send', autocomplete: 'off', spellcheck: 'false' },
  });
  const sendBtn = h<HTMLButtonElement>('button.btn.primary.small.ic-send', { attrs: { type: 'button' } }, h('span.gi', { html: G.up }));
  const onceBtn = h<HTMLButtonElement>('button.seg', { attrs: { type: 'button', 'aria-pressed': 'true' }, data: { k: 'once' } });
  const standBtn = h<HTMLButtonElement>('button.seg', { attrs: { type: 'button', 'aria-pressed': 'false' }, data: { k: 'standing' } });
  const kindSeg = h('div.segs.ic-kind', { attrs: { role: 'group' } }, onceBtn, standBtn);
  const quick = h('div.ic-quick');
  const quickBtns = QUICK_KEYS.map((k) => {
    const b = h<HTMLButtonElement>('button.ic-chip', { attrs: { type: 'button' }, data: { k } });
    quick.appendChild(b);
    return b;
  });
  const standing = h('div.ic-standing', { attrs: { 'aria-live': 'polite' } });
  const recent = h('ol.ic-recent', { attrs: { 'aria-live': 'polite' } });
  const hint = h('small.ic-hint.muted');
  const count = h('small.ic-count.muted');
  const el = h(
    'div.ai-composer',
    { data: { role: o.role } },
    recent,
    standing,
    quick,
    h('div.ic-row', null, kindSeg, input, sendBtn),
    h('div.ic-meta', null, hint, count),
  );

  const paintStatic = (): void => {
    input.placeholder = t(o.role === 'advisor' ? 'agent.dock.inputAdvisor' : 'agent.dock.input');
    input.setAttribute('aria-label', t('agent.dock.inputLabel'));
    sendBtn.setAttribute('aria-label', t('agent.dock.send'));
    sendBtn.title = t('agent.dock.send');
    setText(onceBtn, t('agent.dock.once'));
    onceBtn.title = t('agent.dock.onceTip');
    setText(standBtn, t('agent.dock.standing'));
    standBtn.title = t('agent.dock.standingTip', { n: STANDING_MAX });
    kindSeg.setAttribute('aria-label', t('agent.dock.kind'));
    quick.setAttribute('aria-label', t('agent.dock.quick'));
    for (const b of quickBtns) setText(b, t(`agent.dock.q.${b.dataset.k}`));
    setText(hint, t('agent.dock.hint'));
    el.setAttribute('aria-label', t('agent.dock.inputLabel'));
    paintList(queue.list());
  };

  const paintKind = (): void => {
    for (const b of [onceBtn, standBtn]) {
      const on = b.dataset.k === kind;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    el.dataset.kind = kind;
  };

  const statusText = (x: PlayerInstruction): string => {
    if (x.status === 'pending') return t('agent.dock.st.pending');
    if (x.status === 'sent') return t('agent.dock.st.sent');
    if (x.ack) return x.ack;
    return t(`agent.dock.ack.${x.ackCode ?? 'noReply'}`);
  };

  function paintList(list: readonly PlayerInstruction[]): void {
    // 长期方针：可移除的小标签
    const st = list.filter((x) => x.kind === 'standing' && x.status !== 'removed');
    standing.replaceChildren(
      ...st.map((x) =>
        h(
          'span.ic-pin',
          { attrs: { title: x.text } },
          h('span.gi', { html: G.target }),
          h('span.ic-pin-text', null, x.text),
          h(
            'button.ic-pin-x',
            {
              attrs: { type: 'button', 'aria-label': t('agent.dock.unpin', { text: x.text }) },
              onclick: () => {
                audio.play('click');
                queue.remove(x.id);
              },
            },
            h('span.gi', { html: G.close }),
          ),
        ),
      ),
    );
    standing.hidden = st.length === 0;
    setText(count, st.length ? t('agent.dock.pinned', { n: st.length, max: STANDING_MAX }) : '');
    // 最近几条一次性指令与状态 / AI 的回应
    const once = list.filter((x) => x.kind === 'once').slice(-RECENT_MAX);
    recent.replaceChildren(
      ...once.map((x) => {
        const bad = x.status === 'done' && (!x.ack || /无法|cannot|can't|できない|無法/i.test(x.ack)) && x.ackCode !== 'withdrawn';
        return h(
          `li.ic-item.s-${x.status}${bad ? '.bad' : ''}`,
          null,
          h('span.ic-item-text', null, h('b', null, `P${x.id}`), ` ${x.text}`),
          h('small.ic-item-ack', null, statusText(x)),
          x.status === 'pending'
            ? h(
                'button.ic-item-x',
                {
                  attrs: { type: 'button', 'aria-label': t('agent.dock.withdraw') },
                  onclick: () => {
                    audio.play('click');
                    queue.remove(x.id);
                  },
                },
                h('span.gi', { html: G.close }),
              )
            : null,
        );
      }),
    );
    recent.hidden = once.length === 0;
  }

  const send = (text: string, k: InstructionKind = kind): boolean => {
    if (!enabled) return false;
    const r = queue.add(text, k, o.now());
    if (!r.ok) {
      audio.play('error');
      if (r.reason === 'standing_full') o.toast(t('agent.dock.standingFull', { n: STANDING_MAX }), 'warn');
      return false;
    }
    audio.play('select');
    o.onSend?.(r.item);
    return true;
  };

  const autosize = (): void => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(96, input.scrollHeight)}px`;
  };
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (send(input.value)) {
        input.value = '';
        autosize();
      }
    }
  });
  sendBtn.onclick = () => {
    if (send(input.value)) {
      input.value = '';
      autosize();
    }
    input.focus({ preventScroll: true });
  };
  kindSeg.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-k]');
    if (!b) return;
    audio.play('click');
    kind = b.dataset.k === 'standing' ? 'standing' : 'once';
    paintKind();
  });
  quick.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-k]');
    if (!b) return;
    send(b.textContent ?? '');
  });

  // ── 点棋盘插入坐标 / 塔编号 ──
  /** 输入框刚失焦（点棋盘时 pointerdown 先让输入框失焦）：这段时间里的棋盘点击仍然算插入 */
  let armedUntil = 0;
  let disarmT = 0;
  const pick = (p: { cx: number; cy: number; uid: number }): void => {
    if (!input.isConnected) return;
    const token = p.uid ? `#${p.uid}` : `(${p.cx},${p.cy})`;
    const a = input.selectionStart ?? input.value.length;
    const b = input.selectionEnd ?? a;
    const before = input.value.slice(0, a);
    const sep = before && !/\s$/.test(before) ? ' ' : '';
    input.value = `${before}${sep}${token}${input.value.slice(b)}`.slice(0, INSTRUCTION_MAX_CHARS);
    const caret = Math.min(input.value.length, before.length + sep.length + token.length);
    input.focus({ preventScroll: true });
    input.setSelectionRange(caret, caret);
    autosize();
    audio.play('click');
  };
  const arm = (): void => {
    clearTimeout(disarmT);
    if (enabled) ui.set({ boardPick: pick });
  };
  input.addEventListener('focus', arm);
  input.addEventListener('blur', () => {
    armedUntil = Date.now() + 400;
    clearTimeout(disarmT);
    disarmT = window.setTimeout(() => {
      if (document.activeElement !== input && Date.now() >= armedUntil && ui.state.boardPick === pick) ui.set({ boardPick: null });
    }, 420);
  });

  const off = queue.subscribe((list) => {
    if (!destroyed) paintList(list);
  });
  const offLocale = onLocaleChange(() => {
    if (!destroyed) paintStatic();
  });
  paintKind();
  paintStatic();

  return {
    el,
    focus: () => input.focus({ preventScroll: true }),
    setEnabled(on) {
      enabled = on;
      input.disabled = !on;
      sendBtn.disabled = !on;
      for (const b of quickBtns) b.disabled = !on;
      el.classList.toggle('disabled', !on);
      if (!on && ui.state.boardPick === pick) ui.set({ boardPick: null });
    },
    destroy() {
      destroyed = true;
      off();
      offLocale();
      clearTimeout(disarmT);
      if (ui.state.boardPick === pick) ui.set({ boardPick: null });
      el.remove();
    },
  };
}
