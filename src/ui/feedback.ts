/**
 * 游戏内反馈对话框（设置页底部、主菜单底部、对局暂停 → 设置）。
 *
 * - 类型（bug / 建议 / 其他）+ 正文（必填，≤ 1000 字，带计数）+ 联系方式（可选，≤ 100 字）；
 * - 自动附带版本、语言、屏幕尺寸、当前页面 / 对局模式、浏览器 UA，并在对话框里原样展示；
 * - 发送 POST /api/feedback；失败（离线、本地开发没有 API、原生壳连不上）时给出错误、「复制反馈内容」按钮和 GitHub Issues 地址；
 * - 没发出去就关掉时保留草稿（只在内存里，刷新页面即丢弃）。
 */
import { t } from '../i18n';
import { contextSummary, FEEDBACK_ISSUES_URL, feedbackContext, feedbackCopyText, type RouteLike } from '../meta/feedback';
import { sendFeedback } from '../meta/online';
import { charCount, clampChars, FEEDBACK_CONTACT_MAX, FEEDBACK_KINDS, FEEDBACK_TEXT_MAX, type FeedbackKind } from '../shared/feedback';
import { audio } from './audio';
import { copyText, h } from './dom';
import { G } from './icons';
import { DUR, motionOK } from './screens/motion';

interface Draft {
  kind: FeedbackKind;
  text: string;
  contact: string;
}

let draft: Draft = { kind: 'bug', text: '', contact: '' };
let seq = 0;

