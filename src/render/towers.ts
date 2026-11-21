import Phaser from 'phaser';
import { t } from '../i18n';
import type { TowerState } from '../core/types';
import { ui } from '../game/UiStore';
import { hasArt } from './assets';
import type { RenderCtx } from './ctx';
import { CELL, DEPTH } from './layout';
import { springCos, springSin } from './motion';
import { LAMP } from '../config/towers';
import { C, FONT, TOWER_COLOR } from './palette';
import { PartSet } from './parts';
import { TEX } from './sprites';

const TURN_RATE = Math.PI * 4; // 720°/s
const POP_T = 0.34;
/** 落地瞬间在 pop 时间轴上的位置（之前是下落拉长，之后是压扁回弹） */
const POP_LAND = 0.22;
const MOVE_T = 0.32;

/** 开火动作的输出（模块级复用，避免分配） */
const F = { kick: 0, sx: 1, sy: 1, rot: 0, bsx: 1, bsy: 1, glow: 1 };
const FIRE_DUR: Partial<Record<TowerState['id'], number>> = { pencil: 0.2, stapler: 0.26, lamp: 0.18, compass: 0.3, ruler: 0.24, glue: 0.28, eraser: 0.26, pen: 0.22 };

/**
 * 各塔的开火曲线，p ∈ [0,1)。core 只在开火瞬间发事件，所以「预备」压缩在最前面 10% 左右：
 * 先微微前探 / 蓄力，再后坐，最后带一点过冲地弹回。
 */
function fireCurve(id: TowerState['id'], p: number, reduced: boolean): void {
  F.kick = 0;
  F.sx = 1;
  F.sy = 1;
  F.rot = 0;
  F.bsx = 1;
  F.bsy = 1;
  F.glow = 1;
  const ant = 0.1;
  const q = p < ant ? 0 : (p - ant) / (1 - ant);
  const pre = p < ant ? p / ant : 0;
  if (reduced) {
    // 减弱动效：只保留一次很短的后坐
    F.kick = -2 * (1 - p);
    return;
  }
  switch (id) {
    case 'pencil': // 铅笔：干脆的一踢
      F.kick = p < ant ? pre * 0.8 : -4 * springCos(q, 9, 5);
      break;
    case 'stapler': // 订书机：往下一压
      if (p < ant) F.sy = 1 + pre * 0.05;
      else {
        const w = springCos(q, 8, 5);
        F.sy = 1 - 0.2 * w;
        F.sx = 1 + 0.1 * w;
        F.bsy = 1 - 0.06 * w;
        F.bsx = 1 + 0.04 * w;
        F.kick = -1.5 * w;
      }
      break;
    case 'lamp': // 台灯：灯头一闪一抖
      F.glow = Math.sin(p * 44) > 0 ? 1.5 : 0.75;
      F.sx = F.sy = 1 + 0.07 * springCos(p, 10, 4);
      break;
    case 'compass': // 圆规：甩一整圈
      F.rot = Math.PI * 2 * (1 - (1 - p) * (1 - p) * (1 - p));
      break;
    case 'ruler': // 尺子：后引再横扫
      F.rot = p < 0.2 ? -0.3 * (p / 0.2) : p < 0.45 ? -0.3 + 0.7 * ((p - 0.2) / 0.25) : 0.4 * (1 - (p - 0.45) / 0.55);
      break;
    case 'glue': // 胶水：瓶身一挤
      if (p >= ant) {
        const w = springCos(q, 8, 5);
        F.sx = 1 + 0.16 * w;
        F.sy = 1 - 0.14 * w;
        F.kick = -1 * w;
      }
      break;
    case 'eraser':
      F.kick = p < ant ? pre : -3 * springCos(q, 7, 4);
      break;
    case 'pen': // 钢笔：手腕一抖
      F.rot = 0.18 * springSin(p, 14, 5);
      F.kick = -2 * springCos(p, 9, 5);
      break;
    default:
      F.kick = -2.5 * springCos(p, 9, 5);
  }
}
/** 苍蝇拍挥拍：蓄力 → 拍下 → 回位（秒，按游戏速度） */
const SWING_T = 0.26;
const SWING_BACK = 0.75; // 蓄力时拍子后摆的角度（弧度）
const SWING_OVER = 0.15; // 拍下后的过冲

