import Phaser from 'phaser';
import type { GridState, Obstacle, SpawnerState } from '../core/types';
import { B, C } from './palette';
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

/** 障碍物的稳定键（用于差异比较 / 暂时隐藏正在落下的书） */
export function obstacleKey(o: Obstacle): string {
  return `${o.kind}@${o.x},${o.y},${o.w},${o.h}`;
}

/** 背景缓存键：障碍物 + 固定出生点（边缘 / 隐藏，含开放状态）+ 出口 */
export function boardKey(grid: GridState, spawners: SpawnerState[] | undefined, hidden?: Set<string>): string {
  let k = '';
  for (const o of grid.obstacles) k += obstacleKey(o) + (hidden?.has(obstacleKey(o)) ? '~' : '') + ';';
  k += '|';
  if (spawners && spawners.length) {
    for (const sp of spawners) {
      if (sp.kind === 'drop') continue;
      k += `${sp.id}:${sp.kind}:${sp.active ? 1 : 0}:`;
      for (const c of sp.cells) k += `${c.x},${c.y} `;
      k += ';';
    }
  } else for (const c of grid.spawns) k += `${c.x},${c.y};`;
  k += '|';
  for (const c of grid.exits) k += `${c.x},${c.y};`;
  return k;
}

/**
 * 画整张桌面：底色、木纹、网格、入口、出口、障碍物。
 * spawners 为空时退回旧字段 grid.spawns（全部按边缘入口画）。
 * hidden 中的障碍物暂不画（例如正在播放下落动画的书）。
 */
export function drawBoard(
  g: Phaser.GameObjects.Graphics,
  grid: GridState,
  spawners?: SpawnerState[],
  hidden?: Set<string>,
): void {
  g.clear();
  // 投影与桌面
  g.fillStyle(B.shadow, 0.18 * B.shadowK);
  g.fillRoundedRect(4, 6, BOARD_W, BOARD_H, 12);
  g.fillStyle(B.desk, 1);
  g.fillRoundedRect(0, 0, BOARD_W, BOARD_H, 12);

  // 木纹：几条轻微波动的横线
  const r = rng(7);
  g.lineStyle(2, B.grain, 0.35);
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
    g.lineStyle(1.5, B.grain, 0.4);
    g.strokeEllipse(x, y, 18 + r() * 10, 7 + r() * 4);
    g.strokeEllipse(x, y, 8, 3);
  }

  // 网格
  g.lineStyle(1, B.grid, 0.75);
  for (let x = 1; x < grid.cols; x++) g.lineBetween(x * CELL, 2, x * CELL, BOARD_H - 2);
  for (let y = 1; y < grid.rows; y++) g.lineBetween(2, y * CELL, BOARD_W - 2, y * CELL);
  // 格点小十字（更像方格本）
  g.fillStyle(B.grid, 0.9);
  for (let x = 1; x < grid.cols; x++) for (let y = 1; y < grid.rows; y++) g.fillRect(x * CELL - 1.5, y * CELL - 1.5, 3, 3);

  if (spawners && spawners.length) {
    for (const sp of spawners) {
      if (sp.kind === 'edge') drawEntrances(g, grid, sp.cells, sp.active);
      else if (sp.kind === 'hidden') drawHiddenSpawner(g, sp.cells, sp.active);
    }
  } else drawEntrances(g, grid, grid.spawns, true);
  drawExit(g, grid);
  for (const o of grid.obstacles) if (!hidden || !hidden.has(obstacleKey(o))) drawObstacle(g, o);

  // 桌沿描边
  g.lineStyle(3, B.edge, 0.85);
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

/** 包围盒（格） */
export function cellBounds(cells: { x: number; y: number }[]): { x: number; y: number; w: number; h: number } {
  if (!cells.length) return { x: 0, y: 0, w: 1, h: 1 };
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const c of cells) {
    x0 = Math.min(x0, c.x);
    y0 = Math.min(y0, c.y);
    x1 = Math.max(x1, c.x);
    y1 = Math.max(y1, c.y);
  }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** 隐藏出生点：关闭时只是一块淡淡的"暗门"缝；开启时是一个黑洞口加两扇翻开的门 */
