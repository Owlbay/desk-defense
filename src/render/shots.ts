import Phaser from 'phaser';
import type { ProjectileState, ZoneState } from '../core/types';
import type { RenderCtx } from './ctx';
import { CELL, DEPTH } from './layout';
import { C, TOWER_COLOR } from './palette';

/** 投射物与地面区域（每帧重画） */
export class ShotLayer {
  private pg: Phaser.GameObjects.Graphics;
  private zg: Phaser.GameObjects.Graphics;
  private prev = new Map<number, Rec>();
  private pool: Rec[] = [];
  private seen = new Set<number>();

  constructor(private ctx: RenderCtx) {
    this.pg = ctx.scene.add.graphics().setDepth(DEPTH.proj);
    this.zg = ctx.scene.add.graphics().setDepth(DEPTH.zone);
  }

  sync(): void {
    const st = this.ctx.session.world.state;
    this.drawZones(st.zones, st.time);
    const g = this.pg;
    g.clear();
    this.seen.clear();
    const a = this.ctx.alpha;
    const fx = this.ctx.fx;
    const trails = this.ctx.quality === 'high' && !this.ctx.reduced;
    for (const p of st.projectiles) {
      this.seen.add(p.uid);
      let rec = this.prev.get(p.uid);
      if (!rec) {
        rec = this.pool.pop() ?? { x: 0, y: 0, tick: 0, px: 0, py: 0, hx: 0, hy: 0, n: 0, lx: 0, ly: 0, ang: 0, color: 0 };
        rec.x = rec.px = rec.hx = p.x;
        rec.y = rec.py = rec.hy = p.y;
        rec.tick = st.tick;
        rec.n = 0;
        rec.color = shotColor(p);
        this.prev.set(p.uid, rec);
      } else if (rec.tick !== st.tick) {
        rec.hx = rec.px;
        rec.hy = rec.py;
        rec.px = rec.x;
        rec.py = rec.y;
        rec.x = p.x;
        rec.y = p.y;
        rec.tick = st.tick;
        if (rec.n < 2) rec.n++;
      }
      const x = (rec.px + (rec.x - rec.px) * a) * CELL;
      const y = (rec.py + (rec.y - rec.py) * a) * CELL;
      rec.lx = x;
      rec.ly = y;
      rec.ang = p.angle;
      // 短拖尾：最近两个 tick 的位置连成渐细渐淡的两段（低画质 / 减弱动效不画）
      if (trails && rec.n > 0 && TRAIL[p.kind]) {
        const mx = rec.px * CELL,
          my = rec.py * CELL;
        g.lineStyle(3, rec.color, 0.42);
        g.lineBetween(x, y, mx, my);
        if (rec.n > 1) {
          g.lineStyle(1.6, rec.color, 0.2);
          g.lineBetween(mx, my, rec.hx * CELL, rec.hy * CELL);
        }
      }
      drawProjectile(g, p, x, y, this.ctx.vtime);
    }
    for (const [k, rec] of this.prev) {
      if (this.seen.has(k)) continue;
      // 投射物消失（命中 / 飞完）：按所属塔的颜色溅出火花
      if (rec.n > 0) {
        fx.sparks(rec.lx, rec.ly, rec.color, 3, rec.ang + Math.PI, 2.2, 100);
      }
      this.prev.delete(k);
      if (this.pool.length < 96) this.pool.push(rec);
    }
  }

