import type { BuildOption, Command, GameEvent, RunOptions } from '../../core/types';
import { Session } from '../../game/Session';
import { ui } from '../../game/UiStore';
import { makeMidRun, replayAsync } from '../../meta/midrun';
import { recordWave, settleRun, type Rewards } from '../../meta/progress';
import { mountBoard } from '../../render';
import type { App, Route, Screen } from '../App';
import { audio } from '../audio';
import { h, isTypingTarget } from '../dom';
import { G } from '../icons';
import { BoardOverlay } from './BoardOverlay';
import { BuildBar } from './BuildBar';
import type { GameCtx } from './context';
import { InfoPanel } from './InfoPanel';
import { branchModal, gameOverView, loadingOverlay, pauseMenu, PerkModal } from './Modals';
import { SkillBar } from './SkillBar';
import { TopBar } from './TopBar';
import { Tutorial } from './Tutorial';
import { WavePanel } from './WavePanel';

export function gameScreen(app: App, route: Route): Screen {
  if (route.name !== 'game') throw new Error('bad route');
  const opts: RunOptions = route.opts;
  const userSeed = !!route.userSeed;

  const el = h('div.screen.game-screen');
  const game = h('div.game', { data: { layout: 'portrait', difficulty: opts.difficulty, mode: opts.mode } });
  el.appendChild(game);

  let session: Session;
  try {
    session = new Session(opts);
  } catch (e) {
    console.error(e);
    setTimeout(() => {
      app.toast('无法开始对局', 'warn');
      if (route.resume) app.store.update((p) => (p.midRun = null));
      app.go({ name: 'menu' });
    }, 0);
    return { el };
  }
  const world = session.world;
  const dbg = (window as unknown as { __dd?: Record<string, unknown> }).__dd;
  if (dbg) dbg.session = session;

  const cleanups: (() => void)[] = [];
  let destroyed = false;
  let ended = false;

  // ───────────── 布局 ─────────────
  const boardHost = h('div.board-host');
  const overlay = new BoardOverlay();
  const boardWrap = h('div.g-board', null, boardHost, overlay.el);
  const modals = h('div.g-modals');

  let branchEl: HTMLElement | null = null;
  let pauseEl: HTMLElement | null = null;
  let gameOverEl: HTMLElement | null = null;

  const ctx: GameCtx = {
    app,
    session,
    world,
    opts,
    root: game,
    cmd(c: Command) {
      const r = session.command(c);
      if (!r.ok) {
        audio.play('error');
        if (r.reason) overlay.toast(r.reason, 'warn');
      }
      dirty = true;
      return r;
    },
    toast: (t, tone) => overlay.toast(t, tone),
    openBranch(uid) {
      if (branchEl) return;
      branchEl = branchModal(ctx, uid, () => (branchEl = null));
      if (branchEl) modals.appendChild(branchEl);
    },
    landscape: () => game.dataset.layout === 'landscape',
  };

  const topBar = new TopBar(ctx, () => openPause());
  const buildBar = new BuildBar(ctx);
  const info = new InfoPanel(ctx);
  const skillBar = new SkillBar(ctx);
  const wavePanel = new WavePanel(ctx);
  /** 「传奇在望」等需要选塔的增益：等待玩家点塔 */
  let perkPending: string | null = null;
  const perkModal = new PerkModal(
    ctx,
    (card) => {
      perkPending = card.id;
      ui.set({ build: null, aiming: null, relocateFrom: null, selected: null, pending: null });
      perkHint.hidden = false;
      dirty = true;
    },
    () => perkPending !== null,
  );
  modals.appendChild(perkModal.el);

  topBar.el.classList.add('g-top');
  buildBar.el.classList.add('g-build');
  info.el.classList.add('g-info');
  skillBar.el.classList.add('g-skills');
  wavePanel.el.classList.add('g-wave');
  const side = h('div.side', null, topBar.el, buildBar.el, info.el, skillBar.el, wavePanel.el);
  game.append(boardWrap, side, modals);

  // 横竖屏切换
  const applyLayout = () => {
    const r = game.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const lay = r.width / r.height > 1.1 ? 'landscape' : 'portrait';
    if (game.dataset.layout !== lay) game.dataset.layout = lay;
  };
  const ro = new ResizeObserver(applyLayout);
  ro.observe(game);
  cleanups.push(() => ro.disconnect());

  // 增益选塔提示
  const perkHint = h(
    'div.board-hint',
    null,
    h('span.gi', { html: G.target }),
    h('span', null, '点一座 Lv7–9 的塔'),
    h(
      'button.btn.small',
      {
        onclick: () => {
          audio.play('click');
          perkPending = null;
          perkHint.hidden = true;
          ui.set({ perkTargeting: null, selected: null });
        },
      },
      '换一个',
    ),
  );
  perkHint.hidden = true;
  overlay.hintBox.appendChild(perkHint);

  // ───────────── 新手引导 ─────────────
  const tutorial = new Tutorial(ctx, {
    build: (id) => buildBar.buttonFor(id),
    start: () => wavePanel.startBtn,
    info: () => (ui.state.selected !== null ? info.el : null),
    board: () => boardWrap,
    skill: (id) => skillBar.buttonFor(id),
    skills: () => skillBar.el,
  });

  // ───────────── 暂停 / 生命周期 ─────────────
  function openPause(): void {
    if (pauseEl || ended || destroyed) return;
    session.togglePause(true);
    pauseEl = pauseMenu(ctx, {
      resume: () => resume(),
      restart: () => {
        audio.play('click');
        app.go({ name: 'game', opts: restartOpts(), userSeed });
      },
      quit: () => {
        audio.play('click');
        app.go({ name: 'menu' });
      },
    });
    modals.appendChild(pauseEl);
  }

  function resume(): void {
    audio.play('click');
    pauseEl?.remove();
    pauseEl = null;
    session.setAutoPaused(false);
    session.togglePause(false);
  }

  const restartOpts = (): RunOptions => {
    const o: RunOptions = JSON.parse(JSON.stringify(opts));
    if (!userSeed) delete o.seed;
    return o;
  };

  const onVis = () => {
    if (document.hidden && !ended && !destroyed) {
      session.setAutoPaused(true);
      openPause();
    }
  };
  document.addEventListener('visibilitychange', onVis);
  cleanups.push(() => document.removeEventListener('visibilitychange', onVis));

  // ───────────── 事件 ─────────────
  let dirty = true;

  const onEvent = (ev: GameEvent) => {
    audio.onGameEvent(ev);
    tutorial.onEvent(ev);
    switch (ev.type) {
      case 'toast':
        overlay.toast(ev.text, ev.tone);
        break;
      case 'waveStart':
        overlay.banner(ev.wave, ev.tags, world.state.totalWaves);
        audio.setIntensity(ev.tags.includes('boss') ? 1 : 0.7);
        break;
      case 'waveEnd': {
        audio.setIntensity(0.35);
        const parts = [`第 ${ev.wave} 波完成`];
        const gain = ev.bonus + ev.interest + ev.piggy;
        if (gain > 0) parts.push(`+${Math.round(gain)} 金`);
        if (ev.interest > 0) parts.push(`（利息 ${Math.round(ev.interest)}）`);
        overlay.toast(parts.join(' '), 'good');
        if (!ended && world.state.phase !== 'won' && world.state.phase !== 'lost') {
          app.store.update((p) => {
            recordWave(p, opts, ev.wave);
            p.midRun = makeMidRun(world);
          });
        }
        break;
      }
      case 'leak':
        boardWrap.classList.remove('shake');
        void boardWrap.offsetWidth;
        boardWrap.classList.add('shake');
        break;
      case 'sell':
        if (ui.state.selected === ev.uid) ui.set({ selected: null });
        break;
      case 'levelUp':
        if (ev.tierChanged) {
          const ti = world.getTowerInfo(ev.uid);
          if (ti) overlay.toast(`${ti.name} 进化为「${ti.tierName}」`, 'good');
        }
        break;
      case 'perkChosen':
        perkPending = null;
        perkHint.hidden = true;
        ui.set({ perkTargeting: null });
        break;
      case 'gameOver':
        onGameOver(ev.won, ev.wave, ev.score);
        break;
    }
    dirty = true;
  };
  cleanups.push(session.on(onEvent));
  cleanups.push(
    session.onChange(() => {
      wavePanel.syncSpeed();
      game.classList.toggle('is-paused', session.paused || session.autoPaused);
    }),
  );
  cleanups.push(
    ui.subscribe(() => {
      buildBar.syncSelected();
      skillBar.syncAiming();
      perkHint.hidden = !ui.state.perkTargeting && perkPending === null;
      if (perkPending !== null && ui.state.selected !== null && !branchEl) pickPerkTower(perkPending, ui.state.selected);
      dirty = true;
    }),
  );

  function pickPerkTower(perkId: string, uid: number): void {
    const t = world.state.towers.get(uid);
    if (!t || t.id === 'wall' || t.level < 7 || t.level >= 10) {
      audio.play('error');
      overlay.toast('请选择一座 Lv7–9 的塔', 'warn');
      ui.set({ selected: null });
      return;
    }
    audio.play('select');
    branchEl = branchModal(
      ctx,
      uid,
      (done) => {
        branchEl = null;
        if (!done) ui.set({ selected: null });
      },
      { perkId },
    );
    if (branchEl) modals.appendChild(branchEl);
  }

  function onGameOver(won: boolean, wave: number, score: number): void {
    if (ended) return;
    ended = true;
    tutorial.hide();
    branchEl?.remove();
    branchEl = null;
    const st = world.state;
    const wavesSurvived = won ? wave : Math.max(0, wave - 1);
    let rewards: Rewards = { stars: 0, starsBest: 0, ink: 0, rank: 0, newRecord: false };
    app.store.update((p) => {
      rewards = settleRun(p, opts, {
        won,
        wavesSurvived,
        score,
        kills: st.stats.kills,
        lives: st.lives,
        maxLives: st.maxLives,
        seed: st.seed,
        perks: st.perks.slice(),
      });
    });
    ui.clear();
    audio.setIntensity(0);
    overlay.bigText(won ? '胜利！' : '失败', won ? '防线守住了' : '作业本被弄脏了', won ? 'win' : 'lose');
    setTimeout(() => {
      if (destroyed) return;
      pauseEl?.remove();
      pauseEl = null;
      gameOverEl = gameOverView(ctx, { won, wave, wavesSurvived, score, st, rewards }, {
        again: () => {
          audio.play('select');
          app.go({ name: 'game', opts: restartOpts(), userSeed });
        },
        changeDifficulty: () => {
          audio.play('click');
          app.go({ name: opts.mode });
        },
        menu: () => {
          audio.play('click');
          app.go({ name: 'menu' });
        },
      });
      modals.appendChild(gameOverEl);
    }, 1400);
  }

  // ───────────── 键盘 ─────────────
  const BUILD_KEY_INDEX: Record<string, number> = { '1': 0, '2': 1, '3': 2, '4': 3, '5': 4, '6': 5, '7': 6, '8': 7, '9': 8, '0': 9, '-': 10 };
  const SKILL_KEY_INDEX: Record<string, number> = { q: 0, w: 1, e: 2, r: 3 };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Shift') ui.set({ shift: true });
    if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('.confirm-overlay')) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (gameOverEl) return;
    if (pauseEl) {
      if (k === 'Escape' || k === 'p') {
        e.preventDefault();
        resume();
      }
      return;
    }
    if (branchEl) {
      if (k === 'Escape') {
        e.preventDefault();
        branchEl.click(); // 触发遮罩点击 → 关闭
      }
      return;
    }
    if (perkModal.isOpen) {
      if (k === 'p') openPause();
      return;
    }
    if (k in BUILD_KEY_INDEX || e.code === 'Minus' || e.code === 'NumpadSubtract') {
      e.preventDefault();
      buildBar.pickIndex(BUILD_KEY_INDEX[k] ?? 10);
      return;
    }
    if (k in SKILL_KEY_INDEX) {
      e.preventDefault();
      skillBar.pickIndex(SKILL_KEY_INDEX[k]);
      return;
    }
    switch (k) {
      case ' ':
        e.preventDefault();
        if (!e.repeat) wavePanel.start();
        break;
      case 'f':
        wavePanel.cycleSpeed();
        break;
      case 'p':
        openPause();
        break;
      case 'Escape':
        ui.clear();
        break;
      case 'u':
        if (ui.state.selected !== null) info.upgrade();
        break;
      case 's':
        if (ui.state.selected !== null) info.sell(true);
        break;
      case 't':
        skillBar.toggleAxis();
        break;
    }
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === 'Shift') ui.set({ shift: false });
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKeyUp);
  cleanups.push(() => {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keyup', onKeyUp);
  });

  // ───────────── HUD 刷新 ─────────────
  let raf = 0;
  let frame = 0;
  let lastPerkTarget: string | null = null;
  const tick = () => {
    const st = world.state;
    topBar.update(st);
    skillBar.update(st);
    overlay.update(st);
    perkModal.update(st);
    if (dirty || frame % 6 === 0) {
      dirty = false;
      const opts2 = world.getBuildOptions();
      buildBar.update(opts2);
      wavePanel.update(st);
      let sel = ui.state.selected;
      let ti = sel !== null ? world.getTowerInfo(sel) : null;
      if (sel !== null && !ti) {
        ui.set({ selected: null });
        sel = null;
      }
      const bo: BuildOption | null = ui.state.build ? opts2.find((o) => o.id === ui.state.build) ?? null : null;
      info.update(ti, bo);
      game.classList.toggle('has-selection', !!ti);
      const targeting = ui.state.perkTargeting ?? perkPending;
      if (targeting !== lastPerkTarget) {
        lastPerkTarget = targeting;
        perkHint.hidden = !targeting;
      }
      if (perkPending !== null && st.phase !== 'perk') {
        perkPending = null;
        perkHint.hidden = true;
      }
      // 结束状态兜底（事件丢失时）
      if (!ended && (st.phase === 'won' || st.phase === 'lost')) onGameOver(st.phase === 'won', st.wave, st.score);
    }
    frame++;
  };
  const loop = () => {
    if (destroyed) return;
    tick();
    raf = requestAnimationFrame(loop);
  };

  // ───────────── 启动 ─────────────
  let board: { destroy(): void } | null = null;
  const begin = () => {
    if (destroyed) return;
    ui.clear();
    ui.set({ perkTargeting: null, hover: null });
    applyLayout();
    tick(); // 先填好 HUD，让棋盘容器在挂载前就是最终尺寸
    try {
      board = mountBoard(boardHost, session);
    } catch (e) {
      console.error(e);
      overlay.toast('棋盘加载失败', 'warn');
    }
    applyLayout();
    raf = requestAnimationFrame(loop);
    tutorial.start();
    audio.setIntensity(0.35);
    if (route.resume) overlay.toast(`已恢复到第 ${world.state.wave} 波结束`, 'good');
  };

  if (route.resume) {
    const run = route.resume;
    const ld = loadingOverlay('正在恢复进度…');
    modals.appendChild(ld.el);
    replayAsync(world, run, (p) => ld.set(p))
      .then(() => {
        ld.el.remove();
        begin();
      })
      .catch((e) => {
        console.error(e);
        ld.el.remove();
        app.store.update((p) => (p.midRun = null));
        app.toast('存档无法恢复，已清除', 'warn');
        app.go({ name: 'menu' });
      });
  } else {
    // 开新局即放弃旧的中途存档
    if (app.store.get().midRun) app.store.update((p) => (p.midRun = null));
    requestAnimationFrame(begin);
  }

  return {
    el,
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      tutorial.destroy();
      for (const c of cleanups) {
        try {
          c();
        } catch {
          /* ignore */
        }
      }
      try {
        board?.destroy();
      } catch (e) {
        console.error(e);
      }
      session.dispose();
      ui.clear();
      ui.set({ hover: null, shift: false });
    },
  };
}
