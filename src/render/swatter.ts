import Phaser from 'phaser';
import { t } from '../i18n';
import type { EnemyState, GameEvent } from '../core/types';
import type { RenderCtx } from './ctx';
import type { EnemyLayer } from './enemies';
import { BOARD_H, BOARD_W, CELL, DEPTH } from './layout';
import { C } from './palette';
import type { TowerLayer } from './towers';

/**
 * 苍蝇拍专属特效（文档 02 §2.12 / 文档 11）：
 *  - swat：拍击冲击波（绿色圆环 + 碎屑）
 *  - chain：电蚊拍的连锁闪电（青色锯齿折线，短暂闪烁）
 *  - 神话 A「电网」：持续时间内全场飞行敌人之间不断放电
 *  - 神话 B「天网」：一张大网从天而降罩住棋盘
 * 被网住的敌人（netUntil）在 enemies.ts 里画网罩 / 落地 / 挣扎。
 */

interface Chain {
  pts: { x: number; y: number }[];
  /** 当前锯齿化后的折线（每隔一小段时间重新随机，形成闪烁） */
  jag: { x: number; y: number }[];
  jt: number;
  life: number;
  max: number;
}

interface Arc {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/** 「电网」时长（文档 11：6 秒） */
const GRID_DUR = 6;
/** 天网：下落、落地停留、淡出 */
const SKY_FALL = 0.5;
const SKY_HOLD = 0.35;
const SKY_FADE = 0.6;

export class SwatterLayer {
  private g: Phaser.GameObjects.Graphics;
  private ga: Phaser.GameObjects.Graphics;
  private gSky: Phaser.GameObjects.Graphics;
  private chains: Chain[] = [];
  /** 电网：截止的游戏时间 */
  private gridUntil = 0;
  private gridFrom: { x: number; y: number } | null = null;
  private gridArcs: { a: Arc; jag: { x: number; y: number }[] }[] = [];
  private gridT = 0;
  /** 天网动画进度（视觉秒）；<0 表示没有 */
  private skyT = -1;
  private skyLanded = false;

  constructor(
    private ctx: RenderCtx,
    private towers: TowerLayer,
    private enemies: EnemyLayer,
    private shake: (ms: number, k: number) => void,
  ) {
    // 在飞行敌人之上、血条之下
    this.g = ctx.scene.add.graphics().setDepth(DEPTH.over - 0.6);
    this.ga = ctx.scene.add
      .graphics()
      .setDepth(DEPTH.over - 0.5)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.gSky = ctx.scene.add.graphics().setDepth(DEPTH.fieldTop);
  }

  private epos(e: EnemyState): { x: number; y: number } {
    return this.enemies.pos(e.uid) ?? { x: e.x * CELL, y: e.y * CELL };
  }

  // ───────────── 事件 ─────────────

  onSwat(ev: Extract<GameEvent, { type: 'swat' }>): void {
    const fx = this.ctx.fx;
    const low = this.ctx.quality === 'low';
    this.towers.onSwing(ev.uid);
    const x = ev.x * CELL,
      y = ev.y * CELL,
      r = Math.max(0.3, ev.r || 0.6) * CELL;
    // 与挥拍「拍下」的那一帧对齐（约 0.08s 后）
    const d = 0.07;
    fx.ring(x, y, r * 0.2, r, C.swatter, 0.3, 4, false, d);
    fx.ring(x, y, r * 0.1, r * 0.75, C.white, 0.22, 2, true, d);
    fx.later(d, () => {
      fx.disc(x, y, r * 0.55, C.swatter, 0.14, false, 0.35);
      fx.shatter(x, y, C.paper, low ? 2 : 4, 2.5);
      fx.shatter(x, y, C.swatter, low ? 1 : 3, 2.5);
      if (!low) fx.dust(x, y + 4, r * 0.6, C.deskDark);
    });
  }

  onChain(ev: Extract<GameEvent, { type: 'chain' }>): void {
    if (!ev.points || ev.points.length < 2) return;
    const pts = ev.points.map((p) => ({ x: p.x * CELL, y: p.y * CELL }));
    this.chains.push({ pts, jag: jagged(pts, 6), jt: 0, life: 0, max: 0.24 });
    if (this.chains.length > 24) this.chains.shift();
    const fx = this.ctx.fx;
    for (let i = 1; i < pts.length; i++) {
      fx.disc(pts[i].x, pts[i].y, 5, C.cyan, 0.14, true, 0.9);
      if (this.ctx.quality === 'high') fx.sparkle(pts[i].x, pts[i].y, C.cyan, 2, 8);
    }
  }