function drawHiddenSpawner(g: Phaser.GameObjects.Graphics, cells: { x: number; y: number }[], active: boolean): void {
  for (const b of groupCells(cells)) {
    const X = b.x * CELL,
      Y = b.y * CELL,
      W = b.w * CELL,
      H = b.h * CELL;
    if (!active) {
      // 若隐若现的方形接缝 + 两颗小铰链
      g.lineStyle(1.5, B.grid, 0.9);
      g.strokeRoundedRect(X + 6, Y + 6, W - 12, H - 12, 4);
      g.lineStyle(1, B.pit, 0.12 * B.shadowK);
      g.strokeRoundedRect(X + 7.5, Y + 7.5, W - 15, H - 15, 3);
      g.fillStyle(B.shadow, 0.18 * B.shadowK);
      g.fillCircle(X + 10, Y + H / 2 - 6, 1.6);
      g.fillCircle(X + 10, Y + H / 2 + 6, 1.6);
      g.lineStyle(1, B.grid, 0.7);
      g.lineBetween(X + W / 2, Y + 8, X + W / 2, Y + H - 8);
      continue;
    }
    // 开启：深色洞口
    g.fillStyle(B.shadow, 0.18 * B.shadowK);
    g.fillRoundedRect(X + 3, Y + 4, W - 4, H - 4, 6);
    g.fillStyle(B.pit, 0.9);
    g.fillRoundedRect(X + 6, Y + 6, W - 12, H - 12, 5);
    g.fillStyle(0x000000, 0.3);
    g.fillRoundedRect(X + 9, Y + 9, W - 18, (H - 18) * 0.5, 4);
    // 两扇翻开的门板（左右）
    g.fillStyle(B.grid, 1);
    g.lineStyle(OUT, C.ink, 1);
    g.fillRoundedRect(X + 1, Y + 6, 7, H - 12, 2);
    g.strokeRoundedRect(X + 1, Y + 6, 7, H - 12, 2);
    g.fillRoundedRect(X + W - 8, Y + 6, 7, H - 12, 2);
    g.strokeRoundedRect(X + W - 8, Y + 6, 7, H - 12, 2);
    // 紫色危险描边 + 向外的小箭头（敌人从这里出来）
    g.lineStyle(2, C.magenta, 0.7);
    g.strokeRoundedRect(X + 6, Y + 6, W - 12, H - 12, 5);
    const cx = X + W / 2,
      cy = Y + H / 2;
    g.lineStyle(2.5, C.paper, 0.75);
    for (const [dx, dy] of [
      [0, -1],
      [0, 1],
    ]) {
      g.beginPath();
      g.moveTo(cx - 6, cy + dy * 3);
      g.lineTo(cx, cy + dy * 9 + dx);
      g.lineTo(cx + 6, cy + dy * 3);
      g.strokePath();
    }
  }
}

