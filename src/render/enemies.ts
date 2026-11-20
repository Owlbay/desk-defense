import Phaser from 'phaser';
import type { EnemyId, EnemyState } from '../core/types';
import type { RenderCtx } from './ctx';
import { CELL, DEPTH } from './layout';
import { C, FONT, hex } from './palette';
import { PartSet } from './parts';
import { TEX } from './sprites';

/** 有明确朝向的敌人（素材朝上），按移动方向旋转 */
const DIRECTIONAL = new Set<EnemyId>(['plane', 'moth', 'ant']);

export function enemyAsset(id: EnemyId): { asset: string; mul: number } {
  // 小纸屑复用橡皮屑素材，缩小 0.6
  if (id === 'crumbmini') return { asset: 'enemies/crumb', mul: 0.6 };
  // 小咖啡渍：core 已在 scale 里缩小（0.75），这里不再额外缩放
  if (id === 'boss_coffee_small') return { asset: 'enemies/boss_coffee', mul: 1 };
  return { asset: `enemies/${id}`, mul: 1 };
}

const INK_OFFS = [
  [-0.35, -0.1],
  [0.3, 0.15],
  [-0.05, 0.38],
  [0.2, -0.35],
  [-0.4, 0.3],
];

const UNDER_COUNT = 4;

/**
 * 一个敌人：容器内依次为 脚下标记(4) → 素材部件 → 头顶标记（墨点、血条、星星、眼睛、词缀、兵团数）。
 * 状态标记全部用小纹理 Image 绘制，便于 WebGL 批量提交。
 */
class EnemyView {
  root: Phaser.GameObjects.Container;
  parts: PartSet;
  uid = 0;
  id: EnemyId = 'crumb';
  mul = 1;
  prevX = 0;
  prevY = 0;
  curX = 0;
  curY = 0;
  x = 0; // 显示像素
  y = 0;
  lastTick = -1;
  phase = 0;
  flashUntil = 0;
  flashing = false;
  lastHitSeen = -1;
  rot = 0;
  badges: Phaser.GameObjects.Image[] = [];
  badgeKey = '';
  badgeGen = -1;
  label: Phaser.GameObjects.Text | null = null;
  labelN = 0;
  age = 0;
  lift = 0;
  fxT = 0;
  // 标记
  private eliteRing: Phaser.GameObjects.Image;
  private rootBlob: Phaser.GameObjects.Image;
  private slowFill: Phaser.GameObjects.Image;
  private slowRing: Phaser.GameObjects.Image;
  private markRing: Phaser.GameObjects.Image;
  private inks: Phaser.GameObjects.Image[] = [];
  private barBg: Phaser.GameObjects.Image;
  private barHp: Phaser.GameObjects.Image;
  private barSh: Phaser.GameObjects.Image;
  private stars: Phaser.GameObjects.Image[] = [];
  private eye: Phaser.GameObjects.Image;

  constructor(private ctx: RenderCtx) {
    const sc = ctx.scene;
    this.root = sc.add.container(0, 0);
    const img = (key: string, tint: number) => sc.add.image(0, 0, key).setTint(tint).setVisible(false);
    this.eliteRing = img(TEX.ring, C.white);
    this.rootBlob = img(TEX.disc, C.glue);
    this.slowFill = img(TEX.disc, C.blueCap).setAlpha(0.15);
    this.slowRing = img(TEX.ring, C.blueCap);
    this.root.add([this.eliteRing, this.rootBlob, this.slowFill, this.slowRing]);
    this.parts = new PartSet(sc, this.root, UNDER_COUNT);
    for (let i = 0; i < 5; i++) this.inks.push(img(TEX.disc, C.inkBlue));
    this.markRing = img(TEX.ring, C.alarmRed).setAlpha(0.7);
    this.barBg = img(TEX.px, C.ink).setOrigin(0, 0.5).setAlpha(0.85);
    this.barHp = img(TEX.px, C.bad).setOrigin(0, 0.5);
    this.barSh = img(TEX.px, C.cyan).setOrigin(0, 0.5);
    for (let i = 0; i < 3; i++) this.stars.push(img(TEX.star, C.goldLight));
    this.eye = sc.add.image(0, 0, TEX.eye).setVisible(false);
    this.root.add([...this.inks, this.markRing, this.barBg, this.barHp, this.barSh, ...this.stars, this.eye]);
  }

