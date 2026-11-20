import type { RunOptions } from '../core/types';
import type { MidRun, ProfileStore, Settings } from '../meta/profile';
import { setRenderQuality } from '../render';
import { audio } from './audio';
import { h } from './dom';
import { G } from './icons';
import { countTo, DUR, EASE_IN, EASE_OUT, flip, motionOK, shake } from './screens/motion';

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
  | { name: 'daily' }
  | { name: 'game'; opts: RunOptions; resume?: MidRun; userSeed?: boolean };

export type ScreenFactory = (app: App, route: Route) => Screen;

/** 设置生效：音量、画质、减少动画 */
export function applySettings(s: Settings): void {
  audio.setVolumes(s.sfx, s.music);
  // 动画小组约定：html.reduce-motion 表示设置里开启了"减少动画"
  if (typeof document !== 'undefined') document.documentElement.classList.toggle('reduce-motion', !!s.reduceMotion);
  try {
    setRenderQuality(s.quality);
  } catch {
    /* 渲染层尚未就绪时忽略 */
  }
}

/** 页面层级：数字变大 = 前进（新页面从右侧进入），变小 = 返回（当前页面向右退出） */
const DEPTH: Record<string, number> = { menu: 0, skills: 2, game: 3 };
const depthOf = (name: string): number => DEPTH[name] ?? 1;

const MAX_TOASTS = 4;

export class App {
  private current: Screen | null = null;
  private factories = new Map<Route['name'], ScreenFactory>();
  private toastHost: HTMLElement;
  /** 正在离场的旧页面（快速连点时立即清掉） */
  private leaving: { el: HTMLElement; anim: Animation }[] = [];
  private enterAnims: Animation[] = [];
  private enterTimer = 0;
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
    // iOS Safari 需要有 touchstart 监听，:active 按压反馈才会在手指按下的当帧生效
    document.addEventListener('touchstart', () => {}, { passive: true });
    // 标签页不可见时暂停所有循环的环境动画
    const onVis = () => document.documentElement.classList.toggle('tab-hidden', document.hidden);
    document.addEventListener('visibilitychange', onVis);
    onVis();
    // 菜单页面里被锁住 / 买不起的按钮：点一下摇一摇（提示文字和音效仍由各页面给出）
    root.addEventListener('click', (e) => {
      const t = e.target instanceof Element ? e.target.closest('.locked, .poor, [aria-disabled="true"]') : null;
      if (t && !t.closest('.game-screen')) shake(t);
    });
  }

  register(name: Route['name'], f: ScreenFactory): void {
    this.factories.set(name, f);
  }

  go(route: Route): void {
    const f = this.factories.get(route.name);
    if (!f) return;
    const prev = this.current;
    const fromName = this.route.name;
    this.current = null;
    // 上一次切换还没播完：直接收尾，保证任何时候最多只有一个离场页面
    this.settleTransition();
    if (prev) {
      try {
        prev.destroy?.();
      } catch (e) {
        console.error(e);
      }
    }
    this.route = route;
    const s = f(this, route);
    this.current = s;
    const toGame = route.name === 'game';
    const d = depthOf(route.name) - depthOf(fromName);
    // 没有旧页面、或旧页面是对局（已销毁，无法做离场）时用淡入
    const dir = !prev || fromName === 'game' ? 0 : d > 0 ? 1 : d < 0 ? -1 : 0;
    const animate = motionOK() && typeof s.el.animate === 'function';

    if (prev) {
      // 对局页销毁后棋盘已经没了，不做离场动画
      if (!animate || fromName === 'game') prev.el.remove();
      else this.leave(prev.el, toGame ? 0 : dir);
    }

    s.el.classList.add('is-entering');
    s.el.dataset.nav = dir > 0 ? 'forward' : dir < 0 ? 'back' : 'fade';
    this.root.insertBefore(s.el, this.toastHost);
    if (animate) {
      if (toGame) {
        this.enterAnims.push(s.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DUR.s, easing: 'linear' }));
        this.paperWipe(s.el);
      } else {
        const x = dir * 36;
        const from: Keyframe = dir === 0 ? { opacity: 0, transform: 'translateY(10px) scale(0.985)' } : { opacity: 0, transform: `translateX(${x}px)` };
        this.enterAnims.push(
          s.el.animate([from, { opacity: 1, transform: 'none' }], { duration: dir === 0 ? DUR.m : DUR.l - 100, easing: EASE_OUT }),
        );
      }
    }
    // 入场结束后去掉标记：之后页面内部重新渲染的元素不再重播依次入场
    // 同时兜底：即使浏览器没在出帧（动画时间线停住），也把离场页面和入场动画清干净
    this.enterTimer = window.setTimeout(() => this.settleTransition(), toGame ? 1300 : 900);

    audio.setMusic(this.store.get().settings.music > 0);
    audio.setIntensity(route.name === 'game' ? 0.4 : 0);
  }

  /** 立即结束正在进行的页面切换 */
  private settleTransition(): void {
    clearTimeout(this.enterTimer);
    for (const l of this.leaving) {
      l.anim.onfinish = null;
      l.anim.cancel();
      l.el.remove();
    }
    this.leaving = [];
    for (const a of this.enterAnims) a.cancel();
    this.enterAnims = [];
    for (const el of Array.from(this.root.querySelectorAll('.screen.is-entering'))) el.classList.remove('is-entering');
  }

  private leave(el: HTMLElement, dir: number): void {
    el.classList.remove('is-entering');
    el.classList.add('is-leaving');
    el.setAttribute('inert', '');
    el.setAttribute('aria-hidden', 'true');
    const to: Keyframe = dir === 0 ? { opacity: 0, transform: 'scale(0.985)' } : { opacity: 0, transform: `translateX(${-dir * 36}px)` };
    const anim = el.animate([{ opacity: 1, transform: 'none' }, to], { duration: DUR.s + 20, easing: EASE_IN, fill: 'forwards' });
    const entry = { el, anim };
    this.leaving.push(entry);
    anim.onfinish = () => {
      el.remove();
      this.leaving = this.leaving.filter((l) => l !== entry);
    };
  }

  /** 进入对局：一张稿纸盖住页面，再向左掀开露出棋盘 */
  private paperWipe(host: HTMLElement): void {
    const sheet = h('div.paper-wipe', { attrs: { 'aria-hidden': 'true' } });
    host.appendChild(sheet);
    const a = sheet.animate(
      [
        { transform: 'translateX(0) skewX(-8deg)' },
        { transform: 'translateX(-125%) skewX(-8deg)' },
      ],
      { duration: DUR.l + 80, delay: 220, easing: 'cubic-bezier(0.65, 0, 0.35, 1)', fill: 'forwards' },
    );
    a.onfinish = a.oncancel = () => sheet.remove();
    this.enterAnims.push(a);
  }

  /** 菜单页面的短提示：弹入，旧提示被新提示顶上去 */
  toast(text: string, tone: 'info' | 'warn' | 'good' = 'info'): void {
    const host = this.toastHost;
    const live = Array.from(host.children).filter((c) => !c.classList.contains('out')) as HTMLElement[];
    while (live.length >= MAX_TOASTS) live.shift()?.remove();
    const settle = flip(Array.from(host.children));
    const t = h(`div.app-toast.tone-${tone}`, null, text);
    host.appendChild(t);
    settle();
    setTimeout(() => t.classList.add('out'), 2300);
    setTimeout(() => t.remove(), 2300 + DUR.m + 40);
  }
}

