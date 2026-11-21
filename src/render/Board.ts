import Phaser from 'phaser';

import type { Session } from '../game/Session';
import { t } from '../i18n';
import { Ambience } from './ambience';
import { ArtAtlas } from './assets';
import { boardKey, drawBoard, obstacleKey } from './background';
import type { RenderCtx } from './ctx';
import { EnemyLayer } from './enemies';
import { EventFx } from './events';
import { FieldLayer } from './field';
import { Fx } from './fx';
import { BoardInput } from './input';
import { BOARD_H, BOARD_W, CELL, DEPTH, type Quality } from './layout';
import { CameraRig, readReducedMotion } from './motion';
import { B, C, FONT, hex, onBoardTheme } from './palette';
import { ShotLayer } from './shots';
import { ensureSprites } from './sprites';
import { SwatterLayer } from './swatter';
import { TowerLayer } from './towers';

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
  private field: FieldLayer | null = null;
  private swatter: SwatterLayer | null = null;
  private ambience: Ambience | null = null;
  /** 静态桌面：画进 Graphics（不入显示列表），再烘焙到 RenderTexture，避免每帧重新细分几何 */
  private bg: Phaser.GameObjects.Graphics | null = null;
  private bgRT: Phaser.GameObjects.RenderTexture | null = null;
  private bgZoom = 0;
  private tint: Phaser.GameObjects.Graphics | null = null;
  private loading: Phaser.GameObjects.Text | null = null;
  private unsub: (() => void) | null = null;
  private unsubTheme: (() => void) | null = null;
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private boardScale = 1;
  private rasterCheckT = 0;
  private motionCheckT = 0;
  private destroyed = false;
  /** 背景缓存：快速探针（版本号等）变化时才计算完整键 */
  private bgProbe = '';
  private bgKey = '';
  private bgObstacles = new Map<string, import('../core/types').Obstacle>();

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
      reduced: readReducedMotion(),
      cam: new CameraRig(scene),
      vtime: 0,
      vdt: 0,
      rdt: 0,
      zoom: 1,
      alpha: 0,
    };
    this.ctx = ctx;
    fx.low = this.quality === 'low';
    fx.reduced = ctx.reduced;
    ctx.cam.reduced = ctx.reduced;
    ensureSprites(scene);
    this.bg = scene.make.graphics({}, false);
    this.tint = scene.add.graphics().setDepth(DEPTH.tint);
    this.ambience = new Ambience(ctx);
    this.towers = new TowerLayer(ctx);
    this.enemies = new EnemyLayer(ctx);
    this.shots = new ShotLayer(ctx);
    this.field = new FieldLayer(ctx);
    this.events = new EventFx(ctx, this.towers, this.field, this.enemies);
    this.swatter = new SwatterLayer(ctx, this.towers, this.enemies, (ms, k) => this.events?.shakeBy(ms, k));
    this.events.swatter = this.swatter;
    this.input = new BoardInput(ctx, canvas, (cx, cy) => this.clientToWorld(cx, cy), this.field);
    this.loading = scene.add
      .text(BOARD_W / 2, BOARD_H / 2, t('ui.render.loading'), {
        fontFamily: FONT,
        fontSize: '16px',
        fontStyle: 'bold',
        color: hex(B.line),
      })
      .setOrigin(0.5)
      .setDepth(DEPTH.loading);
    this.unsub = this.session.on((ev) => this.events?.handle(ev));
    // 浅色 / 深色主题切换：桌面颜色变了，重画并重新烘焙底图
    this.unsubTheme = onBoardTheme(() => {
      if (!this.destroyed) this.checkBackground(true);
    });
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

  /** 便宜的探针：地形版本、正在下落的障碍物数、固定出生点的开放状态 */
  private probe(): string {
    const st = this.session.world.state;
    let p = `${st.grid.version}|${this.field?.hiddenObstacles.size ?? 0}|${st.grid.obstacles.length}|${st.grid.spawns.length}|`;
    if (st.spawners) for (const sp of st.spawners) if (sp.kind !== 'drop') p += sp.active ? '1' : '0';
    return p;
  }

  /** 地形可能变化时检查背景键，变了才重画（并把差异交给动态层做动画） */
  private checkBackground(force = false): void {
    if (!this.bg) return;
    const pr = this.probe();
    if (!force && pr === this.bgProbe) return;
    this.bgProbe = pr;
    const st = this.session.world.state;
    const grid = st.grid;
    const hidden = this.field?.hiddenObstacles;
    let key = boardKey(grid, st.spawners, hidden);
    if (!force && key === this.bgKey) return;
    // 障碍物差异
    const next = new Map<string, (typeof grid.obstacles)[number]>();
    for (const o of grid.obstacles) next.set(obstacleKey(o), o);
    if (this.bgKey && this.field) {
      const added = [...next].filter(([k]) => !this.bgObstacles.has(k)).map(([, o]) => o);
      const removed = [...this.bgObstacles].filter(([k]) => !next.has(k)).map(([, o]) => o);
      if (added.length || removed.length) {
        this.field.terrainDiff(added, removed);
        key = boardKey(grid, st.spawners, hidden);
      }
    }
    this.bgObstacles = next;
    this.bgKey = key;
    drawBoard(this.bg, grid, st.spawners, hidden);
    this.bakeBackground(true);
  }

  private drawBackground(): void {
    this.checkBackground(true);
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
    // 基准缩放 / 居中交给镜头（震屏、缩放冲击叠加在其上）
    this.ctx.cam.setBase(zoom);
    this.ctx.zoom = zoom;
    const res = Math.min(4, Math.max(1, zoom));
    this.ctx.fx.setResolution(res);
    this.enemies?.setResolution(res);
    this.field?.setResolution(res);
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

    // 减弱动效开关（系统设置 / 应用内 html.reduce-motion）：低频轮询
    this.motionCheckT -= rdt;
    if (this.motionCheckT <= 0) {
      this.motionCheckT = 0.5;
      const red = readReducedMotion();
      if (red !== ctx.reduced) {
        ctx.reduced = red;
        ctx.fx.reduced = red;
        ctx.cam.reduced = red;
      }
    }

    // 地形变化（随机布局、书本倒下、整理、空降落地、暗门开启）时重画背景
    this.checkBackground();

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
    this.field!.sync();
    this.swatter!.sync();
    this.ambience!.sync();
    // 暂停时仍让一次性反馈（失败提示等）以真实时间播完
    ctx.fx.update(live ? ctx.vdt : rdt);
    ctx.fx.draw();
    this.input!.draw();
    ctx.cam.update(rdt);
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
    const fa = this.ctx!.cam.flashAlpha();
    if (fa > 0.004) {
      g.fillStyle(this.ctx!.cam.flashColor, fa);
      g.fillRoundedRect(0, 0, BOARD_W, BOARD_H, 12);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.ro.disconnect();
    this.unsub?.();
    this.unsubTheme?.();
    this.input?.destroy();
    this.towers?.destroy();
    this.enemies?.destroy();
    this.shots?.destroy();
    this.field?.destroy();
    this.swatter?.destroy();
    this.ambience?.destroy();
    this.ctx?.atlas.destroy();
    this.game.destroy(true);
  }
}