  private drawZones(zones: ZoneState[], now: number): void {
    const g = this.zg;
    g.clear();
    const t = this.ctx.vtime;
    for (const z of zones) {
      const life = z.until - now;
      const fadeIn = Math.min(1, (now - z.createdAt) / 0.2);
      const a = Math.min(1, life / 0.5) * fadeIn;
      if (a <= 0) continue;
      if (z.shape === 'circle') {
        const x = z.x * CELL,
          y = z.y * CELL,
          r = (z.r ?? 1) * CELL;
        switch (z.kind) {
          case 'glue':
          case 'hotglue':
            blob(g, x, y, r, z.uid, z.kind === 'hotglue' ? C.lamp : C.glue, a * (z.kind === 'hotglue' ? 0.55 : 0.75), t);
            if (z.kind === 'hotglue') {
              // 冒泡
              for (let i = 0; i < 3; i++) {
                const ph = (t * 1.2 + i / 3 + z.uid * 0.13) % 1;
                g.lineStyle(1.5, C.alarmRed, a * (1 - ph) * 0.7);
                g.strokeCircle(x + Math.cos(i * 2.1 + z.uid) * r * 0.45, y + Math.sin(i * 2.1 + z.uid) * r * 0.35, 1.5 + ph * 4);
              }
            }
            break;
          case 'magnifier': {
            g.fillStyle(C.ruler, 0.14 * a);
            g.fillCircle(x, y, r);
            g.fillStyle(0xffffff, 0.18 * a);
            g.fillEllipse(x - r * 0.35, y - r * 0.4, r * 0.7, r * 0.3);
            g.lineStyle(6, C.ink, 0.85 * a);
            g.strokeCircle(x, y, r);
            g.lineStyle(3, C.gold, a);
            g.strokeCircle(x, y, r);
            // 把手
            const hx = x + Math.cos(Math.PI / 4) * r,
              hy = y + Math.sin(Math.PI / 4) * r;
            g.lineStyle(9, C.ink, 0.85 * a);
            g.lineBetween(hx, hy, hx + 18, hy + 18);
            g.lineStyle(5, C.coffee, a);
            g.lineBetween(hx + 1, hy + 1, hx + 17, hy + 17);
            break;
          }
          case 'coffee':
          case 'lava':
          case 'inkcross':
          case 'fullcorrect':
            drawSpecialZone(g, z, a, t);
            break;
          default: {
            g.fillStyle(0xf7f7f7, 0.7 * a);
            g.fillCircle(x, y, r);
            g.lineStyle(2, C.whiteoutBlue, a);
            g.strokeCircle(x, y, r);
          }
        }
      } else {
        const x = z.x * CELL,
          y = z.y * CELL,
          w = (z.w ?? 1) * CELL,
          h = (z.h ?? 1) * CELL;
        const ang = z.angle ?? 0;
        if (z.kind === 'coffee' || z.kind === 'lava' || z.kind === 'inkcross' || z.kind === 'fullcorrect') {
          drawSpecialZone(g, z, a, t);
        } else if (z.kind === 'whiteout') {
          rotRect(g, x, y, w, h, ang, 0xf7f7f7, 0.82 * a, C.whiteoutBlue, 3, a);
          // 刷痕
          g.lineStyle(2, C.whiteoutBlue, 0.25 * a);
          for (let i = 1; i < 4; i++) {
            const yy = y + (h * i) / 4;
            g.lineBetween(x + 6, yy + Math.sin(i + z.uid) * 2, x + w - 6, yy - Math.sin(i + z.uid) * 2);
          }
        } else if (z.kind === 'tape') {
          rotRect(g, x, y, w, h, ang, C.paper, 0.85 * a, C.ink, 2, 0.6 * a);
          // 中线虚线
          const c = Math.cos(ang),
            s = Math.sin(ang);
          g.lineStyle(1.5, C.blueCap, 0.7 * a);
          const n = Math.floor(w / 10);
          for (let i = 0; i < n; i += 1) {
            const a0 = i * 10 + 2,
              a1 = a0 + 5;
            const my = h / 2;
            g.lineBetween(x + a0 * c - my * s, y + a0 * s + my * c, x + a1 * c - my * s, y + a1 * s + my * c);
          }
        } else {
          rotRect(g, x, y, w, h, ang, C.glue, 0.6 * a, C.blueCap, 2, a);
        }
      }
    }
  }

  destroy(): void {
    this.pg.destroy();
    this.zg.destroy();
  }
}

interface Rec {
  x: number;
  y: number;
  tick: number;
  px: number;
  py: number;
  /** 再往前一个 tick 的位置（拖尾第二段） */
  hx: number;
  hy: number;
  /** 已记录的历史 tick 数（0–2） */
  n: number;
  /** 最近一次显示位置（像素）与朝向：消失时在这里溅火花 */
  lx: number;
  ly: number;
  ang: number;
  color: number;
}

const TRAIL: Partial<Record<ProjectileState['kind'], boolean>> = {
  graphite: true,
  color: true,
  ink: true,
  eraser: true,
  glue: true,
  nail: true,
};

/** 投射物 → 所属塔的颜色（拖尾与命中火花） */
function shotColor(p: ProjectileState): number {
  switch (p.kind) {
    case 'graphite':
      return TOWER_COLOR.pencil;
    case 'color':
      return COLOR_SHOT[p.color ?? 'red'] ?? C.alarmRed;
    case 'glue':
      return C.blueCap;
    case 'ink':
    case 'brush':
      return TOWER_COLOR.pen;
    case 'ruler':
      return TOWER_COLOR.ruler;
    case 'eraser':
      return TOWER_COLOR.eraser;
    case 'net':
      return C.netString;
    default:
      return C.metal;
  }
}

