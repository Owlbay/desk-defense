import Phaser from 'phaser';
import { t } from '../i18n';
import type { EnemyId, GameEvent, Obstacle, PickupState, RandomEventState, SpawnerState, WorldState } from '../core/types';
import { ui } from '../game/UiStore';
import { cellBounds, drawObstacle, obstacleKey } from './background';
import type { RenderCtx } from './ctx';
import { enemyAsset } from './enemies';
import { dashCircle } from './input';
import { BOARD_H, BOARD_W, CELL, DEPTH } from './layout';
import { B, C, FONT, hex } from './palette';
import { PartSet } from './parts';
import { dashed } from './towers';

/**
 * 动态战场（文档 09）的棋盘表现：
 *  - 空降出生点（纸箱）：预警虚线圈 + 倒计时 → 落地（下落、扬尘、震屏）→ 折叠消失
 *  - 下一波预告：对应出生点高亮，旁边显示将要出来的敌人小图标
 *  - 随机事件：预警框 + 倒计时、持续效果（风扇、起风、午休、作业检查、跳闸…）
 *  - 掉落物：硬币 / 补给箱（上下浮动、快过期时闪烁、收集时飞向左上角）
 *  - 地形变化：书本倒下的下落动画、杂物挪动的扬尘
 *  - 自动开波 3/2/1 秒的桌沿脉冲；神话能力的全局效果（白昼、金库锁门）
 */

type Bounds = { x: number; y: number; w: number; h: number };

interface DropView {
  id: string;
  b: Bounds;
  icon: EnemyId | undefined;
  phase: 'warn' | 'fall' | 'landed' | 'fold' | 'gone';
  /** 当前阶段已经过的真实秒数 */
  t: number;
  seen: boolean;
}

interface Flyer {
  x: number;
  y: number;
  t: number;
  max: number;
  delay: number;
}

interface FallingObstacle {
  o: Obstacle;
  key: string;
  t: number;
  g: Phaser.GameObjects.Graphics;
  drawn: boolean;
}

const FALL_T = 0.45;
const FOLD_T = 0.45;
const OBST_FALL_T = 0.5;
const COIN_TARGET = { x: 14, y: 12 };

/** 小敌人图标（预告 / 纸箱印章） */
class MiniIcon {
  root: Phaser.GameObjects.Container;
  parts: PartSet;
  label: Phaser.GameObjects.Text;
  used = false;
  constructor(scene: Phaser.Scene, depth: number, res: number) {
    this.root = scene.add.container(0, 0).setDepth(depth).setVisible(false);
    this.parts = new PartSet(scene, this.root);
    this.label = scene.add
      .text(0, 0, '', { fontFamily: FONT, fontSize: '10px', fontStyle: 'bold', color: hex(C.paper), stroke: hex(C.ink), strokeThickness: 3 })
      .setOrigin(0, 0.5)
      .setDepth(depth + 0.05)
      .setVisible(false)
      .setResolution(res);
  }
  destroy(): void {
    this.parts.destroy();
    this.root.destroy();
    this.label.destroy();
  }
}

export class FieldLayer {
  private under: Phaser.GameObjects.Graphics;
  private boxG: Phaser.GameObjects.Graphics;
  private top: Phaser.GameObjects.Graphics;
  private pickG: Phaser.GameObjects.Graphics;
  private badgeG: Phaser.GameObjects.Graphics;
  private drops = new Map<string, DropView>();
  private first = true;
  private texts: Phaser.GameObjects.Text[] = [];
  private textN = 0;
  private icons: MiniIcon[] = [];
  private iconN = 0;
  private stampIcons = new Map<string, MiniIcon>();
  private coins: Flyer[] = [];
  private falling: FallingObstacle[] = [];
  /** 正在下落、暂不画进背景的障碍物 */
  readonly hiddenObstacles = new Set<string>();
  private pickupBorn = new Map<number, number>();
  private pickupSeen = new Set<number>();
  private edgePulse = { t: 99, sec: 0 };
  /** 漏怪：出口纸页翻动 + 红色脉冲的进度（秒） */
  private leakT = 99;
  private leakBig = false;
  private startedFx = new Set<number>();
  private resolution = 1;
  /** 神话能力的全局效果（state.time 截止） */
  daylightUntil = 0;
  vaultUntil = 0;

  constructor(private ctx: RenderCtx) {
    const sc = ctx.scene;
    this.under = sc.add.graphics().setDepth(DEPTH.fieldUnder);
    this.boxG = sc.add.graphics().setDepth(DEPTH.box);
    this.pickG = sc.add.graphics().setDepth(DEPTH.pickup);
    this.badgeG = sc.add.graphics().setDepth(DEPTH.over);
    this.top = sc.add.graphics().setDepth(DEPTH.fieldTop);
  }

  setResolution(r: number): void {
    this.resolution = r;
    for (const t of this.texts) t.setResolution(r);
    for (const i of this.icons) i.label.setResolution(r);
  }

  // ───────────── 查询（输入用） ─────────────

