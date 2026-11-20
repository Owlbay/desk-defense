import Phaser from 'phaser';
import type { Command, PlaceCheck, SkillState, TowerId } from '../core/types';
import { ui } from '../game/UiStore';
import type { RenderCtx } from './ctx';
import { BOARD_H, BOARD_W, CELL, DEPTH } from './layout';
import { C } from './palette';
import { PartSet } from './parts';
import { dashed, towerAsset } from './towers';

type Cell = { cx: number; cy: number };
type Path = { x: number; y: number }[];

const TAP_SLOP = 12; // css px

/**
 * 棋盘上的指针输入（鼠标 + 触摸统一用 Pointer Events），并绘制交互预览：
 * 建造幽灵 / 射程 / 路线预览、技能瞄准范围、选中塔射程。
 * 交互规则见 docs/08-实现约定.md「交互」表。
 */
export class BoardInput {
  private under: Phaser.GameObjects.Graphics;
  private over: Phaser.GameObjects.Graphics;
  private ghostRoot: Phaser.GameObjects.Container;
  private ghost: PartSet;
  /** 鼠标悬停位置（格，浮点） */
  private hoverPos: { x: number; y: number } | null = null;
  private down: { id: number; x: number; y: number; type: string; button: number } | null = null;
  private cache = {
    key: '',
    checkT: 0,
    check: null as PlaceCheck | null,
    preview: null as Path[] | null,
    curVersion: -1,
    current: [] as Path[],
  };
  private off: (() => void)[] = [];

