import Phaser from 'phaser';
import type { Session } from '../game/Session';
import { ArtAtlas } from './assets';
import { drawBoard } from './background';
import type { RenderCtx } from './ctx';
import { EnemyLayer } from './enemies';
import { EventFx } from './events';
import { Fx } from './fx';
import { BoardInput } from './input';
import { BOARD_H, BOARD_W, CELL, DEPTH, type Quality } from './layout';
import { C, FONT, hex } from './palette';
import { ShotLayer } from './shots';
import { TowerLayer } from './towers';
import { ensureSprites } from './sprites';

class BoardScene extends Phaser.Scene {
  constructor(private board: Board) {
    super({ key: 'board' });
  }
  create(): void {
    this.board.onCreate(this);
  }
  update(_time: number, delta: number): void {
    this.board.onUpdate(delta);
  }
}

/** 一块挂载在 DOM 容器里的棋盘（Phaser 游戏实例 + 各渲染层 + 输入） */
export class Board {
  private game: Phaser.Game;
  private ro: ResizeObserver;
  private scene: Phaser.Scene | null = null;
  private ctx: RenderCtx | null = null;
  private towers: TowerLayer | null = null;
  private enemies: EnemyLayer | null = null;
  private shots: ShotLayer | null = null;
  private input: BoardInput | null = null;
  private events: EventFx | null = null;
  /** 静态桌面：画进 Graphics（不入显示列表），再烘焙到 RenderTexture，避免每帧重新细分几何 */
  private bg: Phaser.GameObjects.Graphics | null = null;
  private bgRT: Phaser.GameObjects.RenderTexture | null = null;
  private bgZoom = 0;
  private tint: Phaser.GameObjects.Graphics | null = null;
  private loading: Phaser.GameObjects.Text | null = null;
  private unsub: (() => void) | null = null;
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private boardScale = 1;
  private rasterCheckT = 0;
  private destroyed = false;
  private bgVersion = -1;

  constructor(
    private parent: HTMLElement,
    private session: Session,
    private quality: Quality,
  ) {
    this.measure();
    this.game = new Phaser.Game({
      type: Phaser.AUTO,
      parent,
      width: Math.round(this.cssW * this.dpr),
      height: Math.round(this.cssH * this.dpr),
      transparent: true,
      banner: false,
      audio: { noAudio: true },
      input: { keyboard: false, mouse: false, touch: false, gamepad: false },
      render: { antialias: true, pixelArt: false, roundPixels: false, powerPreference: 'high-performance' },
      scale: { mode: Phaser.Scale.NONE, zoom: 1 / this.dpr },
      scene: [new BoardScene(this)],
    });
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__ddBoard = this;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(parent);
  }

  private measure(): void {
    const r = this.parent.getBoundingClientRect();
    this.cssW = Math.max(1, Math.floor(r.width || this.parent.clientWidth || 1));
    this.cssH = Math.max(1, Math.floor(r.height || this.parent.clientHeight || 1));
    const cap = this.quality === 'low' ? 2 : 3;
    this.dpr = Math.max(1, Math.min(cap, window.devicePixelRatio || 1));
  }

  onCreate(scene: Phaser.Scene): void {
    if (this.destroyed) return;
    this.scene = scene;
    const canvas = this.game.canvas;
    canvas.style.display = 'block';
    const fx = new Fx(scene);
    const ctx: RenderCtx = {
      scene,
      session: this.session,
      atlas: new ArtAtlas(scene),
      fx,
      quality: this.quality,
      vtime: 0,
      vdt: 0,
      rdt: 0,
      zoom: 1,
      alpha: 0,
    };
    this.ctx = ctx;
    fx.low = this.quality === 'low';
    ensureSprites(scene);
    this.bg = scene.make.graphics({}, false);
    this.tint = scene.add.graphics().setDepth(DEPTH.tint);
    this.towers = new TowerLayer(ctx);
    this.enemies = new EnemyLayer(ctx);
    this.shots = new ShotLayer(ctx);
    this.events = new EventFx(ctx, this.towers);
    this.input = new BoardInput(ctx, canvas, (cx, cy) => this.clientToWorld(cx, cy));
    this.loading = scene.add
      .text(BOARD_W / 2, BOARD_H / 2, '加载中…', {
        fontFamily: FONT,
        fontSize: '16px',
        fontStyle: 'bold',
        color: hex(C.ink),
      })
      .setOrigin(0.5)
      .setDepth(DEPTH.loading);
    this.unsub = this.session.on((ev) => this.events?.handle(ev));
    this.resize();
    this.drawBackground();
    ctx.atlas.request(CELL * this.boardScale * this.dpr);
  }

