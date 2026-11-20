import Phaser from 'phaser';

/**
 * 运行时 SVG → 纹理图集。
 * - 每个 SVG 按 <g id> 图层拆分为若干「部件」（part）：
 *   shadow / glow / turret / wing-l / wing-r 各自独立（需要单独动画）；
 *   其余连续的静态图层（base/body/accent…）合并成一个部件（static0, static1…），保持原文件顺序。
 * - 每个部件栅格化为一帧，按货架算法装入若干张图集画布，作为 Phaser CanvasTexture。
 * - 为发光层等越出 viewBox 的内容在四周留 PAD 比例的边距。
 */

const RAW = import.meta.glob('../../art/**/*.svg', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** 四周留白比例（相对 viewBox 边长） */
export const PAD = 0.125;
/** 帧显示尺寸 = viewBox 尺寸对应的格数 × (1 + 2*PAD) */
export const PAD_MUL = 1 + 2 * PAD;

const OWN_PARTS = new Set(['shadow', 'glow', 'turret', 'wing-l', 'wing-r']);

export interface PartDef {
  name: string;
  svg: string;
}

export interface AssetDef {
  name: string; // 'towers/pencil_t1'
  group: 'towers' | 'enemies' | 'affixes' | 'skills' | 'abilities';
  vb: number;
  parts: PartDef[];
}

export interface FrameRef {
  key: string;
  frame: string;
  /** 栅格化像素尺寸（正方形） */
  px: number;
}

function parseAll(): AssetDef[] {
  const out: AssetDef[] = [];
  const parser = new DOMParser();
  const ser = new XMLSerializer();
  for (const [path, raw] of Object.entries(RAW)) {
    const m = /art\/(towers|enemies|affixes|skills|abilities)\/([^/]+)\.svg$/.exec(path);
    if (!m) continue;
    const group = m[1] as AssetDef['group'];
    const name = `${group}/${m[2]}`;
    const doc = parser.parseFromString(raw, 'image/svg+xml');
    const root = doc.documentElement;
    if (!root || root.nodeName !== 'svg') continue;
    const vbAttr = (root.getAttribute('viewBox') || '0 0 128 128').trim().split(/[\s,]+/).map(Number);
    const vb = vbAttr[2] || 128;
    let defs = '';
    const parts: { name: string; nodes: string[] }[] = [];
    let staticIdx = 0;
    let lastStatic = false;
    if (group === 'affixes' || group === 'skills' || group === 'abilities') {
      // 图标：整张图作为一个部件
      const nodes: string[] = [];
      for (const ch of Array.from(root.children)) {
        if (ch.nodeName === 'defs') defs += ser.serializeToString(ch);
        else nodes.push(ser.serializeToString(ch));
      }
      parts.push({ name: 'static0', nodes });
    } else {
      for (const ch of Array.from(root.children)) {
        if (ch.nodeName === 'defs') {
          defs += ser.serializeToString(ch);
          continue;
        }
        const id = ch.getAttribute('id') || '';
        if (ch.nodeName === 'g' && ch.childElementCount === 0) continue; // 空图层
        if (OWN_PARTS.has(id)) {
          parts.push({ name: id, nodes: [ser.serializeToString(ch)] });
          lastStatic = false;
        } else {
          if (!lastStatic) {
            parts.push({ name: `static${staticIdx++}`, nodes: [] });
            lastStatic = true;
          }
          parts[parts.length - 1].nodes.push(ser.serializeToString(ch));
        }
      }
    }
    const pad = group === 'towers' || group === 'enemies' ? vb * PAD : 0;
    out.push({
      name,
      group,
      vb,
      parts: parts.map((p) => ({
        name: p.name,
        // 尺寸在栅格化时填入 width/height
        svg:
          `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
          `viewBox="${-pad} ${-pad} ${vb + 2 * pad} ${vb + 2 * pad}" width="__S__" height="__S__">` +
          defs +
          p.nodes.join('') +
          '</svg>',
      })),
    });
  }
  return out;
}

let cachedDefs: AssetDef[] | null = null;
let cachedNames: Set<string> | null = null;
export function assetDefs(): AssetDef[] {
  if (!cachedDefs) cachedDefs = parseAll();
  return cachedDefs;
}

/** 素材是否存在（如 'towers/pencil_t5a'）；新素材可能晚于代码落地，调用方据此回退 */
export function hasArt(name: string): boolean {
  if (!cachedNames) cachedNames = new Set(assetDefs().map((a) => a.name));
  return cachedNames.has(name);
}

function loadImage(svg: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}

interface Job {
  asset: string;
  part: string;
  svg: string;
  px: number;
}

/**
 * 图集：rasterize 所有素材；可按新的像素密度重建（gen 递增，视图检测到后刷新纹理）。
 */
export class ArtAtlas {
  gen = 0;
  ready = false;
  /** 一个逻辑格（48 逻辑像素）对应的栅格化像素 */
  unitPx = 0;
  private frames = new Map<string, FrameRef>();
  private partsOf = new Map<string, string[]>();
  private vbOf = new Map<string, number>();
  private keys: string[] = [];
  private building = false;
  private queued: number | null = null;

  constructor(private scene: Phaser.Scene) {
    for (const a of assetDefs()) {
      this.partsOf.set(a.name, a.parts.map((p) => p.name));
      this.vbOf.set(a.name, a.vb);
    }
  }

  has(asset: string): boolean {
    return this.partsOf.has(asset);
  }

  parts(asset: string): string[] {
    return this.partsOf.get(asset) ?? [];
  }

  /** viewBox 边长（128 / 256 / 64） */
  vb(asset: string): number {
    return this.vbOf.get(asset) ?? 128;
  }

  frame(asset: string, part: string): FrameRef | undefined {
    return this.frames.get(asset + '#' + part);
  }

  /** 请求以 unitPx 重建；构建中则排队 */
  request(unitPx: number): void {
    unitPx = Math.round(Phaser.Math.Clamp(unitPx, 32, 176));
    if (this.building) {
      this.queued = unitPx;
      return;
    }
    if (this.ready && unitPx === this.unitPx) return;
    void this.build(unitPx);
  }

  private async build(unitPx: number): Promise<void> {
    this.building = true;
    const jobs: Job[] = [];
    for (const a of assetDefs()) {
      let px: number;
      if (a.group === 'affixes') px = Math.round(unitPx * 0.32);
      else if (a.group === 'skills' || a.group === 'abilities') px = Math.round(unitPx * 0.8);
      else px = Math.round(unitPx * (a.vb / 128) * PAD_MUL);
      px = Math.max(8, Math.min(px, 440));
      for (const p of a.parts) jobs.push({ asset: a.name, part: p.name, svg: p.svg.replace(/__S__/g, String(px)), px });
    }
    const imgs = await Promise.all(jobs.map((j) => loadImage(j.svg)));
    if (!this.scene.sys || !this.scene.sys.textures) {
      this.building = false;
      return;
    }
    // 货架装箱
    const tex = this.scene.sys.textures;
    const maxTex = Math.min(4096, (this.scene.sys.game.renderer as { getMaxTextureSize?: () => number }).getMaxTextureSize?.() ?? 4096);
    const PAGE = Math.min(2048, maxTex);
    const order = jobs.map((_, i) => i).sort((a, b) => jobs[b].px - jobs[a].px);
    const gen = this.gen + 1;
    const pages: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }[] = [];
    const placed: { page: number; x: number; y: number }[] = new Array(jobs.length);
    let cx = 0,
      cy = 0,
      rowH = 0;
    const GUT = 2;
    const newPage = () => {
      const canvas = document.createElement('canvas');
      canvas.width = PAGE;
      canvas.height = PAGE;
      const ctx = canvas.getContext('2d')!;
      pages.push({ canvas, ctx });
      cx = 0;
      cy = 0;
      rowH = 0;
    };
    newPage();
    for (const i of order) {
      const s = jobs[i].px + GUT;
      if (cx + s > PAGE) {
        cx = 0;
        cy += rowH;
        rowH = 0;
      }
      if (cy + s > PAGE) newPage();
      placed[i] = { page: pages.length - 1, x: cx, y: cy };
      const img = imgs[i];
      if (img) {
        try {
          pages[pages.length - 1].ctx.drawImage(img, cx, cy, jobs[i].px, jobs[i].px);
        } catch {
          /* 忽略单张失败 */
        }
      }
      cx += s;
      rowH = Math.max(rowH, s);
    }
    // 实际高度裁剪最后一页（节省显存）
    const frames = new Map<string, FrameRef>();
    const keys: string[] = [];
    pages.forEach((p, pi) => {
      const key = `dd_art_${gen}_${pi}`;
      if (tex.exists(key)) tex.remove(key);
      const ct = tex.addCanvas(key, p.canvas);
      if (!ct) return;
      keys.push(key);
      jobs.forEach((j, i) => {
        if (placed[i].page !== pi) return;
        const fname = `${j.asset}#${j.part}`;
        ct.add(fname, 0, placed[i].x, placed[i].y, j.px, j.px);
        frames.set(fname, { key, frame: fname, px: j.px });
      });
    });
    const oldKeys = this.keys;
    this.frames = frames;
    this.keys = keys;
    this.unitPx = unitPx;
    this.gen = gen;
    this.ready = true;
    this.building = false;
    // 旧纹理延迟释放（等视图在下一帧换绑）
    if (oldKeys.length) {
      this.scene.time.delayedCall(500, () => {
        for (const k of oldKeys) if (this.scene.sys?.textures?.exists(k)) this.scene.sys.textures.remove(k);
      });
    }
    if (this.queued !== null) {
      const q = this.queued;
      this.queued = null;
      if (q !== this.unitPx) this.request(q);
    }
  }

  destroy(): void {
    this.queued = null;
  }
}