  /** 神话能力：branch A 电网 / B 天网 */
  onAbility(branch: 'A' | 'B', towerUid: number): void {
    const st = this.ctx.session.world.state;
    if (branch === 'A') {
      this.gridUntil = st.time + GRID_DUR;
      this.gridFrom = this.towers.pos(towerUid);
      this.gridT = 0;
      this.ctx.fx.rectFlash(0, 0, BOARD_W, BOARD_H, C.cyan, 0.25);
    } else {
      this.skyT = 0;
      this.skyLanded = false;
    }
  }

  // ───────────── 每帧 ─────────────

  sync(): void {
    const ctx = this.ctx;
    const g = this.g;
    const ga = this.ga;
    g.clear();
    ga.clear();
    const dt = ctx.vdt;
    const low = ctx.quality === 'low';

    // 连锁闪电
    for (let i = this.chains.length - 1; i >= 0; i--) {
      const c = this.chains[i];
      c.life += dt > 0 ? dt : ctx.rdt;
      if (c.life >= c.max) {
        this.chains.splice(i, 1);
        continue;
      }
      c.jt -= ctx.rdt;
      if (c.jt <= 0) {
        c.jt = 0.04;
        c.jag = jagged(c.pts, 6);
      }
      const a = 1 - (c.life / c.max) * (c.life / c.max);
      bolt(g, ga, c.jag, a, low);
    }

    // 电网
    const now = ctx.session.world.state.time;
    if (this.gridUntil > now) {
      this.gridT -= ctx.rdt;
      if (this.gridT <= 0 || !this.gridArcs.length) {
        this.gridT = 0.07;
        this.rebuildGrid();
      }
      const left = this.gridUntil - now;
      const k = Math.min(1, left / 0.4) * (0.75 + 0.25 * Math.random());
      for (const arc of this.gridArcs) bolt(g, ga, arc.jag, k, low);
      // 每个飞行敌人身上一层青色电光
      for (const e of ctx.session.world.state.enemies) {
        if (!e.flying && !((e.netUntil ?? 0) > now)) continue;
        const p = this.epos(e);
        ga.fillStyle(C.cyan, 0.18 * k);
        ga.fillCircle(p.x, p.y - 6, 12);
      }
    } else if (this.gridArcs.length) this.gridArcs = [];

    // 天网
    this.drawSkyNet();
  }

