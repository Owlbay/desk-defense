import type { GameEvent } from '../../core/types';
import { fmtRatio, maxCells } from '../../game/route-length';
import { ui } from '../../game/UiStore';
import { onLocaleChange, t } from '../../i18n';
import { audio } from '../audio';
import { SKILL_META } from '../coreMeta';
import { h, setText } from '../dom';
import type { GameCtx } from './context';
import { firstStep, ghostSegment, type LessonEvent, lessonStep, MAZE_STEPS, type MazeStep } from './maze-lesson';
import type { MazeGuide } from './MazeGuide';

/**
 * 第一章新手引导（文档 01 §6）：不阻塞操作的气泡提示，指向相关按钮，每条只出现一次。
 */

export type TutorialStep =
  | 'ch1-place'
  | 'ch1-start'
  | 'ch1-wall'
  | 'ch1-upgrade'
  | 'ch1-sell'
  | 'ch1-boss'
  // 摆迷宫小教学（放下第一座铅笔之后；步骤推进见 maze-lesson.ts）
  | MazeStep
  // 所有模式通用的一次性提示（文档 09 / 11）
  | 'tip-event'
  | 'tip-drop'
  | 'tip-evolve'
  // 对局里的 AI 按钮（第一次出现时）
  | 'tip-ai';

interface Targets {
  build(id: 'pencil' | 'wall'): HTMLElement | null;
  start(): HTMLElement | null;
  info(): HTMLElement | null;
  board(): HTMLElement | null;
  skill(id: 'eraser_strike'): HTMLElement | null;
  skills(): HTMLElement | null;
  /** 随机事件横幅 / 即将发生时间轴 */
  events(): HTMLElement | null;
  /** 顶栏的 AI 按钮 */
  ai(): HTMLElement | null;
}

interface Active {
  step: TutorialStep;
  bubble: HTMLElement;
  ring: HTMLElement;
  target: () => HTMLElement | null;
  /** 摆迷宫教学：路线长度那一行、「按推荐摆放」按钮 */
  route?: HTMLElement;
  place?: HTMLButtonElement;
}

const isMaze = (s: TutorialStep | undefined): s is MazeStep => !!s && (MAZE_STEPS as readonly string[]).includes(s);

/** 气泡文字：ui.tutorial.<step>.title / .body */
const text = (step: TutorialStep): { title: string; body: string } => {
  // 技能名来自数据层（已翻译），文案里用占位符引用
  const p = { eraser: SKILL_META.eraser_strike?.name ?? 'eraser_strike', tape: SKILL_META.seal_tape?.name ?? 'seal_tape' };
  return { title: t(`ui.tutorial.${step}.title`, p), body: t(`ui.tutorial.${step}.body`, p) };
};

export class Tutorial {
  private active: Active | null = null;
  private queue: TutorialStep[] = [];
  private raf = 0;
  private offLocale: () => void;
  readonly enabled: boolean;
  /** 摆迷宫教学开始时的路线格数（气泡里显示「路线 A → B 格」） */
  private routeFrom = 0;

  constructor(
    private ctx: GameCtx,
    private tg: Targets,
    private maze?: MazeGuide,
  ) {
    const o = ctx.opts;
    this.enabled = o.mode === 'campaign' && o.map === 'ch1';
    // 语言切换：正在显示的气泡就地换成新语言
    this.offLocale = onLocaleChange(() => this.relabel());
    if (maze && this.enabled) maze.onChange = () => this.onTerrain();
  }

  private relabel(): void {
    const a = this.active;
    if (!a) return;
    const tx = text(a.step);
    const title = a.bubble.querySelector<HTMLElement>('.coach-title');
    const body = a.bubble.querySelector<HTMLElement>('.coach-body');
    const ok = a.bubble.querySelector<HTMLElement>('.coach-ok');
    if (title) setText(title, tx.title);
    if (body) setText(body, tx.body);
    if (ok) setText(ok, t('ui.tutorial.ok'));
    const skip = a.bubble.querySelector<HTMLElement>('.coach-skip');
    if (skip) setText(skip, t('ui.tutorial.skip'));
    if (a.place) setText(a.place, t('ui.tutorial.mazePlace'));
    this.refreshMaze();
  }

  private seen(s: TutorialStep): boolean {
    return !!this.ctx.app.store.get().tutorial[s];
  }

  private markSeen(s: TutorialStep): void {
    this.ctx.app.store.update((p) => {
      p.tutorial[s] = true;
    });
  }

  start(): void {
    // AI 按钮的一次性提示：第一章新手引导期间不打扰（第 1 波结束后再出现）
    if (!this.enabled || this.seen('ch1-start')) this.show('tip-ai');
    if (!this.enabled) return;
    const st = this.ctx.world.state;
    if (st.wave === 0 && st.phase === 'build') {
      if (!this.seen('ch1-place') && st.towers.size === 0) this.show('ch1-place');
      else this.afterPlace();
    }
  }

