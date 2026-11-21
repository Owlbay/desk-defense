import type { GameEvent } from '../core/types';
import { t as tr } from '../i18n';
import { abilityFx } from './abilities';
import type { RenderCtx } from './ctx';
import type { EnemyLayer } from './enemies';
import type { FieldLayer } from './field';
import { BOARD_H, BOARD_W, CELL } from './layout';
import type { ShakeMode } from './motion';
import { C, ENEMY_COLOR, TOWER_COLOR } from './palette';
import type { SwatterLayer } from './swatter';
import type { TowerLayer } from './towers';

const BEAM: Record<'warm' | 'cyan' | 'magenta', number> = { warm: C.lampLight, cyan: C.cyan, magenta: C.magenta };
const PULSE: Record<'steel' | 'cyan' | 'magenta' | 'gold' | 'ink', number> = {
  steel: C.metal,
  cyan: C.cyan,
  magenta: C.magenta,
  gold: C.goldLight,
  ink: C.inkBlue,
};

/** 把 core 事件翻译成特效 */
export class EventFx {
  /** 苍蝇拍专属特效层（Board 创建后注入） */
  swatter: SwatterLayer | null = null;

  /** 本 tick 内的即时命中（钉、光、扫）：记下开火的塔，命中火花按塔着色、顺着弹道方向飞 */
  private fireTick = -1;
  private fireN = 0;
  private fireX = new Float32Array(16);
  private fireY = new Float32Array(16);
  private fireA = new Float32Array(16);
  private fireC = new Int32Array(16);

  constructor(
    private ctx: RenderCtx,
    private towers: TowerLayer,
    private field: FieldLayer,
    private enemies: EnemyLayer,
  ) {}

  private shake(ms: number, k: number, mode: ShakeMode = 'rumble'): void {
    this.ctx.cam.shake(ms, k, mode);
  }

  shakeBy(ms: number, k: number): void {
    this.shake(ms, k);
  }

