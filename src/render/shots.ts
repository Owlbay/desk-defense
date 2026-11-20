import Phaser from 'phaser';
import type { ProjectileState, ZoneState } from '../core/types';
import type { RenderCtx } from './ctx';
import { CELL, DEPTH } from './layout';
import { C } from './palette';

/** 投射物与地面区域（每帧重画） */
export class ShotLayer {
  private pg: Phaser.GameObjects.Graphics;
  private zg: Phaser.GameObjects.Graphics;
  private prev = new Map<number, { x: number; y: number; tick: number; px: number; py: number }>();
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
    for (const p of st.projectiles) {
      this.seen.add(p.uid);
      let rec = this.prev.get(p.uid);
      if (!rec) {
        rec = { x: p.x, y: p.y, tick: st.tick, px: p.x, py: p.y };
        this.prev.set(p.uid, rec);
      } else if (rec.tick !== st.tick) {
        rec.px = rec.x;
        rec.py = rec.y;
        rec.x = p.x;
        rec.y = p.y;
        rec.tick = st.tick;
      }
      const x = (rec.px + (rec.x - rec.px) * a) * CELL;
      const y = (rec.py + (rec.y - rec.py) * a) * CELL;
      drawProjectile(g, p, x, y, this.ctx.vtime);
    }
    for (const k of this.prev.keys()) if (!this.seen.has(k)) this.prev.delete(k);
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
        if (z.kind === 'whiteout') {
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
    case 'graphite':
    case 'color': {
      const col = p.kind === 'color' ? COLOR_SHOT[p.color ?? 'red'] ?? C.alarmRed : C.lead;
      // 拖尾
      g.lineStyle(2, col, 0.3);
      g.lineBetween(x - c * 12, y - s * 12, x, y);
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
