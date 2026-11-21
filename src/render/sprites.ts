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
  /** 苍蝇拍·捕虫网：罩在敌人身上的网（自带颜色，不着色） */
  net: 'dd_net',
  /** 易伤准星：带四个刻度的细环 */
  reticle: 'dd_reticle',
  /** 神话光环：一圈虚线 */
  dash: 'dd_dash',
  /** 柔光（径向渐变，叠加用） */
  glow: 'dd_glow',
  /** 桌面暗角（中心透明、四周压暗，带圆角） */
  vignette: 'dd_vignette',
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
  make(scene, TEX.reticle, 128, (c, s) => {
    const m = s / 2,
      R = m - 12;
    c.strokeStyle = '#fff';
    c.lineCap = 'round';
    c.lineWidth = 7;
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2 + 0.28;
      c.beginPath();
      c.arc(m, m, R, a, a + Math.PI / 2 - 0.56);
      c.stroke();
    }
    c.lineWidth = 8;
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      c.beginPath();
      c.moveTo(m + Math.cos(a) * (R - 12), m + Math.sin(a) * (R - 12));
      c.lineTo(m + Math.cos(a) * (R + 9), m + Math.sin(a) * (R + 9));
      c.stroke();
    }
  });
  make(scene, TEX.dash, 128, (c, s) => {
    const m = s / 2,
      R = m - 6;
    c.strokeStyle = '#fff';
    c.lineCap = 'round';
    c.lineWidth = 5;
    const n = 12;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      c.beginPath();
      c.arc(m, m, R, a, a + (Math.PI / n) * 0.9);
      c.stroke();
    }
  });
  make(scene, TEX.glow, 64, (c, s) => {
    const g = c.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.45)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, s, s);
  });
  make(scene, TEX.vignette, 256, (c, s) => {
    c.save();
    c.beginPath();
    const r = s * 0.022;
    c.moveTo(r, 0);
    c.arcTo(s, 0, s, s, r);
    c.arcTo(s, s, 0, s, r);
    c.arcTo(0, s, 0, 0, r);
    c.arcTo(0, 0, s, 0, r);
    c.closePath();
    c.clip();
    const g = c.createRadialGradient(s / 2, s / 2, s * 0.28, s / 2, s / 2, s * 0.74);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,1)');
    c.fillStyle = g;
    c.fillRect(0, 0, s, s);
    c.restore();
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
  make(scene, TEX.net, 96, (c, s) => {
    const m = s / 2;
    const R = m - 6;
    // 网眼：裁成圆形的斜向交叉线，墨色描边 + 米白网线
    c.save();
    c.beginPath();
    c.arc(m, m, R, 0, Math.PI * 2);
    c.clip();
    c.fillStyle = 'rgba(244,234,210,0.18)';
    c.fillRect(0, 0, s, s);
    const step = 13;
    const lines = (w: number, col: string) => {
      c.lineWidth = w;
      c.strokeStyle = col;
      c.beginPath();
      for (let k = -s; k <= s * 2; k += step) {
        c.moveTo(k, 0);
        c.lineTo(k - s, s);
        c.moveTo(k - s, 0);
        c.lineTo(k, s);
      }
      c.stroke();
    };
    lines(4, hex(C.ink));
    lines(2, hex(C.netString));
    c.restore();
    // 网口的绳圈 + 四个坠子
    c.lineWidth = 6;
    c.strokeStyle = hex(C.ink);
    c.beginPath();
    c.arc(m, m, R, 0, Math.PI * 2);
    c.stroke();
    c.lineWidth = 3;
    c.strokeStyle = hex(C.netString);
    c.stroke();
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2;
      c.fillStyle = hex(C.steel);
      c.beginPath();
      c.arc(m + Math.cos(a) * R, m + Math.sin(a) * R, 5, 0, Math.PI * 2);
      c.fill();
      c.lineWidth = 2;
      c.strokeStyle = hex(C.ink);
      c.stroke();
    }
  });
}
