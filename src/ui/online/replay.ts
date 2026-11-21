/**
 * 只读回放：用成绩的开局参数 + 种子新建 Session，按帧号喂入记录的指令。
 * 棋盘用 mountBoard 渲染，上面盖一层透明遮罩拦住所有点击（回放不接受玩家操作）。
 */
import { Session, type Speed } from '../../game/Session';
import { ui } from '../../game/UiStore';
import { fmtNumber, t } from '../../i18n';
import { fetchRun, type RunReplay } from '../../meta/online';
import { mountBoard } from '../../render';
import { boardLabel } from '../../shared/leaderboard';
import type { App } from '../App';
import { audio } from '../audio';
import { MAP_META } from '../coreMeta';
import { h, setText } from '../dom';
import { G } from '../icons';
import { makeFeeder } from './util';

/** 打开回放（先拉取数据）。返回关闭函数。 */
export function openReplay(app: App, runId: string, nickname?: string): () => void {
  const title = h('b', null, nickname ? t('ui.online.replayOf', { name: nickname }) : t('ui.online.replay'));
  const sub = h('small.muted', null, t('ui.online.loading'));
  const stage = h('div.replay-stage');
  const speedBox = h('div.replay-speed', { attrs: { role: 'group', 'aria-label': t('ui.online.replaySpeed') } });
  const pauseBtn = h<HTMLButtonElement>(
    'button.btn.small',
    { attrs: { type: 'button', 'aria-label': t('ui.online.pause') } },
    h('span.gi', { html: G.pause }),
  );
  pauseBtn.disabled = true;
  const exitBtn = h('button.btn.small', { attrs: { type: 'button' } }, h('span.gi', { html: G.close }), t('ui.online.exit'));
  const root = h(
    'div.replay-view',
    { attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': t('ui.online.watchReplay') } },
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
      setText(sub, r.status === 'unavailable' ? t('ui.online.unavailable') : r.message || t('ui.online.loadFailed'));
      stage.appendChild(
        h('div.replay-end', null, h('div.card', null, h('p', null, t('ui.online.replayLoadFailed')), h('small.muted', null, r.message))),
      );
      return;
    }
    start(r.data);
  })();

  function start(run: RunReplay): void {
    try {
      session = new Session({ ...run.opts, seed: run.seed });
    } catch (e) {
      console.error(e);
      setText(sub, t('ui.online.replayIncompatible'));
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
      setText(sub, t('ui.online.boardFailed'));
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
        pauseBtn.setAttribute('aria-label', s.paused ? t('ui.online.resume') : t('ui.online.pause'));
      }
      const pct = endTick > 0 ? Math.min(100, Math.round((st.tick / endTick) * 100)) : 100;
      setText(
        sub,
        t('ui.online.replayStatus', { board: boardLabel(run.board), map, wave: st.wave, score: fmtNumber(Math.round(st.score)), pct }),
      );
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
              h('h3', null, t('ui.online.replayEnded')),
              h('p', null, t('ui.online.replayResult', { n: run.result.wave, score: fmtNumber(Math.round(run.result.score)) })),
              Math.round(st.score) !== run.result.score ? h('small.muted', null, t('ui.online.replayMismatch')) : null,
              h(
                'button.btn.primary',
                { attrs: { type: 'button' }, onclick: () => (audio.play('click'), close()) },
                t('ui.online.exitReplay'),
              ),
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