  /** 放下第一座塔之后：先上摆迷宫小教学（没看过的话），再提示开波 */
  private afterPlace(): void {
    const step = this.maze ? firstStep((s) => this.seen(s)) : null;
    if (step) this.show(step);
    else this.show('ch1-start');
  }

  // ───────────── 摆迷宫小教学 ─────────────

  /** 地形变化 / 规划算好：按已建好的推荐段推进，刷新气泡里的路线长度 */
  private onTerrain(): void {
    const cur = this.active?.step;
    if (!isMaze(cur) || !this.maze?.ready) return;
    this.lesson({ type: 'progress', built: this.maze.built() });
  }

  private lesson(ev: LessonEvent): void {
    const cur = this.active?.step;
    if (!isMaze(cur)) return;
    const r = lessonStep(cur, ev);
    for (const s of r.seen) this.markSeen(s);
    // 第一排墙亲手摆过了：第 1 波后那条「用书本墙改路线」就不用再讲
    if (ev.type === 'progress' && r.seen.includes('ch1-maze-row')) this.markSeen('ch1-wall');
    if (r.step === cur) {
      this.refreshMaze();
      return;
    }
    this.hide();
    const next: TutorialStep | null | undefined = r.step ?? (ev.type === 'abort' ? this.queue.shift() : 'ch1-start');
    if (next) setTimeout(() => this.show(next), 250);
  }

  /** 气泡里的路线长度、「按推荐摆放」按钮的状态 */
  private refreshMaze(): void {
    const a = this.active;
    if (!a || !isMaze(a.step)) return;
    if (a.route) {
      const now = maxCells(this.ctx.world.currentPaths());
      const from = this.routeFrom || now;
      setText(a.route, now > 0 ? t('ui.tutorial.mazeRoute', { from, to: now, r: fmtRatio(now / Math.max(1, from)) }) : '');
    }
    if (a.place) {
      const seg = ghostSegment(a.step);
      a.place.hidden = seg === null || !this.maze?.ready || !ui.state.mazeLesson?.length;
    }
  }

  /** 「按推荐摆放」：只摆金币够的部分 */
  private placeSuggested(): void {
    if (!this.maze) return;
    const r = this.maze.placeLesson();
    if (r.short) this.ctx.toast(r.placed > 0 ? t('ui.tutorial.mazePartial', { n: r.placed }) : t('ui.tutorial.mazeNoGold'), 'warn');
  }

  onEvent(ev: GameEvent): void {
    const cur = this.active?.step;
    // 通用提示：任何模式下第一次遇到时出现
    switch (ev.type) {
      case 'randomEvent':
        if (ev.phase !== 'end' && ev.id !== 'drop_box') this.show('tip-event');
        break;
      case 'spawnerDrop':
        if (ev.phase === 'warn') this.show('tip-drop');
        else if (cur === 'tip-drop' && (ev.phase === 'demolish' || ev.phase === 'close')) this.done();
        break;
      case 'levelUp':
        if (ev.level >= 10) this.show('tip-evolve');
        break;
      case 'evolve':
        if (cur === 'tip-evolve') this.done();
        break;
      case 'waveEnd':
        this.show('tip-ai');
        break;
    }
    if (!this.enabled) return;
    switch (ev.type) {
      case 'place':
        if (cur === 'ch1-place') {
          this.done();
          this.afterPlace();
        } else if (cur === 'ch1-wall' && ev.tower === 'wall') this.done();
        break;
      case 'waveStart':
        if (isMaze(cur)) {
          // 教学途中直接开波：剩下的步骤和「开始第 1 波」都不用再提示
          this.lesson({ type: 'abort' });
          this.ack('ch1-start');
        }
        if (cur === 'ch1-start' || cur === 'ch1-place') this.done();
        if (ev.tags.includes('boss') || ev.wave === 10) this.show('ch1-boss');
        break;
      case 'waveEnd':
        if (ev.wave === 1) this.show('ch1-wall');
        else if (ev.wave === 2) this.show('ch1-upgrade');
        else if (ev.wave === 4) this.show('ch1-sell');
        break;
      case 'levelUp':
        if (cur === 'ch1-upgrade' && !ev.byXp) this.done();
        break;
      case 'sell':
        if (cur === 'ch1-sell') this.done();
        break;
      case 'skill':
        if (cur === 'ch1-boss') this.done();
        break;
      case 'gameOver':
        this.hide();
        break;
    }
  }

