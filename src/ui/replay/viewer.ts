/**
 * 观看回放：排行榜成绩与 AI 对局共用的播放器。
 *
 * - 画面就是对局界面本身（GameScreen 的旁观模式）：顶栏、波次横幅、提示、Boss 血条、事件、塔栏 / 塔信息（只读）、
 *   增益与补给的选择、胜负大字都和玩家当时看到的一样；玩家的操作一律拦下（Session.readOnly + 界面拦截）。
 * - 底部进度条：当前时间 / 波次 / 总长、播放暂停、速度、波次刻度（Boss 波单独标出），点击或拖动任意位置跳转。
 *   往后跳在同一个 World 上快进；往前跳用开局参数新建 World 从头快进（分片进行，界面不卡），快进期间不放提示 / 横幅。
 * - 键盘：空格 播放 / 暂停，←/→ 快退 / 快进 5 秒，Shift+←/→ 上一波 / 下一波，Home / End 跳到开头 / 结尾，Esc 退出。
 */
import { createWorld } from '../../core';
import { type Command, DT, type RunOptions, type WorldState } from '../../core/types';
import { Session, type Speed } from '../../game/Session';
import { ui } from '../../game/UiStore';
import { t } from '../../i18n';
import {
  advanceAsync,
  type AdvanceTask,
  collectWaveMarks,
  fmtClock,
  ReplayDriver,
  type ReplayRun,
  seekPlan,
  waveAt,
  type WaveMark,
  waveSeekTarget,
} from '../../meta/replay';
import type { App } from '../App';
import { audio } from '../audio';
import { h, isTypingTarget, setText } from '../dom';
import { type SpectateScreen, spectateScreen } from '../hud/GameScreen';
import { G } from '../icons';

export type { ReplayRun } from '../../meta/replay';

/** 每个播放器自己的文案（排行榜 / AI 回放各有一套） */
export interface ReplayLabels {
  dialog: string;
  speed: string;
  exit: string;
  exitReplay: string;
  ended: string;
}

export interface ReplayPlayOptions {
  /** 标题下的状态行（每帧调用，内容不变时不会改 DOM） */
  status(st: WorldState, pct: number): string;
  /** 结束卡片里的结果行与提示（如「与原局一致」） */
  result(st: WorldState): (HTMLElement | string | null)[];
  speeds?: number[];
  defaultSpeed?: number;
  /** 每帧回调（AI 回放：思路面板随进度展开） */
  onFrame?(tick: number): void;
}

export interface ReplayView {
  readonly root: HTMLElement;
  readonly stage: HTMLElement;
  /** 顶栏「退出」按钮（额外的按钮插到它前面） */
  readonly exitBtn: HTMLElement;
  setSub(text: string): void;
  /** 加载 / 播放失败：在舞台上显示说明 */
  fail(title: string, detail?: string): void;
  play(run: ReplayRun, o: ReplayPlayOptions): void;
  close(): void;
  /** 关闭时回调（释放外部挂上的面板） */
  onClose(fn: () => void): void;
}

/** 快进 / 快退一次的秒数 */
const STEP_SEC = 5;
/** 增益三选一在回放里停留展示的时长（1× 速度；越快越短） */
const PERK_DWELL_MS = 1600;

