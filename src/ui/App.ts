import type { RunOptions } from '../core/types';
import type { MidRun, ProfileStore, Settings } from '../meta/profile';
import { setRenderQuality } from '../render';
import { audio } from './audio';
import { h } from './dom';
import { G } from './icons';

export interface Screen {
  el: HTMLElement;
  destroy?(): void;
  /** 屏幕上的 Esc 处理；返回 true 表示已处理 */
  onEsc?(): boolean;
}

export type Route =
  | { name: 'menu' }
  | { name: 'campaign' }
  | { name: 'endless' }
  | { name: 'custom' }
  | { name: 'skills'; from?: Route }
  | { name: 'talents' }
  | { name: 'leaderboard' }
  | { name: 'settings' }
  | { name: 'game'; opts: RunOptions; resume?: MidRun; userSeed?: boolean };

export type ScreenFactory = (app: App, route: Route) => Screen;

/** 设置生效：音量与画质 */
export function applySettings(s: Settings): void {
  audio.setVolumes(s.sfx, s.music);
  try {
    setRenderQuality(s.quality);
  } catch {
    /* 渲染层尚未就绪时忽略 */
  }
}

export class App {
  private current: Screen | null = null;
  private factories = new Map<Route['name'], ScreenFactory>();
  private toastHost: HTMLElement;
  route: Route = { name: 'menu' };

  constructor(
    readonly root: HTMLElement,
    readonly store: ProfileStore,
  ) {
    this.toastHost = h('div.app-toasts', { attrs: { 'aria-live': 'polite' } });
    root.appendChild(this.toastHost);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.route.name !== 'game') {
        if (this.current?.onEsc?.()) return;
        if (this.route.name !== 'menu') this.go({ name: 'menu' });
      }
    });
  }

  register(name: Route['name'], f: ScreenFactory): void {
    this.factories.set(name, f);
  }

  go(route: Route): void {
    const f = this.factories.get(route.name);
    if (!f) return;
    const prev = this.current;
    this.current = null;
    if (prev) {
      try {
        prev.destroy?.();
      } catch (e) {
        console.error(e);
      }
      prev.el.remove();
    }
    this.route = route;
    const s = f(this, route);
    this.current = s;
    s.el.classList.add('screen-enter');
    this.root.insertBefore(s.el, this.toastHost);
    audio.setMusic(this.store.get().settings.music > 0);
    audio.setIntensity(route.name === 'game' ? 0.4 : 0);
  }

  /** 菜单页面的短提示 */
  toast(text: string, tone: 'info' | 'warn' | 'good' = 'info'): void {
    const t = h(`div.app-toast.tone-${tone}`, null, text);
    this.toastHost.appendChild(t);
    setTimeout(() => t.classList.add('out'), 2200);
    setTimeout(() => t.remove(), 2600);
  }
}

// ───────────── 通用组件 ─────────────

export function currencyChips(store: ProfileStore): HTMLElement {
  const p = store.get();
  return h(
    'div.chips',
    null,
    h('span.chip', { title: '星星：战役评星获得，用于解锁天赋' }, h('span.gi', { html: G.star }), String(p.currency.star)),
    h('span.chip', { title: '墨水：无尽 / 自定义模式每撑过 1 波获得' }, h('span.gi', { html: G.ink }), String(Math.floor(p.currency.ink))),
  );
}

export function screenHeader(app: App, title: string, opts: { back?: Route; chips?: boolean; extra?: HTMLElement } = {}): HTMLElement {
  return h(
    'header.screen-head',
    null,
    h(
      'button.btn.icon-btn.back',
      {
        attrs: { 'aria-label': '返回' },
        onclick: () => {
          audio.play('click');
          app.go(opts.back ?? { name: 'menu' });
        },
      },
      h('span.gi', { html: G.back }),
    ),
    h('h1.screen-title', null, title),
    h('div.head-right', null, opts.extra ?? null, opts.chips === false ? null : currencyChips(app.store)),
  );
}

export interface ConfirmOptions {
  title: string;
  text?: string;
  ok?: string;
  cancel?: string;
  danger?: boolean;
}

/** 页面内确认框（不用 window.confirm） */
export function confirmDialog(parent: HTMLElement, o: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const close = (v: boolean) => {
      audio.play('click');
      overlay.classList.add('out');
      setTimeout(() => overlay.remove(), 160);
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        close(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        close(true);
      }
    };
    const okBtn = h(`button.btn.${o.danger ? 'danger' : 'primary'}`, { onclick: () => close(true) }, o.ok ?? '确定');
    const overlay = h(
      'div.overlay.confirm-overlay',
      { onclick: (e: MouseEvent) => e.target === overlay && close(false) },
      h(
        'div.dialog.card',
        { attrs: { role: 'alertdialog', 'aria-modal': 'true' } },
        h('h2', null, o.title),
        o.text ? h('p.muted', null, o.text) : null,
        h('div.row.end', null, h('button.btn', { onclick: () => close(false) }, o.cancel ?? '取消'), okBtn),
      ),
    );
    document.addEventListener('keydown', onKey, true);
    parent.appendChild(overlay);
    requestAnimationFrame(() => okBtn.focus());
  });
}
