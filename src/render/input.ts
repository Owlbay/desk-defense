import Phaser from 'phaser';

import {
  CellKind,
  type Command,
  type EnemyState,
  type PlaceCheck,
  type SkillState,
  type TowerId,
  type TowerInfo,
  type TowerState,
} from '../core/types';
import { routeDelta } from '../game/route-length';
import { ui } from '../game/UiStore';
import { t } from '../i18n';
import type { RenderCtx } from './ctx';
import type { FieldLayer } from './field';
import { BOARD_H, BOARD_W, CELL, DEPTH } from './layout';
import { B, C, FONT, hex } from './palette';
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
    /** 放下后主路线格数的变化（只在悬停格 / 地形变化时重算） */
    delta: 0,
  };
  /** 路线高亮用：每个开放出生点 id → 地面路线格序列（地形 / 出生点变化时重算） */
  private routeCache = { key: '', byId: new Map<string, Path>() };
  /** 放置预览旁的「+M 格」（懒创建） */
  private deltaText: Phaser.GameObjects.Text | null = null;
  private deltaShown = '';
  private deltaRes = 0;
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
    // 「给 AI 下指令」输入中：点棋盘 = 把格子 / 塔编号插进输入框
    if (s.boardPick) {
      if (cell) s.boardPick({ cx: cell.cx, cy: cell.cy, uid: this.towerAt(cell) });
      return;
    }
    // AI 玩家操作中：只能点选查看塔 / 空降纸箱，不发任何指令
    if (s.inspectOnly) {
      const uid = this.towerAt(cell);
      const drop = !uid && cell ? this.field.dropAt(cell.cx, cell.cy) : null;
      ui.set({
        selected: uid || null,
        spawnerSelected: drop ? drop.id : null,
        pending: null,
        build: null,
        aiming: null,
        abilityAiming: null,
      });
      return;
    }
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
        if (cell) this.fail(cell, t('ui.render.pickTower'));
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
    // 摆迷宫教学：点一下推荐的幽灵墙格就放一面书本墙（走正常放置指令，规则与金币照常）
    if (cell && s.mazeLesson?.length) {
      const g = session.world.state.grid;
      const i = cell.cy * g.cols + cell.cx;
      if (s.mazeLesson.includes(i) && g.cells[i] === CellKind.Empty) {
        const r = session.command({ type: 'place', tower: 'wall', cx: cell.cx, cy: cell.cy });
        if (!r.ok) this.fail(cell, r.reason);
        ui.set({ pending: null, selected: null });
        return;
      }
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
          this.fail(cell, t('ui.render.pickDirection'));
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
          this.fail(cell, t('ui.render.pickEnemy'));
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
          if (cell) this.fail(cell, t('ui.render.pickTower'));
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
          if (cell) this.fail(cell, t('ui.render.pickTower'));
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
          if (cell) this.fail(cell, t('ui.render.pickDrop'));
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
            if (cell) this.fail(cell, t('ui.render.pickMoveFirst'));
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

    // 推荐迷宫（设置里打开时淡淡显示）与摆迷宫教学的幽灵墙（醒目、可点）
    if (s.mazeHint?.length || s.mazeLesson?.length) this.drawMazeGhost(ug, og, rt);

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
          dashed(
            og,
            (tw.cx + 0.5) * CELL,
            (tw.cy + 0.5) * CELL,
            (focus.cx + 0.5) * CELL,
            (focus.cy + 0.5) * CELL,
            C.paper,
            2,
            6,
            5,
            (rt * 20) % 11,
          );
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
          this.cache.delta = routeDelta(this.cache.current, this.cache.preview);
        }
      }
      const pv = focus ? this.cache.preview : null;
      for (const p of this.cache.current) this.drawPath(ug, p, B.line, pv ? 0.22 : 0.4, true, rt);
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
    if (s.aiFocusCells?.length) {
      const pulse = this.ctx.reduced ? 1 : 0.5 + 0.5 * Math.sin(rt * 6);
      og.lineStyle(3, C.magenta, 0.55 + 0.45 * pulse);
      for (const f of s.aiFocusCells) og.strokeRoundedRect(f.cx * CELL - 1, f.cy * CELL - 1, CELL + 2, CELL + 2, 9);
    }

    // 文档 10 §18-8：整条进攻路线（AI 操作涉及的路线 / 玩家悬停或选中的出生点）
    this.drawRoutes(ug, og, focus, rt);

    // 放置预览：主路线变长 / 变短几格
    const showDelta = !!s.build && !s.aiming && s.abilityAiming === null && ghostCell !== null && ghostOk && this.cache.delta !== 0;
    this.drawDelta(showDelta ? ghostCell : null, this.cache.delta);

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

  /** 推荐墙格：设置里的推荐迷宫画得很淡；教学当前这一排画成醒目的虚线幽灵墙 */
  private drawMazeGhost(ug: Phaser.GameObjects.Graphics, og: Phaser.GameObjects.Graphics, rt: number): void {
    const s = ui.state;
    const g = this.ctx.session.world.state.grid;
    const lesson = s.mazeLesson ?? [];
    if (s.mazeHint?.length) {
      ug.fillStyle(B.line, 0.07);
      for (const i of s.mazeHint) {
        if (g.cells[i] !== CellKind.Empty || lesson.includes(i)) continue;
        const x = (i % g.cols) * CELL;
        const y = Math.floor(i / g.cols) * CELL;
        ug.fillRoundedRect(x + 5, y + 5, CELL - 10, CELL - 10, 5);
      }
      ug.lineStyle(1.5, B.line, 0.22);
      for (const i of s.mazeHint) {
        if (g.cells[i] !== CellKind.Empty || lesson.includes(i)) continue;
        ug.strokeRoundedRect((i % g.cols) * CELL + 5, Math.floor(i / g.cols) * CELL + 5, CELL - 10, CELL - 10, 5);
      }
    }
    if (lesson.length) {
      const pulse = this.ctx.reduced ? 1 : 0.5 + 0.5 * Math.sin(rt * 4);
      ug.fillStyle(C.screen, 0.18 + 0.12 * pulse);
      for (const i of lesson) {
        if (g.cells[i] !== CellKind.Empty) continue;
        ug.fillRoundedRect((i % g.cols) * CELL + 3, Math.floor(i / g.cols) * CELL + 3, CELL - 6, CELL - 6, 6);
      }
      for (const i of lesson) {
        if (g.cells[i] !== CellKind.Empty) continue;
        const x0 = (i % g.cols) * CELL + 3;
        const y0 = Math.floor(i / g.cols) * CELL + 3;
        const x1 = x0 + CELL - 6;
        const y1 = y0 + CELL - 6;
        const a = 0.55 + 0.4 * pulse;
        dashed(og, x0, y0, x1, y0, C.teal, 2, 5, 4, 0, a);
        dashed(og, x1, y0, x1, y1, C.teal, 2, 5, 4, 0, a);
        dashed(og, x1, y1, x0, y1, C.teal, 2, 5, 4, 0, a);
        dashed(og, x0, y1, x0, y0, C.teal, 2, 5, 4, 0, a);
      }
    }
  }

  /** 放置预览旁的「+M 格 / −M 格」 */
  private drawDelta(cell: Cell | null, delta: number): void {
    if (!cell) {
      if (this.deltaText?.visible) this.deltaText.setVisible(false);
      return;
    }
    if (!this.deltaText) {
      this.deltaText = this.ctx.scene.add
        .text(0, 0, '', { fontFamily: FONT, fontSize: '13px', fontStyle: 'bold', strokeThickness: 4 })
        .setOrigin(0.5, 1)
        .setDepth(DEPTH.text);
    }
    const tx = this.deltaText;
    const res = Math.min(4, this.ctx.zoom);
    if (this.deltaRes !== res) {
      this.deltaRes = res;
      tx.setResolution(res);
    }
    const label = t('ui.render.routeDelta', { sign: delta > 0 ? '+' : '−', n: Math.abs(delta) });
    const key = `${label}|${B.textStroke}`;
    if (key !== this.deltaShown) {
      this.deltaShown = key;
      tx.setText(label);
      tx.setColor(hex(delta > 0 ? C.screen : C.pink));
      tx.setStroke(hex(B.textStroke), 4);
    }
    const g = this.ctx.session.world.state.grid;
    const x = Phaser.Math.Clamp((cell.cx + 0.5) * CELL, 28, g.cols * CELL - 28);
    // 顶行放在格子下方，避免出界
    if (cell.cy === 0) tx.setOrigin(0.5, 0).setPosition(x, (cell.cy + 1) * CELL + 2);
    else tx.setOrigin(0.5, 1).setPosition(x, cell.cy * CELL - 2);
    tx.setVisible(true);
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
      g.fillStyle(B.line, 0.1 * alpha);
      g.fillCircle(x, y, r);
      dashCircle(g, x, y, r, B.line, 1.5, 0.6 * alpha, rt * 0.3);
    }
    if (aura && aura > 0) {
      const r = aura * CELL;
      g.fillStyle(C.screen, 0.12 * alpha);
      g.fillCircle(x, y, r);
      dashCircle(g, x, y, r, C.teal, 2, 0.85 * alpha, rt * 0.4);
    }
  }

  /** 出生点 id → 当前地面路线（与 world.currentPaths() 同一套流场；按起点格对应到出生点） */
  private routesById(): Map<string, Path> {
    const st = this.ctx.session.world.state;
    const key = `${st.grid.version}|${st.spawners.map((sp) => (sp.active ? sp.id : '')).join(',')}`;
    if (key === this.routeCache.key) return this.routeCache.byId;
    const byId = new Map<string, Path>();
    const paths = this.ctx.session.world.currentPaths();
    for (const sp of st.spawners) {
      if (!sp.active) continue;
      const c = sp.cells[0];
      const p = paths.find((q) => q.length && q[0].x === c.x && q[0].y === c.y);
      if (p) byId.set(sp.id, p);
    }
    this.routeCache = { key, byId };
    return byId;
  }

  /**
   * 整条路线折线 + 航点（拐点）：
   *  - AI：ui.routeFocus（操作解读 / 工具调用涉及的路线），品红，与 aiFocus 同色；
   *  - 玩家：悬停（电脑）/ 选中（点空降纸箱）出生点 → 主题路线色（浅色桌面墨蓝、深色桌面浅蓝）。
   * 都画得很淡：衬底 + 细线 + 航点小圆，终点画一个空心圈；飞行线（AI 指明 air 时）用虚线。
   */
  private drawRoutes(ug: Phaser.GameObjects.Graphics, og: Phaser.GameObjects.Graphics, focus: Cell | null, rt: number): void {
    const s = ui.state;
    const st = this.ctx.session.world.state;
    // 玩家：悬停在出生点格上（不在建造 / 瞄准等模式里）或选中了空降纸箱
    const mine = new Set<string>();
    const idle = !s.build && !s.aiming && s.abilityAiming === null;
    if (s.spawnerSelected) mine.add(s.spawnerSelected);
    if (idle && focus) {
      for (const sp of st.spawners) {
        if (sp.active && sp.cells.some((c) => c.x === focus.cx && c.y === focus.cy)) mine.add(sp.id);
      }
    }
    const rf = s.routeFocus;
    if (!mine.size && !rf) return;
    const byId = this.routesById();
    const pulse = this.ctx.reduced ? 1 : 0.75 + 0.25 * Math.sin(rt * 4);
    if (rf) {
      const ids = rf.ids ?? [...byId.keys()];
      for (const id of ids) {
        const p = byId.get(id);
        if (p) this.routeLine(ug, og, p, C.magenta, 0.7 * pulse, rt);
      }
      if (rf.air) for (const id of ids) this.flightLine(og, id, C.magenta, 0.75 * pulse, rt);
    }
    for (const id of mine) {
      if (rf && (rf.ids === null || rf.ids.includes(id))) continue;
      const p = byId.get(id);
      if (p) this.routeLine(ug, og, p, B.route, 0.6, rt);
    }
  }

  /** 一条地面路线：衬底 + 折线 + 拐点航点 + 终点圈 + 缓慢流动的方向点 */
  private routeLine(
    ug: Phaser.GameObjects.Graphics,
    og: Phaser.GameObjects.Graphics,
    path: Path,
    color: number,
    alpha: number,
    rt: number,
  ): void {
    if (path.length < 2) return;
    const px = (p: { x: number }) => (p.x + 0.5) * CELL;
    const py = (p: { y: number }) => (p.y + 0.5) * CELL;
    // 航点 = 起点、拐点、终点（与 agent/routes.ts 的 compressWaypoints 同规则）
    const wp: Path = [path[0]];
    for (let i = 1; i < path.length - 1; i++) {
      const a = path[i - 1],
        b = path[i],
        c = path[i + 1];
      if (Math.sign(b.x - a.x) !== Math.sign(c.x - b.x) || Math.sign(b.y - a.y) !== Math.sign(c.y - b.y)) wp.push(b);
    }
    wp.push(path[path.length - 1]);
    const stroke = (g: Phaser.GameObjects.Graphics, w: number, col: number, al: number): void => {
      g.lineStyle(w, col, al);
      g.beginPath();
      g.moveTo(px(wp[0]), py(wp[0]));
      for (let i = 1; i < wp.length; i++) g.lineTo(px(wp[i]), py(wp[i]));
      g.strokePath();
    };
    stroke(ug, 7, B.routeHalo, 0.28 * alpha);
    stroke(ug, 3, color, alpha);
    // 航点：拐点小实心圆（带衬底），起点稍大，终点空心圈
    for (let i = 0; i < wp.length; i++) {
      const p = wp[i];
      const last = i === wp.length - 1;
      const r = i === 0 ? 5 : last ? 6 : 3.6;
      og.fillStyle(B.routeHalo, 0.55 * alpha);
      og.fillCircle(px(p), py(p), r + 1.6);
      if (last) {
        og.lineStyle(2, color, Math.min(1, alpha + 0.2));
        og.strokeCircle(px(p), py(p), r);
      } else {
        og.fillStyle(color, Math.min(1, alpha + 0.2));
        og.fillCircle(px(p), py(p), r);
      }
    }
    if (this.ctx.reduced) return;
    // 方向：沿路线缓慢流动的小点（每 3 格一个）
    const n = path.length;
    const total = n - 1;
    for (let k = 0; k < total; k += 3) {
      const f = (k + ((rt * 2.2) % 3)) % total;
      const i = Math.floor(f),
        fr = f - i;
      const a = path[i],
        b = path[Math.min(n - 1, i + 1)];
      ug.fillStyle(color, 0.8 * alpha);
      ug.fillCircle((a.x + (b.x - a.x) * fr + 0.5) * CELL, (a.y + (b.y - a.y) * fr + 0.5) * CELL, 2);
    }
  }

  /** 飞行线：出生格中心 → 横向最近的出口中心（与 agent/routes.ts 的 flightLines 同规则），虚线 */
  private flightLine(og: Phaser.GameObjects.Graphics, id: string, color: number, alpha: number, rt: number): void {
    const st = this.ctx.session.world.state;
    const sp = st.spawners.find((q) => q.id === id);
    if (!sp?.active || !sp.cells.length) return;
    const c = sp.cells[0];
    let best: { x: number; y: number } | null = null;
    let bd = Infinity;
    for (const ex of st.grid.exits) {
      const d = Math.abs(ex.x - c.x);
      if (d < bd) {
        bd = d;
        best = ex;
      }
    }
    if (!best) return;
    const x0 = (c.x + 0.5) * CELL,
      y0 = (c.y + 0.5) * CELL,
      x1 = (best.x + 0.5) * CELL,
      y1 = (best.y + 0.5) * CELL;
    const off = this.ctx.reduced ? 0 : (rt * 14) % 12;
    dashed(og, x0, y0, x1, y1, B.routeHalo, 5, 7, 5, off, 0.3 * alpha);
    dashed(og, x0, y0, x1, y1, color, 2, 7, 5, off, alpha);
    og.lineStyle(2, color, alpha);
    og.strokeCircle(x1, y1, 6);
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
    this.deltaText?.destroy();
    this.under.destroy();
    this.over.destroy();
  }
}

export function dashCircle(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  r: number,
  color: number,
  w: number,
  a: number,
  rot = 0,
): void {
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
