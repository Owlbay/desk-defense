import Phaser from 'phaser';
import { B, C, FONT, hex } from './palette';
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
  | 'rect2' // 矩形区域闪光
  | 'bolt' // 沿直线飞行的一小段（钉子、射线）
  | 'spark' // 沿速度方向的短火花
  | 'coin' // 出售时飞起的小硬币
  | 'ell'; // 渐隐的地面椭圆（死亡后的影子）

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
  /** 起点与总上升量（像素）：y = y0 - rise * easeOut(p) */
  y0: number;
  rise: number;
  prio: number;
  active: boolean;
  /** 弹出峰值倍率（1 = 不弹） */
  peak: number;
  /** 已套用的样式（相同样式不重复 setStyle，省一次画布重绘） */
  style: TextStyleKind | '';
  styleRes: number;
  /** 伤害数字：所属敌人、累计值、是否待刷新、堆叠槽位 */
  uid: number;
  amount: number;
  dirty: boolean;
  slot: number;
  /** 合并时的小回弹（1 → 0） */
  bump: number;
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
/** 同一敌人在这段时间内的普通伤害合并成一个数字 */
const MERGE_WINDOW = 0.28;
const STACK_X = [0, 9, -9, 5];
const STACK_Y = [0, -6, -11, -16];
/** 各样式的上升距离（像素） */
const RISE: Partial<Record<TextStyleKind, number>> = { dmg: 16, dot: 11, shield: 16, crit: 26, gold: 20, goldLoss: 16, toast: 8 };

function lighten(c: number, k: number): number {
  const r = (c >> 16) & 255,
    g = (c >> 8) & 255,
    b = c & 255;
  return ((r + (255 - r) * k) << 16) | ((g + (255 - g) * k) << 8) | ((b + (255 - b) * k) | 0);
}

/** 复用的顶点缓冲（避免每帧分配） */
const STAR_PTS: { x: number; y: number }[] = [];
for (let i = 0; i < 8; i++) STAR_PTS.push({ x: 0, y: 0 });

export class Fx {
  private items: FxItem[] = [];
  private free: FxItem[] = [];
  private texts: FloatText[] = [];
  private g: Phaser.GameObjects.Graphics;
  private gAdd: Phaser.GameObjects.Graphics;
  private textBudget = 0;
  private sparkBudget = 0;
  low = false;
  /** 减弱动效：粒子减量、数字不做夸张弹跳 */
  reduced = false;
  private resolution = 1;
  private byUid = new Map<number, FloatText>();

  /** 粒子密度：低画质 / 减弱动效各减半 */
  private get density(): number {
    return (this.low ? 0.5 : 1) * (this.reduced ? 0.5 : 1);
  }

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