  private targetFor(s: TutorialStep): () => HTMLElement | null {
    switch (s) {
      case 'ch1-place':
        return () => this.tg.build('pencil');
      case 'ch1-start':
        return () => this.tg.start();
      case 'ch1-wall':
        return () => this.tg.build('wall');
      case 'ch1-upgrade':
      case 'ch1-sell':
        return () => this.tg.info() ?? this.tg.board();
      case 'ch1-boss':
        return () => this.tg.skill('eraser_strike') ?? this.tg.skills();
      case 'ch1-maze-row':
      case 'ch1-maze-snake':
      case 'ch1-maze-lanes':
        return () => this.tg.board();
      case 'tip-event':
        return () => this.tg.events() ?? this.tg.board();
      case 'tip-drop':
        return () => this.tg.board();
      case 'tip-evolve':
        return () => this.tg.info() ?? this.tg.board();
      case 'tip-ai':
        return () => this.tg.ai();
    }
  }

  show(s: TutorialStep): void {
    if (this.seen(s)) return;
    if (this.active) {
      if (this.active.step === s) return;
      if (!this.queue.includes(s)) this.queue.push(s);
      return;
    }
    const tx = text(s);
    const maze = isMaze(s);
    const ok = h(
      'button.btn.small.coach-ok',
      {
        onclick: () => {
          audio.play('click');
          if (maze) this.lesson({ type: 'ok' });
          else this.done();
        },
      },
      t('ui.tutorial.ok'),
    );
    let route: HTMLElement | undefined;
    let place: HTMLButtonElement | undefined;
    let actions: HTMLElement = ok;
    if (maze) {
      route = h('div.coach-route', { attrs: { 'aria-live': 'polite' } });
      place = h<HTMLButtonElement>(
        'button.btn.small.primary.coach-place',
        {
          onclick: () => {
            audio.play('click');
            this.placeSuggested();
          },
        },
        t('ui.tutorial.mazePlace'),
      );
      const skip = h(
        'button.btn.small.coach-skip',
        {
          onclick: () => {
            audio.play('click');
            this.lesson({ type: 'skip' });
          },
        },
        t('ui.tutorial.skip'),
      );
      actions = h('div.coach-actions', null, skip, place, ok);
      if (s === 'ch1-maze-row') this.routeFrom = maxCells(this.ctx.world.currentPaths());
      // 幽灵墙要点得到：收起塔栏里选中的塔（选着铅笔时点幽灵格会放铅笔）
      if (ui.state.build && ui.state.build !== 'wall') ui.set({ build: null, pending: null });
    }
    const bubble = h(
      'div.coach',
      { attrs: { role: 'note' }, data: maze ? { maze: '' } : undefined },
      h('div.coach-title', null, tx.title),
      h('div.coach-body', null, tx.body),
      route ?? null,
      actions,
      h('span.coach-arrow'),
    );
    const ring = h('div.coach-ring');
    this.ctx.root.append(ring, bubble);
    this.active = { step: s, bubble, ring, target: this.targetFor(s), route, place };
    if (maze) {
      if (!this.routeFrom) this.routeFrom = maxCells(this.ctx.world.currentPaths());
      this.maze?.setLesson(ghostSegment(s));
      this.refreshMaze();
      this.onTerrain();
    }
    // 目标基本是静止的界面元素：前几帧立即定位，之后每 6 帧（约 10 次/秒）才重新量一次位置，
    // 避免每帧读布局；提示圈的呼吸动画由 CSS 完成。
    let n = 0;
    const loop = () => {
      if (n < 3 || n % 6 === 0) this.position();
      n++;
      this.raf = requestAnimationFrame(loop);
    };
    cancelAnimationFrame(this.raf);
    loop();
  }

