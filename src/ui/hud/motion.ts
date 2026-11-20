/**
 * 局内界面动画的小工具（只用 CSS 类 + Web Animations API）。
 * 约定：只动 transform / opacity / filter；「减少动画」开启时所有 JS 动画直接跳过。
 */

let mq: MediaQueryList | null = null;

/** 设置里的「减少动画」或系统的减少动态效果 */
export function reduced(): boolean {
  try {
    if (document.documentElement.classList.contains('reduce-motion')) return true;
    mq ??= window.matchMedia('(prefers-reduced-motion: reduce)');
    return mq.matches;
  } catch {
    return false;
  }
}

const timers = new WeakMap<HTMLElement, Map<string, number>>();

/**
 * 播放一次 CSS 类动画，ms 后自动摘掉类。
 * 动画还没播完又触发时，下下帧重新加类来重播 —— 不读 offsetWidth，不强制回流。
 */
export function replay(el: HTMLElement, cls: string, ms = 600): void {
  if (reduced()) return;
  let m = timers.get(el);
  if (!m) timers.set(el, (m = new Map()));
  const old = m.get(cls);
  if (old !== undefined) clearTimeout(old);
  const arm = () => {
    el.classList.add(cls);
    m!.set(cls, window.setTimeout(() => {
      el.classList.remove(cls);
      m!.delete(cls);
    }, ms));
  };
  if (el.classList.contains(cls)) {
    el.classList.remove(cls);
    m.delete(cls);
    requestAnimationFrame(() => requestAnimationFrame(arm));
  } else arm();
}

/** WAAPI 封装：减少动画或环境不支持时返回 null（调用方按「已结束」处理） */
export function anim(el: HTMLElement, frames: Keyframe[], opts: KeyframeAnimationOptions): Animation | null {
  if (reduced() || typeof el.animate !== 'function') return null;
  try {
    return el.animate(frames, opts);
  } catch {
    return null;
  }
}

const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);

/**
 * 顶栏数字滚动：由 HUD 的每帧 tick 驱动（不另开 rAF），只在显示的整数变化时写 DOM。
 */
export class Roll {
  private from = 0;
  private to = 0;
  private shown = NaN;
  private t0 = 0;
  private running = false;

  constructor(
    private el: HTMLElement,
    private fmt: (n: number) => string,
    private dur = 320,
  ) {}

  get target(): number {
    return this.to;
  }

  /** 设定目标值；instant = 直接显示 */
  set(v: number, now: number, instant = false): void {
    if (instant || reduced() || Number.isNaN(this.shown)) {
      this.to = v;
      this.running = false;
      this.write(v);
      return;
    }
    this.from = this.shown;
    this.to = v;
    this.t0 = now;
    this.running = true;
  }

  step(now: number): void {
    if (!this.running) return;
    const t = Math.min(1, (now - this.t0) / this.dur);
    if (t >= 1) {
      this.running = false;
      this.write(this.to);
      return;
    }
    this.write(Math.round(this.from + (this.to - this.from) * easeOut(t)));
  }

  private write(n: number): void {
    if (n === this.shown) return;
    this.shown = n;
    this.el.textContent = this.fmt(n);
  }
}

// ───────────── 结算数字：共用一个 rAF ─────────────

interface Count {
  el: HTMLElement;
  to: number;
  t0: number;
  dur: number;
  fmt: (n: number) => string;
  last: number;
}
let counts: Count[] = [];
let countRaf = 0;

function countLoop(now: number): void {
  countRaf = 0;
  const keep: Count[] = [];
  for (const c of counts) {
    if (!c.el.isConnected) continue;
    const t = (now - c.t0) / c.dur;
    if (t < 0) {
      keep.push(c);
      continue;
    }
    const v = t >= 1 ? c.to : Math.round(c.to * easeOut(t));
    if (v !== c.last) {
      c.last = v;
      c.el.textContent = c.fmt(v);
    }
    if (t < 1) keep.push(c);
    else c.el.classList.add('counted');
  }
  counts = keep;
  if (counts.length) countRaf = requestAnimationFrame(countLoop);
}

/** 数字从 0 涨到 to（元素里应已写好最终值：减少动画 / 无 rAF 时保持不变） */
export function countUp(el: HTMLElement, to: number, fmt: (n: number) => string, delay = 0, dur = 700): void {
  if (reduced() || !(to > 0)) return;
  el.textContent = fmt(0);
  counts.push({ el, to, t0: performance.now() + delay, dur, fmt, last: 0 });
  if (!countRaf) countRaf = requestAnimationFrame(countLoop);
}

// ───────────── 粒子 ─────────────

/**
 * 在 host 内撒一圈小星点（host 需 position 非 static）。x/y 为 host 内的百分比位置。
 * 每个点一次 WAAPI 动画，结束即移除；同一个 host 同时最多一组。
 */
export function sparkle(host: HTMLElement, o: { x?: number; y?: number; n?: number; spread?: number; cls?: string } = {}): void {
  if (reduced()) return;
  host.querySelector(':scope > .fx-sparks')?.remove();
  const n = o.n ?? 7;
  const spread = o.spread ?? 26;
  const box = document.createElement('span');
  box.className = `fx-sparks${o.cls ? ' ' + o.cls : ''}`;
  box.style.left = `${o.x ?? 50}%`;
  box.style.top = `${o.y ?? 50}%`;
  box.setAttribute('aria-hidden', 'true');
  host.appendChild(box);
  let left = n;
  for (let i = 0; i < n; i++) {
    const s = document.createElement('i');
    box.appendChild(s);
    const a = (i / n) * Math.PI * 2 + Math.random() * 0.6;
    const d = spread * (0.6 + Math.random() * 0.6);
    const an = anim(
      s,
      [
        { transform: 'translate(0,0) scale(0.4)', opacity: 1 },
        { transform: `translate(${(Math.cos(a) * d).toFixed(1)}px, ${(Math.sin(a) * d).toFixed(1)}px) scale(1)`, opacity: 1, offset: 0.6 },
        { transform: `translate(${(Math.cos(a) * d * 1.25).toFixed(1)}px, ${(Math.sin(a) * d * 1.25 + 4).toFixed(1)}px) scale(0)`, opacity: 0 },
      ],
      { duration: 520 + Math.random() * 180, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' },
    );
    const done = () => {
      if (--left <= 0) box.remove();
    };
    if (an) an.onfinish = an.oncancel = done;
    else done();
  }
}