export function openReplayView(
  app: App,
  o: {
    title: string;
    subtitle: string;
    labels: ReplayLabels;
    /** 这些容器里的按键留给它们自己（Esc 仍然退出） */
    keysIgnoredIn?: string;
    className?: string;
  },
): ReplayView {
  const L = o.labels;
  const sub = h('small.muted', null, o.subtitle);
  const stage = h('div.replay-stage');
  const speedBox = h('div.replay-speed', { attrs: { role: 'group', 'aria-label': L.speed } });
  const exitBtn = h('button.btn.small', { attrs: { type: 'button' } }, h('span.gi', { html: G.close }), L.exit);

  // ── 进度条 ──
  const playBtn = h<HTMLButtonElement>(
    'button.btn.small.rt-play',
    { attrs: { type: 'button', 'aria-label': t('ui.replay.pause') } },
    h('span.gi', { html: G.pause }),
  );
  const prevBtn = h<HTMLButtonElement>(
    'button.btn.small.rt-step.rt-prev',
    { attrs: { type: 'button', 'aria-label': t('ui.replay.prevWave'), title: t('ui.replay.prevWave') } },
    h('span.gi', { html: G.back }),
  );
  const nextBtn = h<HTMLButtonElement>(
    'button.btn.small.rt-step.rt-next',
    { attrs: { type: 'button', 'aria-label': t('ui.replay.nextWave'), title: t('ui.replay.nextWave') } },
    h('span.gi', { html: G.back }),
  );
  const timeText = h('span.rt-time');
  const waveText = h('span.rt-wave');
  const fill = h('span.rt-fill');
  const scanFill = h('span.rt-scan');
  const marksBox = h('span.rt-marks', { attrs: { 'aria-hidden': 'true' } });
  const thumb = h('span.rt-thumb');
  const tip = h('span.rt-tip', { attrs: { 'aria-hidden': 'true' } });
  tip.hidden = true;
  const track = h(
    'div.rt-track',
    {
      attrs: {
        role: 'slider',
        tabindex: '0',
        'aria-label': t('ui.replay.timeline'),
        'aria-valuemin': '0',
        'aria-valuemax': '0',
        'aria-valuenow': '0',
      },
      title: t('ui.replay.keys'),
    },
    h('span.rt-rail', null, scanFill, fill, marksBox),
    thumb,
    tip,
  );
  const timeline = h(
    'div.replay-timeline',
    null,
    playBtn,
    h('div.rt-info', null, timeText, waveText),
    h('div.rt-steps', null, prevBtn, nextBtn),
    track,
  );
  timeline.hidden = true;

  const root = h(
    `div.replay-view${o.className ? `.${o.className}` : ''}`,
    { attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': L.dialog } },
    h('div.replay-bar', null, h('div.replay-title', null, h('b', null, o.title), sub), speedBox, exitBtn),
    stage,
    timeline,
  );

  const closeFns: (() => void)[] = [];
  let closed = false;
  let player: Player | null = null;
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('visibilitychange', onVis);
    player?.destroy();
    player = null;
    for (const fn of closeFns) {
      try {
        fn();
      } catch (e) {
        console.error(e);
      }
    }
    ui.clear();
    root.remove();
    // 回放里的配乐跟着波次变过：回到菜单曲
    audio.setMusicState('menu');
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  };

  const onKey = (e: KeyboardEvent): void => {
    // 回放期间截住所有按键，避免触发后面页面 / 对局的快捷键
    e.stopPropagation();
    if (e.key !== 'Escape' && o.keysIgnoredIn && e.target instanceof HTMLElement && e.target.closest(o.keysIgnoredIn)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      audio.play('click');
      close();
      return;
    }
    if (!player || isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case ' ':
        // 焦点在按钮上时空格交给按钮自己
        if (e.target instanceof HTMLButtonElement) return;
        e.preventDefault();
        if (!e.repeat) player.togglePlay();
        break;
      case 'ArrowLeft':
      case 'ArrowRight': {
        e.preventDefault();
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        if (e.shiftKey) player.seekWave(dir);
        else player.seekBy(dir * STEP_SEC);
        break;
      }
      case 'Home':
        e.preventDefault();
        player.seekTo(0);
        break;
      case 'End':
        e.preventDefault();
        player.seekTo(Infinity);
        break;
    }
  };
  const onVis = (): void => player?.setHidden(document.hidden);
  exitBtn.onclick = () => {
    audio.play('click');
    close();
  };
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('visibilitychange', onVis);
  (app.root ?? document.body).appendChild(root);

  const fail = (title: string, detail?: string): void => {
    stage.querySelector('.replay-end')?.remove();
    stage.appendChild(h('div.replay-end', null, h('div.card', null, h('p', null, title), detail ? h('small.muted', null, detail) : null)));
  };

  return {
    root,
    stage,
    exitBtn,
    setSub: (text) => setText(sub, text),
    fail,
    onClose: (fn) => void closeFns.push(fn),
    close,
    play(run, po) {
      if (closed || player) return;
      try {
        player = new Player(app, run, po, {
          stage,
          sub,
          speedBox,
          timeline,
          playBtn,
          prevBtn,
          nextBtn,
          timeText,
          waveText,
          track,
          fill,
          scanFill,
          marksBox,
          thumb,
          tip,
          labels: L,
          close,
        });
      } catch (e) {
        console.error(e);
        player = null;
        fail(t('ui.replay.cannotPlay'));
      }
    },
  };
}