function drawEntrances(g: Phaser.GameObjects.Graphics, grid: GridState, cells: { x: number; y: number }[], active: boolean): void {
  for (const b of groupCells(cells)) {
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
    g.fillStyle(B.pit, 0.12 * B.shadowK);
    g.fillRoundedRect(X + 2, Y + 2, W - 4, H - 4, 8);
    g.fillStyle(B.pit, active ? 0.85 : 0.4);
    g.fillRoundedRect(rx, ry - (edge === 'top' ? 8 : 0), rw, rh + (edge === 'top' || edge === 'bottom' ? 8 : 0), 8);
    g.fillStyle(0x000000, 0.25);
    g.fillRoundedRect(rx + 4, ry + (edge === 'top' ? -4 : 4), rw - 8, rh * 0.6, 6);
    if (!active) {
      // 尚未开放：两条交叉的封箱胶带
      g.lineStyle(5, C.tapeTan, 0.9);
      g.lineBetween(X + 6, Y + 6, X + W - 6, Y + H - 6);
      g.lineBetween(X + W - 6, Y + 6, X + 6, Y + H - 6);
      continue;
    }
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
    g.fillStyle(B.shadow, 0.18 * B.shadowK);
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
  g.fillStyle(B.shadow, 0.18 * B.shadowK);
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
      g.fillStyle(B.shadow, 0.18 * B.shadowK);
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
      g.fillStyle(B.shadow, 0.18 * B.shadowK);
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
      g.fillStyle(B.shadow, 0.18 * B.shadowK);
      g.fillEllipse(cx + 3, cy + 5, rw, rh);
      g.fillStyle(C.tapeTan, 1);
      g.fillEllipse(cx, cy, rw, rh);
      g.lineStyle(OUT, C.ink, 1);
      g.strokeEllipse(cx, cy, rw, rh);
      // 拇指孔
      g.fillStyle(B.desk, 1);
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
        g.fillStyle(B.shadow, 0.18 * B.shadowK);
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
    case 'eraser': {
      // 粉蓝两色橡皮，沿长边摆放
      const hor = W >= H;
      const rx = X + m + 2,
        ry = Y + m + 4,
        rw = W - 2 * m - 4,
        rh = H - 2 * m - 8;
      shadowRect(g, rx, ry, rw, rh, 6);
      g.fillStyle(C.pink, 1);
      g.fillRoundedRect(rx, ry, rw, rh, 6);
      g.fillStyle(C.blueCap, 1);
      if (hor) g.fillRect(rx + rw * 0.58, ry, rw * 0.42 - 4, rh);
      else g.fillRect(rx, ry + rh * 0.58, rw, rh * 0.42 - 4);
      g.fillStyle(C.white, 0.35);
      g.fillRoundedRect(rx + 4, ry + 3, (hor ? rw * 0.5 : rw - 8), 3, 1.5);
      g.lineStyle(OUT, C.ink, 1);
      g.strokeRoundedRect(rx, ry, rw, rh, 6);
      g.lineStyle(1.5, C.ink, 0.6);
      if (hor) g.lineBetween(rx + rw * 0.58, ry + 1, rx + rw * 0.58, ry + rh - 1);
      else g.lineBetween(rx + 1, ry + rh * 0.58, rx + rw - 1, ry + rh * 0.58);
      // 擦过的碎屑
      g.fillStyle(C.pink, 0.8);
      g.fillCircle(rx - 2, ry + rh + 3, 1.6);
      g.fillCircle(rx + 6, ry + rh + 5, 1.2);
      break;
    }
    case 'pencilcup': {
      // 俯视：深色笔筒 + 几支笔的笔尾
      const r = Math.min(W, H) / 2 - m;
      g.fillStyle(B.shadow, 0.18 * B.shadowK);
      g.fillCircle(cx + 3, cy + 5, r + 1);
      g.fillStyle(C.slate, 1);
      g.fillCircle(cx, cy, r);
      g.lineStyle(OUT, C.ink, 1);
      g.strokeCircle(cx, cy, r);
      g.fillStyle(C.ink, 0.85);
      g.fillCircle(cx, cy, r * 0.8);
      const tips = [C.pencil, C.alarmRed, C.blueCap, C.teal, C.pink, C.penBlue];
      for (let i = 0; i < tips.length; i++) {
        const a = i * 1.1 + 0.3;
        const d = r * (i % 2 ? 0.45 : 0.2);
        const px = cx + Math.cos(a) * d,
          py = cy + Math.sin(a) * d;
        const pr = r * 0.2;
        g.fillStyle(tips[i], 1);
        g.fillCircle(px, py, pr);
        g.lineStyle(1.5, C.ink, 1);
        g.strokeCircle(px, py, pr);
        g.fillStyle(C.white, 0.45);
        g.fillCircle(px - pr * 0.3, py - pr * 0.3, pr * 0.3);
      }
      g.lineStyle(2, C.white, 0.25);
      g.beginPath();
      g.arc(cx, cy, r * 0.9, Math.PI * 1.1, Math.PI * 1.5, false);
      g.strokePath();
      break;
    }
    case 'sticky': {
      // 一叠便利贴：底下两张错开，顶上一张翘角
      const s0 = Math.min(W, H) - 2 * m - 4;
      const cols2 = [C.pink, C.screen, 0xfce38a];
      for (let i = 0; i < 3; i++) {
        const ox = cx + (i - 1) * 3 - s0 / 2 + (W > H ? (i - 1) * (W - H) * 0.3 : 0);
        const oy = cy + (1 - i) * 2 - s0 / 2 + (H > W ? (i - 1) * (H - W) * 0.3 : 0);
        if (i === 0) shadowRect(g, ox, oy, s0, s0, 2);
        g.fillStyle(cols2[i], 1);
        g.fillRect(ox, oy, s0, s0);
        g.lineStyle(OUT, C.ink, 1);
        if (i < 2) g.strokeRect(ox, oy, s0, s0);
        else {
          const k = s0 * 0.28;
          const pts = [
            { x: ox, y: oy },
            { x: ox + s0, y: oy },
            { x: ox + s0, y: oy + s0 - k },
            { x: ox + s0 - k, y: oy + s0 },
            { x: ox, y: oy + s0 },
          ];
          g.fillStyle(cols2[i], 1);
          g.fillPoints(pts, true);
          g.strokePoints(pts, true);
          g.fillStyle(0xe8c95a, 1);
          g.fillTriangle(ox + s0, oy + s0 - k, ox + s0 - k, oy + s0, ox + s0 - k, oy + s0 - k);
          g.lineStyle(1.5, C.ink, 1);
          g.strokeTriangle(ox + s0, oy + s0 - k, ox + s0 - k, oy + s0, ox + s0 - k, oy + s0 - k);
          // 手写线
          g.lineStyle(1.5, C.ink, 0.45);
          for (let l = 0; l < 3; l++) g.lineBetween(ox + 5, oy + 8 + l * 7, ox + s0 - 8 - l * 4, oy + 8 + l * 7);
        }
      }
      break;
    }
    case 'phone': {
      const hor = W > H;
      const rw = W - 2 * m - (hor ? 0 : 6),
        rh = H - 2 * m - (hor ? 6 : 0);
      const rx = cx - rw / 2,
        ry = cy - rh / 2;
      shadowRect(g, rx, ry, rw, rh, 8);
      g.fillStyle(C.ink, 1);
      g.fillRoundedRect(rx, ry, rw, rh, 8);
      g.fillStyle(0x2c3e50, 1);
      g.fillRoundedRect(rx + 4, ry + 4, rw - 8, rh - 8, 5);
      // 屏幕反光
      g.fillStyle(C.blueCap, 0.35);
      g.fillTriangle(rx + 4, ry + 4, rx + rw * 0.6, ry + 4, rx + 4, ry + rh * 0.55);
      // 听筒 / 摄像头
      g.fillStyle(C.slate, 1);
      if (hor) g.fillRoundedRect(rx + 1.5, cy - 6, 2, 12, 1);
      else g.fillRoundedRect(cx - 6, ry + 1.5, 12, 2, 1);
      g.lineStyle(OUT, C.ink, 1);
      g.strokeRoundedRect(rx, ry, rw, rh, 8);
      // 一条通知
      g.fillStyle(C.paper, 0.85);
      if (hor) g.fillRoundedRect(rx + rw * 0.55, ry + 8, rw * 0.35, 8, 3);
      else g.fillRoundedRect(rx + 8, ry + rh * 0.35, rw - 16, 8, 3);
      break;
    }
    case 'ruler': {
      const hor = W >= H;
      const t = Math.min(W, H) - 2 * m - 10;
      const rx = hor ? X + m : cx - t / 2,
        ry = hor ? cy - t / 2 : Y + m;
      const rw = hor ? W - 2 * m : t,
        rh = hor ? t : H - 2 * m;
      shadowRect(g, rx, ry, rw, rh, 3);
      g.fillStyle(C.ruler, 0.95);
      g.fillRoundedRect(rx, ry, rw, rh, 3);
      g.fillStyle(C.white, 0.35);
      if (hor) g.fillRect(rx + 2, ry + rh - 6, rw - 4, 3);
      else g.fillRect(rx + rw - 6, ry + 2, 3, rh - 4);
      g.lineStyle(1.2, C.ink, 0.8);
      const L = hor ? rw : rh;
      for (let i = 1; i * 6 < L - 2; i++) {
        const tl = i % 5 === 0 ? 9 : 5;
        if (hor) g.lineBetween(rx + i * 6, ry, rx + i * 6, ry + tl);
        else g.lineBetween(rx, ry + i * 6, rx + tl, ry + i * 6);
      }
      g.lineStyle(OUT, C.ink, 1);
      g.strokeRoundedRect(rx, ry, rw, rh, 3);
      break;
    }
    case 'tape': {
      // 胶带卷：米色圆环 + 露出桌面的中心孔
      const r = Math.min(W, H) / 2 - m;
      g.fillStyle(B.shadow, 0.18 * B.shadowK);
      g.fillCircle(cx + 3, cy + 5, r);
      g.fillStyle(C.tapeTan, 1);
      g.fillCircle(cx, cy, r);
      g.lineStyle(OUT, C.ink, 1);
      g.strokeCircle(cx, cy, r);
      g.lineStyle(1, C.ink, 0.25);
      g.strokeCircle(cx, cy, r * 0.82);
      g.strokeCircle(cx, cy, r * 0.68);
      g.fillStyle(C.paper, 1);
      g.fillCircle(cx, cy, r * 0.52);
      g.lineStyle(OUT, C.ink, 1);
      g.strokeCircle(cx, cy, r * 0.52);
      g.fillStyle(B.desk, 1);
      g.fillCircle(cx, cy, r * 0.42);
      g.lineStyle(1.5, C.ink, 0.6);
      g.strokeCircle(cx, cy, r * 0.42);
      // 拉出来的一截
      g.fillStyle(C.tapeTan, 0.85);
      g.fillRect(cx + r * 0.6, cy + r * 0.55, r * 0.7, r * 0.3);
      g.lineStyle(1.5, C.ink, 0.7);
      g.strokeRect(cx + r * 0.6, cy + r * 0.55, r * 0.7, r * 0.3);
      break;
    }
    case 'stapler': {
      // 桌上的大订书机（俯视）：底座 + 上盖 + 金属压板
      const hor = W >= H;
      const t = Math.min(W, H) - 2 * m - 6;
      const rx = hor ? X + m : cx - t / 2,
        ry = hor ? cy - t / 2 : Y + m;
      const rw = hor ? W - 2 * m : t,
        rh = hor ? t : H - 2 * m;
      shadowRect(g, rx, ry, rw, rh, t / 2);
      g.fillStyle(C.slate, 1);
      g.fillRoundedRect(rx, ry, rw, rh, Math.min(t / 2, 10));
      g.lineStyle(OUT, C.ink, 1);
      g.strokeRoundedRect(rx, ry, rw, rh, Math.min(t / 2, 10));
      g.fillStyle(C.bookRed, 1);
      const ix = hor ? rx + 4 : rx + 3,
        iy = hor ? ry + 3 : ry + 4;
      const iw = hor ? rw * 0.78 : rw - 6,
        ih = hor ? rh - 6 : rh * 0.78;
      g.fillRoundedRect(ix, iy, iw, ih, Math.min(t / 2 - 3, 8));
      g.strokeRoundedRect(ix, iy, iw, ih, Math.min(t / 2 - 3, 8));
      g.fillStyle(C.metal, 1);
      if (hor) g.fillRect(ix + iw - 10, iy + 3, 6, ih - 6);
      else g.fillRect(ix + 3, iy + ih - 10, iw - 6, 6);
      g.fillStyle(C.white, 0.3);
      if (hor) g.fillRect(ix + 6, iy + 3, iw * 0.6, 3);
      else g.fillRect(ix + 3, iy + 6, 3, ih * 0.6);
      break;
    }
    case 'clip': {
      // 长尾夹：黑色梯形夹身 + 两个银色把手
      const s0 = Math.min(W, H) - 2 * m - 8;
      const bx = cx - s0 / 2,
        by = cy - s0 * 0.25;
      g.fillStyle(B.shadow, 0.18 * B.shadowK);
      g.fillRect(bx + 3, by + 5, s0, s0 * 0.55);
      g.lineStyle(3, C.metal, 1);
      g.beginPath();
      g.moveTo(bx + s0 * 0.2, by);
      g.lineTo(bx + s0 * 0.1, by - s0 * 0.4);
      g.lineTo(bx + s0 * 0.45, by - s0 * 0.4);
      g.lineTo(bx + s0 * 0.4, by);
      g.strokePath();
      g.beginPath();
      g.moveTo(bx + s0 * 0.8, by);
      g.lineTo(bx + s0 * 0.9, by - s0 * 0.4);
      g.lineTo(bx + s0 * 0.55, by - s0 * 0.4);
      g.lineTo(bx + s0 * 0.6, by);
      g.strokePath();
      const pts = [
        { x: bx + s0 * 0.12, y: by },
        { x: bx + s0 * 0.88, y: by },
        { x: bx + s0, y: by + s0 * 0.55 },
        { x: bx, y: by + s0 * 0.55 },
      ];
      g.fillStyle(0x2d2d2d, 1);
      g.fillPoints(pts, true);
      g.lineStyle(OUT, C.ink, 1);
      g.strokePoints(pts, true);
      g.fillStyle(C.white, 0.25);
      g.fillRect(bx + s0 * 0.2, by + 3, s0 * 0.5, 2.5);
      break;
    }
  }
}
