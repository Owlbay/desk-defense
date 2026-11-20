import type { GameEvent } from '../../core/types';
import { audio } from '../audio';
import { h } from '../dom';
import type { GameCtx } from './context';

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
  // 所有模式通用的一次性提示（文档 09 / 11）
  | 'tip-event'
  | 'tip-drop'
  | 'tip-evolve';

interface Targets {
  build(id: 'pencil' | 'wall'): HTMLElement | null;
  start(): HTMLElement | null;
  info(): HTMLElement | null;
  board(): HTMLElement | null;
  skill(id: 'eraser_strike'): HTMLElement | null;
  skills(): HTMLElement | null;
  /** 随机事件横幅 / 即将发生时间轴 */
  events(): HTMLElement | null;
}

interface Active {
  step: TutorialStep;
  bubble: HTMLElement;
  ring: HTMLElement;
  target: () => HTMLElement | null;
}

const TEXT: Record<TutorialStep, { title: string; body: string }> = {
  'ch1-place': { title: '放一座铅笔塔', body: '点塔栏里的「铅笔」，再点棋盘上路线旁边的空格放下它。手机上点一次预览，再点同一格确认。' },
  'ch1-start': { title: '开始第 1 波', body: '准备好了就点这里。敌人会从顶部入口出发，沿路线走向底部的作业本。' },
  'ch1-wall': { title: '用书本墙改路线', body: '书本墙很便宜。放置前会高亮新的路线——把路绕长，塔就能多打几下。注意不能把路完全堵死。' },
  'ch1-upgrade': { title: '让塔成长', body: '点选一座塔：经验条会随击杀上涨，也可以直接花金币升级，攒的经验越多，升级越便宜。' },
  'ch1-sell': { title: '出售与撤销', body: '不需要的塔可以出售。等级越高，返还比例越低（70% → 25%）；刚放下 5 秒内可以全额撤销。' },
  'ch1-boss': { title: 'Boss 来了！', body: '点「大橡皮」，再点棋盘上的位置释放，对范围内的敌人造成大量伤害。' },
  'tip-event': { title: '随机事件', body: '书桌上会突然发生事件：红色是坏事，绿色是好事。顶部横幅会提前预警并倒计时；硬币和补给箱要点一下才能收集。' },
  'tip-drop': { title: '空降纸箱！', body: '虚线圈里很快会落下一个纸箱，变成新的出生点，路线也会跟着改变。点纸箱可以花金币拆除，技能「封箱胶带」也能直接封掉。' },
  'tip-evolve': { title: '传奇进化', body: '传奇塔之后获得的经验会计入进化。攒经验或花金币升星：★1、★2 解锁分支特性，★3 成为神话并获得主动能力（选中后按 A 释放）。' },
};

export class Tutorial {
  private active: Active | null = null;
  private queue: TutorialStep[] = [];
  private raf = 0;
  readonly enabled: boolean;

  constructor(
    private ctx: GameCtx,
    private t: Targets,
  ) {
    const o = ctx.opts;
    this.enabled = o.mode === 'campaign' && o.map === 'ch1';
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
    if (!this.enabled) return;
    const st = this.ctx.world.state;
    if (st.wave === 0 && st.phase === 'build') {
      if (!this.seen('ch1-place') && st.towers.size === 0) this.show('ch1-place');
      else if (!this.seen('ch1-start')) this.show('ch1-start');
    }
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
    }
    if (!this.enabled) return;
    switch (ev.type) {
      case 'place':
        if (cur === 'ch1-place') {
          this.done();
          this.show('ch1-start');
        } else if (cur === 'ch1-wall' && ev.tower === 'wall') this.done();
        break;
      case 'waveStart':
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
        return () => this.t.build('pencil');
      case 'ch1-start':
        return () => this.t.start();
      case 'ch1-wall':
        return () => this.t.build('wall');
      case 'ch1-upgrade':
      case 'ch1-sell':
        return () => this.t.info() ?? this.t.board();
      case 'ch1-boss':
        return () => this.t.skill('eraser_strike') ?? this.t.skills();
      case 'tip-event':
        return () => this.t.events() ?? this.t.board();
      case 'tip-drop':
        return () => this.t.board();
      case 'tip-evolve':
        return () => this.t.info() ?? this.t.board();
    }
  }

  show(s: TutorialStep): void {
    if (this.seen(s)) return;
    if (this.active) {
      if (this.active.step === s) return;
      if (!this.queue.includes(s)) this.queue.push(s);
      return;
    }
    const text = TEXT[s];
    const bubble = h(
      'div.coach',
      { attrs: { role: 'note' } },
      h('div.coach-title', null, text.title),
      h('div.coach-body', null, text.body),
      h(
        'button.btn.small.coach-ok',
        {
          onclick: () => {
            audio.play('click');
            this.done();
          },
        },
        '知道了',
      ),
      h('span.coach-arrow'),
    );
    const ring = h('div.coach-ring');
    this.ctx.root.append(ring, bubble);
    this.active = { step: s, bubble, ring, target: this.targetFor(s) };
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
    const board = this.ctx.landscape() ? this.t.board() : null;
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
    if (big && (tgt === this.t.board() || !order.some((s) => room[s] >= 0))) {
      // 目标是整块棋盘之类的大区域：放在它里面靠上，不带箭头
      left = clampX(cx - bw / 2);
      top = clampY(y + Math.min(72, r.height * 0.18));
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
    a.bubble.classList.add('out');
    a.ring.classList.add('out');
    setTimeout(() => a.ring.remove(), 200);
    setTimeout(() => a.bubble.remove(), 200);
  }

  destroy(): void {
    this.queue = [];
    this.hide();
  }
}