interface PlayerEls {
  stage: HTMLElement;
  sub: HTMLElement;
  speedBox: HTMLElement;
  timeline: HTMLElement;
  playBtn: HTMLButtonElement;
  prevBtn: HTMLButtonElement;
  nextBtn: HTMLButtonElement;
  timeText: HTMLElement;
  waveText: HTMLElement;
  track: HTMLElement;
  fill: HTMLElement;
  scanFill: HTMLElement;
  marksBox: HTMLElement;
  thumb: HTMLElement;
  tip: HTMLElement;
  labels: ReplayLabels;
  close(): void;
}

/** 一次播放：Session + 回放驱动 + 旁观界面 + 进度条 */
class Player {
  private session!: Session;
  private driver!: ReplayDriver;
  private screen: SpectateScreen | null = null;
  private unstep: (() => void) | null = null;
  private unChange: (() => void) | null = null;
  private raf = 0;
  private destroyed = false;
  private speed: number;
  private readonly speeds: number[];
  private readonly end: number;
  /** 波次刻度（后台扫描整局得到；扫描完成前只有已扫到的部分） */
  private marks: WaveMark[] = [];
  private scanTick = 0;
  private scan: AdvanceTask | null = null;
  // 跳转
  private seekTask: AdvanceTask | null = null;
  private seekId = 0;
  private seekTarget: number | null = null;
  private resumeAfterSeek = false;
  private seekInd: { el: HTMLElement; text: HTMLElement; bar: HTMLElement } | null = null;
  private seekIndTimer: ReturnType<typeof setTimeout> | null = null;
  private hidden = false;
  // 增益三选一停留
  private dwellAt: number | null = null;
  // 结束
  private endEl: HTMLElement | null = null;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  // 拖动
  private dragging = false;
  private dragTick = 0;
  // 进度条显示缓存
  private shown = { tick: -1, wave: -1, paused: null as boolean | null, sub: '', marks: -1 };

  constructor(
    private app: App,
    private run: ReplayRun,
    private o: ReplayPlayOptions,
    private els: PlayerEls,
  ) {
    this.end = Math.max(0, run.tick);
    this.speeds = o.speeds ?? [1, 2, 4, 8];
    this.speed = o.defaultSpeed ?? 1;
    const s = this.makeSession();
    this.attach(s, new ReplayDriver(s.world, run), false);
    els.timeline.hidden = false;
    els.track.setAttribute('aria-valuemax', String(this.end));
    this.paintSpeed();
    this.bindControls();
    this.startScan();
    this.raf = requestAnimationFrame(this.loop);
  }

  // ───────────── Session / 界面 ─────────────

  private makeSession(): Session {
    const s = new Session(JSON.parse(JSON.stringify(this.run.opts)) as RunOptions);
    s.readOnly = true;
    return s;
  }

