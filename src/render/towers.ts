import Phaser from 'phaser';
import type { TowerState } from '../core/types';
import { ui } from '../game/UiStore';
import { hasArt } from './assets';
import type { RenderCtx } from './ctx';
import { CELL, DEPTH } from './layout';
import { C, TOWER_COLOR } from './palette';
import { PartSet } from './parts';

const TURN_RATE = Math.PI * 4; // 720°/s
const RECOIL_T = 0.06;

export function towerAsset(t: Pick<TowerState, 'id' | 'tier' | 'branch' | 'level'>): string {
  // 墙：core 约定 tier 即墙的等级（1–3）
  if (t.id === 'wall') return `towers/wall_l${Math.max(1, Math.min(3, t.tier || t.level))}`;
  const b = t.branch === 'B' ? 'b' : 'a';
  if (t.tier >= 5) {
    // 神话（文档 11）：素材可能晚到，缺失时回退到传奇 T4
    const a5 = `towers/${t.id}_t5${b}`;
    if (hasArt(a5)) return a5;
    return `towers/${t.id}_t4${b}`;
  }
  const tier = t.tier === 4 ? `t4${b}` : `t${t.tier}`;
  return `towers/${t.id}_${tier}`;
}

/** 分支色：A 青、B 品红 */
export function branchColor(branch: TowerState['branch']): number {
  return branch === 'B' ? C.magenta : C.cyan;
}

