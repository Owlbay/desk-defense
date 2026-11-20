import Phaser from 'phaser';
import type { GridState, Obstacle } from '../core/types';
import { C } from './palette';
import { BOARD_H, BOARD_W, CELL } from './layout';

/** 简单可复现的伪随机（只用于装饰） */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

const OUT = 2.5;

/** 画整张桌面：底色、木纹、网格、入口、出口、障碍物 */
export function drawBoard(g: Phaser.GameObjects.Graphics, grid: GridState): void {
  g.clear();
  // 投影与桌面
  g.fillStyle(C.ink, 0.18);
  g.fillRoundedRect(4, 6, BOARD_W, BOARD_H, 12);
  g.fillStyle(C.desk, 1);
  g.fillRoundedRect(0, 0, BOARD_W, BOARD_H, 12);

  // 木纹：几条轻微波动的横线
  const r = rng(7);
  g.lineStyle(2, C.deskDark, 0.35);
  for (let i = 0; i < 18; i++) {
    const y0 = 12 + i * (BOARD_H / 18) + r() * 10;
    const amp = 2 + r() * 4;
    const ph = r() * 6;
    const x0 = r() * 60;
    const len = BOARD_W * (0.35 + r() * 0.5);
    g.beginPath();
    g.moveTo(x0, y0);
    for (let x = x0; x <= Math.min(BOARD_W - 6, x0 + len); x += 12) {
      g.lineTo(x, y0 + Math.sin(x / 60 + ph) * amp);
    }
    g.strokePath();
  }
  // 木节
  for (let i = 0; i < 4; i++) {
    const x = 40 + r() * (BOARD_W - 80);
    const y = 40 + r() * (BOARD_H - 80);
    g.lineStyle(1.5, C.deskDark, 0.4);
    g.strokeEllipse(x, y, 18 + r() * 10, 7 + r() * 4);
    g.strokeEllipse(x, y, 8, 3);
  }

  // 网格
  g.lineStyle(1, C.deskDark, 0.75);
  for (let x = 1; x < grid.cols; x++) g.lineBetween(x * CELL, 2, x * CELL, BOARD_H - 2);
  for (let y = 1; y < grid.rows; y++) g.lineBetween(2, y * CELL, BOARD_W - 2, y * CELL);
  // 格点小十字（更像方格本）
  g.fillStyle(C.deskDark, 0.9);
  for (let x = 1; x < grid.cols; x++) for (let y = 1; y < grid.rows; y++) g.fillRect(x * CELL - 1.5, y * CELL - 1.5, 3, 3);

  drawEntrances(g, grid);
  drawExit(g, grid);
  for (const o of grid.obstacles) drawObstacle(g, o);

  // 桌沿描边
  g.lineStyle(3, C.ink, 0.85);
  g.strokeRoundedRect(0, 0, BOARD_W, BOARD_H, 12);
}

/** 把相邻格合并成矩形块 */
function groupCells(cells: { x: number; y: number }[]): { x: number; y: number; w: number; h: number }[] {
  const seen = new Set<string>();
  const out: { x: number; y: number; w: number; h: number }[] = [];
  const key = (x: number, y: number) => `${x},${y}`;
  const has = new Set(cells.map((c) => key(c.x, c.y)));
  for (const c of cells) {
    if (seen.has(key(c.x, c.y))) continue;
    // 水平扩展
    let w = 1;
    while (has.has(key(c.x + w, c.y)) && !seen.has(key(c.x + w, c.y))) w++;
    let h = 1;
    if (w === 1) while (has.has(key(c.x, c.y + h)) && !seen.has(key(c.x, c.y + h))) h++;
    for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) seen.add(key(c.x + i, c.y + j));
    out.push({ x: c.x, y: c.y, w, h });
  }
  return out;
}

function edgeOf(b: { x: number; y: number; w: number; h: number }, grid: GridState): 'top' | 'bottom' | 'left' | 'right' {
  if (b.y === 0) return 'top';
  if (b.y + b.h >= grid.rows) return 'bottom';
  if (b.x === 0) return 'left';
  if (b.x + b.w >= grid.cols) return 'right';
  return 'top';
}