  shatter(x: number, y: number, color: number, n: number, size = 5, delay = 0): void {
    n = Math.max(2, Math.ceil(n * this.density));
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
      it.delay = delay;
    }
  }

  dust(x: number, y: number, r = 20, color: number = C.deskDark): void {
    const n = Math.max(3, Math.ceil(9 * this.density));
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

  confetti(x: number, y: number, n = 14, delay = 0): void {
    const cols = CONFETTI;
    n = Math.max(2, Math.ceil(n * (this.reduced ? 0.5 : 1)));
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
      it.delay = delay;
    }
  }

  /** 单色纸屑（敌人死亡：本体色 + 提亮色 + 纸白） */
  confettiOf(x: number, y: number, color: number, n: number): void {
    n = Math.ceil(n * this.density);
    const light = lighten(color, 0.45);
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 3;
      const sp = 50 + Math.random() * 70;
      const it = this.alloc('rect', x, y, 0.55 + Math.random() * 0.3, i % 3 === 0 ? color : i % 3 === 1 ? light : C.paper);
      if (!it) return;
      it.vx = Math.cos(a) * sp;
      it.vy = Math.sin(a) * sp;
      it.g = 200;
      it.drag = 2.2;
      it.size = 2.5 + Math.random() * 1.8;
      it.rot = Math.random() * 6;
      it.vr = (Math.random() - 0.5) * 20;
    }
  }

  /**
   * 命中火花：沿 angle 方向（spread 为散布角）飞出的短线。
   * 每帧有总量预算；低画质不出。
   */
  sparks(x: number, y: number, color: number, n: number, angle = 0, spread = Math.PI * 2, speed = 110): void {
    if (this.low) return;
    if (this.reduced) n = Math.ceil(n / 2);
    for (let i = 0; i < n; i++) {
      if (this.sparkBudget <= 0) return;
      this.sparkBudget--;
      const a = angle + (Math.random() - 0.5) * spread;
      const sp = speed * (0.55 + Math.random() * 0.7);
      const it = this.alloc('spark', x, y, 0.16 + Math.random() * 0.12, color);
      if (!it) return;
      it.vx = Math.cos(a) * sp;
      it.vy = Math.sin(a) * sp;
      it.drag = 5;
      it.w = 1.8;
    }
  }

  /** 出售：小硬币向上抛起再落下 */
  coinBurst(x: number, y: number, n: number): void {
    n = Math.max(2, Math.ceil(n * this.density));
    for (let i = 0; i < n; i++) {
      const it = this.alloc('coin', x + (Math.random() - 0.5) * 12, y, 0.6 + Math.random() * 0.2, C.gold);
      if (!it) return;
      it.vx = (Math.random() - 0.5) * 70;
      it.vy = -110 - Math.random() * 70;
      it.g = 300;
      it.size = 4 + Math.random() * 1.5;
      it.rot = Math.random() * 6;
      it.vr = 10 + Math.random() * 6;
      it.delay = i * 0.03;
    }
  }

  /** 渐隐的地面影子 */
  shadowFade(x: number, y: number, w: number, h: number, dur = 0.45): void {
    const it = this.alloc('ell', x, y, dur, C.ink);
    if (!it) return;
    it.x2 = w;
    it.y2 = h;
    it.alpha = 0.22;
  }

  /** 下落的小液滴（墨滴 / 流血） */
  drip(x: number, y: number, color: number, size = 1.8): void {
    const it = this.alloc('dot', x, y, 0.42, color);
    if (!it) return;
    it.vy = 6;
    it.g = 150;
    it.size = size;
    it.size2 = -size * 0.5;
  }

  sparkle(x: number, y: number, color: number, n = 6, spread = 16): void {
    n = Math.ceil(n * this.density);
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

  /** 一小段沿直线飞行的亮条（钉子、射线等），len 为长度（像素） */
  bolt(x: number, y: number, tx: number, ty: number, color: number, width: number, len = 12, dur = 0.3, delay = 0): void {
    const it = this.alloc('bolt', x, y, dur, color);
    if (!it) return;
    it.x2 = tx;
    it.y2 = ty;
    it.w = width;
    it.size = len;
    it.delay = delay;
  }

  /** 延迟出现的扩散圆环（已有 ring 的 delay 参数）/ 延迟的碎片：通用延迟包装 */
  later(sec: number, fn: () => void): void {
    this.scene.time.delayedCall(sec * 1000, fn);
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
    this.sparkBudget = this.reduced ? 12 : 36;
  }

  private allocText(prio: number): FloatText | null {
    for (const c of this.texts) if (!c.active) return c;
    if (this.texts.length < MAX_TEXTS) {
      const t = this.scene.add.text(0, 0, '', { fontFamily: FONT, fontSize: '12px' }).setOrigin(0.5, 1).setDepth(DEPTH.text);
      t.setResolution(this.resolution);
      const ft: FloatText = { t, life: 0, max: 1, y0: 0, rise: 0, prio: 0, active: false, peak: 1, style: '', styleRes: this.resolution, uid: 0, amount: 0, dirty: false, slot: 0, bump: 0 };
      this.texts.push(ft);
      return ft;
    }
    // 回收优先级最低、最老的
    let best: FloatText | null = null;
    for (const c of this.texts) if (c.prio <= prio && (!best || c.life / c.max > best.life / best.max)) best = c;
    if (best) this.releaseText(best);
    return best;
  }

  private releaseText(ft: FloatText): void {
    ft.active = false;
    if (ft.uid && this.byUid.get(ft.uid) === ft) this.byUid.delete(ft.uid);
    ft.uid = 0;
  }

  private spawnText(x: number, y: number, str: string, kind: TextStyleKind): FloatText | null {
    const st = STYLE[kind];
    if (st.prio === 0) {
      if (this.textBudget <= 0) return null;
      this.textBudget--;
    }
    const ft = this.allocText(st.prio);
    if (!ft) return null;
    const t = ft.t;
    if (ft.style !== kind || ft.styleRes !== this.resolution) {
      ft.style = kind;
      ft.styleRes = this.resolution;
      t.setStyle({
        fontFamily: FONT,
        fontSize: `${st.size}px`,
        fontStyle: st.bold ? 'bold' : 'normal',
        color: hex(st.color),
        stroke: hex(st.stroke === C.ink ? B.textStroke : st.stroke),
        strokeThickness: kind === 'toast' ? 4 : 3,
      });
    }
    t.setText(str);
    t.setPosition(x, y);
    t.setAlpha(1);
    t.setScale(this.reduced ? 1 : 0.5);
    t.setVisible(true);
    ft.life = 0;
    ft.max = st.life;
    ft.y0 = y;
    ft.rise = RISE[kind] ?? -st.vy * 0.5;
    ft.prio = st.prio;
    ft.active = true;
    ft.peak = this.reduced ? 1 : kind === 'crit' ? 1.55 : kind === 'level' || kind === 'toast' ? 1.25 : kind === 'gold' ? 1.2 : 1.12;
    ft.uid = 0;
    ft.amount = 0;
    ft.dirty = false;
    ft.slot = 0;
    ft.bump = 0;
    return ft;
  }

  text(x: number, y: number, str: string, kind: TextStyleKind): void {
    this.spawnText(x, y, str, kind);
  }

  /**
   * 伤害数字：同一敌人短时间内的同类小伤害合并成一个数字（累加、轻轻回弹），
   * 超出合并窗口的新数字错开位置，避免叠在一起。暴击单独显示、更大。
   */
  damage(uid: number, x: number, y: number, amount: number, kind: 'dmg' | 'dot' | 'shield' | 'warn' | 'crit'): void {
    if (kind === 'crit') {
      this.spawnText(x, y, `${amount}!`, 'crit');
      return;
    }
    const prev = this.byUid.get(uid);
    let slot = 0;
    if (prev && prev.active) {
      if (prev.style === kind && prev.life < MERGE_WINDOW) {
        prev.amount += amount;
        prev.dirty = true;
        prev.bump = 1;
        return;
      }
      slot = (prev.slot + 1) % STACK_X.length;
    }
    const ft = this.spawnText(x + STACK_X[slot], y + STACK_Y[slot], String(amount), kind);
    if (!ft) return;
    ft.uid = uid;
    ft.amount = amount;
    ft.slot = slot;
    this.byUid.set(uid, ft);
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
        this.releaseText(ft);
        ft.t.setVisible(false);
        continue;
      }
      if (ft.dirty) {
        // 合并的伤害：每帧最多刷新一次文字
        ft.dirty = false;
        ft.t.setText(String(ft.amount));
      }
      const p = ft.life / ft.max;
      // 上升：先快后慢
      const q = 1 - p;
      ft.t.y = ft.y0 - ft.rise * (1 - q * q * q);
      // 淡出 + 缩小退场
      const out = p < 0.62 ? 0 : (p - 0.62) / 0.38;
      ft.t.setAlpha(1 - out * out);
      let sc: number;
      if (p < 0.1) sc = 0.5 + (ft.peak - 0.5) * (p / 0.1);
      else if (p < 0.28) sc = ft.peak - (ft.peak - 1) * ((p - 0.1) / 0.18);
      else sc = 1 - out * 0.3;
      if (ft.bump > 0) {
        sc += 0.16 * ft.bump;
        ft.bump = Math.max(0, ft.bump - dt * 9);
      }
      if (this.reduced) sc = 1;
      ft.t.setScale(sc);
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
          const bx = s * 0.9,
            by = s * 0.6;
          const x0 = it.x + s * sn,
            y0 = it.y - s * c;
          const x1 = it.x + bx * c - by * sn,
            y1 = it.y + bx * sn + by * c;
          const x2 = it.x - bx * c - by * sn,
            y2 = it.y - bx * sn + by * c;
          gg.fillStyle(it.color, a);
          gg.fillTriangle(x0, y0, x1, y1, x2, y2);
          gg.lineStyle(1.2, C.ink, a * 0.8);
          gg.strokeTriangle(x0, y0, x1, y1, x2, y2);
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
        case 'bolt': {
          const e = p;
          const dx = it.x2 - it.x,
            dy = it.y2 - it.y;
          const L = Math.hypot(dx, dy) || 1;
          const ux = dx / L,
            uy = dy / L;
          const hx = it.x + dx * e,
            hy = it.y + dy * e;
          const tl = Math.min(it.size, L * e);
          const a = p > 0.85 ? (1 - p) / 0.15 : 1;
          g.lineStyle(it.w + 2, C.ink, 0.8 * a);
          g.lineBetween(hx - ux * tl, hy - uy * tl, hx, hy);
          g.lineStyle(it.w, it.color, a);
          g.lineBetween(hx - ux * tl, hy - uy * tl, hx, hy);
          break;
        }
        case 'spark': {
          const a = 1 - p;
          const k = 0.045;
          gg.lineStyle(it.w, it.color, a);
          gg.lineBetween(it.x - it.vx * k, it.y - it.vy * k, it.x, it.y);
          break;
        }
        case 'coin': {
          const a = p < 0.7 ? 1 : 1 - (p - 0.7) / 0.3;
          const sx = 0.3 + 0.7 * Math.abs(Math.cos(it.rot));
          const r = it.size;
          g.fillStyle(C.goldDark, a);
          g.fillEllipse(it.x, it.y + 1, r * 2 * sx + 1.6, r * 2 + 1.6);
          g.fillStyle(C.gold, a);
          g.fillEllipse(it.x, it.y, r * 2 * sx, r * 2);
          g.fillStyle(C.goldLight, a);
          g.fillEllipse(it.x - r * 0.15 * sx, it.y - r * 0.2, r * 1.1 * sx, r * 1.1);
          break;
        }
        case 'ell': {
          const q = 1 - p;
          g.fillStyle(it.color, it.alpha * q);
          g.fillEllipse(it.x, it.y, it.x2 * (0.6 + 0.4 * q), it.y2 * (0.6 + 0.4 * q));
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
      ft.uid = 0;
      ft.t.setVisible(false);
    }
    this.byUid.clear();
  }
}

const CONFETTI = [C.cyan, C.magenta, C.goldLight, C.pink, C.blueCap, C.paper];

export function drawStar(g: Phaser.GameObjects.Graphics, x: number, y: number, s: number, rot: number, color: number, alpha: number): void {
  const pts = STAR_PTS;
  for (let i = 0; i < 8; i++) {
    const r = i % 2 === 0 ? s : s * 0.4;
    const a = rot + (i * Math.PI) / 4;
    pts[i].x = x + Math.cos(a) * r;
    pts[i].y = y + Math.sin(a) * r;
  }
  g.fillStyle(color, alpha);
  g.fillPoints(pts, true);
  g.lineStyle(1, C.ink, alpha * 0.8);
  g.strokePoints(pts, true);
}