  reset(e: EnemyState, tick: number): void {
    this.uid = e.uid;
    this.id = e.id;
    const { asset, mul } = enemyAsset(e.id);
    this.mul = mul;
    this.parts.bind(this.ctx.atlas, asset, mul);
    this.prevX = this.curX = e.x;
    this.prevY = this.curY = e.y;
    this.lastTick = tick;
    this.phase = Math.random() * Math.PI * 2;
    this.flashUntil = 0;
    this.lastHitSeen = e.lastHit;
    this.rot = e.angle + Math.PI / 2;
    this.age = 0;
    this.lift = 0;
    this.root.setVisible(true).setActive(true).setAlpha(1).setScale(1);
    this.badgeKey = '';
    this.setBadges(e);
    this.setLabel(e);
    if (this.flashing) {
      this.parts.tintFill(false);
      this.flashing = false;
    }
    this.applyQuality();
  }

  applyQuality(): void {
    const glow = this.parts.get('glow');
    if (glow) glow.setVisible(this.ctx.quality === 'high');
  }

  private setBadges(e: EnemyState): void {
    const key = e.elite ? e.affixes.join(',') : '';
    if (key === this.badgeKey && this.ctx.atlas.gen === this.badgeGen) return;
    this.badgeKey = key;
    this.badgeGen = this.ctx.atlas.gen;
    for (const b of this.badges) b.destroy();
    this.badges = [];
    if (!key) return;
    for (const a of e.affixes) {
      const f = this.ctx.atlas.frame(`affixes/${a}`, 'static0');
      if (!f) continue;
      const img = this.ctx.scene.add.image(0, 0, f.key, f.frame);
      this.root.add(img);
      this.badges.push(img);
    }
  }

  private setLabel(e: EnemyState): void {
    if (e.group > 1) {
      if (!this.label) {
        this.label = this.ctx.scene.add
          .text(0, 0, '', { fontFamily: FONT, fontSize: '10px', fontStyle: 'bold', color: hex(C.paper), stroke: hex(C.ink), strokeThickness: 3 })
          .setOrigin(0, 0.5);
        this.label.setResolution(Math.min(4, this.ctx.zoom));
        this.root.add(this.label);
      }
      if (this.labelN !== e.group) {
        this.labelN = e.group;
        this.label.setText(`×${e.group}`);
      }
      this.label.setVisible(true);
    } else if (this.label && this.label.visible) {
      this.label.setVisible(false);
      this.labelN = 0;
    }
  }

  setResolution(r: number): void {
    this.label?.setResolution(r);
  }

  /** 身体半径（世界像素） */
  rpx(e: EnemyState): number {
    // core 的 radius 已含体型（精英、小咖啡渍等），不再乘 mul
    const r = e.radius > 0 ? e.radius * CELL : 0.3 * CELL * (e.scale || 1) * this.mul;
    return Math.max(6, r);
  }

