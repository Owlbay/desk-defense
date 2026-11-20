import Phaser from 'phaser';
import type { TowerState } from '../core/types';
import { ui } from '../game/UiStore';
import type { RenderCtx } from './ctx';
import { CELL, DEPTH } from './layout';
import { C, TOWER_COLOR } from './palette';
import { PartSet } from './parts';

const TURN_RATE = Math.PI * 4; // 720°/s
const RECOIL_T = 0.06;

export function towerAsset(t: Pick<TowerState, 'id' | 'tier' | 'branch' | 'level'>): string {
  // 墙：core 约定 tier 即墙的等级（1–3）
  if (t.id === 'wall') return `towers/wall_l${Math.max(1, Math.min(3, t.tier || t.level))}`;
  const tier = t.tier === 4 ? `t4${t.branch === 'B' ? 'b' : 'a'}` : `t${t.tier}`;
  return `towers/${t.id}_${tier}`;
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

class TowerView {
  root: Phaser.GameObjects.Container;
  parts: PartSet;
  asset = '';
  tier = 1;
  cx: number;
  cy: number;
  angle: number;
  recoil = 0;
  evolving = false;
  disabled = false;
  moteT = Math.random();
  phase = Math.random() * Math.PI * 2;

  constructor(
    private ctx: RenderCtx,
    t: TowerState,
  ) {
    this.cx = t.cx;
    this.cy = t.cy;
    this.angle = t.angle;
    this.root = ctx.scene.add.container((t.cx + 0.5) * CELL, (t.cy + 0.5) * CELL);
    this.root.setDepth(DEPTH.tower + t.cy * 0.01);
    this.parts = new PartSet(ctx.scene, this.root);
    this.tier = t.tier;
    this.bind(t);
  }

  bind(t: TowerState): void {
    const a = towerAsset(t);
    this.parts.bind(this.ctx.atlas, a);
    this.asset = this.parts.asset;
    this.applyQuality();
  }

  applyQuality(): void {
    const glow = this.parts.get('glow');
    if (glow) glow.setVisible(this.ctx.quality === 'high');
  }

  pop(): void {
    this.root.setScale(0.6);
    this.ctx.scene.tweens.add({ targets: this.root, scale: 1, duration: 200, ease: 'Back.Out', easeParams: [3] });
  }

  evolve(t: TowerState): void {
    if (this.evolving) return;
    this.evolving = true;
    const sc = this.ctx.scene;
    this.parts.tintFill(true, 0xffffff);
    sc.tweens.add({
      targets: this.root,
      scale: 0.6,
      duration: 130,
      ease: 'Quad.In',
      onComplete: () => {
        if (!this.root.active) return;
        this.bind(t);
        this.parts.tintFill(true, 0xffffff);
        this.tier = t.tier;
        this.ctx.fx.confetti(this.root.x, this.root.y - 6, this.ctx.quality === 'low' ? 8 : 16);
        this.ctx.fx.ring(this.root.x, this.root.y, 8, 34, t.tier === 4 ? (t.branch === 'B' ? C.magenta : C.cyan) : t.tier === 3 ? C.gold : C.teal, 0.45, 4);
        sc.time.delayedCall(70, () => this.root.active && this.parts.tintFill(false));
        sc.tweens.add({
          targets: this.root,
          scale: 1,
          duration: 260,
          ease: 'Back.Out',
          easeParams: [3],
          onComplete: () => {
            this.evolving = false;
            this.disabled = false; // 重新应用着色
          },
        });
      },
    });
  }

  update(t: TowerState, now: number): void {
    const ctx = this.ctx;
    // 资源变化（换形态 / 墙升级 / 图集重建）
    const a = towerAsset(t);
    if (!this.evolving) {
      if (a !== this.asset) {
        if (t.tier !== this.tier && t.id !== 'wall') this.evolve(t);
        else {
          this.bind(t);
          this.tier = t.tier;
          this.ctx.fx.dust(this.root.x, this.root.y + 10, 20, C.paper);
          this.root.setScale(0.85);
          ctx.scene.tweens.add({ targets: this.root, scale: 1, duration: 180, ease: 'Back.Out' });
        }
      } else if (ctx.atlas.gen !== this.parts.gen) this.bind(t);
    }
    // 位置（搬家）
    if (t.cx !== this.cx || t.cy !== this.cy) {
      const ox = this.root.x,
        oy = this.root.y;
      this.cx = t.cx;
      this.cy = t.cy;
      const nx = (t.cx + 0.5) * CELL,
        ny = (t.cy + 0.5) * CELL;
      ctx.fx.dust(ox, oy + 10, 22);
      ctx.scene.tweens.add({
        targets: this.root,
        x: nx,
        y: ny,
        duration: 320,
        ease: 'Cubic.InOut',
        onComplete: () => ctx.fx.dust(nx, ny + 10, 22),
      });
      this.root.setDepth(DEPTH.tower + t.cy * 0.01);
    }
    // 炮台
    const turret = this.parts.get('turret');
    if (turret) {
      const d = wrapAngle(t.angle - this.angle);
      const step = TURN_RATE * ctx.rdt;
      this.angle = Math.abs(d) <= step ? t.angle : this.angle + Math.sign(d) * step;
      turret.rotation = this.angle + Math.PI / 2;
      if (this.recoil > 0) this.recoil = Math.max(0, this.recoil - ctx.rdt);
      const k = this.recoil / RECOIL_T;
      turret.x = -Math.cos(this.angle) * 2 * k;
      turret.y = -Math.sin(this.angle) * 2 * k;
    }
    // 光效
    const glow = this.parts.get('glow');
    if (glow && glow.visible) {
      if (t.tier === 4) {
        glow.rotation += 0.5 * ctx.vdt;
        glow.setAlpha(0.75 + 0.25 * Math.sin(ctx.vtime * 2 + this.phase));
      } else {
        glow.setAlpha(0.5 + 0.2 * Math.sin((ctx.vtime * Math.PI * 2) / 2 + this.phase));
      }
    }
    // T4 漂浮粒子
    if (t.tier === 4 && t.id !== 'wall' && ctx.quality === 'high' && ctx.vdt > 0) {
      this.moteT -= ctx.vdt;
      if (this.moteT <= 0) {
        this.moteT = 0.25 + Math.random() * 0.3;
        const col = t.branch === 'B' ? C.magenta : C.cyan;
        const ang = Math.random() * Math.PI * 2;
        ctx.fx.mote(this.root.x + Math.cos(ang) * 18, this.root.y + Math.sin(ang) * 14, col, -14 - Math.random() * 10, 1.1, 1.8);
      }
    }
    // 瘫痪着色
    const dis = t.disabledUntil > now;
    if (dis !== this.disabled && !this.evolving) {
      this.disabled = dis;
      this.parts.tint(dis ? 0xa7856a : null);
    }
  }

  fire(): void {
    this.recoil = RECOIL_T;
    const turret = this.parts.get('turret');
    if (!turret) return;
    // 炮口位置：素材炮口在 (64,16) 附近 → 距中心约 48 单位
    const r = 48 * this.parts.unit;
    this.ctx.fx.disc(this.root.x + Math.cos(this.angle) * r, this.root.y + Math.sin(this.angle) * r, 3.5, 0xffffff, 0.08, true);
  }

  destroy(): void {
    this.ctx.scene.tweens.killTweensOf(this.root);
    this.parts.destroy();
    this.root.destroy();
  }
}

/** 塔视图管理 + 塔上层叠加（等级点、组合连线、瘫痪污渍、选中光圈） */
export class TowerLayer {
  private views = new Map<number, TowerView>();
  private g: Phaser.GameObjects.Graphics;
  private first = true;
  private seen = new Set<number>();

  constructor(private ctx: RenderCtx) {
    this.g = ctx.scene.add.graphics().setDepth(DEPTH.tower + 0.9);
  }

  get(uid: number): TowerView | undefined {
    return this.views.get(uid);
  }

  sync(): void {
    const ctx = this.ctx;
    if (!ctx.atlas.ready) return;
    const st = ctx.session.world.state;
    const now = st.time;
    this.seen.clear();
    for (const t of st.towers.values()) {
      this.seen.add(t.uid);
      let v = this.views.get(t.uid);
      if (!v) {
        v = new TowerView(ctx, t);
        this.views.set(t.uid, v);
        if (!this.first) v.pop();
      }
      v.update(t, now);
    }
    for (const [uid, v] of this.views) {
      if (!this.seen.has(uid)) {
        v.destroy();
        this.views.delete(uid);
      }
    }
    this.first = false;
    this.drawOverlay();
  }

  setQuality(): void {
    for (const v of this.views.values()) v.applyQuality();
  }

  onFire(uid: number): void {
    this.views.get(uid)?.fire();
  }

  private drawOverlay(): void {
    const g = this.g;
    g.clear();
    const st = this.ctx.session.world.state;
    const now = st.time;
    const sel = ui.state.selected;
    for (const t of st.towers.values()) {
      const v = this.views.get(t.uid);
      if (!v) continue;
      const x = v.root.x,
        y = v.root.y;
      // 组合连线（每对只画一次）
      for (const o of t.comboWith) {
        if (o < t.uid) continue;
        const ot = st.towers.get(o);
        const ov = this.views.get(o);
        if (!ot || !ov) continue;
        const off = (this.ctx.vtime * 18) % 9;
        dashed(g, x, y, ov.root.x, ov.root.y, C.ink, 5, 5, 4, off, 0.8);
        dashed(g, x, y, ov.root.x, ov.root.y, C.goldLight, 2.5, 5, 4, off, 1);
      }
      // 瘫痪：棕色咖啡渍
      if (t.disabledUntil > now) {
        const a = Math.min(1, (t.disabledUntil - now) / 0.4);
        g.fillStyle(C.coffee, 0.5 * a);
        g.fillCircle(x - 4, y + 2, 16);
        g.fillCircle(x + 9, y - 6, 9);
        g.fillCircle(x + 6, y + 12, 6);
        g.fillStyle(C.coffee, 0.7 * a);
        g.fillCircle(x - 15, y - 12, 3);
        g.fillCircle(x + 17, y + 6, 2.5);
      }
      // 等级圆点
      if (t.id !== 'wall' && t.tier < 4) {
        const n = Math.max(1, Math.min(3, t.level - (t.tier - 1) * 3));
        const col = t.tier === 1 ? C.paper : t.tier === 2 ? C.teal : C.goldLight;
        const by = y + CELL / 2 - 5;
        for (let i = 0; i < n; i++) {
          const dx = x + (i - (n - 1) / 2) * 7;
          g.fillStyle(C.ink, 1);
          g.fillCircle(dx, by, 3.2);
          g.fillStyle(col, 1);
          g.fillCircle(dx, by, 2);
        }
      } else if (t.tier === 4 && t.id !== 'wall') {
        // 传奇：一颗分支色的小星
        const col = t.branch === 'B' ? C.magenta : C.cyan;
        star5(g, x + CELL / 2 - 7, y + CELL / 2 - 7, 4.5, col);
      }
      // 选中光圈
      if (sel === t.uid) {
        const pulse = 0.6 + 0.4 * Math.sin(this.ctx.vtime * 6 + 1);
        g.lineStyle(2.5, C.white, 0.9 * pulse);
        g.strokeRoundedRect(x - CELL / 2 + 2, y - CELL / 2 + 2, CELL - 4, CELL - 4, 8);
        g.lineStyle(1.5, TOWER_COLOR[t.id], 0.9);
        g.strokeRoundedRect(x - CELL / 2 + 4.5, y - CELL / 2 + 4.5, CELL - 9, CELL - 9, 6);
      }
    }
  }

  destroy(): void {
    for (const v of this.views.values()) v.destroy();
    this.views.clear();
    this.g.destroy();
  }
}

export function dashed(
  g: Phaser.GameObjects.Graphics,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: number,
  width: number,
  dash: number,
  gap: number,
  offset = 0,
  alpha = 0.95,
): void {
  const dx = x1 - x0,
    dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 0.01) return;
  const ux = dx / len,
    uy = dy / len;
  g.lineStyle(width, color, alpha);
  let s = -offset;
  while (s < len) {
    const a = Math.max(0, s),
      b = Math.min(len, s + dash);
    if (b > a) g.lineBetween(x0 + ux * a, y0 + uy * a, x0 + ux * b, y0 + uy * b);
    s += dash + gap;
  }
}

function star5(g: Phaser.GameObjects.Graphics, x: number, y: number, r: number, color: number): void {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 === 0 ? r : r * 0.45;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push({ x: x + Math.cos(a) * rr, y: y + Math.sin(a) * rr });
  }
  g.fillStyle(color, 1);
  g.fillPoints(pts, true);
  g.lineStyle(1.2, C.ink, 1);
  g.strokePoints(pts, true);
}