/**
 * 文档 09 / 11 新增区域：
 *  coffee 咖啡渍（瘫痪区）、lava 熔胶海、inkcross 十字墨迹、fullcorrect 全面修改的修正带。
 *  圆形与矩形两种形状都支持（以 core 实际给出的为准）。
 */
function drawSpecialZone(g: Phaser.GameObjects.Graphics, z: ZoneState, a: number, t: number): void {
  const circle = z.shape === 'circle';
  const cx = circle ? z.x * CELL : (z.x + (z.w ?? 1) / 2) * CELL;
  const cy = circle ? z.y * CELL : (z.y + (z.h ?? 1) / 2) * CELL;
  const rw = circle ? (z.r ?? 1) * CELL : ((z.w ?? 1) * CELL) / 2;
  const rh = circle ? (z.r ?? 1) * CELL : ((z.h ?? 1) * CELL) / 2;
  const rr = Math.min(rw, rh);
  switch (z.kind) {
    case 'coffee': {
      // 不规则的棕色泼溅 + 几滴外溅
      if (circle) blob(g, cx, cy, rr, z.uid, C.coffee, 0.5 * a, t);
      else {
        g.fillStyle(C.coffee, 0.42 * a);
        g.fillRoundedRect(cx - rw + 3, cy - rh + 3, rw * 2 - 6, rh * 2 - 6, 14);
        g.lineStyle(2, C.coffee, 0.7 * a);
        g.strokeRoundedRect(cx - rw + 3, cy - rh + 3, rw * 2 - 6, rh * 2 - 6, 14);
      }
      g.fillStyle(C.coffee, 0.6 * a);
      for (let i = 0; i < 5; i++) {
        const ang = i * 1.3 + z.uid;
        g.fillCircle(cx + Math.cos(ang) * (rw + 4), cy + Math.sin(ang) * (rh + 3), 2 + (i % 3));
      }
      g.fillStyle(0xffffff, 0.18 * a);
      g.fillEllipse(cx - rw * 0.3, cy - rh * 0.35, rw * 0.5, rh * 0.18);
      break;
    }
    case 'lava': {
      // 熔胶海：橙红色、表面翻滚的气泡
      if (circle) blob(g, cx, cy, rr, z.uid, C.lamp, 0.6 * a, t);
      else {
        g.fillStyle(C.lamp, 0.55 * a);
        g.fillRoundedRect(cx - rw + 2, cy - rh + 2, rw * 2 - 4, rh * 2 - 4, 12);
        g.fillStyle(C.alarmRed, 0.25 * a);
        g.fillRoundedRect(cx - rw + 8, cy - rh + 8, rw * 2 - 16, rh * 2 - 16, 10);
        g.lineStyle(2.5, C.alarmRed, 0.7 * a);
        g.strokeRoundedRect(cx - rw + 2, cy - rh + 2, rw * 2 - 4, rh * 2 - 4, 12);
      }
      for (let i = 0; i < 7; i++) {
        const ph = (t * 1.1 + i / 7 + z.uid * 0.17) % 1;
        const bx = cx + Math.cos(i * 2.3 + z.uid) * rw * 0.6;
        const by = cy + Math.sin(i * 1.7 + z.uid) * rh * 0.6;
        g.lineStyle(1.8, C.goldLight, a * (1 - ph) * 0.8);
        g.strokeCircle(bx, by, 2 + ph * 6);
      }
      break;
    }
    case 'inkcross': {
      // 十字墨迹：横竖两道笔画
      const L = circle ? rr : Math.max(rw, rh);
      const W = circle ? CELL * 0.9 : Math.min(rw, rh) * 2;
      const wob = Math.sin(t * 3 + z.uid) * 1.5;
      g.fillStyle(C.inkBlue, 0.45 * a);
      if (circle) {
        g.fillRoundedRect(cx - L, cy - W / 2 + wob, L * 2, W, W / 2);
        g.fillRoundedRect(cx - W / 2 - wob, cy - L, W, L * 2, W / 2);
      } else g.fillRoundedRect(cx - rw, cy - rh, rw * 2, rh * 2, Math.min(rw, rh));
      g.fillStyle(C.inkBlue, 0.75 * a);
      for (let i = 0; i < 6; i++) {
        const ang = i * 1.05 + z.uid;
        g.fillCircle(cx + Math.cos(ang) * L * 0.55, cy + Math.sin(ang) * L * 0.55, 2.5 + (i % 2) * 1.5);
      }
      break;
    }
    case 'fullcorrect': {
      // 修正带：白色带子 + 青色描边 + 流动的虚线
      if (circle) {
        g.fillStyle(C.paper, 0.85 * a);
        g.fillCircle(cx, cy, rr);
        g.lineStyle(2, C.cyan, 0.8 * a);
        g.strokeCircle(cx, cy, rr);
      } else {
        rotRect(g, z.x * CELL, z.y * CELL, (z.w ?? 1) * CELL, (z.h ?? 1) * CELL, z.angle ?? 0, C.paper, 0.85 * a, C.cyan, 2, 0.8 * a);
        if (!z.angle) {
          const hor = rw >= rh;
          const off = (t * 30) % 12;
          g.lineStyle(1.5, C.cyan, 0.6 * a);
          if (hor) for (let x = cx - rw + 4 + off; x < cx + rw - 8; x += 12) g.lineBetween(x, cy, x + 6, cy);
          else for (let y = cy - rh + 4 + off; y < cy + rh - 8; y += 12) g.lineBetween(cx, y, cx, y + 6);
        }
      }
      break;
    }
  }
}

