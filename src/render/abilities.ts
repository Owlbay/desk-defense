import type { GameEvent, TowerId } from '../core/types';
import type { RenderCtx } from './ctx';
import type { FieldLayer } from './field';
import { BOARD_H, BOARD_W, CELL } from './layout';
import { C } from './palette';
import { branchColor, type TowerLayer } from './towers';

type AbilityEv = Extract<GameEvent, { type: 'towerAbility' }>;

/** 持续型能力的光环时长（与文档 11 §2 一致；只影响画面） */
const BUFF: Partial<Record<string, { dur: number; kind: 'aura' | 'spin' | 'rainbow'; color?: number }>> = {
  pencil_A: { dur: 8, kind: 'aura', color: C.goldLight },
  pencil_B: { dur: 8, kind: 'rainbow' },
  lamp_A: { dur: 8, kind: 'aura', color: C.cyan },
  compass_A: { dur: 10, kind: 'spin', color: C.metal },
  calculator_A: { dur: 12, kind: 'aura', color: C.goldLight },
};

/**
 * 神话塔主动能力（文档 11 §2，共 20 种）的释放特效。
 * 按「塔 id + 分支」识别，不依赖 core 的 ability 字符串；事件里缺的坐标从塔 / 目标敌人推出。
 * 持续区域（熔胶海、十字墨迹、全面修改）由 core 以 zone 形式给出，见 shots.ts。
 */