/** 挥拍角度偏移：p ∈ [0,1] */
function swingOffset(p: number): number {
  if (p < 0.3) {
    const q = p / 0.3;
    return -SWING_BACK * (1 - (1 - q) * (1 - q));
  }
  if (p < 0.5) {
    const q = (p - 0.3) / 0.2;
    return -SWING_BACK + (SWING_BACK + SWING_OVER) * q * q;
  }
  return SWING_OVER * (1 - (p - 0.5) / 0.5);
}

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
  id: TowerState['id'];
  root: Phaser.GameObjects.Container;
  /** 塔身（压扁 / 拉伸 / 跳起都作用在这一层；root 只管位置与整体缩放） */
  body: Phaser.GameObjects.Container;
  parts: PartSet;
  asset = '';
  tier = 1;
  cx: number;
  cy: number;
  angle: number;
  /** 开火动作进度（秒）；<0 = 没有 */
  fireT = -1;
  /** 落地弹跳进度（秒） */
  popT = -1;
  /** 搬家跳跃进度（秒） */
  moveT = -1;
  /** 进化：预备压扁（swapped=false）→ 换形态后弹出（swapped=true） */
  evoT = -1;
  private evoSwapped = false;
  private evoMythic = false;
  private auraGlow: Phaser.GameObjects.Image | null = null;
  private auraRing: Phaser.GameObjects.Image | null = null;
  private auraIn: Phaser.GameObjects.Image | null = null;
  evolving = false;
  /** 当前着色（null = 原色）：瘫痪 / 跳闸 */
  tintState: number | null = null;
  moteT = Math.random();
  phase = Math.random() * Math.PI * 2;
  /** 苍蝇拍挥拍进度（秒）；<0 表示未在挥拍 */
  swingT = -1;
  /** 挥拍开始时的瞄准角（残影起点） */
  swingFrom = 0;

  constructor(
    private ctx: RenderCtx,
    t: TowerState,
  ) {
    this.id = t.id;
    this.cx = t.cx;
    this.cy = t.cy;
    this.angle = t.angle;
    this.root = ctx.scene.add.container((t.cx + 0.5) * CELL, (t.cy + 0.5) * CELL);
    this.root.setDepth(DEPTH.tower + t.cy * 0.01);
    this.body = ctx.scene.add.container(0, 0);
    this.root.add(this.body);
    this.parts = new PartSet(ctx.scene, this.body);
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

  /** 放下：拉长落下 → 压扁 → 弹回 */
  pop(): void {
    this.popT = 0;
  }

  /** 只播放落地的压扁回弹（搬家落地、墙升级） */
  land(): void {
    this.popT = POP_T * POP_LAND;
  }

  evolve(t: TowerState): void {
    if (this.evolving) return;
    this.evolving = true;
    this.evoT = 0;
    this.evoSwapped = false;
    this.evoMythic = t.tier >= 5;
  }

  /** 进化的换形态瞬间：闪白、换素材、爆出纸屑 */
  private evoSwap(t: TowerState): void {
    const mythic = this.evoMythic;
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
      fx.shatter(x, y, C.goldLight, 12, 5);
      fx.disc(x, y, 34, C.white, 0.22, true, 0.95);
      fx.ring(x, y, 8, 90, C.gold, 0.55, 6);
      fx.ring(x, y, 8, 60, branchColor(t.branch), 0.5, 4, true, 0.08);
      fx.ring(x, y, 8, 130, C.goldLight, 0.7, 3, false, 0.16);
      fx.sparks(x, y, C.goldLight, 12, 0, Math.PI * 2, 170);
      this.ctx.cam.shake(320, 0.12);
      this.ctx.cam.flash(C.goldLight, 0.18, 300);
    } else {
      const col = t.tier === 4 ? branchColor(t.branch) : t.tier === 3 ? C.gold : C.teal;
      fx.confetti(x, y - 6, low ? 8 : 16);
      fx.disc(x, y, 22, C.white, 0.16, true, 0.9);
      fx.ring(x, y, 8, 36, col, 0.45, 4);
      fx.sparks(x, y, col, 6, 0, Math.PI * 2, 130);
    }
  }

  /** 神话光环：柔光 + 两圈反向慢转的虚线（都是 Image，批量绘制） */
  private aura(t: TowerState): void {
    const want = t.tier >= 5 && t.id !== 'wall';
    if (!want) {
      if (this.auraRing) {
        this.auraRing.setVisible(false);
        this.auraIn?.setVisible(false);
        this.auraGlow?.setVisible(false);
      }
      return;
    }
    const ctx = this.ctx;
    if (!this.auraRing) {
      const sc = ctx.scene;
      this.auraGlow = sc.add.image(0, 0, TEX.glow).setTint(C.goldLight).setBlendMode(Phaser.BlendModes.ADD);
      this.auraRing = sc.add.image(0, 0, TEX.dash).setTint(C.gold);
      this.auraIn = sc.add.image(0, 0, TEX.dash).setTint(branchColor(t.branch));
      this.root.addAt(this.auraGlow, 0);
      this.root.addAt(this.auraRing, 1);
      this.root.addAt(this.auraIn, 2);
    }
    const vt = ctx.vtime;
    const br = 0.5 + 0.5 * Math.sin(vt * 1.8 + this.phase);
    const high = ctx.quality === 'high';
    const spin = ctx.reduced ? 0 : vt;
    this.auraRing.setVisible(true).setDisplaySize(CELL * 1.16, CELL * 1.16).setRotation(spin * 0.6 + this.phase).setAlpha(0.6);
    this.auraIn!
      .setVisible(high)
      .setDisplaySize(CELL * (0.92 + 0.03 * br), CELL * (0.92 + 0.03 * br))
      .setRotation(-spin * 0.9)
      .setAlpha(0.3 + 0.15 * br);
    this.auraGlow!
      .setVisible(high)
      .setDisplaySize(CELL * (1.5 + 0.12 * br), CELL * (1.5 + 0.12 * br))
      .setAlpha(0.22 + 0.14 * br);
  }

  /** 出售：塔身折叠压扁后消失（硬币由事件特效飞起） */
  fold(): void {
    const sc = this.ctx.scene;
    sc.tweens.killTweensOf(this.root);
    sc.tweens.add({
      targets: this.body,
      scaleY: 0.05,
      scaleX: 1.25,
      y: CELL * 0.3,
      duration: this.ctx.reduced ? 90 : 190,
      ease: 'Back.In',
      onComplete: () => this.destroy(),
    });
    sc.tweens.add({ targets: this.root, alpha: 0, duration: 190, ease: 'Quad.In' });
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
          this.land();
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
      // 跳起 → 落到新位置 → 压扁回弹
      this.moveT = 0;
      ctx.scene.tweens.add({
        targets: this.root,
        x: nx,
        y: ny,
        duration: MOVE_T * 1000,
        ease: 'Cubic.InOut',
        onComplete: () => {
          ctx.fx.dust(nx, ny + 10, 22);
          ctx.fx.ring(nx, ny + 8, 5, 24, C.deskDark, 0.28, 2.5);
          this.land();
        },
      });
      this.root.setDepth(DEPTH.tower + t.cy * 0.01);
    }
    // 塔身形变：落地弹跳 / 搬家跳跃 / 进化 / 开火
    let bsx = 1,
      bsy = 1,
      bx = 0,
      by = 0;
    const red = ctx.reduced;
    if (this.popT >= 0) {
      this.popT += ctx.rdt;
      const p = this.popT / POP_T;
      if (p >= 1) this.popT = -1;
      else if (red) bsx = bsy = 0.8 + 0.2 * p;
      else if (p < POP_LAND) {
        // 下落：由小变大、竖向拉长
        const q = p / POP_LAND;
        const sc = 0.6 + 0.4 * q;
        bsx = sc * (1 - 0.14 * (1 - q));
        bsy = sc * (1 + 0.2 * (1 - q));
        by = -9 * (1 - q) * (1 - q);
      } else {
        // 着地：压扁再弹回（峰值约 1.12 倍宽）
        const w = springSin((p - POP_LAND) / (1 - POP_LAND), 12, 4.5);
        bsx = 1 + 0.2 * w;
        bsy = 1 - 0.2 * w;
      }
    }
    if (this.moveT >= 0) {
      this.moveT += ctx.rdt;
      const p = this.moveT / MOVE_T;
      if (p >= 1) this.moveT = -1;
      else if (!red) {
        const h = Math.sin(p * Math.PI);
        by -= h * 14;
        bsy *= 1 + 0.1 * h;
        bsx *= 1 - 0.06 * h;
      }
    }
    if (this.evoT >= 0) {
      this.evoT += ctx.rdt;
      const mythic = this.evoMythic;
      if (!this.evoSwapped) {
        // 预备：往下压、发白；神话压得更久并发抖
        const q = Math.min(1, this.evoT / (mythic ? 0.34 : 0.16));
        const e = q * q;
        if (!red) {
          bsx *= 1 + 0.2 * e;
          bsy *= 1 - 0.3 * e;
          if (mythic) bx = Math.sin(this.evoT * 70) * 1.6 * q;
        }
        if (q > 0.55 && this.tintState !== -2) {
          this.tintState = -2;
          this.parts.tintFill(true, 0xffffff);
        }
        if (q >= 1) {
          this.evoSwap(t);
          this.evoSwapped = true;
          this.evoT = 0;
        }
      } else {
        const p = this.evoT / (mythic ? 0.62 : 0.44);
        if (this.tintState === -2 && this.evoT > (mythic ? 0.12 : 0.07)) {
          this.parts.tintFill(false);
          this.tintState = -1;
        }
        if (p >= 1) {
          this.evoT = -1;
          this.evolving = false;
          this.tintState = -1; // 强制重新应用着色
          this.parts.tintFill(false);
        } else if (red) bsx = bsy = 0.85 + 0.15 * p;
        else {
          // 新形态弹出：从 0.55 倍冲过 1 再落稳，同时先高后宽地晃两下
          const sc = 1 - 0.45 * springCos(p, 13, 6);
          const j = springSin(p, 13, 5) * 0.14;
          bsx *= sc * (1 - j);
          bsy *= sc * (1 + j);
        }
      }
    }
    // 炮台
    const turret = this.parts.get('turret');
    let glowMul = 1;
    if (turret) {
      const d = wrapAngle(t.angle - this.angle);
      const step = TURN_RATE * ctx.rdt;
      this.angle = Math.abs(d) <= step ? t.angle : this.angle + Math.sign(d) * step;
      let swing = 0;
      if (this.swingT >= 0) {
        this.swingT += ctx.vdt;
        const p = this.swingT / SWING_T;
        if (p >= 1) {
          this.swingT = -1;
          this.parts.scaleRel(turret, 1, 1);
        } else {
          swing = swingOffset(p);
          // 拍下瞬间：拍面压扁一点（往桌面上「啪」）
          const hit = p > 0.42 && p < 0.72 ? Math.sin(((p - 0.42) / 0.3) * Math.PI) : 0;
          this.parts.scaleRel(turret, 1 + hit * 0.08, 1 - hit * 0.12);
        }
      }
      let kick = 0,
        frot = 0;
      if (this.fireT >= 0) {
        this.fireT += ctx.rdt;
        const p = this.fireT / (FIRE_DUR[this.id] ?? 0.18);
        if (p >= 1) {
          this.fireT = -1;
          this.parts.scaleRel(turret, 1, 1);
        } else {
          fireCurve(this.id, p, red);
          kick = F.kick;
          frot = F.rot;
          bsx *= F.bsx;
          bsy *= F.bsy;
          glowMul = F.glow;
          this.parts.scaleRel(turret, F.sx, F.sy);
        }
      }
      turret.rotation = this.angle + swing + frot + Math.PI / 2;
      turret.x = Math.cos(this.angle) * kick;
      turret.y = Math.sin(this.angle) * kick;
    }
    // 压扁时以底边为锚：变矮就往下贴
    this.body.setScale(bsx, bsy);
    this.body.setPosition(bx, by + (1 - bsy) * CELL * 0.32);
    this.aura(t);
    // 光效
    const glow = this.parts.get('glow');
    if (glow && glow.visible) {
      if (t.tier >= 4) {
        glow.rotation += (t.tier >= 5 ? 0.8 : 0.5) * ctx.vdt;
        glow.setAlpha(0.75 + 0.25 * Math.sin(ctx.vtime * 2 + this.phase));
      } else {
        glow.setAlpha(Math.min(1, (0.5 + 0.2 * Math.sin((ctx.vtime * Math.PI * 2) / 2 + this.phase)) * glowMul));
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
    if (want !== this.tintState && !this.evolving && this.tintState !== -2) {
      this.tintState = want;
      this.parts.tint(want);
      if (glow) glow.setVisible(this.ctx.quality === 'high' && !out);
    }
  }

  /** 苍蝇拍：开始一次挥拍（同一拍的 fire / swat 事件只触发一次） */
  swing(): void {
    if (this.swingT >= 0 && this.swingT < SWING_T * 0.45) return;
    this.swingT = 0;
    this.swingFrom = this.angle;
  }

  /** 挥拍的弧形残影（画在塔上层的 Graphics 里） */
  drawSmear(g: Phaser.GameObjects.Graphics): void {
    if (this.swingT < 0) return;
    const p = this.swingT / SWING_T;
    if (p < 0.3 || p > 0.8) return;
    const a = p < 0.5 ? 0.6 : 0.6 * (1 - (p - 0.5) / 0.3);
    const a0 = this.swingFrom - SWING_BACK;
    const a1 = this.swingFrom + wrapAngle(this.angle - this.swingFrom) + swingOffset(p);
    if (a1 - a0 < 0.05) return;
    // 拍面在素材里约 12–52 单位（距中心）；神话更大
    const u = this.parts.unit || CELL / 128;
    const big = this.tier >= 4 ? 1.12 : 1;
    const r0 = 14 * u * big,
      r1 = 54 * u * big;
    const x = this.root.x,
      y = this.root.y;
    g.fillStyle(C.white, a * 0.55);
    g.beginPath();
    g.arc(x, y, r1, a0, a1, false);
    g.arc(x, y, r0, a1, a0, true);
    g.closePath();
    g.fillPath();
    // 外沿的速度线
    g.lineStyle(2.5, C.swatter, a);
    g.beginPath();
    g.arc(x, y, r1, a0 + (a1 - a0) * 0.35, a1, false);
    g.strokePath();
    g.lineStyle(1.5, C.white, a * 0.9);
    g.beginPath();
    g.arc(x, y, (r0 + r1) / 2, a0 + (a1 - a0) * 0.55, a1, false);
    g.strokePath();
  }

  fire(): void {
    if (this.id === 'swatter') {
      this.swing();
      return;
    }
    this.fireT = 0;
    const turret = this.parts.get('turret');
    if (!turret) return;
    // 炮口位置：素材炮口在 (64,16) 附近 → 距中心约 48 单位
    const r = 48 * this.parts.unit;
    const fx = this.ctx.fx;
    const mx = this.root.x + Math.cos(this.angle) * r,
      my = this.root.y + Math.sin(this.angle) * r;
    const col = TOWER_COLOR[this.id];
    if (this.id === 'lamp') {
      // 台灯没有炮口火光：灯头亮一下
      fx.disc(mx, my, 9, C.lampLight, 0.12, true, 0.55);
      return;
    }
    // 炮口：叠加的白色闪光 + 两根顺着弹道的塔色火花
    fx.disc(mx, my, 5.5, 0xffffff, 0.09, true, 0.9);
    if (this.id !== 'compass' && this.id !== 'ruler') fx.sparks(mx, my, col, 2, this.angle, 0.8, 90);
  }

  destroy(): void {
    this.ctx.scene.tweens.killTweensOf(this.root);
    this.ctx.scene.tweens.killTweensOf(this.body);
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
const STAR_BOUNCE = 0.45;
const RAINBOW = [C.alarmRed, C.pencil, C.screen, C.blueCap, C.magenta];

export class TowerLayer {
  private views = new Map<number, TowerView>();
  private g: Phaser.GameObjects.Graphics;
  private first = true;
  private seen = new Set<number>();
  private flights: StarFlight[] = [];
  private buffs = new Map<number, TowerBuff>();
  /** 刚被出售的塔：视图移除时播放折叠动画 */
  private selling = new Set<number>();
  /** 台灯联动的汇聚计数（主灯旁的 ×倍率 · 座数），复用 */
  private prismTexts: Phaser.GameObjects.Text[] = [];
  private prismN = 0;

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
        if (this.selling.delete(uid)) v.fold();
        else v.destroy();
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

  /** 出售：下一次同步移除视图时折叠缩小 */
  onSell(uid: number): void {
    if (this.selling.size > 32) this.selling.clear();
    this.selling.add(uid);
  }

  /** 苍蝇拍拍击（swat 事件）：与 fire 去重后挥拍 */
  onSwing(uid: number): void {
    this.views.get(uid)?.swing();
  }

  /** 升星：金星从塔身飞出落到底座（神话的变身由 tier 变化触发） */
  onEvolve(uid: number, stars: number, mythic: boolean): void {
    const v = this.views.get(uid);
    if (!v) return;
    const idx = Math.max(0, Math.min(2, stars - 1));
    this.flights.push({ uid, idx, t: mythic ? -0.45 : 0 });
    this.ctx.fx.sparkle(v.root.x, v.root.y - 10, C.goldLight, 8, 26);
    this.ctx.fx.text(v.root.x, v.root.y - 22, mythic ? t('ui.render.mythic') : `★${stars}`, 'level');
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

  private drawPrism(g: Phaser.GameObjects.Graphics, t: TowerState, x: number, y: number): void {
    const st = this.ctx.session.world.state;
    const r2 = LAMP.link * LAMP.link + 1e-9;
    const relaying = !!t.prismLead;
    for (const o of st.towers.values()) {
      if (o.id !== 'lamp' || o.uid <= t.uid || o.prism !== t.prism) continue;
      if ((o.cx - t.cx) ** 2 + (o.cy - t.cy) ** 2 > r2) continue;
      const ov = this.views.get(o.uid);
      if (!ov) continue;
      const hot = relaying && o.prismLead === t.prismLead;
      g.lineStyle(hot ? 2 : 1.5, C.lampLight, hot ? 0.55 : 0.28);
      g.lineBetween(x, y, ov.root.x, ov.root.y);
    }
    if (t.prismLead !== t.uid || (t.prismRelay ?? 1) <= 1.001) return;
    // 主灯：棱镜高光 + 汇聚计数
    let n = 0;
    for (const o of st.towers.values()) if (o.id === 'lamp' && o.prismLead === t.uid) n++;
    const pulse = this.ctx.reduced ? 0.8 : 0.6 + 0.4 * Math.sin(this.ctx.vtime * 7 + t.uid);
    const d = 6 + Math.min(6, n);
    g.fillStyle(C.white, 0.75 * pulse);
    g.fillTriangle(x, y - CELL * 0.42 - d, x - d * 0.6, y - CELL * 0.42, x + d * 0.6, y - CELL * 0.42);
    g.fillStyle(C.lampLight, 0.9);
    g.fillTriangle(x, y - CELL * 0.42 - d * 0.6, x - d * 0.35, y - CELL * 0.42, x + d * 0.35, y - CELL * 0.42);
    let tx = this.prismTexts[this.prismN];
    if (!tx) {
      tx = this.ctx.scene.add.text(0, 0, '', { fontFamily: FONT, fontSize: '12px', fontStyle: 'bold', color: '#fff6c8', stroke: '#3a2a12', strokeThickness: 3 }).setOrigin(0, 0.5).setDepth(DEPTH.tower + 0.95);
      this.prismTexts.push(tx);
    }
    this.prismN++;
    const label = `×${(t.prismRelay ?? 1).toFixed(1)} · ${n}`;
    if (tx.text !== label) tx.setText(label);
    tx.setPosition(x + CELL * 0.32, y - CELL * 0.42).setVisible(true);
  }

  private drawOverlay(): void {
    const g = this.g;
    g.clear();
    this.prismN = 0;
    const st = this.ctx.session.world.state;
    const now = st.time;
    const sel = ui.state.selected;
    for (const t of st.towers.values()) {
      const v = this.views.get(t.uid);
      if (!v) continue;
      const x = v.root.x,
        y = v.root.y;
      if (v.swingT >= 0) v.drawSmear(g);
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
      // 台灯联动：组内相邻台灯之间的细光线；汇聚中的主灯旁显示 ×倍率 · 座数
      if (t.id === 'lamp' && t.prism) this.drawPrism(g, t, x, y);
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
        // 神话光环改由 TowerView.aura 的 Image 绘制（不再每帧细分圆弧）
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
    for (let i = this.prismN; i < this.prismTexts.length; i++) if (this.prismTexts[i].visible) this.prismTexts[i].setVisible(false);
    // 飞行中的金星：从塔顶弹出，划一道弧线落到底座
    for (let i = this.flights.length - 1; i >= 0; i--) {
      const f = this.flights[i];
      f.t += this.ctx.rdt;
      const t = st.towers.get(f.uid);
      const v = this.views.get(f.uid);
      if (!t || !v || f.t >= STAR_FLY + STAR_BOUNCE) {
        this.flights.splice(i, 1);
        continue;
      }
      if (f.t < 0) continue;
      if (f.t >= STAR_FLY) {
        // 落到底座：火花一次 + 弹两下
        const end = this.pipPos(v.root.x, v.root.y, Math.max(1, t.stars ?? 1), f.idx);
        if (f.t - this.ctx.rdt < STAR_FLY) {
          this.ctx.fx.sparkle(end.x, end.y, C.goldLight, 4, 10);
          this.ctx.fx.ring(end.x, end.y, 2, 14, C.goldLight, 0.3, 2);
        }
        const q = (f.t - STAR_FLY) / STAR_BOUNCE;
        const w = this.ctx.reduced ? 0 : springCos(q, 15, 5);
        star5(g, end.x, end.y - Math.abs(w) * 5, 4.6 * (1 + 0.45 * w), C.goldLight, branchColor(t.branch));
        continue;
      }
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
  const pts = STAR5_PTS;
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 === 0 ? r : r * 0.45;
    const a = -Math.PI / 2 + rot + (i * Math.PI) / 5;
    pts[i].x = x + Math.cos(a) * rr;
    pts[i].y = y + Math.sin(a) * rr;
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

const STAR5_PTS: { x: number; y: number }[] = [];
for (let i = 0; i < 10; i++) STAR5_PTS.push({ x: 0, y: 0 });
