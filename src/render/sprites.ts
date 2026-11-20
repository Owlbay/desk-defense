import type Phaser from 'phaser';
import { C, hex } from './palette';

/**
 * 运行时生成的小纹理（用 Image 批量绘制状态标记，比每帧重绘 Graphics 便宜得多）。
 * 白色为主，使用时 setTint 着色。
 */
export const TEX = {
  px: 'dd_px',
  disc: 'dd_disc',
  ring: 'dd_ring',
  star: 'dd_star',
  eye: 'dd_eye',
} as const;

function make(scene: Phaser.Scene, key: string, size: number, draw: (c: CanvasRenderingContext2D, s: number) => void): void {
  if (scene.textures.exists(key)) return;
  const tex = scene.textures.createCanvas(key, size, size);
  if (!tex) return;
  const ctx = tex.getContext();
  draw(ctx, size);
  tex.refresh();
}

export function ensureSprites(scene: Phaser.Scene): void {
  make(scene, TEX.px, 4, (c) => {
    c.fillStyle = '#fff';
    c.fillRect(0, 0, 4, 4);
  });
  make(scene, TEX.disc, 64, (c, s) => {
    c.fillStyle = '#fff';
    c.beginPath();
    c.arc(s / 2, s / 2, s / 2 - 1, 0, Math.PI * 2);
    c.fill();
  });
  make(scene, TEX.ring, 128, (c, s) => {
    c.strokeStyle = '#fff';
    c.lineWidth = 8;
    c.beginPath();
    c.arc(s / 2, s / 2, s / 2 - 5, 0, Math.PI * 2);
    c.stroke();
  });
  make(scene, TEX.star, 48, (c, s) => {
    c.beginPath();
    for (let i = 0; i < 8; i++) {
      const r = i % 2 === 0 ? s / 2 - 3 : (s / 2 - 3) * 0.42;
      const a = -Math.PI / 2 + (i * Math.PI) / 4;
      const x = s / 2 + Math.cos(a) * r,
        y = s / 2 + Math.sin(a) * r;
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.closePath();
    c.fillStyle = '#fff';
    c.fill();
    c.lineWidth = 3;
    c.strokeStyle = hex(C.ink);
    c.lineJoin = 'round';
    c.stroke();
  });
  make(scene, TEX.eye, 48, (c, s) => {
    c.lineWidth = 3;
    c.strokeStyle = hex(C.ink);
    c.fillStyle = hex(C.paper);
    c.beginPath();
    c.ellipse(s / 2, s / 2, s / 2 - 3, s / 3 - 2, 0, 0, Math.PI * 2);
    c.fill();
    c.stroke();
    c.fillStyle = '#6C5B7B';
    c.beginPath();
    c.arc(s / 2, s / 2, s / 6, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = hex(C.ink);
    c.beginPath();
    c.arc(s / 2, s / 2, s / 12, 0, Math.PI * 2);
    c.fill();
  });
}
