/**
 * 只读回放：用成绩的开局参数 + 种子新建 Session，按帧号喂入记录的指令。
 * 棋盘用 mountBoard 渲染，上面盖一层透明遮罩拦住所有点击（回放不接受玩家操作）。
 */
import { makeFeeder } from './util';
import { Session, type Speed } from '../../game/Session';
import { ui } from '../../game/UiStore';
import { fetchRun, type RunReplay } from '../../meta/online';
import { mountBoard } from '../../render';
import type { App } from '../App';
import { audio } from '../audio';
import { MAP_META } from '../coreMeta';
import { fmtNum, h, setText } from '../dom';
import { G } from '../icons';
import { boardLabel } from '../../shared/leaderboard';

/** 打开回放（先拉取数据）。返回关闭函数。 */
export function openReplay(app: App, runId: string, nickname?: string): () => void {
  const title = h('b', null, nickname ? `${nickname} 的回放` : '回放');
  const sub = h('small.muted', null, '正在加载…');
  const stage = h('div.replay-stage');
  const speedBox = h('div.replay-speed', { attrs: { role: 'group', 'aria-label': '回放速度' } });
  const pauseBtn = h<HTMLButtonElement>('button.btn.small', { attrs: { type: 'button', 'aria-label': '暂停' } }, h('span.gi', { html: G.pause }));
  pauseBtn.disabled = true;
  const exitBtn = h('button.btn.small', { attrs: { type: 'button' } }, h('span.gi', { html: G.close }), '退出');
  const root = h(
    'div.replay-view',
    { attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': '观看回放' } },
    h('div.replay-bar', null, h('div.replay-title', null, title, sub), speedBox, pauseBtn, exitBtn),
    stage,
  );

  let session: Session | null = null;
  let board: { destroy(): void } | null = null;
  let raf = 0;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    cancelAnimationFrame(raf);
    document.removeEventListener('keydown', onKey, true);
    try {
      board?.destroy();
    } catch {
      /* ignore */
    }
    session?.dispose();
    ui.clear();
    root.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    // 回放期间截住所有按键，避免触发后面页面 / 对局的快捷键
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      audio.play('click');
      close();
    } else if (e.key === ' ' && session) {
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

  void (async () => {
    const r = await fetchRun(runId);
    if (closed) return;
    if (!r.ok) {
      setText(sub, r.status === 'unavailable' ? '在线功能暂不可用' : r.message || '加载失败');
      stage.appendChild(h('div.replay-end', null, h('div.card', null, h('p', null, '无法加载回放'), h('small.muted', null, r.message))));
      return;
    }
    start(r.data);
  })();

  function start(run: RunReplay): void {
    try {
      session = new Session({ ...run.opts, seed: run.seed });
    } catch (e) {
      console.error(e);
      setText(sub, '这条回放无法在当前版本播放');
      return;
    }
    const s = session;
    const world = s.world;
    const feeder = makeFeeder(world, run.log);
    // 每一步之前喂入该帧的指令
    const origStep = world.step.bind(world);
    (world as { step: () => void }).step = () => {
      feeder.feed();
      origStep();
    };
    feeder.feed();
    ui.clear();

    const boardHost = h('div.replay-board');
    const blocker = h('div.replay-blocker', { attrs: { 'aria-hidden': 'true' } });
    // 拦住指针 / 滚轮事件，棋盘只读
    for (const ev of ['pointerdown', 'pointerup', 'pointermove', 'click', 'wheel', 'touchstart', 'contextmenu']) {
      blocker.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    }
    stage.append(boardHost, blocker);
    try {
      board = mountBoard(boardHost, s);
    } catch (e) {
      console.error(e);
      setText(sub, '棋盘加载失败');
      return;
    }

    const speeds: { v: number; label: string }[] = [
      { v: 1, label: '1×' },
      { v: 2, label: '2×' },
      { v: 4, label: '4×' },
    ];
    const paintSpeed = () => {
      speedBox.replaceChildren(
        ...speeds.map((sp) =>
          h(
            `button.seg${s.speed === sp.v ? '.on' : ''}`,
            {
              attrs: { type: 'button', 'aria-pressed': s.speed === sp.v ? 'true' : 'false' },
              onclick: () => {
                audio.play('click');
                // Session 的速度类型只到 3×，运行时任意倍数都可用
                s.setSpeed(sp.v as Speed);
                paintSpeed();
              },
            },
            sp.label,
          ),
        ),
      );
    };
    paintSpeed();
    pauseBtn.disabled = false;
    pauseBtn.onclick = () => {
      audio.play('click');
      s.togglePause();
    };

    const map = MAP_META[run.opts.map]?.name ?? run.opts.map;
    const endTick = run.result.ticks;
    let ended = false;
    let lastPaused: boolean | null = null;
    const loop = () => {
      if (closed) return;
      // 增益选择阶段 Session 不推进，这里补喂（choosePerk 的帧号就是当前帧）
      feeder.feed();
      const st = world.state;
      if (lastPaused !== s.paused) {
        lastPaused = s.paused;
        pauseBtn.replaceChildren(h('span.gi', { html: s.paused ? G.play : G.pause }));
        pauseBtn.setAttribute('aria-label', s.paused ? '继续' : '暂停');
      }
      const pct = endTick > 0 ? Math.min(100, Math.round((st.tick / endTick) * 100)) : 100;
      setText(sub, `${boardLabel(run.board)} · ${map} · 第 ${st.wave} 波 · ${fmtNum(Math.round(st.score))} 分 · ${pct}%`);
      const over = st.phase === 'lost' || st.phase === 'won' || (st.tick >= endTick && feeder.done);
      if (over && !ended) {
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
              h('p', null, `撑过 ${run.result.wave} 波 · ${fmtNum(run.result.score)} 分`),
              Math.round(st.score) !== run.result.score ? h('small.muted', null, '回放结果与提交成绩不完全一致（可能是版本差异）') : null,
              h('button.btn.primary', { attrs: { type: 'button' }, onclick: () => (audio.play('click'), close()) }, '退出回放'),
            ),
          ),
        );
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  }

  return close;
}