  private clientToWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.game.canvas.getBoundingClientRect();
    const sx = ((clientX - rect.left) / Math.max(1, rect.width)) * this.game.scale.width;
    const sy = ((clientY - rect.top) / Math.max(1, rect.height)) * this.game.scale.height;
    const p = this.scene!.cameras.main.getWorldPoint(sx, sy);
    return { x: p.x, y: p.y };
  }

  private drawBackground(): void {
    if (!this.bg) return;
    const grid = this.session.world.state.grid;
    drawBoard(this.bg, grid);
    this.bgVersion = grid.obstacles.length * 1000 + grid.spawns.length * 10 + grid.exits.length;
    this.bakeBackground(true);
  }

  private bakeBackground(force = false): void {
    const scene = this.scene;
    if (!scene || !this.bg || !this.ctx) return;
    const M = 10;
    const maxTex = 4096;
    const z = Math.max(0.25, Math.min(this.ctx.zoom, maxTex / (BOARD_H + 2 * M)));
    if (!force && Math.abs(z - this.bgZoom) < 0.01) return;
    this.bgZoom = z;
    const w = Math.ceil((BOARD_W + 2 * M) * z);
    const h = Math.ceil((BOARD_H + 2 * M) * z);
    // RenderTexture.resize 在尺寸变化后不会正确更新显示尺寸（横竖屏切换时底图错位），
    // 所以每次重新烘焙都新建一张。
    this.bgRT?.destroy();
    this.bgRT = scene.add.renderTexture(-M, -M, w, h).setOrigin(0, 0).setDepth(DEPTH.bg);
    this.bg.setScale(z).setPosition(M * z, M * z);
    this.bgRT.draw(this.bg);
    this.bgRT.setScale(1 / z);
  }

  resize(): void {
    if (this.destroyed) return;
    this.measure();
    if (!this.scene || !this.ctx) return;
    const w = Math.round(this.cssW * this.dpr);
    const h = Math.round(this.cssH * this.dpr);
    const sm = this.game.scale;
    sm.zoom = 1 / this.dpr;
    sm.resize(w, h);
    const cv = this.game.canvas;
    cv.style.width = `${this.cssW}px`;
    cv.style.height = `${this.cssH}px`;
    this.boardScale = Math.min(this.cssW / BOARD_W, this.cssH / BOARD_H);
    const zoom = Math.max(0.05, this.boardScale * this.dpr);
    const cam = this.scene.cameras.main;
    cam.setSize(w, h);
    cam.setZoom(zoom);
    cam.centerOn(BOARD_W / 2, BOARD_H / 2);
    this.ctx.zoom = zoom;
    const res = Math.min(4, Math.max(1, zoom));
    this.ctx.fx.setResolution(res);
    this.enemies?.setResolution(res);
    this.loading?.setResolution(res);
    this.rasterCheckT = 0.4;
    this.bakeBackground();
  }

  setQuality(q: Quality): void {
    if (q === this.quality) return;
    this.quality = q;
    if (!this.ctx) return;
    this.ctx.quality = q;
    this.ctx.fx.low = q === 'low';
    this.resize();
    this.towers?.setQuality();
    this.enemies?.setQuality();
  }

  onUpdate(deltaMs: number): void {
    const ctx = this.ctx;
    if (!ctx || this.destroyed) return;
    const s = this.session;
    s.update(deltaMs);
    const rdt = Math.min(0.1, deltaMs / 1000);
    const st = s.world.state;
    const live = s.running && st.phase !== 'perk' && st.phase !== 'won' && st.phase !== 'lost';
    ctx.rdt = rdt;
    ctx.vdt = live ? rdt * s.speed : 0;
    ctx.vtime += ctx.vdt;
    ctx.alpha = live ? Math.max(0, Math.min(1, s.alpha)) : 1;

    // 地形（障碍物）变化时重画背景
    const grid = st.grid;
    const bv = grid.obstacles.length * 1000 + grid.spawns.length * 10 + grid.exits.length;
    if (bv !== this.bgVersion) this.drawBackground();

    // 按需重建图集（缩放/像素密度变化较大时）
    if (this.rasterCheckT > 0) {
      this.rasterCheckT -= rdt;
      if (this.rasterCheckT <= 0 && ctx.atlas.ready) {
        const want = CELL * this.boardScale * this.dpr;
        const have = ctx.atlas.unitPx;
        if (want > have * 1.25 || want < have * 0.6) ctx.atlas.request(want);
      }
    }

    if (ctx.atlas.ready && this.loading) {
      this.loading.destroy();
      this.loading = null;
    }

    ctx.fx.beginFrame();
    this.towers!.sync();
    this.enemies!.sync();
    this.shots!.sync();
    // 暂停时仍让一次性反馈（失败提示等）以真实时间播完
    ctx.fx.update(live ? ctx.vdt : rdt);
    ctx.fx.draw();
    this.input!.draw();
    this.drawTint(st.time, st.caffeineUntil);
  }

  private drawTint(now: number, caffeineUntil: number): void {
    const g = this.tint!;
    g.clear();
    if (caffeineUntil > now) {
      const k = Math.min(1, (caffeineUntil - now) / 0.6);
      const a = (0.07 + 0.03 * Math.sin(this.ctx!.vtime * 4)) * k;
      g.fillStyle(C.lamp, a);
      g.fillRoundedRect(0, 0, BOARD_W, BOARD_H, 12);
      g.lineStyle(6, C.coffee, 0.35 * k);
      g.strokeRoundedRect(3, 3, BOARD_W - 6, BOARD_H - 6, 10);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.ro.disconnect();
    this.unsub?.();
    this.input?.destroy();
    this.towers?.destroy();
    this.enemies?.destroy();
    this.shots?.destroy();
    this.ctx?.atlas.destroy();
    this.game.destroy(true);
  }
}