  update(e: EnemyState, tick: number, now: number): void {
    const ctx = this.ctx;
    if (ctx.atlas.gen !== this.parts.gen) {
      const { asset, mul } = enemyAsset(e.id);
      this.parts.bind(ctx.atlas, asset, mul);
      this.applyQuality();
    }
    // 插值
    if (tick !== this.lastTick) {
      this.prevX = this.curX;
      this.prevY = this.curY;
      this.curX = e.x;
      this.curY = e.y;
      this.lastTick = tick;
      if (Math.abs(this.curX - this.prevX) + Math.abs(this.curY - this.prevY) > 2) {
        this.prevX = this.curX;
        this.prevY = this.curY;
      }
    }
    const a = ctx.alpha;
    this.x = (this.prevX + (this.curX - this.prevX) * a) * CELL;
    this.y = (this.prevY + (this.curY - this.prevY) * a) * CELL;
    this.root.setPosition(this.x, this.y);
    this.root.setDepth(e.flying ? DEPTH.air + this.y * 0.0001 : DEPTH.ground + this.y * 0.0001);

    // 缩放（精英 / 兵团 / Boss）；出生时弹出
    this.age += ctx.rdt;
    const born = this.age < 0.25 ? 0.5 + (this.age / 0.25) * 0.5 : 1;
    const s = (e.scale || 1) * born;
    this.root.setScale(s);

    // 行走动画
    const t = ctx.vtime + this.phase;
    const lift = e.flying ? 7 + Math.sin(t * 3) * 2 : e.jumping ? 10 : 0;
    this.lift += (lift - this.lift) * Math.min(1, ctx.rdt * 14);
    const stunned = e.stunUntil > now;
    const frozen = stunned || ctx.vdt === 0;
    const bob = e.flying || frozen ? 0 : -Math.abs(Math.sin(t * 7)) * 2;
    const sway = frozen ? 0 : e.flying ? Math.sin(t * 3) * 0.06 : Math.sin(t * 7) * ((4 * Math.PI) / 180);
    let rot = 0;
    if (DIRECTIONAL.has(e.id)) {
      const target = e.angle + Math.PI / 2;
      let d = target - this.rot;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.rot += d * Math.min(1, ctx.rdt * 10);
      rot = this.rot;
    }
    for (const [name, img] of this.parts.imgs) {
      if (name === 'shadow') {
        img.y = e.flying ? 4 : 0;
        const sh = e.flying || e.jumping ? 0.8 : 1;
        this.parts.scaleRel(img, sh, sh);
        img.setAlpha(e.flying ? 0.7 : 1);
        continue;
      }
      img.y = bob - this.lift;
      img.rotation = rot + sway;
      if (name === 'wing-l' || name === 'wing-r') {
        const f = stunned ? 1 : 0.55 + 0.45 * Math.abs(Math.cos((t * Math.PI) / 0.25));
        this.parts.scaleRel(img, f, 1);
      } else if (name === 'glow') {
        img.setAlpha(0.55 + 0.35 * Math.sin(t * 2.5));
      }
    }

    // 受击闪白（连续受击时留出间隔，避免一直是白色）
    if (e.lastHit !== this.lastHitSeen) {
      this.lastHitSeen = e.lastHit;
      if (ctx.vtime > this.flashUntil + 0.12) this.flashUntil = ctx.vtime + 0.08;
    }
    const fl = ctx.vtime < this.flashUntil;
    if (fl !== this.flashing) {
      this.flashing = fl;
      for (const [name, img] of this.parts.imgs) {
        if (name === 'shadow' || name === 'glow') continue;
        if (fl) img.setTintFill(0xffffff);
        else img.clearTint();
      }
    }

    // 隐形
    this.root.setAlpha(e.hidden ? 0.25 : 1);

    // 词缀图标 / 兵团标签
    if (e.elite || this.badges.length) this.setBadges(e);
    this.setLabel(e);
    this.status(e, now, s);

    // 持续效果粒子
    if (ctx.vdt > 0 && ctx.quality === 'high') {
      this.fxT -= ctx.vdt;
      if (this.fxT <= 0) {
        this.fxT = 0.18;
        if (e.burnUntil > now) ctx.fx.mote(this.x + (Math.random() - 0.5) * 10, this.y - 4, C.lamp, -26, 0.45, 2.2);
        if (e.bleedStacks > 0 && Math.random() < 0.5) ctx.fx.mote(this.x + (Math.random() - 0.5) * 8, this.y, C.bookRed, 18, 0.4, 1.6, false);
      }
    }
  }