/** 绕左上角 (x,y) 旋转的矩形 */
function rotRect(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  ang: number,
  fill: number,
  fa: number,
  stroke: number,
  sw: number,
  sa: number,
): void {
  if (!ang) {
    g.fillStyle(fill, fa);
    g.fillRoundedRect(x, y, w, h, 6);
    g.lineStyle(sw, stroke, sa);
    g.strokeRoundedRect(x, y, w, h, 6);
    return;
  }
  const c = Math.cos(ang),
    s = Math.sin(ang);
  const pts = [
    { x, y },
    { x: x + w * c, y: y + w * s },
    { x: x + w * c - h * s, y: y + w * s + h * c },
    { x: x - h * s, y: y + h * c },
  ];
  g.fillStyle(fill, fa);
  g.fillPoints(pts, true);
  g.lineStyle(sw, stroke, sa);
  g.strokePoints(pts, true);
}

/** 不规则胶水滩 */
function blob(g: Phaser.GameObjects.Graphics, x: number, y: number, r: number, seed: number, color: number, a: number, t: number): void {
  const pts: { x: number; y: number }[] = [];
  const n = 14;
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2;
    const k = 0.82 + 0.18 * Math.sin(ang * 3 + seed * 1.7) + 0.03 * Math.sin(t * 2 + i);
    pts.push({ x: x + Math.cos(ang) * r * k, y: y + Math.sin(ang) * r * k * 0.85 });
  }
  g.fillStyle(color, a);
  g.fillPoints(pts, true);
  g.lineStyle(2, C.ink, a * 0.45);
  g.strokePoints(pts, true);
  g.fillStyle(0xffffff, a * 0.5);
  g.fillEllipse(x - r * 0.3, y - r * 0.3, r * 0.5, r * 0.18);
}

const COLOR_SHOT: Record<string, number> = { red: C.alarmRed, blue: C.blueCap, yellow: C.pencil };

