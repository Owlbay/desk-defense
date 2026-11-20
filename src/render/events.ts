import type { GameEvent } from '../core/types';
import type { RenderCtx } from './ctx';
import { BOARD_H, BOARD_W, CELL } from './layout';
import { C, ENEMY_COLOR } from './palette';
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
  constructor(
    private ctx: RenderCtx,
    private towers: TowerLayer,
  ) {}

  private shake(ms: number, k: number): void {
    const cam = this.ctx.scene.cameras.main;
    // 强度为视口比例；按缩放修正为固定逻辑像素量
    cam.shake(ms, (k * CELL) / Math.max(1, cam.width * cam.zoom));
  }

  handle(ev: GameEvent): void {
    const fx = this.ctx.fx;
    const st = this.ctx.session.world.state;
    const P = (v: number) => v * CELL;
    switch (ev.type) {
      case 'place':
        fx.dust(P(ev.cx + 0.5), P(ev.cy + 0.5) + 12, 24);
        fx.ring(P(ev.cx + 0.5), P(ev.cy + 0.5) + 6, 6, 26, C.deskDark, 0.3, 3);
        break;
      case 'sell':
        fx.dust(P(ev.cx + 0.5), P(ev.cy + 0.5) + 8, 26, C.paper);
        fx.shatter(P(ev.cx + 0.5), P(ev.cy + 0.5), C.paper, 5, 4);
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
      case 'fire':
        this.towers.onFire(ev.uid);
        break;
      case 'beam':
        {
          // width 为格（<1）或像素
          const w = ev.width > 0 && ev.width < 1 ? ev.width * CELL : ev.width || 3;
          fx.beam(P(ev.x), P(ev.y), P(ev.tx), P(ev.ty), BEAM[ev.color] ?? C.lampLight, Math.max(1.5, Math.min(20, w)), 0.12);
        }
        fx.disc(P(ev.tx), P(ev.ty), 5, BEAM[ev.color] ?? C.lampLight, 0.12, true, 0.8);
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
        const x = P(ev.x) + (Math.random() - 0.5) * 8,
          y = P(ev.y) - 10;
        if (ev.kind === 'shield') {
          fx.disc(P(ev.x), P(ev.y), 4, C.cyan, 0.12, true);
          if (amt > 0) fx.text(x, y, String(amt), 'shield');
        } else if (ev.crit) {
          fx.text(x, y - 4, `${amt}!`, 'crit');
          fx.disc(P(ev.x), P(ev.y), 6, C.goldLight, 0.1, true);
        } else if (ev.kind === 'dot') {
          if (amt > 0) fx.text(x, y, String(amt), 'dot');
        } else if (amt > 0) fx.text(x, y, String(amt), ev.kind === 'true' ? 'warn' : 'dmg');
        break;
      }
      case 'immune':
        fx.text(P(ev.x), P(ev.y) - 14, '免疫', 'info');
        break;
      case 'dodge':
        fx.text(P(ev.x), P(ev.y) - 14, '闪避', 'info');
        break;
      case 'heal':
        fx.plus(P(ev.x) + (Math.random() - 0.5) * 10, P(ev.y) - 8);
        break;
      case 'death': {
        const col = ENEMY_COLOR[ev.enemy] ?? C.paper;
        const n = ev.boss ? 14 : ev.elite ? 8 : 4 + Math.floor(Math.random() * 3);
        fx.shatter(P(ev.x), P(ev.y), col, n, ev.boss ? 9 : 5);
        if (ev.elite) fx.ring(P(ev.x), P(ev.y), 4, 26, C.white, 0.3, 3);
        if (ev.gold > 0) fx.text(P(ev.x), P(ev.y) - 14, `+${Math.round(ev.gold)}`, 'gold');
        if (ev.boss) {
          fx.ring(P(ev.x), P(ev.y), 10, 120, col, 0.6, 6);
          fx.confetti(P(ev.x), P(ev.y), 24);
          this.shake(260, 0.15);
        }
        break;
      }
      case 'split':
        fx.dust(P(ev.x), P(ev.y), 14, C.paper);
        break;
      case 'leak': {
        for (const e of st.grid.exits) fx.cell(P(e.x), P(e.y), CELL, CELL, C.bad, 0.55, 0.5);
        const ex = st.grid.exits.length ? P(st.grid.exits.reduce((s, e) => s + e.x + 0.5, 0) / st.grid.exits.length) : BOARD_W / 2;
        const ey = st.grid.exits.length ? P(st.grid.exits[0].y) : BOARD_H - CELL;
        if (ev.lives > 0) fx.text(ex, ey - 4, `-${ev.lives}♥`, 'goldLoss');
        if (ev.stolenGold > 0 && !ev.lives) {
          /* 偷金币的数字由 gold 事件显示 */
        }
        this.shake(120, 0.06);
        break;
      }
      case 'spawn':
        if (ev.boss) {
          const e = st.enemies.find((q) => q.uid === ev.enemyUid);
          if (e) {
            fx.ring(P(e.x), P(e.y), 10, 90, C.bad, 0.7, 5);
            fx.ring(P(e.x), P(e.y), 10, 60, C.ink, 0.5, 3, false, 0.15);
          }
          this.shake(300, 0.12);
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
            break;
          case 'shred':
            fx.shatter(x, y, C.paper, 8, 4);
            fx.confetti(x, y, 6);
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
            this.shake(280, 0.12);
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
          this.shake(160, 0.08);
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
        for (let i = 0; i < 12; i++) fx.mote(P(cx + 1) + (Math.random() - 0.5) * CELL * 2, P(cy + 1) + (Math.random() - 0.5) * CELL * 2, 0xffffff, -30, 0.5, 3, false);
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
          fx.text(x, y - 24, '灵感!', 'level');
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