// ───────────── 通用组件 ─────────────

/** 上一次显示过的货币数值：变化时数字滚动过去 */
let shownCurrency: { star: number; ink: number } | null = null;

export function currencyChips(store: ProfileStore): HTMLElement {
  const p = store.get();
  const now = { star: p.currency.star, ink: Math.floor(p.currency.ink) };
  const was = shownCurrency ?? now;
  shownCurrency = now;
  const chip = (key: 'star' | 'ink', glyph: string, title: string) => {
    const num = h('span.chip-num', null, String(now[key]));
    const el = h('span.chip', { title, attrs: { 'aria-label': `${key === 'star' ? '星星' : '墨水'} ${now[key]}` } }, h('span.gi', { html: glyph }), num);
    if (was[key] !== now[key]) {
      el.classList.add(now[key] > was[key] ? 'gain' : 'spend');
      countTo(num, was[key], now[key]);
    }
    return el;
  };
  return h(
    'div.chips',
    null,
    chip('star', G.star, '星星：战役评星获得，用于解锁天赋'),
    chip('ink', G.ink, '墨水：无尽 / 自定义模式每撑过 1 波获得'),
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
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let closed = false;
    const close = (v: boolean) => {
      if (closed) return;
      closed = true;
      audio.play('click');
      overlay.classList.add('out');
      setTimeout(() => overlay.remove(), motionOK() ? DUR.s + 40 : 0);
      document.removeEventListener('keydown', onKey, true);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
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