function drawEntrances(g: Phaser.GameObjects.Graphics, grid: GridState): void {
  for (const b of groupCells(grid.spawns)) {
    const edge = edgeOf(b, grid);
    const X = b.x * CELL,
      Y = b.y * CELL,
      W = b.w * CELL,
      H = b.h * CELL;
    // 缺口：桌沿处的深色凹槽
    const depth = 0.55;
    let rx = X + 4,
      ry = Y,
      rw = W - 8,
      rh = H * depth;
    if (edge === 'bottom') {
      ry = Y + H * (1 - depth);
    } else if (edge === 'left') {
      rx = X;
      ry = Y + 4;
      rw = W * depth;
      rh = H - 8;
    } else if (edge === 'right') {
      rx = X + W * (1 - depth);
      ry = Y + 4;
      rw = W * depth;
      rh = H - 8;
    }
    g.fillStyle(C.ink, 0.12);
    g.fillRoundedRect(X + 2, Y + 2, W - 4, H - 4, 8);
    g.fillStyle(C.ink, 0.85);
    g.fillRoundedRect(rx, ry - (edge === 'top' ? 8 : 0), rw, rh + (edge === 'top' || edge === 'bottom' ? 8 : 0), 8);
    g.fillStyle(0x000000, 0.25);
    g.fillRoundedRect(rx + 4, ry + (edge === 'top' ? -4 : 4), rw - 8, rh * 0.6, 6);
    // 向内的箭头
    const cx = X + W / 2,
      cy = Y + H / 2;
    const dir = edge === 'top' ? [0, 1] : edge === 'bottom' ? [0, -1] : edge === 'left' ? [1, 0] : [-1, 0];
    g.lineStyle(3, C.paper, 0.7);
    for (let i = 0; i < 2; i++) {
      const ox = cx + dir[0] * (6 + i * 9),
        oy = cy + dir[1] * (6 + i * 9);
      const px = -dir[1],
        py = dir[0];
      g.beginPath();
      g.moveTo(ox - px * 7 - dir[0] * 5, oy - py * 7 - dir[1] * 5);
      g.lineTo(ox, oy);
      g.lineTo(ox + px * 7 - dir[0] * 5, oy + py * 7 - dir[1] * 5);
      g.strokePath();
    }
  }
}

function drawExit(g: Phaser.GameObjects.Graphics, grid: GridState): void {
  for (const b of groupCells(grid.exits)) {
    const X = b.x * CELL + 4,
      Y = b.y * CELL + 5,
      W = b.w * CELL - 8,
      H = b.h * CELL - 8;
    // 投影
    g.fillStyle(C.ink, 0.18);
    g.fillRoundedRect(X + 3, Y + 4, W, H, 4);
    // 封面边（蓝色作业本）
    g.fillStyle(C.penBlue, 1);
    g.fillRoundedRect(X - 2, Y - 2, W + 4, H + 4, 5);
    // 纸面
    g.fillStyle(C.paper, 1);
    g.fillRoundedRect(X, Y, W, H, 3);
    // 横线
    g.lineStyle(1.2, C.blueCap, 0.6);
    for (let y = Y + 10; y < Y + H - 3; y += 6) g.lineBetween(X + 3, y, X + W - 3, y);
    // 红色页边线
    g.lineStyle(1.5, C.alarmRed, 0.6);
    g.lineBetween(X + 12, Y + 2, X + 12, Y + H - 2);
    // 中缝 + 线圈
    g.lineStyle(1.5, C.ink, 0.35);
    g.lineBetween(X + W / 2, Y + 2, X + W / 2, Y + H - 2);
    g.fillStyle(C.metal, 1);
    for (let y = Y + 5; y < Y + H - 2; y += 7) {
      g.fillCircle(X + W / 2, y, 2);
    }
    // 一颗小勾
    g.lineStyle(2.5, C.alarmRed, 0.8);
    g.beginPath();
    g.moveTo(X + W * 0.68, Y + H * 0.45);
    g.lineTo(X + W * 0.74, Y + H * 0.58);
    g.lineTo(X + W * 0.88, Y + H * 0.3);
    g.strokePath();
    g.lineStyle(OUT, C.ink, 1);
    g.strokeRoundedRect(X - 2, Y - 2, W + 4, H + 4, 5);
  }
}

function shadowRect(g: Phaser.GameObjects.Graphics, x: number, y: number, w: number, h: number, r: number): void {
  g.fillStyle(C.ink, 0.18);
  g.fillRoundedRect(x + 3, y + 5, w, h, r);
}