  handle(ev: GameEvent): void {
    const fx = this.ctx.fx;
    const st = this.ctx.session.world.state;
    const P = (v: number) => v * CELL;
    switch (ev.type) {
      case 'place':
        // 落地的一圈灰尘（塔身的压扁回弹在 TowerView.pop）
        fx.dust(P(ev.cx + 0.5), P(ev.cy + 0.5) + 12, 24);
        fx.ring(P(ev.cx + 0.5), P(ev.cy + 0.5) + 8, 6, 28, C.deskDark, 0.32, 3);
        fx.ring(P(ev.cx + 0.5), P(ev.cy + 0.5) + 8, 4, 18, TOWER_COLOR[ev.tower] ?? C.paper, 0.26, 2, false, 0.05);
        break;
      case 'sell':
        // 塔身折叠缩小（TowerLayer）→ 硬币飞起
        this.towers.onSell(ev.uid);
        fx.dust(P(ev.cx + 0.5), P(ev.cy + 0.5) + 10, 22, C.paper);
        fx.coinBurst(P(ev.cx + 0.5), P(ev.cy + 0.5) - 4, Math.max(3, Math.min(7, Math.round(ev.refund / 25) + 2)));
        fx.sparkle(P(ev.cx + 0.5), P(ev.cy + 0.5) - 8, C.goldLight, 3, 18);
        break;
      case 'levelUp': {
        const t = st.towers.get(ev.uid);
        if (!t) break;
        const x = P(t.cx + 0.5),
          y = P(t.cy + 0.5);
        fx.text(x, y - 18, `Lv${ev.level}`, 'level');
        fx.sparkle(x, y, ev.tier >= 3 ? C.goldLight : C.paper, ev.byXp ? 5 : 7, 26);
        if (!ev.tierChanged) fx.ring(x, y, 10, 28, C.goldLight, 0.35, 2.5);
        break;
      }
      case 'fire': {
        this.towers.onFire(ev.uid);
        if (st.tick !== this.fireTick) {
          this.fireTick = st.tick;
          this.fireN = 0;
        }
        if (this.fireN < 16) {
          const i = this.fireN++;
          this.fireX[i] = ev.tx;
          this.fireY[i] = ev.ty;
          this.fireA[i] = Math.atan2(ev.ty - ev.y, ev.tx - ev.x);
          this.fireC[i] = TOWER_COLOR[ev.tower] ?? C.paper;
        }
        break;
      }
      case 'beam': {
        // width 为格（<1）或像素；台灯的 ramp（0..1）让光束更粗更亮，group > 1 时主灯处有棱镜高光
        const col = BEAM[ev.color] ?? C.lampLight;
        const w = ev.width > 0 && ev.width < 1 ? ev.width * CELL : ev.width || 3;
        const r = ev.ramp ?? 0;
        fx.beam(P(ev.x), P(ev.y), P(ev.tx), P(ev.ty), col, Math.max(1.5, Math.min(20, w)), 0.12);
        fx.disc(P(ev.tx), P(ev.ty), 5 + 5 * r, r > 0.8 ? C.white : col, 0.12, true, 0.6 + 0.3 * r);
        if ((ev.group ?? 1) > 1 && !this.ctx.reduced) fx.disc(P(ev.x), P(ev.y), 6 + Math.min(8, ev.group ?? 1), C.white, 0.12, true, 0.55);
        break;
      }
      case 'prismLink':
        // 辅灯 → 主灯的细光线（低画质 / 减弱动效只画一条细线）
        fx.beam(P(ev.x), P(ev.y), P(ev.tx), P(ev.ty), C.lampLight, fx.low || this.ctx.reduced ? 1.5 : 2.5, 0.12);
        break;
      case 'pulse': {
        const col = PULSE[ev.color] ?? C.metal;
        fx.ring(P(ev.x), P(ev.y), P(ev.r) * 0.25, P(ev.r), col, 0.3, 4, ev.color !== 'steel' && ev.color !== 'ink');
        if (ev.color === 'steel') fx.ring(P(ev.x), P(ev.y), P(ev.r) * 0.1, P(ev.r) * 0.7, C.white, 0.22, 2);
        break;
      }
      case 'sweep':
        if (ev.arc <= 0) {
          // 毛笔：一道 r1 长的笔画
          const x0 = P(ev.x),
            y0 = P(ev.y);
          fx.stroke(x0, y0, x0 + Math.cos(ev.angle) * P(ev.r1), y0 + Math.sin(ev.angle) * P(ev.r1), C.inkBlue, 9, 0.3);
        } else {
          // 整圈攻击画成随针脚转动的扇形
          const arc = ev.arc >= Math.PI * 1.9 ? 1.0 : ev.arc;
          fx.arc(P(ev.x), P(ev.y), P(ev.r0), P(ev.r1), ev.angle, arc, C.metal, 0.16);
        }
        break;
      case 'hit': {
        const amt = Math.round(ev.amount);
        const hx = P(ev.x),
          hy = P(ev.y);
        const y = hy - 10;
        if (ev.kind === 'shield') {
          fx.disc(hx, hy, 4, C.cyan, 0.12, true);
          if (amt > 0) fx.damage(ev.enemyUid, hx, y, amt, 'shield');
        } else if (ev.crit) {
          // 暴击：大数字 + 白闪 + 只冻结这个敌人 2–3 帧
          fx.damage(ev.enemyUid, hx + (Math.random() - 0.5) * 6, y - 5, amt, 'crit');
          fx.disc(hx, hy, 10, C.white, 0.1, true, 0.9);
          fx.ring(hx, hy, 3, 17, C.goldLight, 0.2, 2.5);
          fx.sparks(hx, hy, C.goldLight, 6);
          this.enemies.hitStop(ev.enemyUid, 0.045);
        } else if (ev.kind === 'dot') {
          if (amt > 0) fx.damage(ev.enemyUid, hx, y, amt, 'dot');
        } else if (amt > 0) fx.damage(ev.enemyUid, hx, y, amt, ev.kind === 'true' ? 'warn' : 'dmg');
        // 即时命中的火花：找本 tick 开火且落点在这里的塔
        if (ev.kind !== 'dot' && this.fireTick === st.tick) {
          for (let i = 0; i < this.fireN; i++) {
            if (Math.abs(this.fireX[i] - ev.x) + Math.abs(this.fireY[i] - ev.y) < 0.4) {
              fx.sparks(hx, hy, this.fireC[i], 3, this.fireA[i], 1.5, 95);
              break;
            }
          }
        }
        break;
      }
      case 'immune':
        fx.text(P(ev.x), P(ev.y) - 14, tr('ui.render.immune'), 'info');
        break;
      case 'dodge':
        fx.text(P(ev.x), P(ev.y) - 14, tr('ui.render.dodge'), 'info');
        break;
      case 'heal':
        fx.plus(P(ev.x) + (Math.random() - 0.5) * 10, P(ev.y) - 8);
        break;
      case 'death': {
        const col = ENEMY_COLOR[ev.enemy] ?? C.paper;
        const x = P(ev.x),
          y = P(ev.y);
        const n = ev.boss ? 14 : ev.elite ? 8 : 4 + Math.floor(Math.random() * 3);
        // 碎裂 + 本体色小纸屑 + 一闪 + 影子淡出
        fx.shatter(x, y, col, n, ev.boss ? 9 : 5);
        fx.confettiOf(x, y - 2, col, ev.boss ? 14 : ev.elite ? 8 : 4);
        fx.disc(x, y, ev.boss ? 26 : ev.elite ? 13 : 9, C.white, 0.09, true, 0.75);
        fx.shadowFade(x, y + (ev.boss ? 16 : 7), ev.boss ? 54 : ev.elite ? 26 : 20, ev.boss ? 20 : 8, ev.boss ? 0.9 : 0.45);
        if (ev.elite) {
          fx.ring(x, y, 4, 28, C.white, 0.3, 3);
          fx.ring(x, y, 4, 20, C.goldLight, 0.3, 2, false, 0.06);
        }
        if (ev.gold > 0) fx.text(x, y - 14, `+${Math.round(ev.gold)}`, 'gold');
        // 赏金时刻 / 狂暴：击杀金币加成的「×2」小浮字
        if (ev.goldMul && ev.goldMul > 1 && ev.gold > 0) fx.text(x + 12, y - 24, `×${Math.round(ev.goldMul * 10) / 10}`, 'gold');
        if (ev.enemy === 'goldbag') {
          fx.coinBurst(x, y, 10);
          fx.ring(x, y, 4, 40, C.goldLight, 0.45, 4, true);
        }
        if (ev.boss) {
          // Boss：拉长的连环爆裂（全部用粒子自带的延迟，不开定时器）
          fx.ring(x, y, 10, 120, col, 0.7, 6);
          fx.ring(x, y, 10, 160, C.white, 0.9, 3, false, 0.12);
          for (let i = 0; i < 5; i++) {
            const a = i * 2.4,
              d = 10 + i * 5;
            const bx = x + Math.cos(a) * d,
              by = y + Math.sin(a) * d * 0.8;
            fx.shatter(bx, by, i % 2 ? col : C.paper, 6, 6, 0.1 + i * 0.13);
            fx.ring(bx, by, 4, 40 + i * 8, i % 2 ? C.goldLight : col, 0.45, 3, false, 0.1 + i * 0.13);
          }
          fx.confetti(x, y, 24);
          fx.confetti(x, y - 6, 16, 0.45);
          this.shake(720, 0.2);
          this.ctx.cam.flash(C.white, 0.42, 420);
        }
        break;
      }
      case 'split':
        fx.dust(P(ev.x), P(ev.y), 14, C.paper);
        break;
      case 'leak': {
        const ex = st.grid.exits.length ? P(st.grid.exits.reduce((s, e) => s + e.x + 0.5, 0) / st.grid.exits.length) : BOARD_W / 2;
        const ey = st.grid.exits.length ? P(st.grid.exits[0].y) : BOARD_H - CELL;
        if (ev.lives > 0) fx.text(ex, ey - 4, `-${ev.lives}♥`, 'goldLoss');
        // 出口笔记本：纸页翻动 + 红色脉冲（FieldLayer）
        this.field.onLeak(ev.lives);
        this.shake(140, 0.06);
        break;
      }
      case 'spawn':
        if (ev.boss) {
          const e = st.enemies.find((q) => q.uid === ev.enemyUid);
          if (e) {
            fx.ring(P(e.x), P(e.y), 10, 90, C.bad, 0.7, 5);
            fx.ring(P(e.x), P(e.y), 10, 60, C.ink, 0.5, 3, false, 0.15);
          }
          // Boss 登场：沉重的一震 + 很小的镜头推进
          this.shake(380, 0.14, 'thud');
          this.ctx.cam.punch(0.028, 460);
        }
        break;
      case 'bossSkill': {
        const x = P(ev.x),
          y = P(ev.y),
          r = P(ev.r || 1.5);
        switch (ev.skill) {
          case 'spill':
            fx.ring(x, y, r * 0.2, r, C.coffee, 0.5, 8);
            fx.disc(x, y, r, C.coffee, 0.5, false, 0.35);
            fx.shatter(x, y, C.coffee, 10, 4);
            this.shake(200, 0.07, 'thud');
            break;
          case 'shred':
            fx.shatter(x, y, C.paper, 8, 4);
            fx.confetti(x, y, 6);
            this.shake(160, 0.05);
            break;
          case 'inkShield':
            fx.ring(x, y, 8, r, C.inkBlue, 0.55, 6);
            fx.ring(x, y, 8, r, C.cyan, 0.55, 2, true, 0.08);
            break;
          case 'inkCloud':
            for (let i = 0; i < 14; i++) {
              const a = Math.random() * Math.PI * 2,
                d = Math.random() * r;
              fx.mote(x + Math.cos(a) * d, y + Math.sin(a) * d, C.inkBlue, -6, 1.2, 6 + Math.random() * 6, false);
            }
            break;
          case 'ring':
            fx.ring(x, y, 10, Math.max(BOARD_W, BOARD_H), C.alarmRed, 0.8, 6);
            fx.ring(x, y, 10, Math.max(BOARD_W, BOARD_H) * 0.8, C.goldLight, 0.8, 3, false, 0.12);
            fx.ring(x, y, 10, Math.max(BOARD_W, BOARD_H) * 0.6, C.alarmRed, 0.8, 3, false, 0.24);
            // 闹钟：长一点的嗡嗡震动
            this.shake(520, 0.11);
            break;
        }
        break;
      }
      case 'towerDisabled': {
        const t = st.towers.get(ev.uid);
        if (t) {
          fx.shatter(P(t.cx + 0.5), P(t.cy + 0.5), C.coffee, 6, 4);
          fx.disc(P(t.cx + 0.5), P(t.cy + 0.5), 22, C.coffee, 0.35, false, 0.5);
        }
        break;
      }
      case 'gold': {
        // 击杀金币由 death 事件显示
        if (ev.x === undefined || ev.y === undefined || ev.reason === 'kill') break;
        if (ev.reason === 'stolen' || ev.amount < 0) fx.text(P(ev.x), P(ev.y) - 10, `-${Math.abs(Math.round(ev.amount))}`, 'goldLoss');
        else if (ev.amount > 0) fx.text(P(ev.x), P(ev.y) - 14, `+${Math.round(ev.amount)}`, 'gold');
        break;
      }
      case 'waveStart':
        for (const s of st.grid.spawns) fx.ring(P(s.x + 0.5), P(s.y + 0.5), 4, 30, C.bad, 0.5, 3);
        break;
      case 'skill':
        this.skill(ev);
        break;
      // ── 文档 09 ──
      case 'spawnerDrop':
      case 'pickup':
      case 'autoWave':
      case 'randomEvent':
        this.field.handle(ev);
        break;
      case 'terrainChanged':
        // 背景按地形键自动重画；这里只给一点反馈
        if (ev.reason !== 'drop') this.shake(140, 0.045);
        break;
      case 'towerMoved': {
        this.towers.onMoved(ev.uid, ev.fromX, ev.fromY);
        fx.ring(P(ev.cx + 0.5), P(ev.cy + 0.5), 4, 26, C.paper, 0.35, 3);
        break;
      }
      // ── 文档 11 ──
      case 'evolve':
        this.towers.onEvolve(ev.uid, ev.stars, ev.mythic);
        break;
      case 'towerAbility': {
        abilityFx(this.ctx, this.towers, this.field, ev, (ms, k) => this.shake(ms, k));
        const t = st.towers.get(ev.uid);
        if (t?.id === 'swatter' || (!t && ev.ability.startsWith('swatter'))) {
          const br = t?.branch ?? (/_b$|_B$/.test(ev.ability) ? 'B' : 'A');
          this.swatter?.onAbility(br === 'B' ? 'B' : 'A', ev.uid);
        }
        break;
      }
      // ── 苍蝇拍 ──
      case 'swat':
        if (this.swatter) this.swatter.onSwat(ev);
        else this.towers.onSwing(ev.uid);
        break;
      case 'chain':
        this.swatter?.onChain(ev);
        break;
      default:
        break;
    }
  }

