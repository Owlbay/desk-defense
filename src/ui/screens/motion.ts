/**
 * 菜单页面的动画小工具（只用 Web Animations API，只动 transform / opacity）。
 * 规范见 src/styles/motion.css。减少动画开启时这些函数直接跳过演出。
 */

export const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';
export const EASE_IN = 'cubic-bezier(0.55, 0, 1, 0.45)';
export const EASE_SPRING = 'cubic-bezier(0.34, 1.56, 0.64, 1)';
export const DUR = { xs: 90, s: 160, m: 260, l: 420, xl: 700 } as const;

let mq: MediaQueryList | null | undefined;

/** 是否可以播放动画（设置里的"减少动画"或系统偏好开启时为 false） */
export function motionOK(): boolean {
  if (typeof document === 'undefined') return false;
  if (document.documentElement.classList.contains('reduce-motion')) return false;
  if (mq === undefined) mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  return !mq?.matches;
}

/** 安全的 el.animate：不支持或减少动画时返回 null */
export function anim(el: Element, frames: Keyframe[], opts: KeyframeAnimationOptions): Animation | null {
  if (!motionOK() || typeof el.animate !== 'function') return null;
  try {
    return el.animate(frames, opts);
  } catch {
    return null;
  }
}

/** 锁定项被点：左右摇一下 */
export function shake(el: Element): void {
  anim(
    el,
    [
      { transform: 'translateX(0)' },
      { transform: 'translateX(-5px) rotate(-1deg)' },
      { transform: 'translateX(4px) rotate(1deg)' },
      { transform: 'translateX(-3px)' },
      { transform: 'translateX(2px)' },
      { transform: 'translateX(0)' },
    ],
    { duration: 320, easing: 'ease-out' },
  );
}

/** 选中 / 状态变化：轻弹一下 */
export function pop(el: Element | null | undefined, scale = 1.06): void {
  if (!el) return;
  anim(el, [{ transform: 'scale(0.94)' }, { transform: `scale(${scale})`, offset: 0.55 }, { transform: 'scale(1)' }], {
    duration: DUR.m,
    easing: EASE_OUT,
  });
}

/**
 * 重新渲染一组分段按钮 / 卡片后：让选中的那个弹一下，并把键盘焦点还给它
 * （整组重建会让焦点丢失）。
 */
export function popSelected(box: Element, sel = '.on'): void {
  const on = box.querySelector<HTMLElement>(sel);
  if (!on) return;
  const active = document.activeElement;
  if (!active || active === document.body) on.focus({ preventScroll: true });
  pop(on, 1.04);
}

const BURST_COLORS = ['#f2c14e', '#2a9d8f', '#f28aa0', '#9bd1e5', '#f29e4c', '#fbf8f1'];

/** 升级 / 得星的小纸屑：从元素中心向四周弹开 */
export function burst(host: HTMLElement, count = 10, radius = 46): void {
  if (!motionOK() || typeof host.animate !== 'function') return;
  const layer = document.createElement('span');
  layer.className = 'fx-burst';
  layer.setAttribute('aria-hidden', 'true');
  const ring = document.createElement('i');
  ring.className = 'fx-ring';
  layer.appendChild(ring);
  host.appendChild(layer);
  ring.animate(
    [
      { transform: 'scale(0.3)', opacity: 0.9 },
      { transform: 'scale(1.9)', opacity: 0 },
    ],
    { duration: DUR.l, easing: EASE_OUT, fill: 'forwards' },
  );
  let last: Animation | null = null;
  for (let i = 0; i < count; i++) {
    const dot = document.createElement('i');
    dot.className = i % 3 === 0 ? 'fx-dot sq' : 'fx-dot';
    dot.style.background = BURST_COLORS[i % BURST_COLORS.length]!;
    layer.appendChild(dot);
    const a = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
    const r = radius * (0.7 + Math.random() * 0.5);
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    last = dot.animate(
      [
        { transform: 'translate(0,0) scale(0.4)', opacity: 1 },
        { transform: `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) scale(1) rotate(${Math.round(a * 90)}deg)`, opacity: 1, offset: 0.6 },
        {
          transform: `translate(${(x * 1.15).toFixed(1)}px,${(y * 1.15 + 10).toFixed(1)}px) scale(0.3) rotate(${Math.round(a * 140)}deg)`,
          opacity: 0,
        },
      ],
      { duration: DUR.xl - 80 + Math.random() * 160, easing: EASE_OUT, fill: 'forwards' },
    );
  }
  const done = () => layer.remove();
  if (last) last.onfinish = done;
  setTimeout(done, DUR.xl + 400);
}

/** 数字滚动（货币变化）。减少动画时直接写终值。 */
export function countTo(el: HTMLElement, from: number, to: number, duration = 650): void {
  if (from === to || !motionOK() || typeof requestAnimationFrame !== 'function') {
    el.textContent = String(to);
    return;
  }
  el.textContent = String(from);
  let t0 = 0;
  let seen = false;
  const step = (now: number) => {
    if (el.isConnected) seen = true;
    else if (seen) return; // 页面已切走
    if (!t0) t0 = now;
    const k = Math.min(1, (now - t0) / duration);
    const e = 1 - Math.pow(1 - k, 3);
    const v = Math.round(from + (to - from) * e);
    const s = String(v);
    if (el.textContent !== s) el.textContent = s;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** FLIP：先记位置，改完 DOM 后调用返回的函数，让元素从旧位置滑到新位置 */
export function flip(els: Element[]): () => void {
  if (!motionOK()) return () => {};
  const before = els.map((e) => e.getBoundingClientRect());
  return () => {
    els.forEach((e, i) => {
      if (!e.isConnected) return;
      const b = before[i]!;
      const a = e.getBoundingClientRect();
      const dx = b.left - a.left;
      const dy = b.top - a.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      anim(e, [{ transform: `translate(${dx}px,${dy}px)` }, { transform: 'translate(0,0)' }], { duration: DUR.m, easing: EASE_SPRING });
    });
  };
}