  constructor(
    private ctx: RenderCtx,
    private canvas: HTMLCanvasElement,
    /** 客户端坐标 → 逻辑像素 */
    private toWorld: (clientX: number, clientY: number) => { x: number; y: number },
  ) {
    const sc = ctx.scene;
    this.under = sc.add.graphics().setDepth(DEPTH.inputUnder);
    this.over = sc.add.graphics().setDepth(DEPTH.inputOver);
    this.ghostRoot = sc.add.container(0, 0).setDepth(DEPTH.ghost).setAlpha(0.6).setVisible(false);
    this.ghost = new PartSet(sc, this.ghostRoot);

    canvas.style.touchAction = 'none';
    canvas.style.userSelect = 'none';
    (canvas.style as unknown as Record<string, string>).webkitUserSelect = 'none';
    (canvas.style as unknown as Record<string, string>).webkitTouchCallout = 'none';
    (canvas.style as unknown as Record<string, string>).webkitTapHighlightColor = 'transparent';
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      canvas.addEventListener(type, fn as EventListener, opts);
      this.off.push(() => canvas.removeEventListener(type, fn as EventListener, opts));
    };
    on('contextmenu', (e) => e.preventDefault());
    on('pointerdown', (e) => this.onDown(e));
    on('pointermove', (e) => this.onMove(e));
    on('pointerup', (e) => this.onUp(e));
    on('pointercancel', () => (this.down = null));
    on('pointerleave', (e) => {
      if (e.pointerType === 'mouse') {
        this.hoverPos = null;
        ui.set({ hover: null });
      }
    });
    // iOS：阻止双击缩放与长按菜单
    on('touchstart', (e) => e.preventDefault(), { passive: false });
    on('dblclick', (e) => e.preventDefault());
  }

  // ───────────── 坐标 ─────────────

  private cellAt(clientX: number, clientY: number): { cell: Cell | null; pos: { x: number; y: number } } {
    const p = this.toWorld(clientX, clientY);
    const pos = { x: p.x / CELL, y: p.y / CELL };
    const g = this.ctx.session.world.state.grid;
    const cx = Math.floor(pos.x),
      cy = Math.floor(pos.y);
    const inside = cx >= 0 && cy >= 0 && cx < g.cols && cy < g.rows;
    return { cell: inside ? { cx, cy } : null, pos };
  }

  private towerAt(c: Cell | null): number {
    if (!c) return 0;
    const g = this.ctx.session.world.state.grid;
    return g.towerAt[c.cy * g.cols + c.cx] || 0;
  }

  // ───────────── 事件 ─────────────

  private onDown(e: PointerEvent): void {
    const touch = e.pointerType !== 'mouse' && e.pointerType !== 'pen';
    if (ui.state.touch !== touch) ui.set({ touch });
    if (e.button === 2) {
      e.preventDefault();
      this.cancel();
      return;
    }
    if (e.button !== 0) return;
    this.down = { id: e.pointerId, x: e.clientX, y: e.clientY, type: e.pointerType, button: e.button };
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  private onMove(e: PointerEvent): void {
    if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') return; // 触摸不依赖悬停
    if (ui.state.touch) ui.set({ touch: false });
    const { cell, pos } = this.cellAt(e.clientX, e.clientY);
    this.hoverPos = cell ? pos : null;
    const h = ui.state.hover;
    if (!cell) {
      if (h) ui.set({ hover: null });
    } else if (!h || h.cx !== cell.cx || h.cy !== cell.cy) ui.set({ hover: cell });
  }

  private onUp(e: PointerEvent): void {
    const d = this.down;
    this.down = null;
    if (!d || d.id !== e.pointerId) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_SLOP) return;
    const touch = d.type !== 'mouse' && d.type !== 'pen';
    const { cell, pos } = this.cellAt(e.clientX, e.clientY);
    this.click(cell, pos, touch);
  }

  /** 右键 / 取消 */
  private cancel(): void {
    const s = ui.state;
    if (s.aiming) ui.set({ aiming: null, pending: null, relocateFrom: null });
    else if (s.build) ui.set({ build: null, pending: null });
    else if (s.perkTargeting) ui.set({ perkTargeting: null });
    else if (s.selected !== null) ui.set({ selected: null });
    else ui.set({ pending: null });
  }

  private same(a: Cell | null, b: Cell | null): boolean {
    return !!a && !!b && a.cx === b.cx && a.cy === b.cy;
  }

  private click(cell: Cell | null, pos: { x: number; y: number }, touch: boolean): void {
    const s = ui.state;
    const session = this.ctx.session;
    if (s.aiming) {
      this.clickAim(cell, pos, touch);
      return;
    }
    if (s.perkTargeting) {
      const uid = this.towerAt(cell);
      if (!uid) {
        if (cell) this.fail(cell, '请选择一座塔');
        return;
      }
      const r = session.command({ type: 'choosePerk', id: s.perkTargeting, uid });
      if (r.ok) ui.set({ perkTargeting: null, selected: uid });
      else this.fail(cell!, r.reason);
      return;
    }
    if (s.build) {
      if (!cell) {
        // 触摸：点棋盘外空白处取消
        if (touch) ui.set({ build: null, pending: null });
        return;
      }
      if (touch && !this.same(s.pending, cell)) {
        ui.set({ pending: cell, hover: cell });
        return;
      }
      const r = session.command({ type: 'place', tower: s.build, cx: cell.cx, cy: cell.cy });
      if (!r.ok) {
        this.fail(cell, r.reason);
        if (touch) ui.set({ pending: null });
      } else {
        ui.set({ pending: null });
        this.cache.key = '';
      }
      return;
    }
    // 普通：选塔 / 取消选择
    const uid = this.towerAt(cell);
    ui.set({ selected: uid || null, pending: null });
  }

  private skill(): SkillState | undefined {
    const id = ui.state.aiming;
    return id ? this.ctx.session.world.state.skills.find((k) => k.id === id) : undefined;
  }

  private clickAim(cell: Cell | null, pos: { x: number; y: number }, touch: boolean): void {
    const s = ui.state;
    const sk = this.skill();
    if (!sk) {
      ui.set({ aiming: null, pending: null, relocateFrom: null });
      return;
    }
    const g = this.ctx.session.world.state.grid;
    const cast = (extra: Partial<Extract<Command, { type: 'cast' }>>, at: Cell | null) => {
      const r = this.ctx.session.command({ type: 'cast', skill: sk.id, ...extra });
      if (r.ok) ui.set({ aiming: null, pending: null, relocateFrom: null });
      else {
        if (at) this.fail(at, r.reason);
        else this.toastCenter(r.reason);
        ui.set({ pending: null });
      }
    };
    // 两步确认（触摸）：第一次点设 pending，再点同一格执行
    const needConfirm = (c: Cell) => {
      if (!touch) return false;
      if (this.same(s.pending, c)) return false;
      ui.set({ pending: c, hover: c });
      return true;
    };
    switch (sk.target) {
      case 'none':
        cast({}, cell);
        return;
      case 'circle': {
        if (!cell) {
          if (touch) ui.set({ aiming: null, pending: null });
          return;
        }
        if (needConfirm(cell)) return;
        const x = touch ? cell.cx + 0.5 : Phaser.Math.Clamp(pos.x, 0, g.cols);
        const y = touch ? cell.cy + 0.5 : Phaser.Math.Clamp(pos.y, 0, g.rows);
        cast({ x, y, cx: cell.cx, cy: cell.cy }, cell);
        return;
      }
      case 'rect2': {
        if (!cell) {
          if (touch) ui.set({ aiming: null, pending: null });
          return;
        }
        if (needConfirm(cell)) return;
        const r = this.rectOrigin(cell);
        cast({ cx: r.cx, cy: r.cy, x: r.cx + 1, y: r.cy + 1 }, cell);
        return;
      }
      case 'line': {
        if (!cell) {
          if (touch) ui.set({ aiming: null, pending: null });
          return;
        }
        if (needConfirm(cell)) return;
        cast({ axis: s.aimAxis, cx: cell.cx, cy: cell.cy, x: cell.cx + 0.5, y: cell.cy + 0.5 }, cell);
        return;
      }
      case 'tower': {
        const uid = this.towerAt(cell);
        if (!uid) {
          if (cell) this.fail(cell, '请选择一座塔');
          else if (touch) ui.set({ aiming: null, pending: null });
          return;
        }
        if (needConfirm(cell!)) return;
        cast({ uid }, cell);
        return;
      }
      case 'tower+cell': {
        const uid = this.towerAt(cell);
        if (s.relocateFrom === null) {
          if (!uid) {
            if (cell) this.fail(cell, '先选择要搬的塔');
            else if (touch) ui.set({ aiming: null, pending: null });
            return;
          }
          ui.set({ relocateFrom: uid, pending: null });
          return;
        }
        if (!cell) {
          if (touch) ui.set({ relocateFrom: null, pending: null });
          return;
        }
        if (uid) {
          ui.set({ relocateFrom: uid === s.relocateFrom ? null : uid, pending: null });
          return;
        }
        if (needConfirm(cell)) return;
        cast({ uid: s.relocateFrom, cx: cell.cx, cy: cell.cy }, cell);
        return;
      }
    }
  }

  private rectOrigin(c: Cell): Cell {
    const g = this.ctx.session.world.state.grid;
    // 2×2 的左上角：指针所在格偏向指针所在的象限
    let cx = c.cx,
      cy = c.cy;
    const hp = this.hoverPos;
    if (hp && !ui.state.touch && Math.floor(hp.x) === c.cx && Math.floor(hp.y) === c.cy) {
      if (hp.x - c.cx < 0.5) cx -= 1;
      if (hp.y - c.cy < 0.5) cy -= 1;
    } else {
      cx -= 0;
      cy -= 0;
    }
    return { cx: Phaser.Math.Clamp(cx, 0, g.cols - 2), cy: Phaser.Math.Clamp(cy, 0, g.rows - 2) };
  }

  /** 失败反馈：格子闪红 + 文字 */
  fail(cell: Cell, reason?: string): void {
    const fx = this.ctx.fx;
    fx.cell(cell.cx * CELL, cell.cy * CELL, CELL, CELL, C.bad, 0.5, 0.55);
    if (reason) {
      const x = Phaser.Math.Clamp((cell.cx + 0.5) * CELL, 70, BOARD_W - 70);
      const y = Math.max(24, cell.cy * CELL - 2);
      fx.text(x, y, reason, 'toast');
    }
  }

  private toastCenter(reason?: string): void {
    if (reason) this.ctx.fx.text(BOARD_W / 2, BOARD_H / 2, reason, 'toast');
  }

  // ───────────── 每帧绘制 ─────────────

  draw(): void {
    const ug = this.under,
      og = this.over;
    ug.clear();
    og.clear();
    const s = ui.state;
    const world = this.ctx.session.world;
    const st = world.state;
    const rt = performance.now() / 1000;
    let ghostAsset: string | null = null;
    let ghostCell: Cell | null = null;
    let ghostOk = true;

    // 选中塔的射程
    if (s.selected !== null && !s.build && !s.aiming) {
      const tw = st.towers.get(s.selected);
      const info = tw ? world.getTowerInfo(s.selected) : null;
      if (tw && info) {
        const x = (tw.cx + 0.5) * CELL,
          y = (tw.cy + 0.5) * CELL;
        this.rangeRings(ug, x, y, info.range, info.innerRange, info.auraRange, rt);
      }
    }

    const focus: Cell | null = s.touch ? s.pending : s.hover;

    if (s.aiming) {
      const sk = this.skill();
      if (sk) this.drawAim(ug, og, sk, focus, rt);
      if (sk?.target === 'tower+cell' && s.relocateFrom !== null && focus && !this.towerAt(focus)) {
        const tw = st.towers.get(s.relocateFrom);
        if (tw) {
          ghostAsset = towerAsset(tw);
          ghostCell = focus;
          ghostOk = world.canPlace(tw.id, focus.cx, focus.cy).ok;
          const br = world.baseRange(tw.id);
          if (br.range > 0) this.rangeRings(ug, (focus.cx + 0.5) * CELL, (focus.cy + 0.5) * CELL, br.range, br.inner, br.aura, rt, 0.6);
          dashed(og, (tw.cx + 0.5) * CELL, (tw.cy + 0.5) * CELL, (focus.cx + 0.5) * CELL, (focus.cy + 0.5) * CELL, C.paper, 2, 6, 5, (rt * 20) % 11);
        }
      }
    } else if (s.perkTargeting) {
      // 高亮所有塔
      for (const tw of st.towers.values()) {
        if (tw.id === 'wall') continue;
        const pulse = 0.5 + 0.5 * Math.sin(rt * 5);
        og.lineStyle(2.5, C.magenta, 0.5 + 0.4 * pulse);
        og.strokeRoundedRect(tw.cx * CELL + 3, tw.cy * CELL + 3, CELL - 6, CELL - 6, 8);
      }
      if (focus && this.towerAt(focus)) {
        og.lineStyle(3, C.white, 1);
        og.strokeRoundedRect(focus.cx * CELL + 1, focus.cy * CELL + 1, CELL - 2, CELL - 2, 9);
      }
    } else if (s.build) {
      const id: TowerId = s.build;
      // 当前路线
      if (this.cache.curVersion !== st.grid.version) {
        this.cache.curVersion = st.grid.version;
        this.cache.current = world.currentPaths();
        this.cache.key = '';
      }
      if (focus) {
        const key = `${id}|${focus.cx}|${focus.cy}|${st.grid.version}`;
        this.cache.checkT -= this.ctx.rdt;
        if (key !== this.cache.key || this.cache.checkT <= 0) {
          this.cache.key = key;
          this.cache.checkT = 0.2;
          this.cache.check = world.canPlace(id, focus.cx, focus.cy);
          this.cache.preview = this.cache.check.ok ? world.previewPath(id, focus.cx, focus.cy) : null;
        }
      }
      const pv = focus ? this.cache.preview : null;
      for (const p of this.cache.current) this.drawPath(ug, p, C.ink, pv ? 0.22 : 0.4, true, rt);
      if (pv) for (const p of pv) this.drawPath(ug, p, C.teal, 0.85, false, rt);
      if (focus) {
        const ok = !!this.cache.check?.ok;
        ghostAsset = towerAsset({ id, tier: 1, branch: null, level: 1 });
        ghostCell = focus;
        ghostOk = ok;
        const x = focus.cx * CELL,
          y = focus.cy * CELL;
        ug.fillStyle(ok ? C.screen : C.bad, ok ? 0.45 : 0.4);
        ug.fillRoundedRect(x + 1, y + 1, CELL - 2, CELL - 2, 6);
        og.lineStyle(2.5, ok ? C.teal : C.bad, 0.95);
        og.strokeRoundedRect(x + 1, y + 1, CELL - 2, CELL - 2, 6);
        const br = world.baseRange(id);
        if (br.range > 0) this.rangeRings(ug, x + CELL / 2, y + CELL / 2, br.range, br.inner, br.aura, rt, ok ? 1 : 0.5);
        if (s.touch && s.pending) {
          // 触摸：提示再点一次确认
          const pulse = 0.5 + 0.5 * Math.sin(rt * 6);
          og.lineStyle(2, C.white, 0.5 + 0.5 * pulse);
          og.strokeRoundedRect(x - 2, y - 2, CELL + 4, CELL + 4, 9);
        }
      }
    }

    // 幽灵塔
    if (ghostAsset && ghostCell && this.ctx.atlas.ready) {
      this.ghost.bind(this.ctx.atlas, ghostAsset);
      this.ghostRoot.setVisible(true);
      this.ghostRoot.setPosition((ghostCell.cx + 0.5) * CELL, (ghostCell.cy + 0.5) * CELL);
      for (const img of this.ghost.order) {
        if (ghostOk) img.clearTint();
        else img.setTint(0xff8080);
      }
      const glow = this.ghost.get('glow');
      if (glow) glow.setVisible(false);
    } else this.ghostRoot.setVisible(false);
  }

  private rangeRings(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    range: number,
    inner: number | undefined,
    aura: number | undefined,
    rt: number,
    alpha = 1,
  ): void {
    if (range > 0) {
      const r = range * CELL;
      g.fillStyle(C.white, 0.12 * alpha);
      g.fillCircle(x, y, r);
      g.lineStyle(2, C.paper, 0.9 * alpha);
      g.strokeCircle(x, y, r);
      g.lineStyle(1, C.ink, 0.35 * alpha);
      g.strokeCircle(x, y, r + 1.5);
    }
    if (inner && inner > 0) {
      const r = inner * CELL;
      g.fillStyle(C.ink, 0.1 * alpha);
      g.fillCircle(x, y, r);
      dashCircle(g, x, y, r, C.ink, 1.5, 0.6 * alpha, rt * 0.3);
    }
    if (aura && aura > 0) {
      const r = aura * CELL;
      g.fillStyle(C.screen, 0.12 * alpha);
      g.fillCircle(x, y, r);
      dashCircle(g, x, y, r, C.teal, 2, 0.85 * alpha, rt * 0.4);
    }
  }

  private drawPath(g: Phaser.GameObjects.Graphics, path: Path, color: number, alpha: number, dash: boolean, rt: number): void {
    if (path.length < 2) return;
    if (dash) {
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1],
          b = path[i];
        dashed(g, (a.x + 0.5) * CELL, (a.y + 0.5) * CELL, (b.x + 0.5) * CELL, (b.y + 0.5) * CELL, color, 2.5, 5, 5, 0, alpha);
      }
      return;
    }
    g.lineStyle(4, color, alpha);
    g.beginPath();
    g.moveTo((path[0].x + 0.5) * CELL, (path[0].y + 0.5) * CELL);
    for (let i = 1; i < path.length; i++) g.lineTo((path[i].x + 0.5) * CELL, (path[i].y + 0.5) * CELL);
    g.strokePath();
    // 流动的小点表示方向
    const n = path.length;
    const speed = 3; // 格/秒
    const total = n - 1;
    for (let k = 0; k < total; k += 2) {
      const f = (k + ((rt * speed) % 2)) % total;
      const i = Math.floor(f),
        fr = f - i;
      const a = path[i],
        b = path[Math.min(n - 1, i + 1)];
      g.fillStyle(C.paper, alpha);
      g.fillCircle((a.x + (b.x - a.x) * fr + 0.5) * CELL, (a.y + (b.y - a.y) * fr + 0.5) * CELL, 2.5);
    }
  }

  private drawAim(ug: Phaser.GameObjects.Graphics, og: Phaser.GameObjects.Graphics, sk: SkillState, focus: Cell | null, rt: number): void {
    const s = ui.state;
    const st = this.ctx.session.world.state;
    const g = st.grid;
    const col = C.alarmRed;
    const pulse = 0.5 + 0.5 * Math.sin(rt * 6);
    const confirm = s.touch && !!s.pending;
    switch (sk.target) {
      case 'circle': {
        if (!focus) return;
        const hp = !s.touch && this.hoverPos ? this.hoverPos : { x: focus.cx + 0.5, y: focus.cy + 0.5 };
        const x = hp.x * CELL,
          y = hp.y * CELL,
          r = (sk.radius ?? 1.5) * CELL;
        ug.fillStyle(col, 0.16 + 0.06 * pulse);
        ug.fillCircle(x, y, r);
        og.lineStyle(2.5, col, 0.9);
        og.strokeCircle(x, y, r);
        dashCircle(og, x, y, r + 4, C.white, 1.5, 0.6, rt * 0.8);
        og.lineStyle(2, C.white, 0.9);
        og.lineBetween(x - 6, y, x + 6, y);
        og.lineBetween(x, y - 6, x, y + 6);
        if (confirm) og.strokeCircle(x, y, r + 8 + pulse * 3);
        return;
      }
      case 'rect2': {
        if (!focus) return;
        const o = this.rectOrigin(focus);
        const x = o.cx * CELL,
          y = o.cy * CELL;
        ug.fillStyle(C.whiteoutBlue, 0.18 + 0.08 * pulse);
        ug.fillRect(x, y, CELL * 2, CELL * 2);
        og.lineStyle(2.5, C.whiteoutBlue, 0.95);
        og.strokeRect(x + 1, y + 1, CELL * 2 - 2, CELL * 2 - 2);
        if (confirm) {
          og.lineStyle(2, C.white, 0.6 + 0.4 * pulse);
          og.strokeRect(x - 3, y - 3, CELL * 2 + 6, CELL * 2 + 6);
        }
        return;
      }
      case 'line': {
        if (!focus) return;
        const row = s.aimAxis === 'row';
        const x = row ? 0 : focus.cx * CELL,
          y = row ? focus.cy * CELL : 0;
        const w = row ? g.cols * CELL : CELL,
          h = row ? CELL : g.rows * CELL;
        ug.fillStyle(C.ruler, 0.22 + 0.1 * pulse);
        ug.fillRect(x, y, w, h);
        og.lineStyle(2.5, C.penBlue, 0.85);
        og.strokeRect(x + 1, y + 1, w - 2, h - 2);
        // 方向箭头
        og.lineStyle(2, C.penBlue, 0.7);
        const n = row ? g.cols : g.rows;
        for (let i = 0; i < n; i++) {
          const cx = row ? (i + 0.5) * CELL : x + CELL / 2;
          const cy = row ? y + CELL / 2 : (i + 0.5) * CELL;
          const ph = ((rt * 2 + i * 0.15) % 1) * 4 - 2;
          if (row) {
            og.lineBetween(cx - 4 + ph, cy - 5, cx + 1 + ph, cy);
            og.lineBetween(cx + 1 + ph, cy, cx - 4 + ph, cy + 5);
          } else {
            og.lineBetween(cx - 5, cy - 4 + ph, cx, cy + 1 + ph);
            og.lineBetween(cx, cy + 1 + ph, cx + 5, cy - 4 + ph);
          }
        }
        if (confirm) {
          og.lineStyle(2, C.white, 0.6 + 0.4 * pulse);
          og.strokeRect(x - 2, y - 2, w + 4, h + 4);
        }
        return;
      }
      case 'tower':
      case 'tower+cell': {
        const from = s.relocateFrom;
        const choosingTower = sk.target === 'tower' || from === null;
        if (choosingTower) {
          for (const tw of st.towers.values()) {
            og.lineStyle(2, C.goldLight, 0.35 + 0.4 * pulse);
            og.strokeRoundedRect(tw.cx * CELL + 3, tw.cy * CELL + 3, CELL - 6, CELL - 6, 8);
          }
          if (focus && this.towerAt(focus)) {
            og.lineStyle(3, C.white, 1);
            og.strokeRoundedRect(focus.cx * CELL + 1, focus.cy * CELL + 1, CELL - 2, CELL - 2, 9);
          }
        } else {
          const tw = st.towers.get(from!);
          if (tw) {
            og.lineStyle(3, C.goldLight, 1);
            og.strokeRoundedRect(tw.cx * CELL + 1, tw.cy * CELL + 1, CELL - 2, CELL - 2, 9);
          }
          if (focus && !this.towerAt(focus)) {
            const ok = tw ? this.ctx.session.world.canPlace(tw.id, focus.cx, focus.cy).ok : false;
            ug.fillStyle(ok ? C.screen : C.bad, 0.4);
            ug.fillRoundedRect(focus.cx * CELL + 1, focus.cy * CELL + 1, CELL - 2, CELL - 2, 6);
          }
        }
        return;
      }
    }
  }

  destroy(): void {
    for (const f of this.off) f();
    this.off = [];
    this.ghost.destroy();
    this.ghostRoot.destroy();
    this.under.destroy();
    this.over.destroy();
  }
}

export function dashCircle(g: Phaser.GameObjects.Graphics, x: number, y: number, r: number, color: number, w: number, a: number, rot = 0): void {
  const n = Math.max(12, Math.round((r * Math.PI * 2) / 12));
  g.lineStyle(w, color, a);
  for (let i = 0; i < n; i++) {
    const a0 = rot + (i / n) * Math.PI * 2;
    const a1 = a0 + (Math.PI / n) * 1.1;
    g.beginPath();
    g.arc(x, y, r, a0, a1, false);
    g.strokePath();
  }
}