  private position(): void {
    const a = this.active;
    if (!a) return;
    const tgt = a.target();
    const root = this.ctx.root.getBoundingClientRect();
    const bw = a.bubble.offsetWidth;
    const bh = a.bubble.offsetHeight;
    if (!tgt || !tgt.isConnected || tgt.getClientRects().length === 0) {
      a.ring.style.opacity = '0';
      delete a.ring.dataset.k;
      a.bubble.style.left = `${(root.width - bw) / 2}px`;
      a.bubble.style.top = `${Math.max(10, Math.min(root.height - bh - 10, root.height * 0.3))}px`;
      a.bubble.dataset.side = 'none';
      return;
    }
    const r = tgt.getBoundingClientRect();
    const x = r.left - root.left;
    const y = r.top - root.top;
    const ringKey = `${Math.round(x)},${Math.round(y)},${Math.round(r.width)},${Math.round(r.height)}`;
    if (a.ring.dataset.k !== ringKey) {
      a.ring.dataset.k = ringKey;
      a.ring.style.opacity = '1';
      a.ring.style.transform = `translate(${x - 4}px, ${y - 4}px)`;
      a.ring.style.width = `${r.width + 8}px`;
      a.ring.style.height = `${r.height + 8}px`;
    }
    const cx = x + r.width / 2;
    const cy = y + r.height / 2;
    const margin = 10;
    const gap = 14;
    const clampX = (v: number) => Math.max(margin, Math.min(root.width - bw - margin, v));
    const clampY = (v: number) => Math.max(margin, Math.min(root.height - bh - margin, v));
    // 横屏时目标在棋盘旁边的面板里：气泡要越过整块面板放到棋盘上，
    // 否则会盖住同一面板里的其他按钮（塔栏、顶栏数值）
    let edgeL = x;
    let edgeR = x + r.width;
    const board = this.ctx.landscape() ? this.tg.board() : null;
    if (board && board !== tgt) {
      const br = board.getBoundingClientRect();
      if (r.left >= br.right - 1) edgeL = br.right - root.left;
      else if (r.right <= br.left + 1) edgeR = br.left - root.left;
    }
    // 竖屏时目标在底部操作区（塔栏 / 技能 / 开波）：气泡放到塔栏上方，不挡住这几排按钮
    let edgeT = y;
    if (!board) {
      const build = this.ctx.root.querySelector<HTMLElement>('.g-build');
      const bt = build && build.getClientRects().length > 0 ? build.getBoundingClientRect().top : null;
      if (bt !== null && r.top >= bt - 1) edgeT = bt - root.top;
    }
    // 四个方向各剩多少空间（负数 = 放不下）
    const room = {
      top: edgeT - gap - bh - margin,
      bottom: root.height - margin - (y + r.height + gap + bh),
      left: edgeL - gap - bw - margin,
      right: root.width - margin - (edgeR + gap + bw),
    };
    type Side = keyof typeof room;
    // 横屏时界面在两侧，气泡优先放到棋盘一侧（不挡塔栏 / 开波按钮）；竖屏优先放上面
    const order: Side[] = this.ctx.landscape() ? ['left', 'right', 'top', 'bottom'] : ['top', 'bottom', 'left', 'right'];
    let left: number;
    let top: number;
    let side: string;
    const big = r.width * r.height > root.width * root.height * 0.3;
    // 大目标里只有棋盘（或四周都放不下时）才把气泡放进目标内部；
    // 横置手机上的塔信息卡也很大，但气泡放进去会盖住「升级 / 出售」
    if (big && (tgt === this.tg.board() || !order.some((s) => room[s] >= 0))) {
      // 目标是整块棋盘之类的大区域：放在它里面靠上，不带箭头；
      // 摆迷宫教学的幽灵墙在入口一侧（上方），气泡改放到棋盘里靠下
      left = clampX(cx - bw / 2);
      top = isMaze(a.step) ? clampY(y + r.height - bh - 12) : clampY(y + Math.min(72, r.height * 0.18));
      side = 'none';
    } else {
      const pick: Side = order.find((s) => room[s] >= 0) ?? order.reduce((best, s) => (room[s] > room[best] ? s : best));
      side = pick;
      if (pick === 'top' || pick === 'bottom') {
        left = clampX(cx - bw / 2);
        top = clampY(pick === 'top' ? edgeT - gap - bh : y + r.height + gap);
      } else {
        top = clampY(cy - bh / 2);
        left = clampX(pick === 'left' ? edgeL - gap - bw : edgeR + gap);
      }
    }
    a.bubble.style.left = `${left}px`;
    a.bubble.style.top = `${top}px`;
    a.bubble.dataset.side = side;
    const arrowX = Math.max(14, Math.min(bw - 14, cx - left));
    a.bubble.style.setProperty('--ax', `${arrowX}px`);
    a.bubble.style.setProperty('--ay', `${Math.max(14, Math.min(bh - 14, cy - top))}px`);
  }

  /** 玩家已经用过对应的按钮：正在显示就收起，否则直接记为已看过 */
  ack(s: TutorialStep): void {
    if (this.active?.step === s) this.done();
    else if (!this.seen(s)) {
      this.queue = this.queue.filter((q) => q !== s);
      this.markSeen(s);
    }
  }

  private done(): void {
    const a = this.active;
    if (!a) return;
    this.markSeen(a.step);
    this.hide();
    const next = this.queue.shift();
    if (next) setTimeout(() => this.show(next), 250);
  }

  hide(): void {
    const a = this.active;
    cancelAnimationFrame(this.raf);
    if (!a) return;
    this.active = null;
    if (isMaze(a.step)) this.maze?.setLesson(null);
    a.bubble.classList.add('out');
    a.ring.classList.add('out');
    setTimeout(() => a.ring.remove(), 200);
    setTimeout(() => a.bubble.remove(), 200);
  }

  destroy(): void {
    this.offLocale();
    this.queue = [];
    this.hide();
  }
}
