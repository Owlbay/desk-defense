import Phaser from 'phaser';
import { C, FONT, hex } from './palette';
import { DEPTH } from './layout';

/**
 * 轻量特效系统：所有几何特效记录在对象池里，每帧画进两个 Graphics（普通 / 叠加）。
 * 浮动文字用 Text 对象池。坐标单位为逻辑像素。
 */

type FxKind =
  | 'tri' // 碎片三角
  | 'dot' // 圆点粒子
  | 'rect' // 纸屑
  | 'star' // 四角星
  | 'ring' // 扩散圆环
  | 'disc' // 实心圆（闪光）
  | 'beam' // 光束
  | 'arc' // 圆规扫弧
  | 'cell' // 格子闪烁
  | 'plus' // 治疗十字
  | 'line' // 横扫尺的扫线
  | 'eraser' // 大橡皮落下
  | 'rect2'; // 矩形区域闪光

interface FxItem {
  k: FxKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  g: number; // 重力
  drag: number;
  life: number;
  max: number;
  size: number;
  size2: number;
  color: number;
  color2: number;
  rot: number;
  vr: number;
  alpha: number;
  add: boolean;
  x2: number;
  y2: number;
  a0: number;
  a1: number;
  w: number;
  delay: number;
}

interface FloatText {
  t: Phaser.GameObjects.Text;
  life: number;
  max: number;
  vy: number;
  prio: number;
  active: boolean;
  pop: boolean;
}

export type TextStyleKind = 'dmg' | 'crit' | 'dot' | 'shield' | 'gold' | 'goldLoss' | 'heal' | 'info' | 'warn' | 'level' | 'toast';

const STYLE: Record<TextStyleKind, { size: number; color: number; stroke: number; bold: boolean; life: number; vy: number; prio: number }> = {
  dmg: { size: 11, color: C.white, stroke: C.ink, bold: true, life: 0.6, vy: -28, prio: 0 },
  dot: { size: 9, color: 0xd8c7f0, stroke: C.ink, bold: false, life: 0.5, vy: -20, prio: 0 },
  shield: { size: 11, color: C.cyan, stroke: C.ink, bold: true, life: 0.6, vy: -28, prio: 0 },
  crit: { size: 16, color: C.goldLight, stroke: C.ink, bold: true, life: 0.85, vy: -34, prio: 1 },
  gold: { size: 12, color: C.goldLight, stroke: C.goldDark, bold: true, life: 0.9, vy: -30, prio: 2 },
  goldLoss: { size: 13, color: C.bad, stroke: C.ink, bold: true, life: 1.1, vy: -26, prio: 2 },
  heal: { size: 10, color: 0x9ae6b4, stroke: C.ink, bold: true, life: 0.7, vy: -22, prio: 0 },
  info: { size: 10, color: C.paper, stroke: C.ink, bold: true, life: 0.8, vy: -22, prio: 1 },
  warn: { size: 11, color: C.goldLight, stroke: C.ink, bold: true, life: 1.0, vy: -20, prio: 1 },
  level: { size: 12, color: C.goldLight, stroke: C.ink, bold: true, life: 1.1, vy: -24, prio: 2 },
  toast: { size: 12, color: C.paper, stroke: C.bad, bold: true, life: 1.4, vy: -14, prio: 3 },
};

const MAX_ITEMS = 1400;
const MAX_TEXTS = 56;

export class Fx {
  private items: FxItem[] = [];
  private free: FxItem[] = [];
  private texts: FloatText[] = [];
  private g: Phaser.GameObjects.Graphics;
  private gAdd: Phaser.GameObjects.Graphics;
  private textBudget = 0;
  low = false;
  private resolution = 1;

  constructor(private scene: Phaser.Scene) {
    this.g = scene.add.graphics().setDepth(DEPTH.fx);
    this.gAdd = scene.add.graphics().setDepth(DEPTH.fx + 1).setBlendMode(Phaser.BlendModes.ADD);
  }

  setResolution(r: number): void {
    this.resolution = r;
    for (const ft of this.texts) ft.t.setResolution(r);
  }

  get count(): number {
    return this.items.length;
  }

  private alloc(k: FxKind, x: number, y: number, max: number, color: number): FxItem | null {
    if (this.items.length >= MAX_ITEMS) return null;
    const it =
      this.free.pop() ??
      ({} as FxItem);
    it.k = k;
    it.x = x;
    it.y = y;
    it.vx = 0;
    it.vy = 0;
    it.g = 0;
    it.drag = 0;
    it.life = 0;
    it.max = max;
    it.size = 3;
    it.size2 = 0;
    it.color = color;
    it.color2 = color;
    it.rot = 0;
    it.vr = 0;
    it.alpha = 1;
    it.add = false;
    it.x2 = 0;
    it.y2 = 0;
    it.a0 = 0;
    it.a1 = 0;
    it.w = 2;
    it.delay = 0;
    this.items.push(it);
    return it;
  }