  private skill(ev: Extract<GameEvent, { type: 'skill' }>): void {
    const fx = this.ctx.fx;
    const st = this.ctx.session.world.state;
    const P = (v: number) => v * CELL;
    switch (ev.skill) {
      case 'eraser_strike': {
        const x = P(ev.x ?? (ev.cx ?? 0) + 0.5),
          y = P(ev.y ?? (ev.cy ?? 0) + 0.5),
          r = P(ev.r ?? 1.5);
        fx.eraserDrop(x, y, r);
        // 落地冲击
        fx.ring(x, y, r * 0.3, r, C.pink, 0.4, 6, false, 0.17);
        fx.ring(x, y, r * 0.5, r * 1.25, C.white, 0.4, 2, false, 0.2);
        this.ctx.scene.time.delayedCall(170, () => {
          fx.shatter(x, y, C.pink, 10, 4);
          fx.dust(x, y + 6, r * 0.8, C.paper);
          this.shake(220, 0.1, 'thud');
        });
        break;
      }
      case 'bell': {
        const x = BOARD_W / 2,
          y = BOARD_H / 2;
        for (let i = 0; i < 3; i++) fx.ring(x, y, 10, Math.hypot(BOARD_W, BOARD_H) * 0.55, C.goldLight, 0.9, 5 - i, false, i * 0.15);
        this.shake(220, 0.06);
        for (const e of st.enemies) if (!e.flying) fx.sparkle(P(e.x), P(e.y) - 12, C.goldLight, 2, 10);
        break;
      }
      case 'whiteout_zone': {
        const cx = ev.cx ?? Math.floor((ev.x ?? 1) - 1),
          cy = ev.cy ?? Math.floor((ev.y ?? 1) - 1);
        fx.rectFlash(P(cx), P(cy), CELL * 2, CELL * 2, 0xf7f7f7, 0.45);
        for (let i = 0; i < 12; i++)
          fx.mote(P(cx + 1) + (Math.random() - 0.5) * CELL * 2, P(cy + 1) + (Math.random() - 0.5) * CELL * 2, 0xffffff, -30, 0.5, 3, false);
        break;
      }
      case 'caffeine': {
        for (const t of st.towers.values()) {
          if (t.id === 'wall') continue;
          fx.ring(P(t.cx + 0.5), P(t.cy + 0.5), 4, 24, C.coffee, 0.45, 3);
          for (let i = 0; i < 2; i++) fx.mote(P(t.cx + 0.5) + (Math.random() - 0.5) * 16, P(t.cy + 0.3), C.paper, -24, 1, 3, false);
        }
        break;
      }
      case 'ruler_sweep': {
        const row = (ev.axis ?? 'row') === 'row';
        if (row) {
          const cy = ev.cy ?? Math.floor(ev.y ?? 0);
          const y = P(cy + 0.5);
          fx.sweepLine(0, y, BOARD_W, y, true, CELL * 1.3);
          fx.cell(0, P(cy), BOARD_W, CELL, C.ruler, 0.5, 0.35);
        } else {
          const cx = ev.cx ?? Math.floor(ev.x ?? 0);
          const x = P(cx + 0.5);
          fx.sweepLine(x, 0, x, BOARD_H, false, CELL * 1.3);
          fx.cell(P(cx), 0, CELL, BOARD_H, C.ruler, 0.5, 0.35);
        }
        this.shake(140, 0.05);
        break;
      }
      case 'scholarship': {
        const x = BOARD_W / 2,
          y = BOARD_H / 2;
        fx.ring(x, y, 10, 120, C.goldLight, 0.6, 5);
        for (let i = 0; i < 20; i++) {
          const a = Math.random() * Math.PI * 2,
            d = Math.random() * 60;
          fx.sparkle(x + Math.cos(a) * d, y + Math.sin(a) * d, C.goldLight, 1, 4);
        }
        fx.shatter(x, y, C.gold, 10, 5);
        break;
      }
      case 'relocate': {
        const t = ev.uid !== undefined ? st.towers.get(ev.uid) : undefined;
        if (t) fx.sparkle(P(t.cx + 0.5), P(t.cy + 0.5), C.paper, 6, 24);
        break;
      }
      case 'inspiration': {
        const t = ev.uid !== undefined ? st.towers.get(ev.uid) : undefined;
        if (t) {
          const x = P(t.cx + 0.5),
            y = P(t.cy + 0.5);
          fx.ring(x, y, 30, 6, C.goldLight, 0.4, 4);
          fx.sparkle(x, y - 6, C.goldLight, 10, 30);
          fx.text(x, y - 24, tr('ui.render.inspiration'), 'level');
        }
        break;
      }
      case 'seal_tape': {
        // 封箱胶带：在纸箱上贴一个大叉
        const sp = st.spawners?.find((q) => q.kind === 'drop' && q.cells.some((c) => c.x === ev.cx && c.y === ev.cy));
        const cells = sp?.cells ?? (ev.cx !== undefined && ev.cy !== undefined ? [{ x: ev.cx, y: ev.cy }] : []);
        if (!cells.length && ev.x !== undefined && ev.y !== undefined) cells.push({ x: Math.floor(ev.x), y: Math.floor(ev.y) });
        for (const c of cells) {
          const x = P(c.x + 0.5),
            y = P(c.y + 0.5);
          fx.stroke(x - 18, y - 18, x + 18, y + 18, C.tapeTan, 10, 0.6);
          fx.stroke(x + 18, y - 18, x - 18, y + 18, C.tapeTan, 10, 0.6);
          fx.dust(x, y, 18, C.tapeTan);
        }
        break;
      }
      case 'magnifier': {
        const x = P(ev.x ?? (ev.cx ?? 0) + 0.5),
          y = P(ev.y ?? (ev.cy ?? 0) + 0.5),
          r = P(ev.r ?? 2);
        fx.ring(x, y, r * 1.4, r, C.gold, 0.4, 4);
        fx.sparkle(x, y, C.white, 6, r);
        break;
      }
    }
  }
}
