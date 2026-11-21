import type Phaser from 'phaser';

import { BOARD_H, BOARD_W, CELL } from './layout';

/** 系统 / 应用是否要求减弱动效（html.reduce-motion 或 prefers-reduced-motion） */
let mq: MediaQueryList | null = null;
export function readReducedMotion(): boolean {
  if (typeof document === 'undefined') return false;
  if (document.documentElement.classList.contains('reduce-motion')) return true;
  if (!mq && typeof matchMedia === 'function') mq = matchMedia('(prefers-reduced-motion: reduce)');
  return !!mq?.matches;
}

// ───────────── 缓动小工具（纯函数，无分配） ─────────────
export const easeOutCubic = (p: number): number => 1 - (1 - p) * (1 - p) * (1 - p);
export const easeOutBack = (p: number, s = 1.70158): number => 1 + (s + 1) * Math.pow(p - 1, 3) + s * Math.pow(p - 1, 2);
/** 阻尼弹簧：p=0 时为 1，逐渐振荡衰减到 0 */
export const springCos = (p: number, freq: number, damp: number): number => Math.exp(-damp * p) * Math.cos(freq * p);
/** 阻尼弹簧：p=0 时为 0，先冲到峰值再衰减 */
export const springSin = (p: number, freq: number, damp: number): number => Math.exp(-damp * p) * Math.sin(freq * p);

export type ShakeMode = 'rumble' | 'thud';

interface Shake {
  t: number;
  dur: number;
  amp: number;
  mode: ShakeMode;
  seed: number;
}

/**
 * 镜头：震屏（曲线衰减）、缩放冲击、全屏闪光。
 * 所有偏移都叠加在 Board 算好的基准缩放 / 居中之上，不改动棋盘缩放逻辑；
 * 减弱动效时全部禁用。
 */
export class CameraRig {
  reduced = false;
  private baseZoom = 1;
  private shakes: Shake[] = [];
  private nShake = 0;
  private punchT = -1;
  private punchDur = 0.4;
  private punchAmp = 0;
  private flashT = -1;
  private flashDur = 0.3;
  private flashA = 0;
  flashColor = 0xffffff;
  private dirty = false;
  private clock = 0;

  constructor(private scene: Phaser.Scene) {
    for (let i = 0; i < 4; i++) this.shakes.push({ t: 0, dur: 0, amp: 0, mode: 'rumble', seed: 0 });
  }

  /** Board.resize 调用：记录基准缩放并立即复位 */
  setBase(zoom: number): void {
    this.baseZoom = zoom;
    const cam = this.scene.cameras.main;
    cam.setZoom(zoom);
    cam.centerOn(BOARD_W / 2, BOARD_H / 2);
  }

  /**
   * 震屏。k 为幅度（格），ms 为时长。
   * rumble：高频抖动、平方衰减（Boss 技能、爆炸）；thud：以竖直方向为主的一次下砸再回弹（重物落地）。
   */
  shake(ms: number, k: number, mode: ShakeMode = 'rumble'): void {
    if (this.reduced || ms <= 0 || k <= 0) return;
    let s: Shake;
    if (this.nShake < this.shakes.length) s = this.shakes[this.nShake++];
    else {
      // 槽位已满：替换剩余能量最小的
      s = this.shakes[0];
      for (const c of this.shakes) if (c.amp * (1 - c.t / c.dur) < s.amp * (1 - s.t / s.dur)) s = c;
    }
    s.t = 0;
    s.dur = ms / 1000;
    s.amp = k * CELL * 0.7;
    s.mode = mode;
    s.seed = Math.random() * 100;
  }

  /** 缩放冲击：瞬间放大 amount，弹回 */
  punch(amount = 0.025, ms = 420): void {
    if (this.reduced) return;
    this.punchT = 0;
    this.punchDur = ms / 1000;
    this.punchAmp = amount;
  }

  /** 全屏闪光（由 Board 画在最上层） */
  flash(color: number, alpha: number, ms: number): void {
    if (this.reduced) return;
    this.flashT = 0;
    this.flashDur = ms / 1000;
    this.flashA = alpha;
    this.flashColor = color;
  }

  /** 当前闪光透明度（0 = 没有） */
  flashAlpha(): number {
    if (this.flashT < 0) return 0;
    const p = this.flashT / this.flashDur;
    return this.flashA * (1 - p) * (1 - p);
  }

  update(rdt: number): void {
    this.clock += rdt;
    if (this.flashT >= 0) {
      this.flashT += rdt;
      if (this.flashT >= this.flashDur) this.flashT = -1;
    }
    let ox = 0,
      oy = 0,
      z = 1;
    for (let i = this.nShake - 1; i >= 0; i--) {
      const s = this.shakes[i];
      s.t += rdt;
      if (s.t >= s.dur) {
        const last = this.shakes[--this.nShake];
        this.shakes[i] = last;
        this.shakes[this.nShake] = s;
        continue;
      }
      const p = s.t / s.dur;
      if (s.mode === 'thud') {
        const w = Math.exp(-5 * p) * Math.cos(p * 20) * (1 - p);
        oy += s.amp * w;
        ox += s.amp * 0.25 * Math.sin(this.clock * 47 + s.seed) * (1 - p) * (1 - p);
      } else {
        const d = (1 - p) * (1 - p);
        const t = this.clock;
        ox += s.amp * d * (0.6 * Math.sin(t * 61 + s.seed) + 0.4 * Math.sin(t * 37.3 + s.seed * 2));
        oy += s.amp * d * (0.6 * Math.cos(t * 53 + s.seed * 3) + 0.4 * Math.sin(t * 41.7 + s.seed));
      }
    }
    if (this.punchT >= 0) {
      this.punchT += rdt;
      const p = this.punchT / this.punchDur;
      if (p >= 1) this.punchT = -1;
      else z += this.punchAmp * Math.exp(-4 * p) * Math.cos(p * 7) * (1 - p);
    }
    const active = ox !== 0 || oy !== 0 || z !== 1;
    if (!active && !this.dirty) return;
    const lim = CELL * 0.22;
    ox = Math.max(-lim, Math.min(lim, ox));
    oy = Math.max(-lim, Math.min(lim, oy));
    const cam = this.scene.cameras.main;
    cam.setZoom(this.baseZoom * z);
    cam.centerOn(BOARD_W / 2 + ox, BOARD_H / 2 + oy);
    this.dirty = active;
  }
}
