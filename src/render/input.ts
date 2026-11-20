import Phaser from 'phaser';
import type { Command, EnemyState, PlaceCheck, SkillState, TowerId, TowerInfo, TowerState } from '../core/types';
import { ui } from '../game/UiStore';
import type { RenderCtx } from './ctx';
import type { FieldLayer } from './field';
import { BOARD_H, BOARD_W, CELL, DEPTH } from './layout';
import { C } from './palette';
import { PartSet } from './parts';
import { branchColor, dashed, towerAsset } from './towers';

type Ability = NonNullable<TowerInfo['ability']>;

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
  /** 触摸：能力选敌第一次点中的敌人 */
  private pendingEnemy: number | null = null;
  /** 幽灵塔：当前显示位置（向目标格缓动）、是否正在显示、无效放置的抖动剩余时间 */
  private gx = 0;
  private gy = 0;
  private ghostOn = false;
  private ghostShake = 0;

  constructor(
    private ctx: RenderCtx,
    private canvas: HTMLCanvasElement,
    /** 客户端坐标 → 逻辑像素 */
    private toWorld: (clientX: number, clientY: number) => { x: number; y: number },
    private field: FieldLayer,
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
        ui.set({ hover: null, hoverPickup: null });
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
    const pk = cell ? this.field.pickupAt(pos, 0.5) : null;
    const hp = pk ? pk.uid : null;
    if (ui.state.hoverPickup !== hp) ui.set({ hoverPickup: hp });
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
    this.pendingEnemy = null;
    if (s.abilityAiming !== null) ui.set({ abilityAiming: null, abilityAngle: null, pending: null });
    else if (s.aiming) ui.set({ aiming: null, pending: null, relocateFrom: null });
    else if (s.spawnerSelected !== null) ui.set({ spawnerSelected: null });
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
    if (s.abilityAiming !== null) {
      this.clickAbility(cell, pos, touch);
      return;
    }
    if (s.aiming) {
      this.clickAim(cell, pos, touch);
      return;
    }
    // 掉落物优先于建造 / 选塔
    if (cell) {
      const pk = this.field.pickupAt(pos, touch ? 0.62 : 0.48);
      if (pk) {
        const r = session.command({ type: 'collect', uid: pk.uid });
        if (!r.ok) this.fail(cell, r.reason);
        else if (touch) ui.set({ pending: null });
        return;
      }
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
    // 普通：选塔 / 选空降纸箱（UI 显示拆除按钮）/ 取消选择
    const uid = this.towerAt(cell);
    const drop = !uid && cell ? this.field.dropAt(cell.cx, cell.cy) : null;
    if (drop) {
      ui.set({ spawnerSelected: s.spawnerSelected === drop.id ? null : drop.id, selected: null, pending: null });
      return;
    }
    ui.set({ selected: uid || null, spawnerSelected: null, pending: null });
  }

  // ───────────── 神话塔主动能力（文档 11 §1.4） ─────────────

  private ability(): { tower: TowerState; info: TowerInfo; ab: Ability } | null {
    const uid = ui.state.abilityAiming;
    if (uid === null) return null;
    const world = this.ctx.session.world;
    const tower = world.state.towers.get(uid);
    const info = tower ? world.getTowerInfo(uid) : null;
    if (!tower || !info || !info.ability) return null;
    return { tower, info, ab: info.ability };
  }

  /** 方形 3×3 的中心格（保证整块在棋盘内） */
  private rect3Center(c: Cell): Cell {
    const g = this.ctx.session.world.state.grid;
    return { cx: Phaser.Math.Clamp(c.cx, 1, g.cols - 2), cy: Phaser.Math.Clamp(c.cy, 1, g.rows - 2) };
  }

  /** 指针附近可选中的敌人 */
  private enemyNear(pos: { x: number; y: number }, r: number): EnemyState | null {
    let best: EnemyState | null = null,
      bd = r;
    for (const e of this.ctx.session.world.state.enemies) {
      if (e.hidden || e.jumping) continue;
      const d = Math.hypot(e.x - pos.x, e.y - pos.y) - e.radius * (e.scale || 1) * 0.5;
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  private abilityAngleTo(tower: TowerState, p: { x: number; y: number }): number {
    return Math.atan2(p.y - (tower.cy + 0.5), p.x - (tower.cx + 0.5));
  }

  private clickAbility(cell: Cell | null, pos: { x: number; y: number }, touch: boolean): void {
    const s = ui.state;
    const a = this.ability();
    if (!a) {
      ui.set({ abilityAiming: null, abilityAngle: null, pending: null });
      return;
    }
    const { tower, ab } = a;
    const g = this.ctx.session.world.state.grid;
    const cast = (extra: Partial<Extract<Command, { type: 'towerAbility' }>>, at: Cell | null) => {
      const r = this.ctx.session.command({ type: 'towerAbility', uid: tower.uid, ...extra });
      this.pendingEnemy = null;
      if (r.ok) ui.set({ abilityAiming: null, abilityAngle: null, pending: null });
      else {
        if (at) this.fail(at, r.reason);
        else this.toastCenter(r.reason);
        ui.set({ pending: null });
      }
    };
    const needConfirm = (c: Cell) => {
      if (!touch) return false;
      if (this.same(s.pending, c)) return false;
      ui.set({ pending: c, hover: c });
      return true;
    };
    const outside = () => {
      if (touch) {
        this.pendingEnemy = null;
        ui.set({ abilityAiming: null, abilityAngle: null, pending: null });
      }
    };
    switch (ab.target) {
      case 'none':
        cast({}, cell);
        return;
      case 'circle': {
        if (!cell) return outside();
        if (needConfirm(cell)) return;
        const x = touch ? cell.cx + 0.5 : Phaser.Math.Clamp(pos.x, 0, g.cols);
        const y = touch ? cell.cy + 0.5 : Phaser.Math.Clamp(pos.y, 0, g.rows);
        cast({ x, y }, cell);
        return;
      }
      case 'rect3': {
        if (!cell) return outside();
        if (needConfirm(cell)) return;
        const c = this.rect3Center(cell);
        cast({ x: c.cx + 0.5, y: c.cy + 0.5 }, cell);
        return;
      }
      case 'direction': {
        if (!cell) return outside();
        if (cell.cx === tower.cx && cell.cy === tower.cy) {
          this.fail(cell, '请点击要射击的方向');
          return;
        }
        if (needConfirm(cell)) {
          ui.set({ abilityAngle: this.abilityAngleTo(tower, { x: cell.cx + 0.5, y: cell.cy + 0.5 }) });
          return;
        }
        const p = touch ? { x: cell.cx + 0.5, y: cell.cy + 0.5 } : pos;
        cast({ angle: this.abilityAngleTo(tower, p), x: p.x, y: p.y }, cell);
        return;
      }
      case 'axis': {
        if (!cell) return outside();
        if (needConfirm(cell)) return;
        const axis = s.aimAxis;
        cast({ axis, index: axis === 'row' ? cell.cy : cell.cx, x: cell.cx + 0.5, y: cell.cy + 0.5 }, cell);
        return;
      }
      case 'enemy': {
        if (!cell) return outside();
        const e = this.enemyNear(pos, touch ? 0.9 : 0.7);
        if (!e) {
          this.fail(cell, '请选择一个敌人');
          this.pendingEnemy = null;
          return;
        }
        if (touch && this.pendingEnemy !== e.uid) {
          this.pendingEnemy = e.uid;
          ui.set({ pending: cell, hover: cell });
          return;
        }
        cast({ targetUid: e.uid, x: e.x, y: e.y }, cell);
        return;
      }
      case 'tower': {
        const uid = this.towerAt(cell);
        if (!uid) {
          if (cell) this.fail(cell, '请选择一座塔');
          else outside();
          return;
        }
        if (needConfirm(cell!)) return;
        cast({ targetUid: uid, x: cell!.cx + 0.5, y: cell!.cy + 0.5 }, cell);
        return;
      }
    }
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
      case 'spawner': {
        // 封箱胶带：点一个已落地的空降纸箱
        const sp = cell ? this.field.dropAt(cell.cx, cell.cy, true) : null;
        if (!sp) {
          if (cell) this.fail(cell, '请选择一个空降纸箱');
          else if (touch) ui.set({ aiming: null, pending: null });
          return;
        }
        if (needConfirm(cell!)) return;
        cast({ spawner: sp.id, cx: cell!.cx, cy: cell!.cy, x: cell!.cx + 0.5, y: cell!.cy + 0.5 }, cell);
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
    this.ghostShake = 0.32;
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
    if (s.selected !== null && !s.build && !s.aiming && s.abilityAiming === null) {
      const tw = st.towers.get(s.selected);
      const info = tw ? world.getTowerInfo(s.selected) : null;
      if (tw && info) {
        const x = (tw.cx + 0.5) * CELL,
          y = (tw.cy + 0.5) * CELL;
        this.rangeRings(ug, x, y, info.range, info.innerRange, info.auraRange, rt);
      }
    }

    const focus: Cell | null = s.touch ? s.pending : s.hover;

    if (s.abilityAiming === null) this.pendingEnemy = null;
    if (s.abilityAiming !== null) {
      const a = this.ability();
      if (a) this.drawAbilityAim(ug, og, a, focus, rt);
      else ui.set({ abilityAiming: null, abilityAngle: null, pending: null });
    } else if (s.aiming) {
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

    // 文档 10：思路与请求面板里悬停的工具调用 → 棋盘上对应格子描一圈
    if (s.aiFocus) {
      const f = s.aiFocus;
      const pulse = this.ctx.reduced ? 1 : 0.5 + 0.5 * Math.sin(rt * 6);
      og.lineStyle(3, C.magenta, 0.55 + 0.45 * pulse);
      og.strokeRoundedRect(f.cx * CELL - 1, f.cy * CELL - 1, CELL + 2, CELL + 2, 9);
    }

    // 幽灵塔
    if (ghostAsset && ghostCell && this.ctx.atlas.ready) {
      this.ghost.bind(this.ctx.atlas, ghostAsset);
      this.ghostRoot.setVisible(true);
      const tx = (ghostCell.cx + 0.5) * CELL,
        ty = (ghostCell.cy + 0.5) * CELL;
      const red = this.ctx.reduced;
      const rdt = this.ctx.rdt;
      if (!this.ghostOn || red) {
        this.gx = tx;
        this.gy = ty;
      } else {
        // 换格：快速吸附过去（指数缓动，约 80ms 到位）
        const k = 1 - Math.exp(-rdt * 30);
        this.gx += (tx - this.gx) * k;
        this.gy += (ty - this.gy) * k;
      }
      this.ghostOn = true;
      let sx = 0;
      if (this.ghostShake > 0) {
        // 放不下：左右摇头
        this.ghostShake -= rdt;
        if (!red) sx = Math.sin(this.ghostShake * 60) * 4.5 * Math.max(0, this.ghostShake / 0.32);
      }
      // 轻轻上下浮动 + 呼吸
      const bob = red ? 0 : Math.sin(rt * 3.2) * 1.6;
      this.ghostRoot.setPosition(this.gx + sx, this.gy - 2 + bob);
      this.ghostRoot.setScale(red ? 1 : 1 + 0.025 * Math.sin(rt * 3.2 + 1));
      this.ghostRoot.setAlpha(ghostOk ? 0.62 : 0.5);
      for (const img of this.ghost.order) {
        if (ghostOk) img.clearTint();
        else img.setTint(0xff8080);
      }
      const glow = this.ghost.get('glow');
      if (glow) glow.setVisible(false);
    } else {
      this.ghostRoot.setVisible(false);
      this.ghostOn = false;
    }
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
      case 'spawner': {
        for (const sp of st.spawners ?? []) {
          if (sp.kind !== 'drop' || (sp.warnUntil !== undefined && sp.warnUntil > st.time)) continue;
          let x0 = Infinity,
            y0 = Infinity,
            x1 = -Infinity,
            y1 = -Infinity;
          for (const c of sp.cells) {
            x0 = Math.min(x0, c.x);
            y0 = Math.min(y0, c.y);
            x1 = Math.max(x1, c.x + 1);
            y1 = Math.max(y1, c.y + 1);
          }
          const hot = !!focus && sp.cells.some((c) => c.x === focus.cx && c.y === focus.cy);
          og.lineStyle(hot ? 3.5 : 2.5, hot ? C.white : C.tapeTan, hot ? 1 : 0.45 + 0.45 * pulse);
          og.strokeRoundedRect(x0 * CELL - 2, y0 * CELL - 2, (x1 - x0) * CELL + 4, (y1 - y0) * CELL + 4, 8);
          if (hot && confirm) {
            og.lineStyle(2, C.white, 0.6 + 0.4 * pulse);
            og.strokeRoundedRect(x0 * CELL - 6, y0 * CELL - 6, (x1 - x0) * CELL + 12, (y1 - y0) * CELL + 12, 10);
          }
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

  private drawAbilityAim(
    ug: Phaser.GameObjects.Graphics,
    og: Phaser.GameObjects.Graphics,
    a: { tower: TowerState; info: TowerInfo; ab: Ability },
    focus: Cell | null,
    rt: number,
  ): void {
    const s = ui.state;
    const st = this.ctx.session.world.state;
    const g = st.grid;
    const { tower, info, ab } = a;
    const col = branchColor(tower.branch);
    const pulse = 0.5 + 0.5 * Math.sin(rt * 6);
    const confirm = s.touch && !!s.pending;
    const tx = (tower.cx + 0.5) * CELL,
      ty = (tower.cy + 0.5) * CELL;
    // 施放者
    og.lineStyle(3, C.goldLight, 0.7 + 0.3 * pulse);
    og.strokeRoundedRect(tower.cx * CELL + 1, tower.cy * CELL + 1, CELL - 2, CELL - 2, 9);
    const hp = !s.touch && this.hoverPos ? this.hoverPos : focus ? { x: focus.cx + 0.5, y: focus.cy + 0.5 } : null;
    switch (ab.target) {
      case 'none':
        return;
      case 'circle': {
        if (!hp) return;
        const x = hp.x * CELL,
          y = hp.y * CELL,
          r = (ab.radius ?? 1.5) * CELL;
        ug.fillStyle(col, 0.16 + 0.06 * pulse);
        ug.fillCircle(x, y, r);
        og.lineStyle(2.5, col, 0.95);
        og.strokeCircle(x, y, r);
        dashCircle(og, x, y, r + 4, C.white, 1.5, 0.6, rt * 0.8);
        if (confirm) og.strokeCircle(x, y, r + 8 + pulse * 3);
        return;
      }
      case 'rect3': {
        if (!focus) return;
        const c = this.rect3Center(focus);
        const x = (c.cx - 1) * CELL,
          y = (c.cy - 1) * CELL;
        ug.fillStyle(col, 0.18 + 0.08 * pulse);
        ug.fillRect(x, y, CELL * 3, CELL * 3);
        og.lineStyle(2.5, col, 0.95);
        og.strokeRect(x + 1, y + 1, CELL * 3 - 2, CELL * 3 - 2);
        og.lineStyle(1, C.white, 0.4);
        for (let i = 1; i < 3; i++) {
          og.lineBetween(x + i * CELL, y + 2, x + i * CELL, y + CELL * 3 - 2);
          og.lineBetween(x + 2, y + i * CELL, x + CELL * 3 - 2, y + i * CELL);
        }
        if (confirm) {
          og.lineStyle(2, C.white, 0.6 + 0.4 * pulse);
          og.strokeRect(x - 3, y - 3, CELL * 3 + 6, CELL * 3 + 6);
        }
        return;
      }
      case 'direction': {
        let ang: number | null = null;
        if (s.touch) ang = s.pending ? this.abilityAngleTo(tower, { x: s.pending.cx + 0.5, y: s.pending.cy + 0.5 }) : null;
        else if (hp && (Math.floor(hp.x) !== tower.cx || Math.floor(hp.y) !== tower.cy)) ang = this.abilityAngleTo(tower, hp);
        if (ang === null) {
          dashCircle(og, tx, ty, CELL * 0.8, col, 2, 0.6, rt);
          return;
        }
        if (s.abilityAngle === null || Math.abs(s.abilityAngle - ang) > 0.02) ui.set({ abilityAngle: ang });
        const L = Math.hypot(BOARD_W, BOARD_H);
        const ex = tx + Math.cos(ang) * L,
          ey = ty + Math.sin(ang) * L;
        // 宽一点的半透明条 + 虚线中心 + 箭头
        ug.lineStyle(CELL * 0.6, col, 0.14 + 0.06 * pulse);
        ug.lineBetween(tx, ty, ex, ey);
        dashed(og, tx, ty, ex, ey, col, 3, 10, 6, (rt * 40) % 16, 0.95);
        const hx = tx + Math.cos(ang) * CELL * 1.4,
          hy = ty + Math.sin(ang) * CELL * 1.4;
        const px = -Math.sin(ang),
          py = Math.cos(ang);
        og.fillStyle(col, 0.95);
        og.fillTriangle(hx + Math.cos(ang) * 12, hy + Math.sin(ang) * 12, hx + px * 8, hy + py * 8, hx - px * 8, hy - py * 8);
        og.lineStyle(1.5, C.ink, 0.9);
        og.strokeTriangle(hx + Math.cos(ang) * 12, hy + Math.sin(ang) * 12, hx + px * 8, hy + py * 8, hx - px * 8, hy - py * 8);
        return;
      }
      case 'axis': {
        if (!focus) return;
        const row = s.aimAxis === 'row';
        const x = row ? 0 : focus.cx * CELL,
          y = row ? focus.cy * CELL : 0;
        const w = row ? g.cols * CELL : CELL,
          h = row ? CELL : g.rows * CELL;
        ug.fillStyle(col, 0.18 + 0.1 * pulse);
        ug.fillRect(x, y, w, h);
        og.lineStyle(2.5, col, 0.9);
        og.strokeRect(x + 1, y + 1, w - 2, h - 2);
        if (confirm) {
          og.lineStyle(2, C.white, 0.6 + 0.4 * pulse);
          og.strokeRect(x - 2, y - 2, w + 4, h + 4);
        }
        return;
      }
      case 'enemy': {
        const pe = this.pendingEnemy !== null ? st.enemies.find((e) => e.uid === this.pendingEnemy) : undefined;
        const cand = pe ?? (hp && !s.touch ? this.enemyNear(hp, 0.7) : null);
        if (!cand) return;
        const x = cand.x * CELL,
          y = cand.y * CELL;
        const r = Math.max(10, cand.radius * CELL * (cand.scale || 1)) + 6;
        og.lineStyle(2.5, col, 0.95);
        og.strokeCircle(x, y, r);
        og.lineStyle(2, C.white, 0.9);
        for (let k = 0; k < 4; k++) {
          const aa = (k * Math.PI) / 2 + rt;
          og.lineBetween(x + Math.cos(aa) * (r + 2), y + Math.sin(aa) * (r + 2), x + Math.cos(aa) * (r + 8), y + Math.sin(aa) * (r + 8));
        }
        if (pe) dashCircle(og, x, y, r + 10 + pulse * 3, C.white, 1.5, 0.8, rt);
        return;
      }
      case 'tower': {
        const aura = info.auraRange ?? 0;
        if (aura > 0) this.rangeRings(ug, tx, ty, 0, undefined, aura, rt, 0.8);
        for (const tw of st.towers.values()) {
          if (tw.uid === tower.uid || tw.id === 'wall') continue;
          if (aura > 0 && Math.hypot(tw.cx - tower.cx, tw.cy - tower.cy) > aura + 0.01) continue;
          og.lineStyle(2, C.goldLight, 0.35 + 0.4 * pulse);
          og.strokeRoundedRect(tw.cx * CELL + 3, tw.cy * CELL + 3, CELL - 6, CELL - 6, 8);
        }
        if (focus && this.towerAt(focus)) {
          og.lineStyle(3, C.white, 1);
          og.strokeRoundedRect(focus.cx * CELL + 1, focus.cy * CELL + 1, CELL - 2, CELL - 2, 9);
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