  /** 挂上新的 Session（首次 / 往前跳重建）：旧界面与旧 Session 一并释放 */
  private attach(s: Session, d: ReplayDriver, paused: boolean): void {
    const keepSel = this.screen?.selected ?? null;
    this.detach();
    this.session = s;
    this.driver = d;
    this.unstep = d.install();
    d.onCommand = (cmd: Command) => this.screen?.noteCommand(cmd);
    s.setSpeed(this.speed as Speed);
    s.togglePause(paused);
    this.unChange = s.onChange(() => {
      // 对局界面的速度键（1–3×）也能改速度：同步到回放的速度按钮
      if (s.speed !== this.speed) {
        this.speed = s.speed;
        this.paintSpeed();
      }
    });
    const screen = spectateScreen(this.app, this.run.opts, {
      session: s,
      togglePause: () => this.togglePlay(),
      onGameOver: () => this.showEnd(1400),
    });
    this.screen = screen;
    this.els.stage.prepend(screen.el);
    if (keepSel !== null) {
      // 界面开局时会清空选择（下一帧），之后再选回同一座塔（uid 由回放决定，同一帧同一座塔）
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (!this.destroyed && this.session === s && s.world.state.towers.has(keepSel)) ui.set({ selected: keepSel });
        }),
      );
    }
  }

  private detach(): void {
    this.unChange?.();
    this.unChange = null;
    this.unstep?.();
    this.unstep = null;
    if (this.screen) {
      try {
        this.screen.destroy?.();
      } catch (e) {
        console.error(e);
      }
      this.screen.el.remove();
      this.screen = null;
    }
    this.session?.dispose();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.scan?.cancel();
    this.seekTask?.cancel();
    if (this.seekIndTimer) clearTimeout(this.seekIndTimer);
    if (this.endTimer) clearTimeout(this.endTimer);
    this.detach();
  }

  // ───────────── 播放控制 ─────────────

  private get playing(): boolean {
    return this.seekTarget !== null ? this.resumeAfterSeek : !this.session.paused;
  }

  togglePlay(): void {
    audio.play('click');
    if (this.seekTarget !== null) {
      this.resumeAfterSeek = !this.resumeAfterSeek;
      this.paintPlay();
      return;
    }
    // 播完了：从头再看
    if (this.driver.atEnd && this.session.paused) {
      this.seekTo(0, true);
      return;
    }
    this.session.togglePause();
  }

  setHidden(v: boolean): void {
    this.hidden = v;
    if (this.seekTarget === null) this.session.setAutoPaused(v);
  }

  private paintSpeed(): void {
    const { speedBox } = this.els;
    speedBox.replaceChildren(
      ...this.speeds.map((v) =>
        h(
          `button.seg${this.speed === v ? '.on' : ''}`,
          {
            attrs: { type: 'button', 'aria-pressed': this.speed === v ? 'true' : 'false' },
            onclick: () => {
              audio.play('click');
              this.speed = v;
              // Session 的速度类型只到 3×，运行时任意倍数都可用
              this.session.setSpeed(v as Speed);
              this.paintSpeed();
            },
          },
          `${v}×`,
        ),
      ),
    );
  }

  private paintPlay(): void {
    const paused = !this.playing;
    if (this.shown.paused === paused) return;
    this.shown.paused = paused;
    const { playBtn } = this.els;
    playBtn.replaceChildren(h('span.gi', { html: paused ? G.play : G.pause }));
    playBtn.setAttribute('aria-label', paused ? t('ui.replay.play') : t('ui.replay.pause'));
    playBtn.title = paused ? t('ui.replay.play') : t('ui.replay.pause');
  }

  // ───────────── 跳转 ─────────────

  private get baseTick(): number {
    return this.seekTarget ?? this.driver.tick;
  }

  seekBy(sec: number): void {
    this.seekTo(this.baseTick + Math.round(sec / DT));
  }

  seekWave(dir: -1 | 1): void {
    const target = waveSeekTarget(this.marks, this.baseTick, dir);
    if (target !== null) this.seekTo(target);
  }

  /** 跳到 target 帧；play = 跳完后播放（缺省保持跳转前的播放状态） */
  seekTo(target: number, play?: boolean): void {
    if (this.destroyed) return;
    const goal = Math.max(0, Math.min(this.end, Math.round(Number.isFinite(target) ? target : this.end)));
    const plan = seekPlan(this.driver.tick, goal);
    if (this.seekTarget === null) this.resumeAfterSeek = !this.session.paused;
    if (play !== undefined) this.resumeAfterSeek = play;
    this.seekTask?.cancel();
    this.seekTask = null;
    const id = ++this.seekId;
    this.dwellAt = null;
    this.screen?.markPerk(null);
    if (goal < this.end) this.hideEnd();
    if (plan === 'none') {
      this.finishSeek(id);
      return;
    }
    this.seekTarget = goal;
    this.session.setAutoPaused(true);
    this.showSeeking(0);
    const progress = (p: number): void => {
      if (id === this.seekId) this.showSeeking(p);
    };
    if (plan === 'forward') {
      const task = advanceAsync(this.driver, goal, progress);
      this.seekTask = task;
      task.promise.then(
        (ok) => ok && this.finishSeek(id),
        (e) => this.seekFailed(id, e),
      );
      return;
    }
    // 往前跳：新开一局从头快进；完成前旧画面保持不动
    const s = this.makeSession();
    const d = new ReplayDriver(s.world, this.run);
    const task = advanceAsync(d, goal, progress);
    this.seekTask = task;
    task.promise.then(
      (ok) => {
        if (!ok || id !== this.seekId || this.destroyed) {
          s.dispose();
          return;
        }
        this.attach(s, d, true);
        this.finishSeek(id);
      },
      (e) => {
        s.dispose();
        this.seekFailed(id, e);
      },
    );
  }

  private finishSeek(id: number): void {
    if (id !== this.seekId || this.destroyed) return;
    this.seekTask = null;
    this.seekTarget = null;
    this.hideSeeking();
    this.session.setAutoPaused(this.hidden);
    this.session.togglePause(!this.resumeAfterSeek || this.driver.atEnd);
    if (this.driver.atEnd) this.showEnd(0);
  }

  private seekFailed(id: number, e: unknown): void {
    console.error(e);
    if (id !== this.seekId || this.destroyed) return;
    this.seekTask = null;
    this.seekTarget = null;
    this.hideSeeking();
    this.session.setAutoPaused(this.hidden);
    this.app.toast(t('ui.replay.seekFailed'), 'warn');
  }

  /** 跳转进度：很快就完成的跳转不闪提示（150ms 后才出现） */
  private showSeeking(p: number): void {
    if (!this.seekInd) {
      const text = h('span');
      const bar = h('span.rs-fill');
      const el = h('div.replay-seeking', { attrs: { role: 'status' } }, text, h('span.rs-bar', null, bar));
      el.hidden = true;
      this.seekInd = { el, text, bar };
      this.els.stage.appendChild(el);
      this.seekIndTimer = setTimeout(() => {
        this.seekIndTimer = null;
        if (this.seekInd) this.seekInd.el.hidden = false;
      }, 150);
    }
    setText(this.seekInd.text, t('ui.replay.seeking', { pct: Math.round(p * 100) }));
    this.seekInd.bar.style.transform = `scaleX(${p.toFixed(3)})`;
  }

  private hideSeeking(): void {
    if (this.seekIndTimer) clearTimeout(this.seekIndTimer);
    this.seekIndTimer = null;
    this.seekInd?.el.remove();
    this.seekInd = null;
  }

  // ───────────── 波次刻度（后台扫描） ─────────────

  private startScan(): void {
    let d: ReplayDriver;
    try {
      d = new ReplayDriver(createWorld(JSON.parse(JSON.stringify(this.run.opts)) as RunOptions), this.run);
    } catch (e) {
      console.error(e);
      return;
    }
    // 低优先级：每片 4ms，和播放 / 跳转交替进行
    const task = advanceAsync(
      d,
      this.end,
      () => {
        this.scanTick = d.tick;
      },
      { budgetMs: 4, sink: (evs, tick) => collectWaveMarks(evs, tick, this.marks) },
    );
    this.scan = task;
    task.promise.then(
      () => {
        this.scanTick = this.end;
        this.scan = null;
      },
      (e) => console.error('[replay] scan failed', e),
    );
  }

  private paintMarks(): void {
    if (this.shown.marks === this.marks.length) return;
    const box = this.els.marksBox;
    for (let i = this.shown.marks < 0 ? 0 : this.shown.marks; i < this.marks.length; i++) {
      const m = this.marks[i];
      const el = h(`span.rt-mark${m.boss ? '.boss' : ''}`);
      el.style.left = `${this.pct(m.tick)}%`;
      if (m.boss) el.title = t('ui.replay.bossWave', { n: m.wave });
      box.appendChild(el);
    }
    this.shown.marks = this.marks.length;
  }

  // ───────────── 进度条交互 ─────────────

  private pct(tick: number): number {
    return this.end > 0 ? Math.max(0, Math.min(100, (tick / this.end) * 100)) : 0;
  }

  private tickAtClient(clientX: number): number {
    const r = this.els.track.getBoundingClientRect();
    const k = r.width > 0 ? (clientX - r.left) / r.width : 0;
    return Math.round(Math.max(0, Math.min(1, k)) * this.end);
  }

  private waveLabel(tick: number): string {
    const w = waveAt(this.marks, tick);
    if (w <= 0) return t('ui.replay.beforeWave');
    const boss = this.marks.find((m) => m.wave === w)?.boss;
    return boss ? t('ui.replay.bossWave', { n: w }) : t('ui.replay.wave', { n: w });
  }

  private bindControls(): void {
    const { track, playBtn, prevBtn, nextBtn, tip } = this.els;
    playBtn.onclick = () => this.togglePlay();
    prevBtn.onclick = () => (audio.play('click'), this.seekWave(-1));
    nextBtn.onclick = () => (audio.play('click'), this.seekWave(1));
    const showTip = (tick: number): void => {
      tip.hidden = false;
      setText(tip, `${fmtClock(tick * DT)} · ${this.waveLabel(tick)}`);
      tip.style.left = `${this.pct(tick)}%`;
    };
    track.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      track.setPointerCapture(e.pointerId);
      this.dragging = true;
      this.dragTick = this.tickAtClient(e.clientX);
      track.classList.add('dragging');
      showTip(this.dragTick);
    });
    track.addEventListener('pointermove', (e) => {
      const tick = this.tickAtClient(e.clientX);
      if (this.dragging) this.dragTick = tick;
      // 鼠标悬停也显示时间提示；触屏只在拖动时显示
      if (this.dragging || e.pointerType === 'mouse') showTip(tick);
    });
    const release = (commit: boolean) => (e: PointerEvent) => {
      if (!this.dragging) {
        if (e.type === 'pointerleave') tip.hidden = true;
        return;
      }
      this.dragging = false;
      track.classList.remove('dragging');
      tip.hidden = true;
      if (commit) this.seekTo(this.tickAtClient(e.clientX));
    };
    track.addEventListener('pointerup', release(true));
    track.addEventListener('pointercancel', release(false));
    track.addEventListener('pointerleave', release(false));
    track.addEventListener('lostpointercapture', () => {
      if (this.dragging) {
        this.dragging = false;
        track.classList.remove('dragging');
        tip.hidden = true;
      }
    });
  }

  // ───────────── 结束 ─────────────

  private showEnd(delayMs: number): void {
    if (this.endEl || this.endTimer) return;
    this.endTimer = setTimeout(() => {
      this.endTimer = null;
      if (this.destroyed || this.endEl || this.seekTarget !== null || !this.driver.atEnd) return;
      this.session.togglePause(true);
      const st = this.session.world.state;
      const L = this.els.labels;
      this.endEl = h(
        'div.replay-end',
        null,
        h(
          'div.card',
          null,
          h('h3', null, L.ended),
          ...this.o.result(st),
          h(
            'div.row.center.replay-end-actions',
            null,
            h(
              'button.btn',
              { attrs: { type: 'button' }, onclick: () => (audio.play('click'), this.seekTo(0, true)) },
              h('span.gi', { html: G.refresh }),
              t('ui.replay.restart'),
            ),
            h('button.btn.primary', { attrs: { type: 'button' }, onclick: () => (audio.play('click'), this.els.close()) }, L.exitReplay),
          ),
        ),
      );
      this.els.stage.appendChild(this.endEl);
    }, delayMs);
  }

  private hideEnd(): void {
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = null;
    this.endEl?.remove();
    this.endEl = null;
  }

  // ───────────── 每帧 ─────────────

  private loop = (): void => {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.loop);
    const s = this.session;
    const d = this.driver;
    const st = s.world.state;
    if (this.seekTarget === null) {
      // 增益选择阶段 Session 不推进：停留一会儿展示原局选了哪张，再补喂
      if (st.phase === 'perk') {
        const cmd = d.pending();
        if (cmd && s.running) {
          const now = performance.now();
          if (this.dwellAt === null) {
            this.dwellAt = now;
            if (cmd.type === 'choosePerk') this.screen?.markPerk(cmd.id);
          }
          const dwell = (cmd.type === 'choosePerk' ? PERK_DWELL_MS : PERK_DWELL_MS / 2) / Math.max(1, this.speed);
          if (now - this.dwellAt >= dwell) {
            this.dwellAt = null;
            d.feed();
          }
        }
      } else {
        this.dwellAt = null;
      }
      if (d.atEnd && !this.endEl && !this.endTimer) {
        const over = st.phase === 'won' || st.phase === 'lost';
        // 分出胜负时界面会通知（先放结算大字）；兜底：没有胜负的结束（到结束帧）直接出卡片
        if (!over) {
          s.togglePause(true);
          this.showEnd(0);
        }
      }
    }
    this.paint(st);
    this.o.onFrame?.(st.tick);
  };

  private paint(st: WorldState): void {
    const els = this.els;
    this.paintPlay();
    this.paintMarks();
    const tick = this.seekTarget ?? st.tick;
    const showTick = this.dragging ? this.dragTick : tick;
    if (showTick !== this.shown.tick) {
      this.shown.tick = showTick;
      const p = this.pct(showTick);
      els.fill.style.transform = `scaleX(${(p / 100).toFixed(4)})`;
      els.thumb.style.left = `${p}%`;
      setText(els.timeText, t('ui.replay.time', { cur: fmtClock(showTick * DT), total: fmtClock(this.end * DT) }));
      els.track.setAttribute('aria-valuenow', String(showTick));
      els.track.setAttribute('aria-valuetext', t('ui.replay.valueText', { time: fmtClock(showTick * DT), wave: this.waveLabel(showTick) }));
    }
    const wave = this.seekTarget !== null || this.dragging ? waveAt(this.marks, showTick) : st.wave;
    if (wave !== this.shown.wave) {
      this.shown.wave = wave;
      setText(els.waveText, wave > 0 ? t('ui.replay.wave', { n: wave }) : t('ui.replay.beforeWave'));
    }
    els.scanFill.style.transform = `scaleX(${(this.pct(this.scanTick) / 100).toFixed(4)})`;
    const prev = waveSeekTarget(this.marks, this.baseTick, -1);
    const next = waveSeekTarget(this.marks, this.baseTick, 1);
    els.prevBtn.disabled = prev === null;
    els.nextBtn.disabled = next === null;
    const pct = this.end > 0 ? Math.min(100, Math.round((st.tick / this.end) * 100)) : 100;
    const subText = this.o.status(st, pct);
    if (subText !== this.shown.sub) {
      this.shown.sub = subText;
      setText(els.sub, subText);
    }
  }
}