function drawProjectile(g: Phaser.GameObjects.Graphics, p: ProjectileState, x: number, y: number, t: number): void {
  const c = Math.cos(p.angle),
    s = Math.sin(p.angle);
  switch (p.kind) {
    case 'net': {
      // 捕虫网：旋转着飞出的网盘
      const R = 8;
      const spin = t * 12 + p.uid;
      g.lineStyle(3, C.netString, 0.3);
      g.lineBetween(x - c * 16, y - s * 16, x - c * 6, y - s * 6);
      g.fillStyle(C.netString, 0.3);
      g.fillCircle(x, y, R);
      for (const off of [0, Math.PI / 2]) {
        const a0 = spin + off;
        const ca = Math.cos(a0),
          sa = Math.sin(a0);
        for (let i = -1; i <= 1; i++) {
          const d = i * R * 0.5;
          const h = Math.sqrt(Math.max(0, R * R - d * d));
          const ox = -sa * d,
            oy = ca * d;
          g.lineStyle(1.3, C.ink, 0.85);
          g.lineBetween(x + ox - ca * h, y + oy - sa * h, x + ox + ca * h, y + oy + sa * h);
        }
      }
      g.lineStyle(2.4, C.ink, 1);
      g.strokeCircle(x, y, R);
      g.lineStyle(1.2, C.netString, 1);
      g.strokeCircle(x, y, R);
      g.fillStyle(C.steel, 1);
      for (let i = 0; i < 4; i++) {
        const a = spin + (i * Math.PI) / 2 + Math.PI / 4;
        g.fillCircle(x + Math.cos(a) * R, y + Math.sin(a) * R, 1.8);
      }
      break;
    }
    case 'graphite':
    case 'color': {
      const col = p.kind === 'color' ? (COLOR_SHOT[p.color ?? 'red'] ?? C.alarmRed) : C.lead;
      const L = 6,
        W = 2.4;
      const pts = [
        { x: x + c * L, y: y + s * L },
        { x: x - s * W, y: y + c * W },
        { x: x - c * L * 0.6, y: y - s * L * 0.6 },
        { x: x + s * W, y: y - c * W },
      ];
      g.fillStyle(col, 1);
      g.fillPoints(pts, true);
      g.lineStyle(1.2, C.ink, 1);
      g.strokePoints(pts, true);
      break;
    }
    case 'glue': {
      g.fillStyle(C.ink, 0.18);
      g.fillCircle(x + 1, y + 4, 4);
      g.fillStyle(C.glue, 1);
      g.fillCircle(x, y, 4.5);
      g.lineStyle(1.5, C.ink, 1);
      g.strokeCircle(x, y, 4.5);
      g.fillStyle(C.blueCap, 0.8);
      g.fillCircle(x - 1.2, y - 1.2, 1.5);
      break;
    }
    case 'ink': {
      g.fillStyle(C.inkBlue, 0.35);
      g.fillCircle(x - c * 6, y - s * 6, 2);
      g.fillCircle(x - c * 10, y - s * 10, 1.3);
      g.fillStyle(C.inkBlue, 1);
      g.fillCircle(x, y, 3.6);
      g.lineStyle(1.2, C.ink, 1);
      g.strokeCircle(x, y, 3.6);
      break;
    }
    case 'brush': {
      // 一道横向笔画（垂直于前进方向）
      const L = 26;
      g.lineStyle(9, C.inkBlue, 0.25);
      g.lineBetween(x - s * L * 0.5 - c * 8, y + c * L * 0.5 - s * 8, x + s * L * 0.5 - c * 8, y - c * L * 0.5 - s * 8);
      g.fillStyle(C.inkBlue, 0.95);
      const pts = [
        { x: x - s * L * 0.5, y: y + c * L * 0.5 },
        { x: x + c * 4, y: y + s * 4 },
        { x: x + s * L * 0.5, y: y - c * L * 0.5 },
        { x: x - c * 3, y: y - s * 3 },
      ];
      g.fillPoints(pts, true);
      break;
    }
    case 'ruler': {
      // 刻度波：一段垂直于方向的半透明蓝弧
      const L = 22;
      const ox = -s,
        oy = c;
      g.lineStyle(7, C.ruler, 0.35);
      g.lineBetween(x - ox * L * 0.5 - c * 5, y - oy * L * 0.5 - s * 5, x + ox * L * 0.5 - c * 5, y + oy * L * 0.5 - s * 5);
      g.lineStyle(4, C.ruler, 0.95);
      g.lineBetween(x - ox * L * 0.5, y - oy * L * 0.5, x + ox * L * 0.5, y + oy * L * 0.5);
      g.lineStyle(1.2, C.ink, 0.9);
      for (let i = -2; i <= 2; i++) {
        const bx = x + ox * i * 4.5,
          by = y + oy * i * 4.5;
        g.lineBetween(bx - c * 2.5, by - s * 2.5, bx + c * 2.5, by + s * 2.5);
      }
      break;
    }
    case 'eraser': {
      const r = t * 9 + p.uid;
      const cr = Math.cos(r),
        sr = Math.sin(r);
      const hw = 5,
        hh = 3.2;
      const pts = [
        { x: x + -hw * cr - -hh * sr, y: y + -hw * sr + -hh * cr },
        { x: x + hw * cr - -hh * sr, y: y + hw * sr + -hh * cr },
        { x: x + hw * cr - hh * sr, y: y + hw * sr + hh * cr },
        { x: x + -hw * cr - hh * sr, y: y + -hw * sr + hh * cr },
      ];
      g.fillStyle(C.pink, 1);
      g.fillPoints(pts, true);
      g.lineStyle(1.3, C.ink, 1);
      g.strokePoints(pts, true);
      break;
    }
  }
}