export function abilityFx(ctx: RenderCtx, towers: TowerLayer, field: FieldLayer, ev: AbilityEv, shake: (ms: number, k: number) => void): void {
  const st = ctx.session.world.state;
  const fx = ctx.fx;
  const t = st.towers.get(ev.uid);
  const P = (v: number) => v * CELL;
  const low = ctx.quality === 'low';
  const id: TowerId | string = t?.id ?? ev.ability.split(/[_:]/)[0];
  const br = t?.branch ?? (/_b$|_B$/.test(ev.ability) ? 'B' : 'A');
  const key = `${id}_${br}`;
  const tp = t ? towers.pos(t.uid) ?? { x: P(t.cx + 0.5), y: P(t.cy + 0.5) } : null;
  const tx = tp?.x ?? BOARD_W / 2,
    ty = tp?.y ?? BOARD_H / 2;
  const col = branchColor(br === 'B' ? 'B' : 'A');
  const target = ev.targetUid !== undefined ? st.enemies.find((e) => e.uid === ev.targetUid) : undefined;
  const targetTower = ev.targetUid !== undefined ? st.towers.get(ev.targetUid) : undefined;
  // 目标位置：事件坐标 > 目标敌人 > 目标塔 > 塔自身
  const ax = ev.x !== undefined ? P(ev.x) : target ? P(target.x) : targetTower ? P(targetTower.cx + 0.5) : tx;
  const ay = ev.y !== undefined ? P(ev.y) : target ? P(target.y) : targetTower ? P(targetTower.cy + 0.5) : ty;

  const b = BUFF[key];
  towers.onAbility(ev.uid, b ? { dur: b.dur, kind: b.kind, color: b.color ?? col } : undefined);
  // 通用：塔下的分支色冲击环
  fx.ring(tx, ty, 6, CELL * 0.9, col, 0.35, 4, true);

  switch (key) {
    case 'pencil_A': {
      // 弹幕：一圈向外喷出的石墨
      for (let i = 0; i < (low ? 8 : 16); i++) {
        const a = (i / 16) * Math.PI * 2;
        fx.bolt(tx, ty, tx + Math.cos(a) * CELL * 1.6, ty + Math.sin(a) * CELL * 1.6, C.lead, 2.5, 8, 0.25, i * 0.012);
      }
      fx.text(tx, ty - 24, '弹幕!', 'level');
      break;
    }
    case 'pencil_B': {
      const cols = [C.alarmRed, C.pencil, C.screen, C.blueCap, C.magenta];
      cols.forEach((c, i) => fx.ring(tx, ty, 6, CELL * (0.9 + i * 0.25), c, 0.5, 3, false, i * 0.06));
      fx.confetti(tx, ty - 6, low ? 6 : 14);
      fx.text(tx, ty - 24, '调色盘!', 'level');
      break;
    }
    case 'stapler_A': {
      // 连环钉：沿方向射出 12 枚
      const ang = ev.angle ?? (ev.x !== undefined ? Math.atan2(ay - ty, ax - tx) : t?.angle ?? 0);
      const L = Math.hypot(BOARD_W, BOARD_H);
      for (let i = 0; i < 12; i++) {
        const sp = (i % 3 - 1) * 0.04;
        const a = ang + sp;
        fx.bolt(tx, ty, tx + Math.cos(a) * L, ty + Math.sin(a) * L, C.metal, 3, 14, 0.55, i * 0.05);
      }
      fx.disc(tx + Math.cos(ang) * 20, ty + Math.sin(ang) * 20, 8, C.white, 0.12, true);
      shake(120, 0.05);
      break;
    }
    case 'stapler_B': {
      // 拆解：2 格内护甲护盾碎裂
      const r = P(ev.r ?? 2);
      fx.ring(tx, ty, 8, r, C.steel, 0.4, 6);
      fx.ring(tx, ty, 8, r * 0.8, C.white, 0.35, 2, false, 0.08);
      for (const e of st.enemies) {
        if (Math.hypot(P(e.x) - tx, P(e.y) - ty) > r) continue;
        fx.shatter(P(e.x), P(e.y), e.shield > 0 ? C.cyan : C.metal, 5, 3);
      }
      fx.text(tx, ty - 24, '拆解!', 'level');
      break;
    }
    case 'glue_A': {
      // 封冻：全场冒胶
      fx.ring(tx, ty, 10, Math.hypot(BOARD_W, BOARD_H), C.glue, 0.8, 8);
      fx.ring(tx, ty, 10, Math.hypot(BOARD_W, BOARD_H) * 0.8, C.blueCap, 0.8, 3, false, 0.1);
      let n = 0;
      for (const e of st.enemies) {
        if (e.flying || n++ > 60) continue;
        fx.disc(P(e.x), P(e.y) + 4, 12, C.glue, 0.5, false, 0.8);
      }
      shake(160, 0.05);
      break;
    }
    case 'glue_B': {
      // 熔胶海：3×3 区域
      const r = P(ev.r ?? 1.5);
      fx.bolt(tx, ty, ax, ay, C.lamp, 5, 16, 0.25);
      fx.ring(ax, ay, r * 0.2, r * 1.2, C.lamp, 0.5, 8, true, 0.2);
      fx.shatter(ax, ay, C.alarmRed, 10, 4);
      for (let i = 0; i < (low ? 6 : 14); i++) fx.mote(ax + (Math.random() - 0.5) * r * 2, ay + (Math.random() - 0.5) * r * 2, C.lamp, -30, 0.9, 3);
      break;
    }
    case 'lamp_A': {
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        fx.beam(tx, ty, tx + Math.cos(a) * CELL * 2.5, ty + Math.sin(a) * CELL * 2.5, C.cyan, 4, 0.3);
      }
      fx.text(tx, ty - 24, '过载!', 'level');
      break;
    }
    case 'lamp_B': {
      // 白昼：全屏一亮，之后 8 秒暖光
      fx.rectFlash(0, 0, BOARD_W, BOARD_H, C.lampLight, 0.5);
      fx.ring(tx, ty, 10, Math.hypot(BOARD_W, BOARD_H), C.lampLight, 0.7, 6, true);
      field.daylightUntil = st.time + 8;
      for (const e of st.enemies) if (e.stealthy) fx.sparkle(P(e.x), P(e.y), C.white, 2, 10);
      break;
    }
    case 'compass_A': {
      for (let i = 0; i < 3; i++) fx.arc(tx, ty, CELL * 0.6, CELL * 1.9, (i * Math.PI * 2) / 3, Math.PI * 0.6, C.metal, 0.35);
      fx.ring(tx, ty, CELL * 0.6, CELL * 1.9, C.white, 0.4, 3);
      fx.text(tx, ty - 24, '满圆!', 'level');
      break;
    }
    case 'compass_B': {
      // 深钻：钻头射线 + 螺旋
      fx.beam(tx, ty, ax, ay, C.metal, 5, 0.3);
      for (let i = 0; i < 3; i++) fx.ring(ax, ay, 22 - i * 6, 4, C.bookRed, 0.3, 3, false, i * 0.08);
      fx.later(0.15, () => {
        fx.shatter(ax, ay, C.bookRed, 8, 4);
        shake(120, 0.06);
      });
      break;
    }
    case 'eraser_A': {
      // 全面修改：沿当前路线刷一道白
      const paths = ctx.session.world.currentPaths();
      let d = 0;
      for (const p of paths.slice(0, 3)) {
        for (let i = 1; i < p.length; i++) {
          const a = p[i - 1],
            q = p[i];
          fx.bolt(P(a.x + 0.5), P(a.y + 0.5), P(q.x + 0.5), P(q.y + 0.5), C.paper, 10, CELL, 0.12, d);
          d += 0.012;
        }
      }
      fx.text(tx, ty - 24, '全面修改!', 'level');
      break;
    }
    case 'eraser_B': {
      fx.eraserDrop(ax, ay, CELL * 0.7);
      fx.later(0.17, () => {
        fx.sparkle(ax, ay - 6, C.white, 8, 22);
        fx.shatter(ax, ay, C.pink, 6, 3);
        fx.text(ax, ay - 20, '擦除', 'info');
      });
      break;
    }
    case 'ruler_A': {
      const axis = ev.axis ?? 'row';
      const idx = ev.index ?? (axis === 'row' ? Math.floor(ev.y ?? (t?.cy ?? 0)) : Math.floor(ev.x ?? (t?.cx ?? 0)));
      if (axis === 'row') {
        const y = P(idx + 0.5);
        fx.sweepLine(0, y, BOARD_W, y, true, CELL * 1.3);
        fx.cell(0, P(idx), BOARD_W, CELL, C.ruler, 0.5, 0.4);
      } else {
        const x = P(idx + 0.5);
        fx.sweepLine(x, 0, x, BOARD_H, false, CELL * 1.3);
        fx.cell(P(idx), 0, CELL, BOARD_H, C.ruler, 0.5, 0.4);
      }
      shake(200, 0.08);
      break;
    }
    case 'ruler_B': {
      // 精准测量：准星收拢到目标
      fx.ring(ax, ay, CELL * 1.2, CELL * 0.3, C.alarmRed, 0.4, 3);
      fx.ring(ax, ay, CELL * 0.9, CELL * 0.3, C.ruler, 0.4, 2, false, 0.1);
      fx.beam(tx, ty, ax, ay, C.ruler, 2, 0.25);
      fx.text(ax, ay - 22, '+40%', 'warn');
      break;
    }
    case 'pen_A': {
      // 挥毫：十字两笔
      const L = P(ev.r ?? 1.5);
      fx.stroke(ax - L, ay, ax + L, ay, C.inkBlue, 14, 0.5);
      fx.later(0.12, () => fx.stroke(ax, ay - L, ax, ay + L, C.inkBlue, 14, 0.5));
      for (let i = 0; i < (low ? 5 : 10); i++) fx.mote(ax + (Math.random() - 0.5) * L * 2, ay + (Math.random() - 0.5) * L * 2, C.inkBlue, 10, 0.6, 3, false);
      break;
    }
    case 'pen_B': {
      // 不及格：所有被标记的敌人打红叉
      let n = 0;
      for (const e of st.enemies) {
        if (e.markedUntil <= st.time || n++ > 40) continue;
        const x = P(e.x),
          y = P(e.y);
        fx.stroke(x - 9, y - 9, x + 9, y + 9, C.alarmRed, 4, 0.5);
        fx.stroke(x + 9, y - 9, x - 9, y + 9, C.alarmRed, 4, 0.5);
      }
      fx.text(BOARD_W / 2, BOARD_H * 0.45, '不及格!', 'toast');
      shake(140, 0.05);
      break;
    }
    case 'calculator_A': {
      fx.ring(tx, ty, 6, CELL * 2.5, C.goldLight, 0.5, 4, true);
      fx.sparkle(tx, ty - 6, C.goldLight, 8, 30);
      fx.text(tx, ty - 24, '精算!', 'level');
      break;
    }
    case 'calculator_B': {
      fx.beam(tx, ty, ax, ay, C.goldLight, 3, 0.3);
      fx.ring(ax, ay, 26, 6, C.goldLight, 0.4, 4);
      fx.sparkle(ax, ay - 6, C.goldLight, 8, 26);
      break;
    }
    case 'piggy_A': {
      // 砸罐：金币四溅并飞向金币栏
      fx.shatter(tx, ty, C.piggy, 10, 5);
      fx.shatter(tx, ty, C.gold, 8, 4);
      fx.confetti(tx, ty - 6, low ? 8 : 16);
      field.flyCoins(tx, ty, low ? 3 : 6);
      shake(160, 0.06);
      break;
    }
    case 'piggy_B': {
      field.vaultUntil = st.time + 10;
      for (const e of st.grid.exits) fx.ring(P(e.x + 0.5), P(e.y + 0.5), 4, CELL, C.gold, 0.5, 4);
      fx.text(tx, ty - 24, '锁门!', 'level');
      break;
    }
    case 'swatter_A': {
      // 电网：持续放电由 swatter.ts 画；这里给一次释放冲击
      fx.ring(tx, ty, 6, CELL * 2.2, C.cyan, 0.45, 4, true);
      for (const e of st.enemies) if (e.flying) fx.disc(P(e.x), P(e.y), 10, C.cyan, 0.2, true, 0.8);
      fx.text(tx, ty - 24, '电网!', 'level');
      break;
    }
    case 'swatter_B': {
      // 天网：大网下落动画由 swatter.ts 画
      fx.ring(tx, ty, 6, CELL * 1.6, C.netString, 0.4, 4);
      fx.text(tx, ty - 24, '撒网!', 'level');
      break;
    }
    default:
      fx.sparkle(ax, ay, col, 8, 26);
      break;
  }
}
