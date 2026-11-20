/**
 * 本地回放：刚结束的 AI 对局不用先上传，直接用「开局参数 + 指令日志」重放一遍。
 * 与 src/ui/online/replay.ts 相同的做法（新建 Session、按帧号喂指令、棋盘只读），样式也复用它的。
 */
import { AgentTrace, type TraceExport } from '../../agent/trace';
import type { Command, RunOptions } from '../../core/types';
import { Session, type Speed } from '../../game/Session';
import { ui } from '../../game/UiStore';
import { mountBoard } from '../../render';
import type { App } from '../App';
import { audio } from '../audio';
import { fmtNum, h, setText } from '../dom';
import { G } from '../icons';
import { makeFeeder } from '../online/util';
import { mountTracePanel, type TracePanelHandle } from './trace-panel';

export interface LocalReplay {
  opts: RunOptions;
  log: readonly { tick: number; cmd: Command }[];
  /** 结束帧 */
  tick: number;
}

export function openLocalReplay(
  app: App,
  run: LocalReplay,
  o: { title: string; subtitle: string; wave: number; score: number; /** 对局时记录的思路与请求（有就在旁边显示，随回放进度展开） */ trace?: TraceExport },
): () => void {
  const sub = h('small.muted', null, o.subtitle);
  const stage = h('div.replay-stage');
  const speedBox = h('div.replay-speed', { attrs: { role: 'group', 'aria-label': '回放速度' } });
  const pauseBtn = h<HTMLButtonElement>('button.btn.small', { attrs: { type: 'button', 'aria-label': '暂停' } }, h('span.gi', { html: G.pause }));
  const exitBtn = h('button.btn.small', { attrs: { type: 'button' } }, h('span.gi', { html: G.close }), '退出');
  const root = h(
    'div.replay-view.ai-replay',
    { attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': '观看回放' } },
    h('div.replay-bar', null, h('div.replay-title', null, h('b', null, o.title), sub), speedBox, pauseBtn, exitBtn),
    stage,
  );

  let session: Session | null = null;
  let board: { destroy(): void } | null = null;
  let tp: TracePanelHandle | null = null;
  let raf = 0;
  let closed = false;
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const close = (): void => {
    if (closed) return;
    closed = true;
    cancelAnimationFrame(raf);
    document.removeEventListener('keydown', onKey, true);
    tp?.destroy();
    try {
      board?.destroy();
    } catch {
      /* ignore */
    }
    session?.dispose();
    ui.clear();
    root.remove();
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  };
  const onKey = (e: KeyboardEvent): void => {
    e.stopPropagation();
    // 思路与请求面板里的输入框 / 按钮：按键留给它们（Esc 仍然退出回放）
    if (e.key !== 'Escape' && e.target instanceof HTMLElement && e.target.closest('.tr-panel')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      audio.play('click');
      close();
    } else if (e.key === ' ' && session && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      session.togglePause();
    }
  };
  exitBtn.onclick = () => {
    audio.play('click');
    close();
  };
  document.addEventListener('keydown', onKey, true);
  (app.root ?? document.body).appendChild(root);
  if (o.trace?.events?.length) {
    try {
      tp = mountTracePanel({
        host: root,
        anchor: () => stage,
        trace: AgentTrace.fromExport(o.trace),
        live: false,
        subtitle: '随回放进度显示',
        onHighlight: (c) => ui.set({ aiFocus: c ? { cx: c.x, cy: c.y } : null }),
      });
      exitBtn.before(tp.toggle);
      tp.setTickLimit(0);
    } catch (e) {
      console.error('[ai] 思路与请求面板加载失败', e);
    }
  }

  try {
    session = new Session(JSON.parse(JSON.stringify(run.opts)) as RunOptions);
  } catch (e) {
    console.error(e);
    setText(sub, '这条回放无法播放');
    return close;
  }
  const s = session;
  const world = s.world;
  const feeder = makeFeeder(world, run.log);
  const origStep = world.step.bind(world);
  (world as { step: () => void }).step = () => {
    feeder.feed();
    origStep();
  };
  feeder.feed();
  ui.clear();

  const boardHost = h('div.replay-board');
  const blocker = h('div.replay-blocker', { attrs: { 'aria-hidden': 'true' } });
  for (const ev of ['pointerdown', 'pointerup', 'pointermove', 'click', 'wheel', 'touchstart', 'contextmenu']) {
    blocker.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
  }
  stage.append(boardHost, blocker);
  try {
    board = mountBoard(boardHost, s);
  } catch (e) {
    console.error(e);
    setText(sub, '棋盘加载失败');
    return close;
  }

  const speeds = [1, 2, 4, 8];
  const paintSpeed = (): void => {
    speedBox.replaceChildren(
      ...speeds.map((v) =>
        h(
          `button.seg${s.speed === v ? '.on' : ''}`,
          {
            attrs: { type: 'button', 'aria-pressed': s.speed === v ? 'true' : 'false' },
            onclick: () => {
              audio.play('click');
              // Session 的速度类型只到 3×，运行时任意倍数都可用
              s.setSpeed(v as Speed);
              paintSpeed();
            },
          },
          `${v}×`,
        ),
      ),
    );
  };
  s.setSpeed(2);
  paintSpeed();
  pauseBtn.onclick = () => {
    audio.play('click');
    s.togglePause();
  };

  let ended = false;
  let lastPaused: boolean | null = null;
  const loop = (): void => {
    if (closed) return;
    // 增益选择阶段 Session 不推进，这里补喂
    feeder.feed();
    const st = world.state;
    if (lastPaused !== s.paused) {
      lastPaused = s.paused;
      pauseBtn.replaceChildren(h('span.gi', { html: s.paused ? G.play : G.pause }));
      pauseBtn.setAttribute('aria-label', s.paused ? '继续' : '暂停');
    }
    tp?.setTickLimit(st.tick);
    const pct = run.tick > 0 ? Math.min(100, Math.round((st.tick / run.tick) * 100)) : 100;
    setText(sub, `${o.subtitle} · 第 ${st.wave} 波 · ${fmtNum(Math.round(st.score))} 分 · ${pct}%`);
    const done = st.phase === 'lost' || st.phase === 'won' || (st.tick >= run.tick && feeder.done);
    if (done && !ended) {
      ended = true;
      s.togglePause(true);
      stage.appendChild(
        h(
          'div.replay-end',
          null,
          h(
            'div.card',
            null,
            h('h3', null, '回放结束'),
            h('p', null, `撑过 ${o.wave} 波 · ${fmtNum(o.score)} 分`),
            Math.round(st.score) !== o.score ? h('small.muted', null, '回放结果与原对局不完全一致') : h('small.muted', null, '与原对局完全一致'),
            h('button.btn.primary', { attrs: { type: 'button' }, onclick: () => (audio.play('click'), close()) }, '退出回放'),
          ),
        ),
      );
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  return close;
}
