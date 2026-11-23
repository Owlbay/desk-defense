/**
 * 可收起的卡片：点卡片标题（h3）收起 / 展开，收起时标题下面显示一行摘要（当前选了什么）。
 * 开合状态按 key 记在 localStorage（每个卡片一份）。手机和电脑都能用；标题是真正的按钮，键盘可操作。
 *
 *   const c = collapsible(section, { key: 'ai.run', summary: () => '无尽 · 学生书桌 · 普通' });
 *   c.refresh();   // 选项变了：更新摘要
 *
 * 要求：section 的第一个 h3 文字是固定的（会被包进按钮里，之后不要再对 h3 setText）。
 */
import { onLocaleChange, t } from '../i18n';
import { audio } from './audio';
import { h } from './dom';
import { G } from './icons';

const PREFIX = 'desk-defense.fold.';

const read = (key: string): boolean | null => {
  try {
    const v = localStorage.getItem(PREFIX + key);
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
};
const write = (key: string, folded: boolean): void => {
  try {
    localStorage.setItem(PREFIX + key, folded ? '1' : '0');
  } catch {
    /* 隐私模式 */
  }
};

export interface CollapsibleOptions {
  /** 记忆开合状态用的键 */
  key: string;
  /** 收起时显示的一行摘要 */
  summary?: () => string;
  /** 没有记忆时是否默认收起（缺省展开） */
  folded?: boolean;
}

export interface CollapsibleHandle {
  readonly folded: boolean;
  setFolded(v: boolean): void;
  /** 选项变化后刷新摘要 */
  refresh(): void;
  destroy(): void;
}

let seq = 0;

/** 默认摘要：卡片里选中的分段按钮 / 单选项（取第一行文字），最多 5 个 */
function autoSummary(body: HTMLElement): string {
  const out: string[] = [];
  for (const b of body.querySelectorAll<HTMLElement>('button.on, [role="radio"][aria-checked="true"]')) {
    const hid = b.closest('[hidden]');
    if (hid && hid !== body && body.contains(hid)) continue;
    const s = (b.querySelector('b')?.textContent ?? b.textContent ?? '').trim().split('\n')[0];
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= 5) break;
  }
  return out.join(' · ');
}

export function collapsible(section: HTMLElement, o: CollapsibleOptions): CollapsibleHandle {
  const head = section.querySelector<HTMLElement>(':scope > h3');
  if (!head) return { folded: false, setFolded: () => undefined, refresh: () => undefined, destroy: () => undefined };
  const id = `fold-${++seq}`;
  const body = h('div.fold-body', { attrs: { id } });
  // 标题后面的所有内容移进 body（收起时整体隐藏）
  let n = head.nextSibling;
  while (n) {
    const next = n.nextSibling;
    body.appendChild(n);
    n = next;
  }
  const label = h('span.fold-label');
  label.append(...Array.from(head.childNodes));
  const sum = h('small.fold-sum.muted');
  const btn = h<HTMLButtonElement>(
    'button.fold-toggle',
    { attrs: { type: 'button', 'aria-controls': id } },
    label,
    h('span.gi.fold-chev', { html: G.up, attrs: { 'aria-hidden': 'true' } }),
  );
  head.replaceChildren(btn);
  section.classList.add('foldable');
  section.append(sum, body);

  let folded = read(o.key) ?? !!o.folded;
  const paint = (): void => {
    section.classList.toggle('folded', folded);
    btn.setAttribute('aria-expanded', folded ? 'false' : 'true');
    btn.title = folded ? t('ui.fold.expand') : t('ui.fold.collapse');
    body.hidden = folded;
    const s = folded ? (o.summary ? o.summary() : autoSummary(body)) : '';
    sum.textContent = s;
    sum.hidden = !s;
  };
  btn.onclick = () => {
    audio.play('click');
    folded = !folded;
    write(o.key, folded);
    paint();
  };
  const off = onLocaleChange(() => paint());
  paint();
  return {
    get folded() {
      return folded;
    },
    setFolded(v) {
      folded = v;
      paint();
    },
    refresh: paint,
    destroy: off,
  };
}