  /** pos 为格坐标（浮点）；返回半径内最近的掉落物 */
  pickupAt(pos: { x: number; y: number }, radius: number): PickupState | null {
    const st = this.ctx.session.world.state;
    if (!st.pickups) return null;
    let best: PickupState | null = null,
      bd = radius;
    for (const p of st.pickups) {
      if (p.until <= st.time) continue;
      const d = Math.hypot(p.x - pos.x, p.y - pos.y);
      if (d <= bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  }

  /** 格子上的空降出生点（已落地或预警中） */
  dropAt(cx: number, cy: number, landedOnly = false): SpawnerState | null {
    const st = this.ctx.session.world.state;
    if (!st.spawners) return null;
    for (const sp of st.spawners) {
      if (sp.kind !== 'drop') continue;
      if (landedOnly && sp.warnUntil !== undefined && sp.warnUntil > st.time) continue;
      for (const c of sp.cells) if (c.x === cx && c.y === cy) return sp;
    }
    return null;
  }

  /** n 枚硬币从 (x,y)（像素）飞向左上角的金币栏 */
  flyCoins(x: number, y: number, n: number): void {
    for (let i = 0; i < n; i++) this.coins.push({ x: x + (Math.random() - 0.5) * 8, y: y + (Math.random() - 0.5) * 8, t: 0, max: 0.55 + i * 0.03, delay: i * 0.06 });
  }

  // ───────────── 事件 ─────────────

  /** 敌人漏过出口：纸页翻动、红色脉冲、飞出几张纸片 */
  onLeak(lives: number): void {
    this.leakT = 0;
    this.leakBig = lives > 1;
    const st = this.ctx.session.world.state;
    const fx = this.ctx.fx;
    for (const e of st.grid.exits) {
      fx.cell(e.x * CELL, e.y * CELL, CELL, CELL, C.bad, 0.5, 0.45);
      if (lives > 0) fx.confettiOf((e.x + 0.5) * CELL, (e.y + 0.4) * CELL, C.bookPage, 3);
    }
  }

  handle(ev: GameEvent): void {
    const fx = this.ctx.fx;
    const P = (v: number) => v * CELL;
    switch (ev.type) {
      case 'spawnerDrop': {
        const v = this.drops.get(ev.id);
        if (ev.phase === 'warn') {
          fx.ring(P(ev.x + 0.5), P(ev.y + 0.5), 4, CELL * 1.6, C.bad, 0.5, 3);
        } else if (ev.phase === 'land') {
          if (v && (v.phase === 'warn' || v.phase === 'gone')) this.startFall(v);
        } else if (v && (v.phase === 'landed' || v.phase === 'fall')) {
          this.startFold(v, ev.phase === 'demolish');
        }
        break;
      }
      case 'pickup': {
        const x = P(ev.x),
          y = P(ev.y);
        if (ev.phase === 'spawn') {
          this.pickupBorn.set(ev.uid, this.ctx.vtime);
          fx.ring(x, y, 2, 18, ev.kind === 'coin' ? C.goldLight : C.wood, 0.35, 2);
        } else if (ev.phase === 'collect') {
          if (ev.kind === 'coin') {
            this.flyCoins(x, y, Math.max(1, Math.min(5, Math.ceil((ev.value ?? 5) / 5))));
            if (ev.value) fx.text(x, y - 12, `+${Math.round(ev.value)}`, 'gold');
            fx.sparkle(x, y, C.goldLight, 5, 14);
          } else {
            // 补给箱：箱盖弹开 + 纸屑
            fx.shatter(x, y, C.wood, 7, 5);
            fx.confetti(x, y - 4, this.ctx.quality === 'low' ? 8 : 16);
            fx.ring(x, y, 4, 30, C.goldLight, 0.4, 3, true);
          }
          this.pickupBorn.delete(ev.uid);
        } else {
          fx.dust(x, y + 4, 10, C.paper);
          this.pickupBorn.delete(ev.uid);
        }
        break;
      }
      case 'autoWave':
        this.edgePulse = { t: 0, sec: ev.secondsLeft };
        break;
      case 'randomEvent':
        if (ev.phase === 'start') this.eventStart(ev);
        else if (ev.phase === 'warn' && ev.area) {
          const a = ev.area;
          fx.cell(P(a.x), P(a.y), P(a.w), P(a.h), C.bad, 0.5, 0.35);
        }
        break;
      default:
        break;
    }
  }

  private eventStart(ev: Extract<GameEvent, { type: 'randomEvent' }>): void {
    if (this.startedFx.has(ev.uid)) return;
    this.startedFx.add(ev.uid);
    if (this.startedFx.size > 64) this.startedFx.clear();
    const fx = this.ctx.fx;
    const st = this.ctx.session.world.state;
    const P = (v: number) => v * CELL;
    const low = this.ctx.quality === 'low';
    const areaC = ev.area ? { x: P(ev.area.x + ev.area.w / 2), y: P(ev.area.y + ev.area.h / 2) } : null;
    switch (ev.id) {
      case 'praise': {
        for (let i = 0; i < (low ? 6 : 14); i++) fx.sparkle(Math.random() * BOARD_W, Math.random() * BOARD_H, C.goldLight, 2, 12);
        fx.ring(BOARD_W / 2, BOARD_H / 2, 10, BOARD_H * 0.6, C.goldLight, 0.7, 4, true);
        break;
      }
      case 'inspiration': {
        if (areaC) {
          fx.sparkle(areaC.x, areaC.y - 6, C.goldLight, 10, 30);
          fx.ring(areaC.x, areaC.y, 30, 6, C.goldLight, 0.4, 4);
        } else for (const t of st.towers.values()) if (t.id !== 'wall') fx.sparkle(P(t.cx + 0.5), P(t.cy + 0.5), C.goldLight, 2, 16);
        break;
      }
      case 'nap':
        for (const e of st.enemies) if (!e.flying) fx.text(P(e.x), P(e.y) - 14, 'z', 'info');
        break;
      case 'homework_check':
        for (const e of st.enemies) fx.sparkle(P(e.x), P(e.y) - 6, C.white, 1, 8);
        break;
      case 'coffee_spill':
        if (areaC) {
          const r = ev.area ? P(Math.max(ev.area.w, ev.area.h)) * 0.5 : CELL * 1.5;
          fx.ring(areaC.x, areaC.y, r * 0.2, r, C.coffee, 0.5, 8);
          fx.shatter(areaC.x, areaC.y, C.coffee, 10, 4);
          fx.disc(areaC.x, areaC.y, r, C.coffee, 0.5, false, 0.35);
        }
        break;
      case 'secret_door': {
        const cells = ev.area ? [ev.area] : [];
        if (!cells.length && st.spawners)
          for (const sp of st.spawners) if (sp.kind === 'hidden' && sp.active) cells.push(cellBounds(sp.cells));
        for (const b of cells) {
          const x = P(b.x + b.w / 2),
            y = P(b.y + b.h / 2);
          fx.ring(x, y, 4, CELL * 1.3, C.magenta, 0.5, 4);
          fx.dust(x, y, 24, C.ink);
          fx.shatter(x, y, C.deskDark, 6, 4);
        }
        break;
      }
      case 'reinforce':
        if (st.spawners)
          for (const sp of st.spawners) {
            if (!sp.active) continue;
            const b = cellBounds(sp.cells);
            fx.ring(P(b.x + b.w / 2), P(b.y + b.h / 2), 4, CELL * 1.2, C.bad, 0.5, 4);
          }
        break;
      case 'lamp_outage':
        for (const t of st.towers.values()) if (t.id === 'lamp') fx.shatter(P(t.cx + 0.5), P(t.cy + 0.3), C.lampLight, 3, 3);
        break;
      default:
        break;
    }
  }

  /** 地形差异（由 Board 在背景重画前调用）：新出现的书本播放下落，其余杂物扬尘 */
  terrainDiff(added: Obstacle[], removed: Obstacle[]): void {
    const fx = this.ctx.fx;
    const st = this.ctx.session.world.state;
    const booksFalling = !!st.events?.some((e) => e.id === 'books_fall' && e.phase !== 'done');
    for (const o of removed) fx.dust((o.x + o.w / 2) * CELL, (o.y + o.h / 2) * CELL, Math.max(o.w, o.h) * CELL * 0.4, C.deskDark);
    for (const o of added) {
      if (o.kind === 'books' && booksFalling && this.falling.length < 4) {
        const key = obstacleKey(o);
        if (this.hiddenObstacles.has(key)) continue;
        this.hiddenObstacles.add(key);
        const g = this.ctx.scene.add.graphics().setDepth(DEPTH.fieldTop + 0.5);
        this.falling.push({ o, key, t: 0, g, drawn: false });
      } else {
        const x = (o.x + o.w / 2) * CELL,
          y = (o.y + o.h / 2) * CELL;
        fx.dust(x, y, Math.max(o.w, o.h) * CELL * 0.45, C.paper);
        fx.ring(x, y, 4, Math.max(o.w, o.h) * CELL * 0.7, C.deskDark, 0.35, 3);
      }
    }
  }

  // ───────────── 纸箱生命周期 ─────────────

  private startFall(v: DropView): void {
    v.phase = 'fall';
    v.t = 0;
  }

  private startFold(v: DropView, demolish: boolean): void {
    if (v.phase === 'fold' || v.phase === 'gone') return;
    v.phase = 'fold';
    v.t = 0;
    const x = (v.b.x + v.b.w / 2) * CELL,
      y = (v.b.y + v.b.h / 2) * CELL;
    this.ctx.fx.dust(x, y + 8, CELL * 0.6, C.tapeTan);
    if (demolish) {
      this.ctx.fx.shatter(x, y, 0xc89b6a, 8, 5);
      this.ctx.fx.text(x, y - 18, t('ui.render.demolish'), 'info');
    }
  }

  private landed(v: DropView): void {
    const fx = this.ctx.fx;
    const x = (v.b.x + v.b.w / 2) * CELL,
      y = (v.b.y + v.b.h / 2) * CELL;
    fx.dust(x, y + 10, CELL * 0.9, C.deskDark);
    fx.dust(x, y + 6, CELL * 0.5, C.paper);
    fx.ring(x, y, CELL * 0.4, CELL * 1.6, C.ink, 0.35, 4);
    fx.shatter(x, y + 8, C.deskDark, 6, 3);
    // 纸箱落地：一次下砸再回弹
    this.ctx.cam.shake(260, 0.12, 'thud');
  }

  private syncDrops(st: WorldState): void {
    const now = st.time;
    for (const v of this.drops.values()) v.seen = false;
    if (st.spawners)
      for (const sp of st.spawners) {
        if (sp.kind !== 'drop') continue;
        const warn = sp.warnUntil !== undefined && sp.warnUntil > now;
        let v = this.drops.get(sp.id);
        if (!v) {
          v = { id: sp.id, b: cellBounds(sp.cells), icon: sp.icon, phase: warn ? 'warn' : this.first ? 'landed' : 'fall', t: 0, seen: true };
          this.drops.set(sp.id, v);
        }
        v.seen = true;
        v.b = cellBounds(sp.cells);
        v.icon = sp.icon;
        if (v.phase === 'warn' && !warn) this.startFall(v);
      }
    const sel = ui.state.spawnerSelected;
    if (sel !== null && !st.spawners?.some((sp) => sp.id === sel)) ui.set({ spawnerSelected: null });
    for (const [id, v] of this.drops) {
      if (v.seen) continue;
      if (v.phase === 'warn') this.drops.delete(id);
      else if (v.phase === 'landed' || v.phase === 'fall') this.startFold(v, false);
      else if (v.phase === 'gone') this.drops.delete(id);
    }
  }

  // ───────────── 每帧 ─────────────

  sync(): void {
    const ctx = this.ctx;
    const st = ctx.session.world.state;
    const now = st.time;
    const rdt = ctx.rdt;
    const ug = this.under,
      bg = this.boxG,
      tg = this.top,
      pg = this.pickG;
    ug.clear();
    bg.clear();
    tg.clear();
    pg.clear();
    this.badgeG.clear();
    this.textN = 0;
    this.iconN = 0;
    for (const m of this.stampIcons.values()) m.used = false;

    this.syncDrops(st);
    this.drawSpawnerPreview(st);
    this.drawDrops(st, rdt);
    this.drawEvents(st);
    this.drawPickups(st);
    this.drawFalling(rdt);
    this.drawCoins(rdt);
    this.drawGlobal(st, now);
    this.drawEdgePulse(rdt);
    this.drawLeak(st, rdt);

    // 回收未使用的文字 / 图标
    for (let i = this.textN; i < this.texts.length; i++) if (this.texts[i].visible) this.texts[i].setVisible(false);
    for (let i = this.iconN; i < this.icons.length; i++) {
      const m = this.icons[i];
      if (m.root.visible) m.root.setVisible(false);
      if (m.label.visible) m.label.setVisible(false);
    }
    for (const [id, m] of this.stampIcons) {
      if (m.used) continue;
      m.destroy();
      this.stampIcons.delete(id);
    }
    this.first = false;
  }

  private text(x: number, y: number, str: string, color: number, size = 14, stroke: number = B.textStroke): void {
    let t = this.texts[this.textN];
    if (!t) {
      t = this.ctx.scene.add.text(0, 0, '', { fontFamily: FONT, fontSize: '14px', fontStyle: 'bold' }).setOrigin(0.5).setDepth(DEPTH.text - 2);
      t.setResolution(this.resolution);
      this.texts.push(t);
    }
    this.textN++;
    const key = `${str}|${color}|${size}|${stroke}`;
    if (t.getData('k') !== key) {
      t.setData('k', key);
      t.setStyle({ fontFamily: FONT, fontSize: `${size}px`, fontStyle: 'bold', color: hex(color), stroke: hex(stroke), strokeThickness: 4 });
      t.setText(str);
    }
    t.setPosition(x, y).setVisible(true);
  }

  private icon(enemy: EnemyId, x: number, y: number, size: number, label: string, alpha = 1): void {
    if (!this.ctx.atlas.ready) return;
    let m = this.icons[this.iconN];
    if (!m) {
      m = new MiniIcon(this.ctx.scene, DEPTH.over + 0.2, this.resolution);
      this.icons.push(m);
    }
    this.iconN++;
    const { asset, mul } = enemyAsset(enemy);
    m.parts.bind(this.ctx.atlas, asset, mul * size);
    m.root.setPosition(x, y).setVisible(true).setAlpha(alpha);
    if (label) {
      if (m.label.text !== label) m.label.setText(label);
      m.label.setPosition(x + CELL * size * 0.32, y + CELL * size * 0.28).setVisible(true).setAlpha(alpha);
    } else m.label.setVisible(false);
  }

  /** 下一波：用到的出生点高亮 + 将要出来的敌人小图标 */
  private drawSpawnerPreview(st: WorldState): void {
    if (!st.spawners || !st.spawners.length) return;
    const show = st.phase === 'build' || (st.autoWave && st.autoWave.nextAt !== null);
    const groups = st.nextWave?.groups ?? [];
    const rt = performance.now() / 1000;
    const pulse = 0.5 + 0.5 * Math.sin(rt * 5);
    // 出生点「呼吸」：慢吸慢呼；自动开波只剩 3 秒时越来越急
    const left = st.autoWave?.nextAt != null ? st.autoWave.nextAt - st.time : 99;
    const period = left < 3 ? 0.55 : 1.9;
    const bph = this.ctx.reduced ? 0.6 : (rt / period) % 1;
    const breath = this.ctx.reduced ? 0.6 : 0.5 - 0.5 * Math.cos(bph * Math.PI * 2);
    const g = this.under;
    const sel = ui.state.spawnerSelected;
    for (const sp of st.spawners) {
      const b = cellBounds(sp.cells);
      const X = b.x * CELL,
        Y = b.y * CELL,
        W = b.w * CELL,
        H = b.h * CELL;
      if (sel === sp.id) {
        this.top.lineStyle(3, C.white, 0.7 + 0.3 * pulse);
        this.top.strokeRoundedRect(X - 3, Y - 3, W + 6, H + 6, 10);
        dashed(this.top, X - 6, Y - 6, X + W + 6, Y - 6, C.bad, 2, 6, 4, (rt * 20) % 10);
        dashed(this.top, X - 6, Y + H + 6, X + W + 6, Y + H + 6, C.bad, 2, 6, 4, (rt * 20) % 10);
      }
      if (!show || !sp.active || (sp.warnUntil !== undefined && sp.warnUntil > st.time)) continue;
      const mine = groups.filter((q) => q.spawner === sp.id || q.spawner === '*');
      if (!mine.length) continue;
      // 出生点亮起
      const grow = breath * 2.5;
      g.fillStyle(C.bad, 0.08 + 0.14 * breath);
      g.fillRoundedRect(X + 2 - grow, Y + 2 - grow, W - 4 + grow * 2, H - 4 + grow * 2, 8);
      g.lineStyle(2.5, C.bad, 0.4 + 0.45 * breath);
      g.strokeRoundedRect(X + 2 - grow, Y + 2 - grow, W - 4 + grow * 2, H - 4 + grow * 2, 8);
      if (!this.ctx.reduced) {
        // 每次呼气向外吐出一圈淡淡的环
        const o = 3 + bph * 10;
        g.lineStyle(2, C.bad, 0.3 * (1 - bph));
        g.strokeRoundedRect(X - o, Y - o, W + o * 2, H + o * 2, 8 + o * 0.5);
      }
      // 图标放在出生点自身的格子上（这些格子不能建塔），不再画到相邻的可建造格上——
      // 之前画在入口内侧一格，会和建在那里的塔互相遮挡（见玩家反馈截图）。
      // 沿出生点的长边排开；放不下的用「+N」收尾。
      const horizontal = b.w >= b.h;
      const span = horizontal ? b.w : b.h; // 可用长度（格）
      const step = 0.9; // 图标间距（格）：图标 + 下方数量标签互不重叠
      const cap = Math.max(1, Math.floor((span - 0.1) / step));
      const n = Math.min(cap, mine.length);
      const more = mine.length - n;
      const slots = n + (more > 0 ? 1 : 0);
      const ox0 = horizontal ? b.x + b.w / 2 - ((slots - 1) * step) / 2 : b.x + b.w / 2;
      const oy0 = horizontal ? b.y + b.h / 2 - 0.08 : b.y + b.h / 2 - ((slots - 1) * step) / 2;
      const at = (i: number): { x: number; y: number } => ({
        x: (horizontal ? ox0 + step * i : ox0) * CELL,
        y: (horizontal ? oy0 : oy0 + step * i) * CELL,
      });
      const bg = this.badgeG;
      // 一条底板把同一出生点的图标收在一起，读起来像一个整体
      const p0 = at(0),
        p1 = at(slots - 1);
      bg.fillStyle(C.paper, 0.9);
      bg.fillRoundedRect(Math.min(p0.x, p1.x) - 15, Math.min(p0.y, p1.y) - 15, Math.abs(p1.x - p0.x) + 30, Math.abs(p1.y - p0.y) + 30, 14);
      for (let i = 0; i < n; i++) {
        const q = mine[i];
        const { x, y } = at(i);
        bg.lineStyle(2, q.elite > 0 ? C.gold : C.bad, 0.95);
        bg.strokeCircle(x, y, 12);
        const cnt = q.spawner === '*' ? Math.ceil(q.count / Math.max(1, st.spawners.filter((s) => s.active).length)) : q.count;
        this.icon(q.enemy, x, y, 0.4, `×${cnt}`, 0.95);
      }
      if (more > 0) {
        const { x, y } = at(n);
        this.text(x, y, `+${more}`, C.ink, 12);
      }
    }
  }

  private drawDrops(st: WorldState, rdt: number): void {
    const now = st.time;
    const rt = performance.now() / 1000;
    for (const [id, v] of this.drops) {
      v.t += rdt;
      const sp = st.spawners?.find((s) => s.id === id);
      const X = v.b.x * CELL,
        Y = v.b.y * CELL,
        W = v.b.w * CELL,
        H = v.b.h * CELL;
      const cx = X + W / 2,
        cy = Y + H / 2;
      if (v.phase === 'warn') {
        const left = sp?.warnUntil !== undefined ? Math.max(0, sp.warnUntil - now) : 0;
        const blink = 0.5 + 0.5 * Math.sin(rt * (left < 2 ? 14 : 8));
        // 落点格子闪红
        this.under.fillStyle(C.bad, 0.16 + 0.16 * blink);
        this.under.fillRect(X, Y, W, H);
        // 3×3 推开范围
        const R = (Math.max(v.b.w, v.b.h) / 2 + 1) * CELL;
        dashCircle(this.top, cx, cy, R, C.bad, 2.5, 0.55 + 0.35 * blink, rt * 0.8);
        dashCircle(this.top, cx, cy, Math.max(W, H) * 0.62, C.white, 1.5, 0.5, -rt * 1.2);
        // 越来越大的投影
        const k = Phaser.Math.Clamp(1 - left / 5, 0.1, 1);
        this.under.fillStyle(C.ink, 0.12 + 0.18 * k);
        this.under.fillEllipse(cx, cy + 4, W * 0.9 * k, H * 0.6 * k);
        this.text(cx, cy, String(Math.ceil(left)), C.paper, 18, C.bad);
        continue;
      }
      if (v.phase === 'gone') continue;
      let yOff = 0,
        sx = 1,
        sy = 1,
        alpha = 1,
        shadowK = 1;
      if (v.phase === 'fall') {
        const p = Math.min(1, v.t / FALL_T);
        yOff = -(1 - p * p) * 150;
        shadowK = 0.3 + 0.7 * p;
        if (p >= 1) {
          this.landed(v);
          v.phase = 'landed';
          v.t = 0;
        }
      } else if (v.phase === 'landed' && v.t < 0.22) {
        // 落地压扁回弹
        const q = v.t / 0.22;
        sy = 1 - Math.sin(q * Math.PI) * 0.18;
        sx = 1 + Math.sin(q * Math.PI) * 0.1;
      } else if (v.phase === 'fold') {
        const p = Math.min(1, v.t / FOLD_T);
        sy = 1 - p;
        sx = 1 + p * 0.15;
        alpha = 1 - p * 0.5;
        if (p >= 1) {
          v.phase = 'gone';
          continue;
        }
      }
      const g = v.phase === 'fall' ? this.top : this.boxG;
      // 投影
      this.boxG.fillStyle(C.ink, 0.2 * shadowK * alpha);
      this.boxG.fillRoundedRect(X + 6, Y + 8, W - 8, H - 8, 5);
      const bw = (W - 10) * sx,
        bh = (H - 10) * sy;
      const bx = cx - bw / 2,
        by = cy + (H - 10) / 2 - bh + yOff - 2;
      drawBox(g, bx, by, bw, bh, alpha, v.phase === 'fold' ? Math.min(1, v.t / FOLD_T) : 0);
      // 印在箱子上的敌人图标
      if (v.icon && bh > 8) {
        let m = this.stampIcons.get(id);
        if (!m) {
          m = new MiniIcon(this.ctx.scene, DEPTH.box + 0.05, this.resolution);
          this.stampIcons.set(id, m);
        }
        m.used = true;
        const { asset, mul } = enemyAsset(v.icon);
        m.parts.bind(this.ctx.atlas, asset, mul * 0.5 * Math.min(v.b.w, v.b.h));
        m.root.setDepth(v.phase === 'fall' ? DEPTH.fieldTop + 0.1 : DEPTH.box + 0.05);
        m.root.setPosition(cx, by + bh / 2 + 2).setScale(sx, sy).setAlpha(0.85 * alpha).setVisible(true);
      }
      // 拆除可用提示：可拆的箱子顶上一枚小锤子标记（选中时）
      if (ui.state.spawnerSelected === id && v.phase === 'landed') {
        this.top.lineStyle(2, C.white, 0.8);
        this.top.strokeRoundedRect(bx - 3, by - 3, bw + 6, bh + 6, 6);
      }
    }
  }

  private drawEvents(st: WorldState): void {
    const evs = st.events;
    if (!evs || !evs.length) return;
    const now = st.time;
    const rt = performance.now() / 1000;
    const vt = this.ctx.vtime;
    const low = this.ctx.quality === 'low';
    const tg = this.top;
    for (const e of evs) {
      if (e.phase === 'warn') {
        if (e.area) this.warnArea(e, now, rt);
        continue;
      }
      if (e.phase !== 'active' || e.endsAt <= now) continue;
      const fade = Math.min(1, (e.endsAt - now) / 0.6, (now - e.startsAt) / 0.4 + 0.2);
      switch (e.id) {
        case 'fan': {
          // 飞行敌人周围的气流线
          tg.lineStyle(1.5, C.white, 0.6 * fade);
          let n = 0;
          for (const en of st.enemies) {
            if (!en.flying || n++ > (low ? 12 : 30)) continue;
            const x = en.x * CELL,
              y = en.y * CELL - 8;
            for (let k = 0; k < 2; k++) {
              const ph = (vt * 2.5 + k * 0.5 + en.uid * 0.37) % 1;
              const ox = x - 10 - ph * 18,
                oy = y - 6 + k * 10 + Math.sin(vt * 6 + k) * 2;
              tg.beginPath();
              tg.moveTo(ox, oy);
              tg.lineTo(ox + 8, oy - 2);
              tg.lineTo(ox + 14, oy + 1);
              tg.strokePath();
            }
          }
          this.streaks(tg, vt, fade * 0.5, low ? 6 : 12, 1, 0.35);
          break;
        }
        case 'wind': {
          const dir = /左/.test(e.desc) ? -1 : 1;
          this.streaks(tg, vt, fade, low ? 8 : 18, dir, 0);
          break;
        }
        case 'nap': {
          // 地面敌人头顶的 Zzz
          let n = 0;
          for (const en of st.enemies) {
            if (en.flying || n++ > (low ? 15 : 40)) continue;
            const ph = (vt * 0.8 + en.uid * 0.29) % 1;
            const x = en.x * CELL + 6 + ph * 6,
              y = en.y * CELL - 14 - ph * 14;
            const s = 3 + ph * 2.5;
            const a = fade * (ph < 0.2 ? ph / 0.2 : 1 - (ph - 0.2) / 0.8);
            zGlyph(tg, x, y, s, a);
            if (!low) zGlyph(tg, x + s * 1.6, y - s * 1.8, s * 0.7, a * 0.8);
          }
          break;
        }
        case 'homework_check': {
          // 护甲反光：一道扫过的白色亮线 + 小盾牌
          let n = 0;
          for (const en of st.enemies) {
            if (en.hidden || n++ > (low ? 15 : 40)) continue;
            const x = en.x * CELL,
              y = en.y * CELL;
            const r = Math.max(6, en.radius * CELL) * (en.scale || 1);
            const ph = (vt * 0.9 + en.uid * 0.41) % 1;
            if (ph < 0.35) {
              const q = ph / 0.35;
              const a = Math.sin(q * Math.PI) * fade;
              tg.lineStyle(2.5, C.white, 0.85 * a);
              const lx = x - r + q * r * 2;
              tg.lineBetween(lx - 3, y - r * 0.6, lx + 3, y + r * 0.6);
            }
            tg.fillStyle(C.metal, 0.85 * fade);
            tg.lineStyle(1.2, C.ink, 0.9 * fade);
            const sx = x + r * 0.75,
              sy = y + r * 0.35;
            const pts = [
              { x: sx - 3.5, y: sy - 4 },
              { x: sx + 3.5, y: sy - 4 },
              { x: sx + 3, y: sy + 1 },
              { x: sx, y: sy + 4.5 },
              { x: sx - 3, y: sy + 1 },
            ];
            tg.fillPoints(pts, true);
            tg.strokePoints(pts, true);
          }
          break;
        }
        case 'coffee_spill': {
          if (!e.area || st.zones.some((z) => z.kind === 'coffee')) break;
          const a = e.area;
          const X = a.x * CELL,
            Y = a.y * CELL;
          this.under.fillStyle(C.coffee, 0.4 * fade);
          this.under.fillRoundedRect(X + 3, Y + 3, a.w * CELL - 6, a.h * CELL - 6, 16);
          this.under.lineStyle(2, C.coffee, 0.7 * fade);
          this.under.strokeRoundedRect(X + 3, Y + 3, a.w * CELL - 6, a.h * CELL - 6, 16);
          break;
        }
        case 'lamp_outage': {
          for (const t of st.towers.values()) {
            if (t.id !== 'lamp') continue;
            const x = (t.cx + 0.5) * CELL,
              y = (t.cy + 0.5) * CELL;
            tg.fillStyle(C.ink, 0.25 * fade);
            tg.fillCircle(x, y, CELL * 0.45);
            // 小小的"断电"闪电
            const blink = Math.sin(rt * 9 + t.uid) > 0.2 ? 1 : 0.4;
            tg.lineStyle(2, C.goldLight, 0.9 * fade * blink);
            tg.beginPath();
            tg.moveTo(x + 10, y - 20);
            tg.lineTo(x + 5, y - 13);
            tg.lineTo(x + 10, y - 13);
            tg.lineTo(x + 5, y - 6);
            tg.strokePath();
          }
          break;
        }
        case 'praise': {
          if (!low && this.ctx.vdt > 0 && Math.random() < 0.08) this.ctx.fx.sparkle(Math.random() * BOARD_W, Math.random() * BOARD_H, C.goldLight, 1, 4);
          break;
        }
        default:
          break;
      }
    }
  }

  /** 预警框：红色闪烁 + 虚线 + 倒计时 */
  private warnArea(e: RandomEventState, now: number, rt: number): void {
    const a = e.area!;
    const X = a.x * CELL,
      Y = a.y * CELL,
      W = a.w * CELL,
      H = a.h * CELL;
    const left = Math.max(0, e.startsAt - now);
    const blink = 0.5 + 0.5 * Math.sin(rt * (left < 1.5 ? 14 : 7));
    const col = e.tone === 'good' ? C.teal : e.tone === 'neutral' ? C.lamp : C.bad;
    this.under.fillStyle(col, 0.1 + 0.16 * blink);
    this.under.fillRect(X, Y, W, H);
    const off = (rt * 24) % 12;
    dashed(this.top, X, Y, X + W, Y, col, 2.5, 7, 5, off, 0.95);
    dashed(this.top, X + W, Y, X + W, Y + H, col, 2.5, 7, 5, off, 0.95);
    dashed(this.top, X + W, Y + H, X, Y + H, col, 2.5, 7, 5, off, 0.95);
    dashed(this.top, X, Y + H, X, Y, col, 2.5, 7, 5, off, 0.95);
    if (e.startsAt > now) this.text(X + W / 2, Y + H / 2, String(Math.ceil(left)), C.paper, 18, col);
  }

  /** 横向气流线（风扇 / 起风） */
  private streaks(g: Phaser.GameObjects.Graphics, vt: number, a: number, n: number, dir: number, wobble: number): void {
    for (let i = 0; i < n; i++) {
      const seed = i * 7.31;
      const speed = 0.35 + (i % 5) * 0.08;
      let ph = (vt * speed + (seed % 1)) % 1;
      if (dir < 0) ph = 1 - ph;
      const y = ((i * 0.618 + 0.05) % 1) * BOARD_H + Math.sin(vt * 2 + i) * 6 * (1 + wobble * 4);
      const x = ph * (BOARD_W + 120) - 60;
      const len = 26 + (i % 4) * 10;
      const al = a * 0.75 * Math.sin(ph * Math.PI);
      g.lineStyle(2.5, C.white, al);
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x - dir * len * 0.5, y - 2);
      g.lineTo(x - dir * len, y + 1);
      g.strokePath();
    }
  }

  private drawPickups(st: WorldState): void {
    const ps = st.pickups;
    this.pickupSeen.clear();
    if (ps && ps.length) {
      const g = this.pickG;
      const now = st.time;
      const vt = this.ctx.vtime;
      const rt = performance.now() / 1000;
      const hov = ui.state.hoverPickup;
      for (const p of ps) {
        if (p.until <= now) continue;
        this.pickupSeen.add(p.uid);
        let born = this.pickupBorn.get(p.uid);
        if (born === undefined) {
          born = this.first ? vt - 1 : vt;
          this.pickupBorn.set(p.uid, born);
        }
        const age = vt - born;
        const pop = age < 0.3 ? Phaser.Math.Easing.Back.Out(Math.max(0, age / 0.3), 2.5) : 1;
        const left = p.until - now;
        const blinkA = left < 3 ? (Math.sin(rt * (left < 1.2 ? 22 : 12)) > 0 ? 1 : 0.35) : 1;
        const x = p.x * CELL,
          y = p.y * CELL;
        const bob = Math.sin(vt * 3 + p.uid) * 3;
        // 投影
        g.fillStyle(C.ink, 0.2 * blinkA);
        g.fillEllipse(x, y + 9, 18 * pop - Math.abs(bob), 6 * pop);
        if (p.kind === 'coin') drawCoin(g, x, y - 4 + bob, 9 * pop, blinkA, vt + p.uid);
        else drawCrate(g, x, y - 5 + bob, 13 * pop, blinkA, rt);
        if (hov === p.uid) {
          g.lineStyle(2.5, C.white, 0.9);
          g.strokeCircle(x, y - 4 + bob, (p.kind === 'coin' ? 14 : 19) + Math.sin(rt * 8) * 1.5);
        }
        if (this.ctx.quality === 'high' && this.ctx.vdt > 0 && Math.random() < 0.03) this.ctx.fx.sparkle(x + (Math.random() - 0.5) * 14, y - 8 + bob, C.goldLight, 1, 4);
      }
    }
    // 清理已消失的出生时间记录
    if (this.pickupBorn.size > this.pickupSeen.size + 8) for (const k of this.pickupBorn.keys()) if (!this.pickupSeen.has(k)) this.pickupBorn.delete(k);
    if (ui.state.hoverPickup !== null && !this.pickupSeen.has(ui.state.hoverPickup)) ui.set({ hoverPickup: null });
  }

  private drawCoins(rdt: number): void {
    const g = this.top;
    for (let i = this.coins.length - 1; i >= 0; i--) {
      const c = this.coins[i];
      if (c.delay > 0) {
        c.delay -= rdt;
        drawCoin(g, c.x, c.y, 8, 1, c.t * 10);
        continue;
      }
      c.t += rdt;
      const p = Math.min(1, c.t / c.max);
      const e = p * p * (3 - 2 * p);
      const x = c.x + (COIN_TARGET.x - c.x) * e + Math.sin(p * Math.PI) * -30;
      const y = c.y + (COIN_TARGET.y - c.y) * e - Math.sin(p * Math.PI) * 40;
      drawCoin(g, x, y, 8 * (1 - p * 0.4), 1, c.t * 14);
      if (p >= 1) {
        this.ctx.fx.sparkle(COIN_TARGET.x, COIN_TARGET.y, C.goldLight, 2, 8);
        this.coins.splice(i, 1);
      }
    }
  }

  private drawFalling(rdt: number): void {
    for (let i = this.falling.length - 1; i >= 0; i--) {
      const f = this.falling[i];
      f.t += rdt;
      const p = Math.min(1, f.t / OBST_FALL_T);
      if (!f.drawn) {
        drawObstacle(f.g, f.o);
        f.drawn = true;
      }
      // 以障碍物中心为轴：先放大后落下
      const ox = (f.o.x + f.o.w / 2) * CELL,
        oy = (f.o.y + f.o.h / 2) * CELL;
      const s = 1 + (1 - p) * 0.35;
      const yOff = -(1 - p * p) * 120;
      f.g.setScale(s);
      f.g.setPosition(ox - ox * s, oy - oy * s + yOff);
      f.g.setAlpha(Math.min(1, 0.3 + p * 1.5));
      if (p >= 1) {
        const fx = this.ctx.fx;
        fx.dust(ox, oy + 8, Math.max(f.o.w, f.o.h) * CELL * 0.5, C.deskDark);
        fx.shatter(ox, oy, C.bookPage, 6, 4);
        fx.ring(ox, oy, 6, Math.max(f.o.w, f.o.h) * CELL * 0.8, C.ink, 0.35, 4);
        // 书本倒下：沉一点的下砸
        this.ctx.cam.shake(320, 0.14, 'thud');
        this.hiddenObstacles.delete(f.key);
        // 背景下一帧会重画并包含这摞书；稍等一帧再移除，避免闪一下
        const g = f.g;
        this.ctx.scene.time.delayedCall(60, () => g.destroy());
        this.falling.splice(i, 1);
      }
    }
  }

  private drawGlobal(st: WorldState, now: number): void {
    const g = this.top;
    if (this.daylightUntil > now) {
      const k = Math.min(1, (this.daylightUntil - now) / 0.6);
      g.fillStyle(C.lampLight, (0.1 + 0.03 * Math.sin(this.ctx.vtime * 3)) * k);
      g.fillRoundedRect(0, 0, BOARD_W, BOARD_H, 12);
    }
    if (this.vaultUntil > now) {
      const k = Math.min(1, (this.vaultUntil - now) / 0.4);
      const pulse = 0.5 + 0.5 * Math.sin(this.ctx.vtime * 5);
      for (const e of st.grid.exits) {
        const X = e.x * CELL,
          Y = e.y * CELL;
        g.fillStyle(C.steel, 0.2 * k);
        g.fillRect(X, Y, CELL, CELL);
        g.lineStyle(3, C.gold, (0.5 + 0.4 * pulse) * k);
        g.strokeRect(X + 2, Y + 2, CELL - 4, CELL - 4);
      }
      if (st.grid.exits.length) {
        const ex = (st.grid.exits.reduce((s, e) => s + e.x + 0.5, 0) / st.grid.exits.length) * CELL;
        const ey = (st.grid.exits.reduce((s, e) => s + e.y + 0.5, 0) / st.grid.exits.length) * CELL;
        drawLock(g, ex, ey, 11, k);
      }
    }
  }

  /** 自动开波最后 3 秒：桌沿向内收拢的双层脉冲，最后 1 秒变红、更重 */
  private drawEdgePulse(rdt: number): void {
    const p = this.edgePulse;
    if (p.t > 0.8) return;
    p.t += rdt;
    const q = p.t / 0.8;
    if (q >= 1) return;
    const last = p.sec <= 1;
    const col = last ? C.bad : C.goldLight;
    const e = this.ctx.reduced ? 0 : 1 - (1 - q) * (1 - q) * (1 - q);
    const k = (1 - q) * (1 - q);
    const g = this.top;
    const w = (last ? 7 : 5) * (1 - 0.5 * e);
    const inset = w / 2 + e * (last ? 14 : 9);
    g.lineStyle(w, col, (last ? 0.7 : 0.5) * k);
    g.strokeRoundedRect(inset, inset, BOARD_W - inset * 2, BOARD_H - inset * 2, 12);
    // 外圈细线留在桌沿，稍晚淡出
    g.lineStyle(2, C.white, 0.35 * (1 - q));
    g.strokeRoundedRect(1.5, 1.5, BOARD_W - 3, BOARD_H - 3, 12);
    if (last) {
      g.fillStyle(C.bad, 0.07 * k);
      g.fillRoundedRect(0, 0, BOARD_W, BOARD_H, 12);
    }
  }

  private drawLeak(st: WorldState, rdt: number): void {
    if (this.leakT > 0.7) return;
    this.leakT += rdt;
    const p = this.leakT / 0.7;
    if (p >= 1) return;
    const g = this.top;
    const k = (1 - p) * (1 - p);
    const red = this.ctx.reduced;
    for (const e of st.grid.exits) {
      const X = e.x * CELL,
        Y = e.y * CELL;
      // 红色脉冲：两圈先后向外扩散
      for (let i = 0; i < 2; i++) {
        const q = p * 1.4 - i * 0.25;
        if (q <= 0 || q >= 1) continue;
        const o = red ? 2 : q * (this.leakBig ? 16 : 10);
        g.lineStyle(3 * (1 - q) + 1, C.bad, 0.75 * (1 - q));
        g.strokeRoundedRect(X - o, Y - o, CELL + o * 2, CELL + o * 2, 6 + o * 0.5);
      }
      if (red) continue;
      // 纸页翻动：右上角的页角掀起来抖几下
      const f = Math.abs(Math.sin(p * Math.PI * 3)) * k * CELL * 0.42;
      if (f > 1) {
        const cx = X + CELL - 4,
          cy = Y + 4;
        g.fillStyle(C.ink, 0.18 * k);
        g.fillTriangle(cx - f, cy + 1, cx, cy + f + 1, cx - f * 0.75, cy + f * 0.8 + 1);
        g.fillStyle(C.bookPage, 0.95);
        g.fillTriangle(cx - f, cy, cx, cy + f, cx - f * 0.8, cy + f * 0.8);
        g.lineStyle(1.5, C.ink, 0.8);
        g.strokeTriangle(cx - f, cy, cx, cy + f, cx - f * 0.8, cy + f * 0.8);
      }
    }
  }

  destroy(): void {
    for (const m of this.icons) m.destroy();
    for (const m of this.stampIcons.values()) m.destroy();
    for (const t of this.texts) t.destroy();
    for (const f of this.falling) f.g.destroy();
    this.icons = [];
    this.stampIcons.clear();
    this.texts = [];
    this.falling = [];
    this.under.destroy();
    this.boxG.destroy();
    this.top.destroy();
    this.pickG.destroy();
    this.badgeG.destroy();
  }
}

// ───────────── 绘制小件 ─────────────

const CARD = 0xc89b6a;
const CARD_LIGHT = 0xdcb383;

/** 纸箱（俯视）：四片箱盖 + 中缝胶带；fold 0..1 为折叠进度 */
function drawBox(g: Phaser.GameObjects.Graphics, x: number, y: number, w: number, h: number, a: number, fold: number): void {
  if (w < 1 || h < 1) return;
  g.fillStyle(CARD, a);
  g.fillRoundedRect(x, y, w, h, 4);
  // 箱盖（翻起的四个角，折叠时收拢）
  const f = Math.max(0, 1 - fold * 1.5);
  g.fillStyle(CARD_LIGHT, a);
  g.fillTriangle(x, y, x + w * 0.22 * f, y - 5 * f, x + w * 0.4, y);
  g.fillTriangle(x + w, y, x + w - w * 0.22 * f, y - 5 * f, x + w * 0.6, y);
  g.lineStyle(2.5, C.ink, a);
  g.strokeRoundedRect(x, y, w, h, 4);
  if (f > 0) {
    g.lineStyle(1.5, C.ink, a * 0.8);
    g.strokeTriangle(x, y, x + w * 0.22 * f, y - 5 * f, x + w * 0.4, y);
    g.strokeTriangle(x + w, y, x + w - w * 0.22 * f, y - 5 * f, x + w * 0.6, y);
  }
  // 中缝 + 胶带
  g.fillStyle(C.tapeTan, 0.9 * a);
  g.fillRect(x + w / 2 - 5, y + 1, 10, h - 2);
  g.lineStyle(1, C.ink, 0.35 * a);
  g.lineBetween(x + w / 2, y + 2, x + w / 2, y + h - 2);
  // 侧面阴影 + "易碎"红杠
  g.fillStyle(C.ink, 0.12 * a);
  g.fillRect(x + 2, y + h - 6, w - 4, 4);
  g.fillStyle(C.alarmRed, 0.6 * a);
  g.fillRect(x + 5, y + 5, 7, 2);
  g.fillRect(x + 5, y + 9, 5, 2);
}

function drawCoin(g: Phaser.GameObjects.Graphics, x: number, y: number, r: number, a: number, spin: number): void {
  if (r < 0.5) return;
  const sx = 0.35 + 0.65 * Math.abs(Math.cos(spin * 1.6));
  g.fillStyle(C.goldDark, a);
  g.fillEllipse(x, y + 1.2, r * 2 * sx, r * 2);
  g.fillStyle(C.gold, a);
  g.fillEllipse(x, y, r * 2 * sx, r * 2);
  g.fillStyle(C.goldLight, a);
  g.fillEllipse(x, y, r * 1.4 * sx, r * 1.4);
  g.lineStyle(1.8, C.ink, a);
  g.strokeEllipse(x, y, r * 2 * sx, r * 2);
  if (sx > 0.6) {
    // 方孔钱的小方孔
    g.fillStyle(C.goldDark, a);
    g.fillRect(x - r * 0.22, y - r * 0.22, r * 0.44, r * 0.44);
  }
  g.fillStyle(C.white, 0.6 * a);
  g.fillCircle(x - r * 0.35 * sx, y - r * 0.4, r * 0.18);
}

function drawCrate(g: Phaser.GameObjects.Graphics, x: number, y: number, s: number, a: number, rt: number): void {
  if (s < 1) return;
  const pulse = 0.5 + 0.5 * Math.sin(rt * 4);
  g.lineStyle(4, C.goldLight, (0.3 + 0.4 * pulse) * a);
  g.strokeRoundedRect(x - s - 3, y - s - 3, s * 2 + 6, s * 2 + 6, 6);
  g.fillStyle(C.wood, a);
  g.fillRoundedRect(x - s, y - s, s * 2, s * 2, 3);
  g.fillStyle(0xb85c45, a);
  g.fillRect(x - s, y - s * 0.15, s * 2, s * 0.3);
  g.fillRect(x - s * 0.15, y - s, s * 0.3, s * 2);
  g.lineStyle(2, C.ink, a);
  g.strokeRoundedRect(x - s, y - s, s * 2, s * 2, 3);
  g.lineStyle(1.2, C.ink, 0.6 * a);
  g.lineBetween(x - s, y - s, x + s, y + s);
  // 问号贴纸
  g.fillStyle(C.paper, a);
  g.fillCircle(x + s * 0.5, y - s * 0.5, s * 0.38);
  g.lineStyle(1.2, C.ink, a);
  g.strokeCircle(x + s * 0.5, y - s * 0.5, s * 0.38);
  g.lineStyle(1.6, C.magenta, a);
  g.beginPath();
  g.arc(x + s * 0.5, y - s * 0.58, s * 0.14, Math.PI, Math.PI * 2.4, false);
  g.strokePath();
  g.fillStyle(C.magenta, a);
  g.fillCircle(x + s * 0.5, y - s * 0.3, 1.1);
}

function zGlyph(g: Phaser.GameObjects.Graphics, x: number, y: number, s: number, a: number): void {
  if (a <= 0.02) return;
  g.lineStyle(3.2, C.ink, a * 0.8);
  g.beginPath();
  g.moveTo(x - s, y - s);
  g.lineTo(x + s, y - s);
  g.lineTo(x - s, y + s);
  g.lineTo(x + s, y + s);
  g.strokePath();
  g.lineStyle(1.8, C.paper, a);
  g.beginPath();
  g.moveTo(x - s, y - s);
  g.lineTo(x + s, y - s);
  g.lineTo(x - s, y + s);
  g.lineTo(x + s, y + s);
  g.strokePath();
}

function drawLock(g: Phaser.GameObjects.Graphics, x: number, y: number, s: number, a: number): void {
  g.lineStyle(3, C.ink, a);
  g.beginPath();
  g.arc(x, y - s * 0.4, s * 0.55, Math.PI, 0, false);
  g.strokePath();
  g.lineStyle(1.8, C.metal, a);
  g.beginPath();
  g.arc(x, y - s * 0.4, s * 0.55, Math.PI, 0, false);
  g.strokePath();
  g.fillStyle(C.gold, a);
  g.fillRoundedRect(x - s * 0.8, y - s * 0.4, s * 1.6, s * 1.2, 3);
  g.lineStyle(2, C.ink, a);
  g.strokeRoundedRect(x - s * 0.8, y - s * 0.4, s * 1.6, s * 1.2, 3);
  g.fillStyle(C.ink, a);
  g.fillCircle(x, y + s * 0.1, s * 0.16);
  g.fillRect(x - s * 0.06, y + s * 0.1, s * 0.12, s * 0.35);
}