/** 打开反馈对话框；route 用来附带当前页面 / 对局模式 */
export function feedbackDialog(parent: HTMLElement, route: RouteLike | null | undefined): void {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const ctx = feedbackContext(route);
  const uid = `fb${++seq}`;
  let sending = false;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    audio.play('click');
    overlay.classList.add('out');
    setTimeout(() => overlay.remove(), motionOK() ? DUR.s + 40 : 0);
    document.removeEventListener('keydown', onKey, true);
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      close();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !sendBtn.disabled) {
      e.preventDefault();
      void submit();
    }
  };

  // ── 类型 ──
  const kindLabel = t('ui.feedback.kindLabel');
  const kindSeg = h('div.seg-grid.three.feedback-kinds', { attrs: { role: 'radiogroup', 'aria-label': kindLabel } });
  const renderKinds = () => {
    kindSeg.replaceChildren(
      ...FEEDBACK_KINDS.map((k) =>
        h(
          `button.seg${draft.kind === k ? '.on' : ''}`,
          {
            attrs: { type: 'button', role: 'radio', 'aria-checked': String(draft.kind === k) },
            onclick: () => {
              if (draft.kind === k) return;
              audio.play('click');
              draft.kind = k;
              renderKinds();
              (kindSeg.querySelector('.seg.on') as HTMLElement | null)?.focus();
            },
          },
          t(`ui.feedback.kind.${k}`),
        ),
      ),
    );
  };
  renderKinds();

  // ── 正文 ──
  const counter = h('small.feedback-count.muted', { attrs: { id: `${uid}-count`, 'aria-live': 'polite' } });
  const textArea = h<HTMLTextAreaElement>('textarea.input.feedback-text', {
    attrs: {
      id: `${uid}-text`,
      rows: 5,
      maxlength: FEEDBACK_TEXT_MAX * 2,
      required: true,
      placeholder: t('ui.feedback.textPlaceholder'),
      'aria-describedby': `${uid}-count`,
    },
  });
  textArea.value = draft.text;
  const syncText = () => {
    if (charCount(textArea.value) > FEEDBACK_TEXT_MAX) textArea.value = clampChars(textArea.value, FEEDBACK_TEXT_MAX);
    draft.text = textArea.value;
    const n = charCount(textArea.value);
    counter.textContent = t('ui.feedback.count', { n, max: FEEDBACK_TEXT_MAX });
    counter.classList.toggle('near', n >= FEEDBACK_TEXT_MAX * 0.9);
    sendBtn.disabled = sending || !textArea.value.trim();
  };
  textArea.addEventListener('input', syncText);

  // ── 联系方式（可选） ──
  const contactInput = h<HTMLInputElement>('input.input', {
    attrs: {
      id: `${uid}-contact`,
      type: 'text',
      maxlength: FEEDBACK_CONTACT_MAX,
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: t('ui.feedback.contactPlaceholder'),
    },
  });
  contactInput.value = draft.contact;
  contactInput.addEventListener('input', () => (draft.contact = contactInput.value));

  // ── 发送结果 / 失败兜底 ──
  const status = h('div.feedback-status', { attrs: { 'aria-live': 'polite' } });
  const showFailure = (message: string) => {
    const copyBtn = h(
      'button.btn.small',
      {
        attrs: { type: 'button' },
        onclick: async () => {
          audio.play('click');
          const ok = await copyText(feedbackCopyText({ kind: draft.kind, text: textArea.value, contact: contactInput.value }, ctx));
          copyMsg.textContent = ok ? t('ui.feedback.copied') : t('ui.feedback.copyFailed');
          copyMsg.className = `form-msg ${ok ? 'good' : 'bad'}`;
        },
      },
      h('span.gi', { html: G.copy }),
      t('ui.feedback.copy'),
    );
    const copyMsg = h('small.form-msg');
    status.replaceChildren(
      h('p.form-msg.bad', { attrs: { role: 'alert' } }, t('ui.feedback.failed', { msg: message })),
      h('p.muted', null, t('ui.feedback.fallback')),
      h(
        'p.feedback-url',
        null,
        h('a', { attrs: { href: FEEDBACK_ISSUES_URL, target: '_blank', rel: 'noopener noreferrer' } }, FEEDBACK_ISSUES_URL),
      ),
      h('div.row', null, copyBtn, copyMsg),
    );
  };

  const submit = async () => {
    if (sending || closed) return;
    const text = textArea.value.trim();
    if (!text) {
      textArea.focus();
      return;
    }
    sending = true;
    sendBtn.disabled = true;
    sendBtn.textContent = t('ui.feedback.sending');
    status.replaceChildren();
    const r = await sendFeedback({ kind: draft.kind, text, contact: contactInput.value.trim() || undefined, context: ctx });
    sending = false;
    sendBtn.textContent = t('ui.feedback.send');
    if (closed) return;
    if (r.ok) {
      audio.play('select');
      draft = { kind: 'bug', text: '', contact: '' };
      const done = h('button.btn.primary', { attrs: { type: 'button' }, onclick: close }, t('common.close'));
      dialog.replaceChildren(
        h('h2', { attrs: { id: `${uid}-title` } }, t('ui.feedback.title')),
        h('p.feedback-thanks', { attrs: { role: 'status' } }, t('ui.feedback.thanks')),
        h('div.row.end', null, done),
      );
      done.focus();
      return;
    }
    audio.play('error');
    showFailure(r.message);
    syncText();
  };

  const cancelBtn = h('button.btn', { attrs: { type: 'button' }, onclick: close }, t('common.cancel'));
  const sendBtn = h<HTMLButtonElement>(
    'button.btn.primary',
    { attrs: { type: 'button' }, onclick: () => void submit() },
    t('ui.feedback.send'),
  );

  const dialog = h(
    'div.dialog.card.feedback-dialog',
    { attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': `${uid}-title` } },
    h('h2', { attrs: { id: `${uid}-title` } }, t('ui.feedback.title')),
    h('p.muted', null, t('ui.feedback.intro')),
    h('div.field', null, h('span', null, kindLabel), kindSeg),
    h(
      'div.field',
      null,
      h('label.feedback-label', { attrs: { for: `${uid}-text` } }, h('span', null, t('ui.feedback.text')), counter),
      textArea,
    ),
    h(
      'div.field',
      null,
      h('label', { attrs: { for: `${uid}-contact` } }, t('ui.feedback.contact'), ' ', h('small.muted', null, t('ui.feedback.optional'))),
      contactInput,
    ),
    h('p.feedback-attached.muted', null, t('ui.feedback.attached', { info: contextSummary(ctx) })),
    status,
    h('div.row.end', null, cancelBtn, sendBtn),
  );
  const overlay = h('div.overlay.confirm-overlay', { onclick: (e: MouseEvent) => e.target === overlay && !sending && close() }, dialog);

  syncText();
  document.addEventListener('keydown', onKey, true);
  parent.appendChild(overlay);
  requestAnimationFrame(() => textArea.focus({ preventScroll: true }));
}