/** 神话塔的主动能力是否就绪（充能制看 abilityCharges） */
export function abilityReady(t: TowerState): boolean {
  if (t.id === 'wall' || (t.stars ?? 0) < 3) return false;
  if (t.abilityCharges !== undefined) return t.abilityCharges > 0;
  return (t.abilityCd ?? 0) <= 0;
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
  /** 当前着色（null = 原色）：瘫痪 / 跳闸 */
  tintState: number | null = null;
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
    this.tintState = -1; // 换绑后重新着色
  }

  pop(): void {
    this.root.setScale(0.6);
    this.ctx.scene.tweens.add({ targets: this.root, scale: 1, duration: 200, ease: 'Back.Out', easeParams: [3] });
  }

  evolve(t: TowerState): void {
    if (this.evolving) return;
    this.evolving = true;
    const sc = this.ctx.scene;
    const mythic = t.tier >= 5;
    this.parts.tintFill(true, 0xffffff);
    sc.tweens.add({
      targets: this.root,
      scale: mythic ? 0.45 : 0.6,
      duration: mythic ? 260 : 130,
      ease: 'Quad.In',
      onComplete: () => {
        if (!this.root.active) return;
        this.bind(t);
        this.parts.tintFill(true, 0xffffff);
        this.tier = t.tier;
        const fx = this.ctx.fx;
        const x = this.root.x,
          y = this.root.y;
        const low = this.ctx.quality === 'low';
        if (mythic) {
          // 神话：金色纸屑炸开 + 冲击波
          fx.confetti(x, y - 6, low ? 12 : 26);
          fx.shatter(x, y, C.goldLight, low ? 6 : 12, 5);
          fx.disc(x, y, 30, C.goldLight, 0.25, true, 0.9);
          fx.ring(x, y, 8, 90, C.gold, 0.55, 6);
          fx.ring(x, y, 8, 60, branchColor(t.branch), 0.5, 4, true, 0.08);
          fx.ring(x, y, 8, 130, C.goldLight, 0.7, 3, false, 0.16);
          const cam = sc.cameras.main;
          cam.shake(220, (0.1 * CELL) / Math.max(1, cam.width * cam.zoom));
        } else {
          fx.confetti(x, y - 6, low ? 8 : 16);
          fx.ring(x, y, 8, 34, t.tier === 4 ? branchColor(t.branch) : t.tier === 3 ? C.gold : C.teal, 0.45, 4);
        }
        sc.time.delayedCall(mythic ? 120 : 70, () => this.root.active && this.parts.tintFill(false));
        sc.tweens.add({
          targets: this.root,
          scale: 1,
          duration: mythic ? 420 : 260,
          ease: 'Back.Out',
          easeParams: [mythic ? 4 : 3],
          onComplete: () => {
            this.evolving = false;
            this.tintState = -1; // 强制重新应用着色
          },
        });
      },
    });
  }

  /** 释放能力：塔身一抖 + 能力图标浮起 */
  cast(t: TowerState): void {
    const sc = this.ctx.scene;
    if (!this.evolving) {
      sc.tweens.killTweensOf(this.root);
      this.root.setScale(1.18);
      sc.tweens.add({ targets: this.root, scale: 1, duration: 260, ease: 'Back.Out', easeParams: [3] });
    }
    const f = this.ctx.atlas.frame(`abilities/${t.id}_${t.branch === 'B' ? 'b' : 'a'}`, 'static0');
    if (!f) return;
    const img = sc.add.image(this.root.x, this.root.y - 20, f.key, f.frame).setDepth(DEPTH.text - 1);
    img.setDisplaySize(26, 26).setAlpha(0);
    const s0 = img.scaleX;
    sc.tweens.add({
      targets: img,
      y: this.root.y - 46,
      alpha: { from: 1, to: 0 },
      scale: { from: s0 * 0.6, to: s0 * 1.15 },
      duration: 900,
      ease: 'Cubic.Out',
      onComplete: () => img.destroy(),
    });
  }

  update(t: TowerState, now: number, lampsOut: boolean): void {
    const ctx = this.ctx;
    // 资源变化（换形态 / 墙升级 / 图集重建）；神话素材缺失时 asset 不变但 tier 变化，同样播放进化
    const a = towerAsset(t);
    if (!this.evolving) {
      if (a !== this.asset || (t.tier !== this.tier && t.id !== 'wall')) {
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
      if (t.tier >= 4) {
        glow.rotation += (t.tier >= 5 ? 0.8 : 0.5) * ctx.vdt;
        glow.setAlpha(0.75 + 0.25 * Math.sin(ctx.vtime * 2 + this.phase));
      } else {
        glow.setAlpha(0.5 + 0.2 * Math.sin((ctx.vtime * Math.PI * 2) / 2 + this.phase));
      }
    }
    // T4 / 神话 漂浮粒子（星级越高越多）
    if (t.tier >= 4 && t.id !== 'wall' && ctx.quality === 'high' && ctx.vdt > 0) {
      this.moteT -= ctx.vdt;
      if (this.moteT <= 0) {
        const st = t.stars ?? 0;
        this.moteT = (0.25 + Math.random() * 0.3) / (1 + st * 0.35);
        const col = (t.tier >= 5 || st >= 2) && Math.random() < 0.4 ? C.goldLight : branchColor(t.branch);
        const ang = Math.random() * Math.PI * 2;
        ctx.fx.mote(this.root.x + Math.cos(ang) * 18, this.root.y + Math.sin(ang) * 14, col, -14 - Math.random() * 10, 1.1, 1.8);
      }
    }
    // 瘫痪 / 台灯跳闸着色
    const out = lampsOut && t.id === 'lamp';
    const want = t.disabledUntil > now ? 0xa7856a : out ? 0x6e6e82 : null;
    if (want !== this.tintState && !this.evolving) {
      this.tintState = want;
      this.parts.tint(want);
      if (glow) glow.setVisible(this.ctx.quality === 'high' && !out);
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
interface StarFlight {
  uid: number;
  /** 第几颗星（0 起） */
  idx: number;
  t: number;
}

interface TowerBuff {
  until: number; // state.time
  color: number;
  kind: 'aura' | 'spin' | 'rainbow';
}

const STAR_FLY = 0.7;
const RAINBOW = [C.alarmRed, C.pencil, C.screen, C.blueCap, C.magenta];

export class TowerLayer {
  private views = new Map<number, TowerView>();
  private g: Phaser.GameObjects.Graphics;
  private first = true;
  private seen = new Set<number>();
  private flights: StarFlight[] = [];
  private buffs = new Map<number, TowerBuff>();

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
    let lampsOut = false;
    if (st.events) for (const e of st.events) if (e.id === 'lamp_outage' && e.phase === 'active' && e.endsAt > now) lampsOut = true;
    this.seen.clear();
    for (const t of st.towers.values()) {
      this.seen.add(t.uid);
      let v = this.views.get(t.uid);
      if (!v) {
        v = new TowerView(ctx, t);
        this.views.set(t.uid, v);
        if (!this.first) v.pop();
      }
      v.update(t, now, lampsOut);
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

  /** 升星：金星从塔身飞出落到底座（神话的变身由 tier 变化触发） */
  onEvolve(uid: number, stars: number, mythic: boolean): void {
    const v = this.views.get(uid);
    if (!v) return;
    const idx = Math.max(0, Math.min(2, stars - 1));
    this.flights.push({ uid, idx, t: mythic ? -0.45 : 0 });
    this.ctx.fx.sparkle(v.root.x, v.root.y - 10, C.goldLight, 8, 26);
    this.ctx.fx.text(v.root.x, v.root.y - 22, mythic ? '神话!' : `★${stars}`, 'level');
  }

  /** 神话能力释放：塔身反馈 + 持续型能力的光环 */
  onAbility(uid: number, buff?: { dur: number; color: number; kind: TowerBuff['kind'] }): void {
    const t = this.ctx.session.world.state.towers.get(uid);
    const v = this.views.get(uid);
    if (!t || !v) return;
    v.cast(t);
    if (buff) this.buffs.set(uid, { until: this.ctx.session.world.state.time + buff.dur, color: buff.color, kind: buff.kind });
  }

  /** 塔被推走（书本倒下等）：起点扬尘（滑动由位置变化处理） */
  onMoved(uid: number, fromX: number, fromY: number): void {
    this.ctx.fx.dust((fromX + 0.5) * CELL, (fromY + 0.5) * CELL + 10, 22, C.paper);
    void uid;
  }

  /** 塔视图的显示位置 */
  pos(uid: number): { x: number; y: number } | null {
    const v = this.views.get(uid);
    return v ? { x: v.root.x, y: v.root.y } : null;
  }

  private pipPos(x: number, y: number, n: number, i: number): { x: number; y: number } {
    return { x: x + (i - (n - 1) / 2) * 9, y: y + CELL / 2 - 6 };
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
      } else if (t.tier >= 4 && t.id !== 'wall') {
        const stars = t.stars ?? 0;
        if (stars <= 0) {
          // 传奇：一颗分支色的小星
          star5(g, x + CELL / 2 - 7, y + CELL / 2 - 7, 4.5, branchColor(t.branch));
        } else {
          // 进化星级：底座下 1–3 颗金星（正在飞的那颗先不画）
          let flying = -1;
          for (const f of this.flights) if (f.uid === t.uid) flying = Math.max(flying, f.idx);
          for (let i = 0; i < stars; i++) {
            if (i === flying) continue;
            const p = this.pipPos(x, y, stars, i);
            star5(g, p.x, p.y, 4.6, C.goldLight, branchColor(t.branch));
          }
        }
        // 神话：一圈缓慢旋转的金色虚线光环
        if (t.tier >= 5) {
          const rot = this.ctx.vtime * 0.6 + t.uid;
          const n = 12;
          g.lineStyle(1.8, C.gold, 0.55);
          for (let i = 0; i < n; i++) {
            const a0 = rot + (i / n) * Math.PI * 2;
            g.beginPath();
            g.arc(x, y, CELL * 0.56, a0, a0 + (Math.PI / n) * 0.9, false);
            g.strokePath();
          }
        }
        // 主动能力就绪：分支色脉动光圈 + 两颗绕行的光点
        if (abilityReady(t)) {
          const aim = ui.state.abilityAiming === t.uid;
          const pulse = 0.5 + 0.5 * Math.sin(this.ctx.vtime * 4 + t.uid);
          const col = branchColor(t.branch);
          g.lineStyle(aim ? 3.5 : 2.5, col, (aim ? 0.75 : 0.45) + 0.3 * pulse);
          g.strokeCircle(x, y, CELL * 0.5 + pulse * 2);
          const ra = this.ctx.vtime * 2.4 + t.uid;
          for (let k = 0; k < 2; k++) {
            const a = ra + k * Math.PI;
            g.fillStyle(C.goldLight, 0.9);
            g.fillCircle(x + Math.cos(a) * CELL * 0.5, y + Math.sin(a) * CELL * 0.5, 2.6);
          }
        }
      }
      // 持续型能力的光环
      const bf = this.buffs.get(t.uid);
      if (bf) {
        const left = bf.until - now;
        if (left <= 0) this.buffs.delete(t.uid);
        else {
          const k = Math.min(1, left / 0.5);
          const rot = this.ctx.vtime * (bf.kind === 'spin' ? 6 : 1.5);
          const R = CELL * (bf.kind === 'spin' ? 0.9 : 0.62);
          g.fillStyle(bf.color, 0.1 * k);
          g.fillCircle(x, y, R);
          const n = bf.kind === 'spin' ? 3 : 8;
          for (let i = 0; i < n; i++) {
            const a0 = rot + (i / n) * Math.PI * 2;
            const col = bf.kind === 'rainbow' ? RAINBOW[i % RAINBOW.length] : bf.color;
            g.lineStyle(bf.kind === 'spin' ? 4 : 2.5, col, 0.8 * k);
            g.beginPath();
            g.arc(x, y, R, a0, a0 + (Math.PI / n) * (bf.kind === 'spin' ? 1.2 : 0.8), false);
            g.strokePath();
          }
        }
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
    // 飞行中的金星：从塔顶弹出，划一道弧线落到底座
    for (let i = this.flights.length - 1; i >= 0; i--) {
      const f = this.flights[i];
      f.t += this.ctx.rdt;
      const t = st.towers.get(f.uid);
      const v = this.views.get(f.uid);
      if (!t || !v || f.t >= STAR_FLY) {
        if (t && v) {
          const p = this.pipPos(v.root.x, v.root.y, Math.max(1, t.stars ?? 1), f.idx);
          this.ctx.fx.sparkle(p.x, p.y, C.goldLight, 4, 10);
          this.ctx.fx.ring(p.x, p.y, 2, 12, C.goldLight, 0.3, 2);
        }
        this.flights.splice(i, 1);
        continue;
      }
      if (f.t < 0) continue;
      const p = f.t / STAR_FLY;
      const x0 = v.root.x,
        y0 = v.root.y - 16;
      const end = this.pipPos(v.root.x, v.root.y, Math.max(1, t.stars ?? 1), f.idx);
      const sx = x0 + (end.x - x0) * p + Math.sin(p * Math.PI) * 14;
      const sy = y0 + (end.y - y0) * p - Math.sin(p * Math.PI) * 34;
      const r = 4.6 * (1 + (1 - p) * 1.4);
      star5(g, sx, sy, r, C.goldLight, branchColor(t.branch), this.ctx.vtime * 10);
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

export function star5(g: Phaser.GameObjects.Graphics, x: number, y: number, r: number, color: number, outline: number = C.ink, rot = 0): void {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 === 0 ? r : r * 0.45;
    const a = -Math.PI / 2 + rot + (i * Math.PI) / 5;
    pts.push({ x: x + Math.cos(a) * rr, y: y + Math.sin(a) * rr });
  }
  g.fillStyle(color, 1);
  g.fillPoints(pts, true);
  g.lineStyle(1.2, C.ink, 1);
  g.strokePoints(pts, true);
  if (outline !== C.ink) {
    g.lineStyle(0.8, outline, 0.9);
    g.strokePoints(pts, true);
  }
}