  /** 状态标记（容器内坐标 = 世界像素 / s） */
  private status(e: EnemyState, now: number, s: number): void {
    const k = 1 / s;
    const r = this.rpx(e); // 世界像素
    const liftW = this.lift * s;
    const bodyY = -liftW * k;
    // 精英环
    if (e.elite) {
      this.eliteRing.setVisible(true).setPosition(0, r * 0.55 * k).setDisplaySize(r * 2.3 * k, r * 0.95 * k);
    } else this.eliteRing.setVisible(false);
    // 定身
    if (e.rootUntil > now) {
      this.rootBlob.setVisible(true).setPosition(0, r * 0.5 * k).setDisplaySize(r * 2.2 * k, r * 0.9 * k).setAlpha(0.85);
    } else this.rootBlob.setVisible(false);
    // 减速外圈
    if (e.slowUntil > now && e.slowPct > 0) {
      const d = (r + 3) * 2 * k;
      this.slowRing.setVisible(true).setPosition(0, bodyY).setDisplaySize(d, d);
      this.slowFill.setVisible(true).setPosition(0, bodyY).setDisplaySize(d, d);
    } else {
      this.slowRing.setVisible(false);
      this.slowFill.setVisible(false);
    }
    // 易伤标记
    if (e.markedUntil > now) {
      const d = (r + 6) * 2 * k;
      this.markRing.setVisible(true).setPosition(0, bodyY).setDisplaySize(d, d);
    } else this.markRing.setVisible(false);
    // 墨迹点
    const ink = Math.min(5, e.inkStacks | 0);
    for (let i = 0; i < 5; i++) {
      const im = this.inks[i];
      if (i < ink) {
        const d = (4.4 + (i % 2) * 1.2) * k;
        im.setVisible(true).setPosition(INK_OFFS[i][0] * r * k, bodyY + INK_OFFS[i][1] * r * k).setDisplaySize(d, d);
      } else if (im.visible) im.setVisible(false);
    }
    // 血条（宽为体型 1.1 倍，高 3px；护盾为青色段）
    const top = -(r + liftW); // 世界像素，相对中心
    const showBar = !e.hidden && (e.hp < e.maxHp || e.shield > 0 || e.elite || e.boss);
    let barTop = top;
    if (showBar) {
      const w = Math.max(18, r * 2 * 1.1);
      const h = e.boss ? 5 : 3;
      const by = top - 6 - h / 2;
      barTop = by - h / 2;
      const bx = -w / 2;
      this.barBg.setVisible(true).setPosition((bx - 1) * k, by * k).setDisplaySize((w + 2) * k, (h + 2) * k);
      const hpw = w * Phaser.Math.Clamp(e.hp / Math.max(1, e.maxHp), 0, 1);
      this.barHp.setVisible(hpw > 0).setPosition(bx * k, by * k).setDisplaySize(Math.max(0.01, hpw) * k, h * k);
      this.barHp.setTint(e.boss ? C.alarmRed : C.bad);
      if (e.shield > 0) {
        const sw = Math.min(w, (w * e.shield) / Math.max(1, e.maxHp));
        const sx = Math.min(bx + hpw, bx + w - sw);
        this.barSh.setVisible(true).setPosition(sx * k, by * k).setDisplaySize(sw * k, h * k);
      } else this.barSh.setVisible(false);
    } else {
      this.barBg.setVisible(false);
      this.barHp.setVisible(false);
      this.barSh.setVisible(false);
    }
    // 词缀图标排在血条上方，每个 10px
    const n = this.badges.length;
    if (n) {
      const yb = (barTop - 7) * k;
      for (let i = 0; i < n; i++) this.badges[i].setPosition((i - (n - 1) / 2) * 11 * k, yb).setDisplaySize(10 * k, 10 * k);
    }
    // 眩晕星星
    if (e.stunUntil > now) {
      const tt = this.ctx.vtime * 5 + this.phase;
      const yb = barTop - (n ? 16 : 4);
      for (let i = 0; i < 3; i++) {
        const a = tt + (i * Math.PI * 2) / 3;
        this.stars[i]
          .setVisible(true)
          .setPosition(Math.cos(a) * r * 0.8 * k, (yb + Math.sin(a) * 3) * k)
          .setDisplaySize(7 * k, 7 * k)
          .setRotation(tt);
      }
    } else if (this.stars[0].visible) for (const st of this.stars) st.setVisible(false);
    // 被侦测的隐形敌人：眼睛
    if (e.stealthy && !e.hidden) {
      this.eye.setVisible(true).setPosition(-r * 0.95 * k, (top - 1) * k).setDisplaySize(12 * k, 12 * k);
    } else this.eye.setVisible(false);
    if (this.label && this.label.visible) this.label.setPosition(r * 0.6 * k, r * 0.5 * k + bodyY).setScale(k);
  }

  release(): void {
    this.root.setVisible(false).setActive(false);
    if (this.flashing) {
      this.parts.tintFill(false);
      this.flashing = false;
    }
  }

  destroy(): void {
    this.parts.destroy();
    this.root.destroy(true);
  }
}

export class EnemyLayer {
  private views = new Map<number, EnemyView>();
  private pool: EnemyView[] = [];
  private seen = new Set<number>();

  constructor(private ctx: RenderCtx) {}

  /** 显示位置（像素），用于特效定位 */
  pos(uid: number): { x: number; y: number } | null {
    const v = this.views.get(uid);
    return v ? { x: v.x, y: v.y } : null;
  }

  setResolution(r: number): void {
    for (const v of this.views.values()) v.setResolution(r);
    for (const v of this.pool) v.setResolution(r);
  }

  setQuality(): void {
    for (const v of this.views.values()) v.applyQuality();
  }

  sync(): void {
    const ctx = this.ctx;
    if (!ctx.atlas.ready) return;
    const st = ctx.session.world.state;
    const tick = st.tick;
    const now = st.time;
    this.seen.clear();
    for (const e of st.enemies) {
      this.seen.add(e.uid);
      let v = this.views.get(e.uid);
      if (!v) {
        v = this.pool.pop() ?? new EnemyView(ctx);
        v.reset(e, tick);
        this.views.set(e.uid, v);
      }
      v.update(e, tick, now);
    }
    for (const [uid, v] of this.views) {
      if (!this.seen.has(uid)) {
        v.release();
        this.views.delete(uid);
        if (this.pool.length < 160) this.pool.push(v);
        else v.destroy();
      }
    }
  }

  destroy(): void {
    for (const v of this.views.values()) v.destroy();
    for (const v of this.pool) v.destroy();
    this.views.clear();
    this.pool = [];
  }
}