  // ───────────── 生成器 ─────────────

  shatter(x: number, y: number, color: number, n: number, size = 5): void {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.8;
      const sp = 40 + Math.random() * 70;
      const it = this.alloc('tri', x, y, 0.45 + Math.random() * 0.3, color);
      if (!it) return;
      it.vx = Math.cos(a) * sp;
      it.vy = Math.sin(a) * sp - 20;
      it.g = 160;
      it.drag = 2.5;
      it.size = size * (0.7 + Math.random() * 0.6);
      it.rot = Math.random() * 6;
      it.vr = (Math.random() - 0.5) * 16;
    }
  }

  dust(x: number, y: number, r = 20, color: number = C.deskDark): void {
    const n = this.low ? 5 : 9;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const it = this.alloc('dot', x + Math.cos(a) * r * 0.5, y + Math.sin(a) * r * 0.4, 0.35 + Math.random() * 0.15, color);
      if (!it) return;
      it.vx = Math.cos(a) * 45;
      it.vy = Math.sin(a) * 30;
      it.drag = 5;
      it.size = 3 + Math.random() * 2.5;
      it.size2 = -4;
    }
  }

  confetti(x: number, y: number, n = 14): void {
    const cols = [C.cyan, C.magenta, C.goldLight, C.pink, C.blueCap, C.paper];
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.6;
      const sp = 60 + Math.random() * 80;
      const it = this.alloc('rect', x, y, 0.8 + Math.random() * 0.4, cols[i % cols.length]);
      if (!it) return;
      it.vx = Math.cos(a) * sp;
      it.vy = Math.sin(a) * sp;
      it.g = 180;
      it.drag = 2;
      it.size = 3 + Math.random() * 2;
      it.rot = Math.random() * 6;
      it.vr = (Math.random() - 0.5) * 18;
    }
  }

  sparkle(x: number, y: number, color: number, n = 6, spread = 16): void {
    if (this.low) n = Math.ceil(n / 2);
    for (let i = 0; i < n; i++) {
      const it = this.alloc('star', x + (Math.random() - 0.5) * spread, y + (Math.random() - 0.5) * spread, 0.5 + Math.random() * 0.4, color);
      if (!it) return;
      it.vy = -20 - Math.random() * 30;
      it.vx = (Math.random() - 0.5) * 20;
      it.size = 3 + Math.random() * 3;
      it.vr = (Math.random() - 0.5) * 4;
    }
  }

  /** 漂浮的小光点（T4 粒子、咖啡因蒸汽等） */
  mote(x: number, y: number, color: number, vy = -18, life = 0.9, size = 2, add = true): void {
    const it = this.alloc('dot', x, y, life, color);
    if (!it) return;
    it.vy = vy;
    it.vx = (Math.random() - 0.5) * 8;
    it.size = size;
    it.add = add && !this.low;
  }

  ring(x: number, y: number, r0: number, r1: number, color: number, dur = 0.35, width = 3, add = false, delay = 0): void {
    const it = this.alloc('ring', x, y, dur, color);
    if (!it) return;
    it.size = r0;
    it.size2 = r1;
    it.w = width;
    it.add = add && !this.low;
    it.delay = delay;
  }

  disc(x: number, y: number, r: number, color: number, dur = 0.1, add = false, alpha = 1): void {
    const it = this.alloc('disc', x, y, dur, color);
    if (!it) return;
    it.size = r;
    it.add = add && !this.low;
    it.alpha = alpha;
  }

  beam(x: number, y: number, tx: number, ty: number, color: number, width: number, dur = 0.14): void {
    const it = this.alloc('beam', x, y, dur, color);
    if (!it) return;
    it.x2 = tx;
    it.y2 = ty;
    it.w = width;
    it.add = !this.low;
  }

  /** 墨迹笔画（无发光） */
  stroke(x: number, y: number, tx: number, ty: number, color: number, width: number, dur = 0.25): void {
    const it = this.alloc('beam', x, y, dur, color);
    if (!it) return;
    it.x2 = tx;
    it.y2 = ty;
    it.w = width;
    it.add = false;
    it.alpha = 0; // 标记：笔画
  }

  arc(x: number, y: number, r0: number, r1: number, angle: number, arc: number, color: number, dur = 0.18): void {
    const it = this.alloc('arc', x, y, dur, color);
    if (!it) return;
    it.size = r0;
    it.size2 = r1;
    it.a0 = angle - arc / 2;
    it.a1 = angle + arc / 2;
  }

  cell(x: number, y: number, w: number, h: number, color: number, dur = 0.45, alpha = 0.55): void {
    const it = this.alloc('cell', x, y, dur, color);
    if (!it) return;
    it.x2 = w;
    it.y2 = h;
    it.alpha = alpha;
  }

  rectFlash(x: number, y: number, w: number, h: number, color: number, dur = 0.4): void {
    const it = this.alloc('rect2', x, y, dur, color);
    if (!it) return;
    it.x2 = w;
    it.y2 = h;
  }

  plus(x: number, y: number, color = 0x9ae6b4): void {
    const it = this.alloc('plus', x, y, 0.7, color);
    if (!it) return;
    it.vy = -26;
    it.size = 4;
  }

  /** 横扫尺：一条刻度尺沿行/列扫过 */
  sweepLine(x0: number, y0: number, x1: number, y1: number, horizontal: boolean, len: number): void {
    const it = this.alloc('line', x0, y0, 0.45, C.ruler);
    if (!it) return;
    it.x2 = x1;
    it.y2 = y1;
    it.w = len;
    it.a0 = horizontal ? 1 : 0;
  }

  /** 大橡皮从上方砸下 */
  eraserDrop(x: number, y: number, r: number): void {
    const it = this.alloc('eraser', x, y, 0.5, C.pink);
    if (!it) return;
    it.size = r;
  }

  // ───────────── 浮动文字 ─────────────

  beginFrame(): void {
    this.textBudget = 8;
  }

  text(x: number, y: number, str: string, kind: TextStyleKind): void {
    const st = STYLE[kind];
    if (st.prio === 0) {
      if (this.textBudget <= 0) return;
      this.textBudget--;
    }
    let ft = this.texts.find((t) => !t.active);
    if (!ft) {
      if (this.texts.length < MAX_TEXTS) {
        const t = this.scene.add.text(0, 0, '', { fontFamily: FONT, fontSize: '12px' }).setOrigin(0.5, 1).setDepth(DEPTH.text);
        t.setResolution(this.resolution);
        ft = { t, life: 0, max: 1, vy: 0, prio: 0, active: false, pop: false };
        this.texts.push(ft);
      } else {
        // 回收优先级最低、最老的
        let best: FloatText | null = null;
        for (const c of this.texts) if (c.prio <= st.prio && (!best || c.life / c.max > best.life / best.max)) best = c;
        if (!best) return;
        ft = best;
      }
    }
    const t = ft.t;
    t.setStyle({
      fontFamily: FONT,
      fontSize: `${st.size}px`,
      fontStyle: st.bold ? 'bold' : 'normal',
      color: hex(st.color),
      stroke: hex(st.stroke),
      strokeThickness: kind === 'toast' ? 4 : 3,
    });
    t.setText(str);
    t.setPosition(x, y);
    t.setAlpha(1);
    t.setScale(1);
    t.setVisible(true);
    ft.life = 0;
    ft.max = st.life;
    ft.vy = st.vy;
    ft.prio = st.prio;
    ft.active = true;
    ft.pop = kind === 'crit' || kind === 'level' || kind === 'toast';
  }

  // ───────────── 更新与绘制 ─────────────

  update(dt: number): void {
    const items = this.items;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.delay > 0) {
        it.delay -= dt;
        continue;
      }
      it.life += dt;
      if (it.life >= it.max) {
        items[i] = items[items.length - 1];
        items.pop();
        this.free.push(it);
        continue;
      }
      if (it.drag) {
        const d = Math.max(0, 1 - it.drag * dt);
        it.vx *= d;
        it.vy *= d;
      }
      it.vy += it.g * dt;
      it.x += it.vx * dt;
      it.y += it.vy * dt;
      it.rot += it.vr * dt;
    }
    for (const ft of this.texts) {
      if (!ft.active) continue;
      ft.life += dt;
      if (ft.life >= ft.max) {
        ft.active = false;
        ft.t.setVisible(false);
        continue;
      }
      const p = ft.life / ft.max;
      ft.t.y += ft.vy * dt;
      ft.vy *= Math.max(0, 1 - 2.5 * dt);
      ft.t.setAlpha(p < 0.6 ? 1 : 1 - (p - 0.6) / 0.4);
      if (ft.pop) ft.t.setScale(p < 0.12 ? 0.6 + (p / 0.12) * 0.6 : p < 0.25 ? 1.2 - ((p - 0.12) / 0.13) * 0.2 : 1);
    }
  }

  draw(): void {
    const g = this.g;
    const ga = this.gAdd;
    g.clear();
    ga.clear();
    for (const it of this.items) {
      if (it.delay > 0) continue;
      const p = it.life / it.max;
      const gg = it.add ? ga : g;
      switch (it.k) {
        case 'tri': {
          const a = 1 - p * p;
          const s = it.size;
          const c = Math.cos(it.rot),
            sn = Math.sin(it.rot);
          const pts = [
            [0, -s],
            [s * 0.9, s * 0.6],
            [-s * 0.9, s * 0.6],
          ];
          const X = pts.map(([px, py]) => it.x + px * c - py * sn);
          const Y = pts.map(([px, py]) => it.y + px * sn + py * c);
          gg.fillStyle(it.color, a);
          gg.fillTriangle(X[0], Y[0], X[1], Y[1], X[2], Y[2]);
          gg.lineStyle(1.2, C.ink, a * 0.8);
          gg.strokeTriangle(X[0], Y[0], X[1], Y[1], X[2], Y[2]);
          break;
        }
        case 'dot': {
          const s = Math.max(0.3, it.size + it.size2 * p);
          gg.fillStyle(it.color, (1 - p) * it.alpha);
          gg.fillCircle(it.x, it.y, s);
          break;
        }
        case 'rect': {
          const a = 1 - p * p;
          const s = it.size;
          const sx = Math.abs(Math.cos(it.rot * 1.7));
          gg.fillStyle(it.color, a);
          gg.fillRect(it.x - (s * sx) / 2, it.y - s * 0.35, s * sx + 0.5, s * 0.7);
          break;
        }
        case 'star': {
          const a = p < 0.2 ? p / 0.2 : 1 - (p - 0.2) / 0.8;
          drawStar(gg, it.x, it.y, it.size * (1 - p * 0.4), it.rot, it.color, a);
          break;
        }
        case 'ring': {
          const e = 1 - (1 - p) * (1 - p);
          const r = it.size + (it.size2 - it.size) * e;
          gg.lineStyle(it.w * (1 - p * 0.6), it.color, (1 - p) * 0.9);
          gg.strokeCircle(it.x, it.y, Math.max(0.5, r));
          break;
        }
        case 'disc': {
          gg.fillStyle(it.color, (1 - p) * it.alpha);
          gg.fillCircle(it.x, it.y, it.size * (1 - p * 0.3));
          break;
        }
        case 'beam': {
          const a = 1 - p;
          if (it.alpha === 0) {
            // 笔画：粗细两端收尖
            g.lineStyle(it.w, it.color, a * 0.9);
            g.lineBetween(it.x, it.y, it.x2, it.y2);
            g.fillStyle(it.color, a * 0.9);
            g.fillCircle(it.x2, it.y2, it.w * 0.35);
            break;
          }
          if (!this.low) {
            ga.lineStyle(it.w * 3, it.color, a * 0.35);
            ga.lineBetween(it.x, it.y, it.x2, it.y2);
          }
          g.lineStyle(it.w, it.color, a);
          g.lineBetween(it.x, it.y, it.x2, it.y2);
          g.lineStyle(Math.max(1, it.w * 0.35), C.white, a);
          g.lineBetween(it.x, it.y, it.x2, it.y2);
          if (!this.low) {
            ga.fillStyle(it.color, a * 0.6);
            ga.fillCircle(it.x2, it.y2, it.w * 1.6);
          }
          break;
        }
        case 'arc': {
          const a = 1 - p;
          const r0 = it.size,
            r1 = it.size2;
          g.fillStyle(it.color, 0.35 * a);
          g.beginPath();
          g.arc(it.x, it.y, r1, it.a0, it.a1, false);
          g.arc(it.x, it.y, Math.max(0, r0), it.a1, it.a0, true);
          g.closePath();
          g.fillPath();
          g.lineStyle(2, C.white, 0.7 * a);
          g.beginPath();
          g.arc(it.x, it.y, r1, it.a0, it.a1, false);
          g.strokePath();
          break;
        }
        case 'cell': {
          const a = it.alpha * (1 - p) * (0.6 + 0.4 * Math.abs(Math.sin(p * 18)));
          g.fillStyle(it.color, a);
          g.fillRect(it.x, it.y, it.x2, it.y2);
          g.lineStyle(2, it.color, Math.min(1, a * 1.6));
          g.strokeRect(it.x + 1, it.y + 1, it.x2 - 2, it.y2 - 2);
          break;
        }
        case 'rect2': {
          const a = 1 - p;
          g.fillStyle(it.color, 0.45 * a);
          g.fillRect(it.x, it.y, it.x2, it.y2);
          g.lineStyle(3, C.white, a);
          g.strokeRect(it.x, it.y, it.x2, it.y2);
          break;
        }
        case 'plus': {
          const a = 1 - p;
          const s = it.size;
          g.fillStyle(C.ink, a);
          g.fillRect(it.x - s - 1, it.y - s / 3 - 1, 2 * s + 2, (2 * s) / 3 + 2);
          g.fillRect(it.x - s / 3 - 1, it.y - s - 1, (2 * s) / 3 + 2, 2 * s + 2);
          g.fillStyle(it.color, a);
          g.fillRect(it.x - s, it.y - s / 3, 2 * s, (2 * s) / 3);
          g.fillRect(it.x - s / 3, it.y - s, (2 * s) / 3, 2 * s);
          break;
        }
        case 'line': {
          // 刻度尺从 (x,y) 扫到 (x2,y2)
          const e = p < 0.7 ? p / 0.7 : 1;
          const a = p < 0.7 ? 1 : 1 - (p - 0.7) / 0.3;
          const cx = it.x + (it.x2 - it.x) * e;
          const cy = it.y + (it.y2 - it.y) * e;
          const hor = it.a0 === 1; // 横扫一行：尺子竖着，从左扫到右
          const L = it.w;
          const T = 14;
          const rx = hor ? cx - T / 2 : cx - L / 2;
          const ry = hor ? cy - L / 2 : cy - T / 2;
          const rw = hor ? T : L;
          const rh = hor ? L : T;
          // 拖尾
          g.fillStyle(C.ruler, 0.25 * a);
          if (hor) g.fillRect(it.x, ry, cx - it.x, rh);
          else g.fillRect(rx, it.y, rw, cy - it.y);
          g.fillStyle(C.ruler, 0.9 * a);
          g.fillRect(rx, ry, rw, rh);
          g.lineStyle(2.5, C.ink, a);
          g.strokeRect(rx, ry, rw, rh);
          g.lineStyle(1.5, C.ink, 0.8 * a);
          const n = Math.floor(L / 8);
          for (let i = 1; i < n; i++) {
            const tl = i % 4 === 0 ? 7 : 4;
            if (hor) g.lineBetween(rx, ry + i * 8, rx + tl, ry + i * 8);
            else g.lineBetween(rx + i * 8, ry, rx + i * 8, ry + tl);
          }
          break;
        }
        case 'eraser': {
          // 0..0.35 下落，之后压扁回弹并淡出
          const r = it.size;
          const fall = Math.min(1, p / 0.35);
          const dy = (1 - fall * fall) * -80;
          const squash = p < 0.35 ? 1 : 1 - Math.sin(((p - 0.35) / 0.65) * Math.PI) * 0.25;
          const a = p < 0.7 ? 1 : 1 - (p - 0.7) / 0.3;
          const w = r * 1.3,
            h = r * 0.75 * squash;
          const x = it.x - w / 2,
            y = it.y + dy - h / 2;
          g.fillStyle(C.ink, 0.18 * a * fall);
          g.fillEllipse(it.x, it.y + h * 0.5, w * fall, h * 0.5 * fall);
          g.fillStyle(C.pink, a);
          g.fillRoundedRect(x, y, w, h, 6);
          g.fillStyle(C.blueCap, a);
          g.fillRect(x + w * 0.55, y, w * 0.45 - 3, h);
          g.lineStyle(3, C.ink, a);
          g.strokeRoundedRect(x, y, w, h, 6);
          break;
        }
      }
    }
  }

  clear(): void {
    for (const it of this.items) this.free.push(it);
    this.items.length = 0;
    for (const ft of this.texts) {
      ft.active = false;
      ft.t.setVisible(false);
    }
  }
}

export function drawStar(g: Phaser.GameObjects.Graphics, x: number, y: number, s: number, rot: number, color: number, alpha: number): void {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < 8; i++) {
    const r = i % 2 === 0 ? s : s * 0.4;
    const a = rot + (i * Math.PI) / 4;
    pts.push({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r });
  }
  g.fillStyle(color, alpha);
  g.fillPoints(pts, true);
  g.lineStyle(1, C.ink, alpha * 0.8);
  g.strokePoints(pts, true);
}
