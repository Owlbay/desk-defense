import Phaser from 'phaser';

import type { RenderCtx } from './ctx';
import { BOARD_H, BOARD_W, DEPTH } from './layout';
import { C } from './palette';
import { TEX } from './sprites';

const MOTES = 6;

/**
 * 桌面氛围（全部是 Image，几乎不花 CPU）：
 *  - 暗角：战斗中四周略微压暗，备战时放亮
 *  - 一小片暖色灯光缓慢游移（仅高画质）
 *  - 几粒在灯光里飘的灰尘（仅高画质且未减弱动效）
 */
export class Ambience {
  private vig: Phaser.GameObjects.Image;
  private light: Phaser.GameObjects.Image;
  private motes: Phaser.GameObjects.Image[] = [];
  private k = 0;
  private t = 0;

  constructor(private ctx: RenderCtx) {
    const sc = ctx.scene;
    this.vig = sc.add
      .image(BOARD_W / 2, BOARD_H / 2, TEX.vignette)
      .setDisplaySize(BOARD_W, BOARD_H)
      .setTint(C.ink)
      .setAlpha(0)
      .setDepth(DEPTH.tint - 0.6);
    this.light = sc.add
      .image(BOARD_W / 2, BOARD_H / 2, TEX.glow)
      .setTint(C.lampLight)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDisplaySize(BOARD_W * 1.1, BOARD_W * 1.1)
      .setAlpha(0)
      .setDepth(DEPTH.bg + 0.5);
    for (let i = 0; i < MOTES; i++)
      this.motes.push(
        sc.add
          .image(0, 0, TEX.disc)
          .setTint(C.white)
          .setVisible(false)
          .setDepth(DEPTH.fx - 1),
      );
  }

  sync(): void {
    const ctx = this.ctx;
    const ph = ctx.session.world.state.phase;
    const wave = ph !== 'build' && ph !== 'perk';
    // 暗角强度缓慢过渡
    this.k += ((wave ? 1 : 0) - this.k) * Math.min(1, ctx.rdt * 1.6);
    this.t += ctx.reduced ? 0 : ctx.rdt;
    const t = this.t;
    this.vig.setAlpha(0.06 + 0.15 * this.k + (ctx.reduced ? 0 : 0.015 * Math.sin(t * 0.7)));
    const high = ctx.quality === 'high';
    this.light.setVisible(high);
    if (high) {
      this.light.setPosition(BOARD_W * (0.5 + 0.22 * Math.sin(t * 0.11)), BOARD_H * (0.42 + 0.14 * Math.sin(t * 0.073 + 1)));
      this.light.setAlpha(0.1 - 0.04 * this.k);
    }
    const motes = high && !ctx.reduced;
    for (let i = 0; i < MOTES; i++) {
      const m = this.motes[i];
      if (!motes) {
        if (m.visible) m.setVisible(false);
        continue;
      }
      // 位置由时间直接算出（无状态）：缓慢斜向漂移 + 左右摆动，越界回绕
      const sp = 3 + (i % 3) * 1.6;
      const x = (((i * 0.37 + t * sp * 0.004) % 1) + 1) % 1;
      const y = (((i * 0.61 - t * sp * 0.0025) % 1) + 1) % 1;
      const tw = 0.5 + 0.5 * Math.sin(t * 0.9 + i * 2.1);
      const d = 2 + (i % 2) * 1.2;
      m.setVisible(true)
        .setPosition(x * BOARD_W + Math.sin(t * 0.5 + i) * 10, y * BOARD_H)
        .setDisplaySize(d, d)
        .setAlpha(0.12 + 0.3 * tw);
    }
  }

  destroy(): void {
    this.vig.destroy();
    this.light.destroy();
    for (const m of this.motes) m.destroy();
    this.motes = [];
  }
}
