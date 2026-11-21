import type Phaser from 'phaser';

import { type ArtAtlas, PAD_MUL } from './assets';
import { CELL } from './layout';

/**
 * 一组按图层拆分的 Image，挂在同一个容器里，顺序与 SVG 文件一致。
 */
export class PartSet {
  imgs = new Map<string, Phaser.GameObjects.Image>();
  order: Phaser.GameObjects.Image[] = [];
  asset = '';
  gen = -1;
  /** 一个 viewBox 单位 → 逻辑像素 */
  unit = 0;
  private baseScale = new Map<Phaser.GameObjects.Image, number>();

  constructor(
    private scene: Phaser.Scene,
    private container: Phaser.GameObjects.Container,
    private insertAt = 0,
  ) {}

  /** 绑定素材；sizeMul 为额外缩放（如小纸屑 0.6） */
  bind(atlas: ArtAtlas, asset: string, sizeMul = 1): void {
    if (!atlas.ready) return;
    if (asset === this.asset && atlas.gen === this.gen) return;
    const sameAsset = asset === this.asset;
    this.asset = asset;
    this.gen = atlas.gen;
    const vb = atlas.vb(asset);
    const logical = CELL * (vb / 128) * PAD_MUL * sizeMul;
    this.unit = (CELL / 128) * sizeMul;
    const parts = atlas.parts(asset);
    if (!sameAsset) {
      for (const img of this.order) img.destroy();
      this.imgs.clear();
      this.order = [];
      this.baseScale.clear();
      let idx = this.insertAt;
      for (const p of parts) {
        const f = atlas.frame(asset, p);
        if (!f) continue;
        const img = this.scene.add.image(0, 0, f.key, f.frame);
        const s = logical / f.px;
        img.setScale(s);
        this.baseScale.set(img, s);
        this.container.addAt(img, idx++);
        this.imgs.set(p, img);
        this.order.push(img);
      }
    } else {
      for (const p of parts) {
        const img = this.imgs.get(p);
        const f = atlas.frame(asset, p);
        if (!img || !f) continue;
        const rel = img.scaleX / (this.baseScale.get(img) || 1);
        const relY = img.scaleY / (this.baseScale.get(img) || 1);
        img.setTexture(f.key, f.frame);
        const s = logical / f.px;
        this.baseScale.set(img, s);
        img.setScale(s * rel, s * relY);
      }
    }
  }

  get(part: string): Phaser.GameObjects.Image | undefined {
    return this.imgs.get(part);
  }

  base(img: Phaser.GameObjects.Image): number {
    return this.baseScale.get(img) ?? 1;
  }

  /** 相对基准缩放设置 */
  scaleRel(img: Phaser.GameObjects.Image, sx: number, sy = sx): void {
    const b = this.base(img);
    img.setScale(b * sx, b * sy);
  }

  /** 静态部件（static* 与 shadow 以外的都算可动部件） */
  statics(): Phaser.GameObjects.Image[] {
    const out: Phaser.GameObjects.Image[] = [];
    for (const [k, v] of this.imgs) if (k.startsWith('static')) out.push(v);
    return out;
  }

  tintFill(on: boolean, color = 0xffffff): void {
    for (const img of this.order) {
      if (on) img.setTintFill(color);
      else img.clearTint();
    }
  }

  tint(color: number | null): void {
    for (const [k, img] of this.imgs) {
      if (k === 'shadow' || k === 'glow') continue;
      if (color === null) img.clearTint();
      else img.setTint(color);
    }
  }

  destroy(): void {
    for (const img of this.order) img.destroy();
    this.imgs.clear();
    this.order = [];
    this.asset = '';
  }
}