export function drawObstacle(g: Phaser.GameObjects.Graphics, o: Obstacle): void {
  const X = o.x * CELL,
    Y = o.y * CELL,
    W = o.w * CELL,
    H = o.h * CELL;
  const cx = X + W / 2,
    cy = Y + H / 2;
  const m = 5;
  switch (o.kind) {
    case 'cup': {
      const r = Math.min(W, H) / 2 - m;
      g.fillStyle(C.ink, 0.18);
      g.fillCircle(cx + 3, cy + 5, r + 2);
      // 把手
      g.fillStyle(C.paper, 1);
      g.lineStyle(OUT, C.ink, 1);
      const hx = cx + r * 0.75,
        hy = cy + r * 0.1;
      g.fillRoundedRect(hx, hy - r * 0.25, r * 0.6, r * 0.5, r * 0.2);
      g.strokeRoundedRect(hx, hy - r * 0.25, r * 0.6, r * 0.5, r * 0.2);
      // 杯身
      g.fillStyle(C.blueCap, 1);
      g.fillCircle(cx, cy, r);
      g.strokeCircle(cx, cy, r);
      g.fillStyle(C.paper, 1);
      g.fillCircle(cx, cy, r * 0.82);
      g.strokeCircle(cx, cy, r * 0.82);
      // 咖啡
      g.fillStyle(C.coffee, 1);
      g.fillCircle(cx, cy, r * 0.66);
      g.fillStyle(0xffffff, 0.25);
      g.fillEllipse(cx - r * 0.2, cy - r * 0.25, r * 0.5, r * 0.2);
      g.lineStyle(2, 0xffffff, 0.35);
      g.beginPath();
      g.arc(cx, cy, r * 0.9, Math.PI * 1.05, Math.PI * 1.45, false);
      g.strokePath();
      break;
    }
    case 'books': {
      const cols = [C.bookRed, C.penBlue, C.teal, C.pencil];
      const n = Math.max(2, Math.round(H / 26));
      const bh = (H - m * 2) / n;
      shadowRect(g, X + m, Y + m, W - 2 * m, H - 2 * m, 4);
      for (let i = 0; i < n; i++) {
        const inset = (i % 2) * 4 + (i === 0 ? 2 : 0);
        const bx = X + m + inset,
          by = Y + m + i * bh,
          bw = W - 2 * m - inset * 1.5;
        g.fillStyle(cols[i % cols.length], 1);
        g.fillRoundedRect(bx, by, bw, bh - 1, 3);
        // 书页边
        g.fillStyle(C.bookPage, 1);
        g.fillRect(bx + bw - 8, by + 3, 6, bh - 7);
        g.lineStyle(OUT, C.ink, 1);
        g.strokeRoundedRect(bx, by, bw, bh - 1, 3);
        g.lineStyle(1, C.ink, 0.3);
        g.lineBetween(bx + bw - 8, by + 3, bx + bw - 8, by + bh - 4);
        g.lineStyle(2, C.gold, 0.9);
        g.lineBetween(bx + 8, by + bh / 2 - 0.5, bx + Math.min(40, bw * 0.4), by + bh / 2 - 0.5);
      }
      break;
    }
    case 'keyboard': {
      shadowRect(g, X + m, Y + m, W - 2 * m, H - 2 * m, 8);
      g.fillStyle(C.slate, 1);
      g.fillRoundedRect(X + m, Y + m, W - 2 * m, H - 2 * m, 8);
      g.lineStyle(OUT, C.ink, 1);
      g.strokeRoundedRect(X + m, Y + m, W - 2 * m, H - 2 * m, 8);
      const kx0 = X + m + 6,
        ky0 = Y + m + 6;
      const kw = W - 2 * m - 12,
        kh = H - 2 * m - 12;
      const rows = Math.max(2, Math.round(kh / 13));
      const cols = Math.max(4, Math.round(kw / 13));
      const sw = kw / cols,
        sh = kh / rows;
      for (let rr = 0; rr < rows; rr++) {
        for (let cc = 0; cc < cols; cc++) {
          if (rr === rows - 1 && cc > cols * 0.25 && cc < cols * 0.75) continue;
          g.fillStyle(C.metal, 1);
          g.fillRoundedRect(kx0 + cc * sw + 1, ky0 + rr * sh + 1, sw - 2, sh - 2, 2);
          g.fillStyle(0xffffff, 0.35);
          g.fillRect(kx0 + cc * sw + 2, ky0 + rr * sh + 2, sw - 5, 1.5);
        }
      }
      // 空格键
      g.fillStyle(C.metal, 1);
      g.fillRoundedRect(kx0 + Math.ceil(cols * 0.25 + 0.01) * sw + 1, ky0 + (rows - 1) * sh + 1, (Math.floor(cols * 0.75 - 0.01) - Math.ceil(cols * 0.25 + 0.01) + 1) * sw - 2, sh - 2, 2);
      break;
    }
    case 'mouse': {
      const rw = Math.min(W - 2 * m, (H - 2 * m) * 0.7);
      const rh = Math.min(H - 2 * m, rw * 1.45);
      // 线
      g.lineStyle(3, C.ink, 0.8);
      g.beginPath();
      g.moveTo(cx, cy - rh / 2);
      g.lineTo(cx + 4, Y + 2);
      g.strokePath();
      g.fillStyle(C.ink, 0.18);
      g.fillEllipse(cx + 3, cy + 5, rw, rh);
      g.fillStyle(C.metal, 1);
      g.fillEllipse(cx, cy, rw, rh);
      g.fillStyle(C.paper, 1);
      g.fillEllipse(cx, cy + rh * 0.12, rw * 0.86, rh * 0.7);
      g.lineStyle(OUT, C.ink, 1);
      g.strokeEllipse(cx, cy, rw, rh);
      g.lineStyle(2, C.ink, 0.7);
      g.lineBetween(cx, cy - rh / 2 + 2, cx, cy - rh * 0.08);
      g.lineBetween(cx - rw / 2 + 3, cy - rh * 0.08, cx + rw / 2 - 3, cy - rh * 0.08);
      g.fillStyle(C.slate, 1);
      g.fillRoundedRect(cx - 2.5, cy - rh * 0.34, 5, 9, 2);
      break;
    }
    case 'palette': {
      const rw = W - 2 * m,
        rh = H - 2 * m;
      g.fillStyle(C.ink, 0.18);
      g.fillEllipse(cx + 3, cy + 5, rw, rh);
      g.fillStyle(C.tapeTan, 1);
      g.fillEllipse(cx, cy, rw, rh);
      g.lineStyle(OUT, C.ink, 1);
      g.strokeEllipse(cx, cy, rw, rh);
      // 拇指孔
      g.fillStyle(C.desk, 1);
      g.fillEllipse(cx + rw * 0.25, cy + rh * 0.18, rw * 0.16, rh * 0.18);
      g.strokeEllipse(cx + rw * 0.25, cy + rh * 0.18, rw * 0.16, rh * 0.18);
      const blobs = [C.alarmRed, C.pencil, C.blueCap, C.teal, C.magenta, C.paper];
      const rr = Math.min(rw, rh) * 0.11;
      blobs.forEach((c, i) => {
        const a = Math.PI * (0.85 + i * 0.25);
        const bx = cx + Math.cos(a) * rw * 0.32,
          by = cy + Math.sin(a) * rh * 0.3;
        g.fillStyle(c, 1);
        g.fillCircle(bx, by, rr);
        g.lineStyle(1.5, C.ink, 0.9);
        g.strokeCircle(bx, by, rr);
      });
      break;
    }
    case 'paint': {
      // 一排颜料管
      const n = Math.max(2, Math.round(W / 22));
      const tw = (W - 2 * m) / n;
      const cols = [C.alarmRed, C.blueCap, C.pencil, C.teal, C.magenta];
      for (let i = 0; i < n; i++) {
        const tx = X + m + i * tw + 2;
        const ty = Y + m + (i % 2) * 5;
        const th = H - 2 * m - 6;
        g.fillStyle(C.ink, 0.18);
        g.fillRoundedRect(tx + 3, ty + 5, tw - 4, th, 4);
        g.fillStyle(C.paper, 1);
        g.fillRoundedRect(tx, ty, tw - 4, th, 4);
        g.fillStyle(cols[i % cols.length], 1);
        g.fillRect(tx, ty + th * 0.35, tw - 4, th * 0.35);
        g.fillStyle(C.slate, 1);
        g.fillRoundedRect(tx + (tw - 4) * 0.2, ty - 4, (tw - 4) * 0.6, 8, 2);
        g.lineStyle(OUT, C.ink, 1);
        g.strokeRoundedRect(tx, ty, tw - 4, th, 4);
        g.strokeRoundedRect(tx + (tw - 4) * 0.2, ty - 4, (tw - 4) * 0.6, 8, 2);
        // 挤出的颜料
        g.fillStyle(cols[i % cols.length], 1);
        g.fillCircle(tx + (tw - 4) / 2, ty + th + 2, 3);
      }
      break;
    }
  }
}
