/**
 * 昵称：对话框 + 页面头部的「昵称 · 修改」小组件
 */
import { getNickname, setNickname } from '../../meta/online';
import { NICK_MAX } from '../../shared/leaderboard';
import { audio } from '../audio';
import { h } from '../dom';
import { nicknameError } from './util';

/** 对话框挂载点：优先挂在 .app 根上（fixed 覆盖层） */
function host(parent?: HTMLElement | null): HTMLElement {
  return parent ?? (document.querySelector('.app') as HTMLElement | null) ?? document.body;
}

/**
 * 弹出昵称输入框。确认后保存并返回昵称；取消返回 null。
 */
export function askNickname(o: { parent?: HTMLElement | null; title?: string; hint?: string } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h<HTMLInputElement>('input.input', {
      attrs: { type: 'text', maxlength: NICK_MAX * 2, placeholder: `1–${NICK_MAX} 个字`, autocomplete: 'nickname', spellcheck: 'false', enterkeyhint: 'done' },
    });
    input.value = getNickname();
    const msg = h('small.form-msg', { attrs: { 'aria-live': 'polite' } });
    const okBtn = h<HTMLButtonElement>('button.btn.primary', { attrs: { type: 'submit' } }, '保存');
    const cancelBtn = h<HTMLButtonElement>('button.btn', { attrs: { type: 'button' } }, '取消');

    let done = false;
    const close = (v: string | null) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.classList.add('out');
      setTimeout(() => overlay.remove(), 160);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        audio.play('click');
        close(null);
      }
    };
    const validate = (): string | null => {
      const err = nicknameError(input.value);
      msg.textContent = err ?? '';
      msg.classList.toggle('bad', !!err);
      return err;
    };
    input.addEventListener('input', () => {
      if (msg.textContent) validate();
    });
    const form = h<HTMLFormElement>(
      'form.dialog.card.nick-dialog',
      {
        attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': '设置昵称', novalidate: true },
        onsubmit: (e: Event) => {
          e.preventDefault();
          if (validate()) return audio.play('error');
          const r = setNickname(input.value);
          if (!r.ok) {
            msg.textContent = r.message;
            msg.classList.add('bad');
            return audio.play('error');
          }
          audio.play('select');
          close(r.value);
        },
      },
      h('h2', null, o.title ?? '设置昵称'),
      h('p.muted.small', null, o.hint ?? '昵称会显示在全服排行榜上，之后可以随时修改。'),
      h('label.field', null, h('span', null, '昵称'), input, msg),
      h('div.nick-actions', null, cancelBtn, okBtn),
    );
    cancelBtn.onclick = () => {
      audio.play('click');
      close(null);
    };
    const overlay = h('div.overlay.nick-overlay', {
      onclick: (e: Event) => {
        if (e.target === overlay) {
          audio.play('click');
          close(null);
        }
      },
    }, form);
    document.addEventListener('keydown', onKey, true);
    host(o.parent).appendChild(overlay);
    setTimeout(() => input.focus(), 30);
  });
}

/** 确保有昵称：已有直接返回，否则弹框询问 */
export async function ensureNickname(parent?: HTMLElement | null): Promise<string | null> {
  const n = getNickname();
  if (n && !nicknameError(n)) return n;
  return askNickname({ parent, title: '第一次上传成绩', hint: '给自己起个昵称吧，它会显示在全服排行榜上。' });
}

/** 页面头部：昵称 + 修改按钮 */
export function nicknameChip(onChange?: (n: string) => void): HTMLElement {
  const name = h('span.nick-name');
  const paint = () => {
    const n = getNickname();
    name.textContent = n || '未设置昵称';
    name.classList.toggle('muted', !n);
  };
  paint();
  return h(
    'span.online-nick',
    null,
    h('span.muted.small', null, '昵称'),
    name,
    h(
      'button.btn.small',
      {
        attrs: { type: 'button', 'aria-label': '修改昵称' },
        onclick: async () => {
          audio.play('click');
          const n = await askNickname();
          if (n) {
            paint();
            onChange?.(n);
          }
        },
      },
      '修改',
    ),
  );
}
