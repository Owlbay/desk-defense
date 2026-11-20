/** 轻量 DOM 构建工具 */
export type Child = Node | string | number | null | undefined | false | Child[];

export interface Props {
  class?: string;
  style?: string | Partial<Record<string, string>>;
  html?: string;
  title?: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  data?: Record<string, string>;
  [on: `on${string}`]: ((ev: any) => void) | undefined;
}

/** h('div.card.big', {onclick}, '文字', child) */
export function h<T extends HTMLElement = HTMLElement>(sel: string, props?: Props | null, ...children: Child[]): T {
  const [tag, ...classes] = sel.split('.');
  const el = document.createElement(tag || 'div') as T;
  if (classes.length) el.className = classes.join(' ');
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null) continue;
      if (k === 'class') el.className = (el.className ? el.className + ' ' : '') + String(v);
      else if (k === 'style') {
        if (typeof v === 'string') el.setAttribute('style', v);
        else for (const [sk, sv] of Object.entries(v as Record<string, string>)) el.style.setProperty(sk, sv);
      } else if (k === 'html') el.innerHTML = String(v);
      else if (k === 'title') el.title = String(v);
      else if (k === 'attrs') {
        for (const [ak, av] of Object.entries(v as Record<string, unknown>)) {
          if (av === false || av === null || av === undefined) continue;
          el.setAttribute(ak, av === true ? '' : String(av));
        }
      } else if (k === 'data') {
        for (const [dk, dv] of Object.entries(v as Record<string, string>)) el.dataset[dk] = dv;
      } else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2), v as EventListener);
      }
    }
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** 只在文本变化时写 DOM */
export function setText(el: Element, t: string | number): void {
  const s = String(t);
  if (el.textContent !== s) el.textContent = s;
}

export function toggle(el: Element, cls: string, on: boolean): void {
  if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}

export function img(src: string, cls = 'ico', alt = ''): HTMLImageElement {
  const i = document.createElement('img');
  i.src = src;
  i.className = cls;
  i.alt = alt;
  i.draggable = false;
  i.decoding = 'async';
  return i;
}

export function svgIcon(svg: string, cls = 'gi'): HTMLElement {
  const s = document.createElement('span');
  s.className = cls;
  s.innerHTML = svg;
  s.setAttribute('aria-hidden', 'true');
  return s;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export const fmtNum = (n: number): string => Math.round(n).toLocaleString('zh-CN');

export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (t as HTMLInputElement).type;
    return !['range', 'checkbox', 'radio', 'button', 'submit'].includes(type);
  }
  return t.isContentEditable;
}