  /** 电网：把全场飞行敌人连成网（每个连到最近的两个邻居）；只有一个时从塔连过去 */
  private rebuildGrid(): void {
    const st = this.ctx.session.world.state;
    const now = st.time;
    const pts: { x: number; y: number }[] = [];
    for (const e of st.enemies) {
      if (!e.flying && !((e.netUntil ?? 0) > now)) continue;
      const p = this.epos(e);
      pts.push({ x: p.x, y: p.y - 6 });
      if (pts.length >= 40) break;
    }
    const arcs: Arc[] = [];
    const seen = new Set<string>();
    if (pts.length === 1 && this.gridFrom) {
      arcs.push({ ax: this.gridFrom.x, ay: this.gridFrom.y - 10, bx: pts[0].x, by: pts[0].y });
    }
    for (let i = 0; i < pts.length; i++) {
      const near = pts
        .map((q, j) => ({ j, d: j === i ? Infinity : Math.hypot(q.x - pts[i].x, q.y - pts[i].y) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 2);
      for (const n of near) {
        if (!Number.isFinite(n.d)) continue;
        const key = i < n.j ? `${i}-${n.j}` : `${n.j}-${i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        arcs.push({ ax: pts[i].x, ay: pts[i].y, bx: pts[n.j].x, by: pts[n.j].y });
      }
    }
    this.gridArcs = arcs.map((a) => ({
      a,
      jag: jagged(
        [
          { x: a.ax, y: a.ay },
          { x: a.bx, y: a.by },
        ],
        5,
      ),
    }));
  }

  private drawSkyNet(): void {
    const g = this.gSky;
    g.clear();
    if (this.skyT < 0) return;
    const ctx = this.ctx;
    this.skyT += ctx.vdt > 0 ? ctx.vdt : ctx.rdt;
    const t = this.skyT;
    if (t >= SKY_FALL + SKY_HOLD + SKY_FADE) {
      this.skyT = -1;
      return;
    }
    let s: number;
    let alpha: number;
    let dropY: number;
    if (t < SKY_FALL) {
      const p = t / SKY_FALL;
      const e = p * p;
      s = 1.6 - 0.6 * e;
      alpha = 0.25 + 0.65 * p;
      dropY = -60 * (1 - e);
    } else {
      if (!this.skyLanded) {
        this.skyLanded = true;
        this.land();
      }
      const q = t - SKY_FALL;
      // 落地后轻微回弹
      s = 1 + Math.sin(Math.min(1, q / 0.25) * Math.PI) * 0.015;
      alpha = q < SKY_HOLD ? 0.9 : 0.9 * (1 - (q - SKY_HOLD) / SKY_FADE);
      dropY = 0;
    }
    const cx = BOARD_W / 2,
      cy = BOARD_H / 2 + dropY;
    const M = (x: number, y: number) => ({ x: cx + (x - BOARD_W / 2) * s, y: cy + (y - BOARD_H / 2) * s + Math.sin(x * 0.03 + y * 0.02) * 2 });
    const W = BOARD_W,
      H = BOARD_H,
      S = CELL * 0.85;
    const lines: [number, number, number, number][] = [];
    // 两组斜线 → 菱形网眼
    for (let k = -H; k < W; k += S) {
      const sx = Math.max(0, k),
        sy = Math.max(0, -k);
      const len = Math.min(W - sx, H - sy);
      if (len > 0) lines.push([sx, sy, sx + len, sy + len]);
    }
    for (let k = S; k < W + H; k += S) {
      const sx = Math.min(W, k),
        sy = Math.max(0, k - W);
      const len = Math.min(sx, H - sy);
      if (len > 0) lines.push([sx, sy, sx - len, sy + len]);
    }
    // 网下的阴影（落地前更淡、更大）
    g.fillStyle(C.ink, 0.08 * alpha);
    g.fillRoundedRect(cx - (W / 2) * s + 6, cy - (H / 2) * s + 10 - dropY * 0.5, W * s, H * s, 16);
    for (const pass of [0, 1]) {
      g.lineStyle(pass === 0 ? 4 : 2, pass === 0 ? C.ink : C.netString, alpha * (pass === 0 ? 0.55 : 0.95));
      for (const [x0, y0, x1, y1] of lines) {
        const a = M(x0, y0),
          b = M(x1, y1);
        g.lineBetween(a.x, a.y, b.x, b.y);
      }
    }
    // 外圈绳子 + 坠子
    const tl = M(0, 0),
      br = M(W, H);
    g.lineStyle(8, C.ink, alpha * 0.8);
    g.strokeRoundedRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y, 14);
    g.lineStyle(4, C.netString, alpha);
    g.strokeRoundedRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y, 14);
    const weights = [M(0, 0), M(W, 0), M(0, H), M(W, H), M(W / 2, 0), M(W / 2, H), M(0, H / 2), M(W, H / 2)];
    for (const p of weights) {
      g.fillStyle(C.steel, alpha);
      g.fillCircle(p.x, p.y, 7);
      g.lineStyle(2, C.ink, alpha);
      g.strokeCircle(p.x, p.y, 7);
    }
  }

  private land(): void {
    const ctx = this.ctx;
    const fx = ctx.fx;
    this.shake(220, 0.08);
    fx.text(BOARD_W / 2, BOARD_H * 0.42, t('ui.render.skynet'), 'toast');
    const st = ctx.session.world.state;
    let n = 0;
    for (const e of st.enemies) {
      if (!e.flying && !((e.netUntil ?? 0) > st.time)) continue;
      if (n++ > 40) break;
      const p = this.epos(e);
      fx.dust(p.x, p.y + 6, 14, C.paper);
    }
    for (let i = 0; i < 4; i++) fx.dust(BOARD_W * (0.2 + 0.2 * i), BOARD_H * (i % 2 ? 0.3 : 0.7), 26, C.paper);
  }

  destroy(): void {
    this.g.destroy();
    this.ga.destroy();
    this.gSky.destroy();
  }
}

/** 把折线每段细分并沿法向随机错位（端点不动） */
function jagged(pts: { x: number; y: number }[], amp: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1],
      b = pts[i];
    const dx = b.x - a.x,
      dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    const n = Math.max(2, Math.min(10, Math.round(len / 11)));
    const nx = len > 0 ? -dy / len : 0,
      ny = len > 0 ? dx / len : 0;
    for (let k = 1; k < n; k++) {
      const f = k / n;
      const o = (Math.random() * 2 - 1) * amp;
      out.push({ x: a.x + dx * f + nx * o, y: a.y + dy * f + ny * o });
    }
    out.push(b);
  }
  return out;
}

/** 青色闪电：外发光（叠加）+ 白色芯 */
function bolt(g: Phaser.GameObjects.Graphics, ga: Phaser.GameObjects.Graphics, pts: { x: number; y: number }[], a: number, low: boolean): void {
  if (pts.length < 2 || a <= 0) return;
  if (!low) {
    ga.lineStyle(7, C.cyan, 0.28 * a);
    ga.strokePoints(pts, false);
  }
  ga.lineStyle(3, C.cyan, 0.9 * a);
  ga.strokePoints(pts, false);
  g.lineStyle(1.3, C.white, a);
  g.strokePoints(pts, false);
}
