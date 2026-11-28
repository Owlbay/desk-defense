import type { BuildOption, Command, GameEvent, RunOptions } from '../../core/types';
import { Session } from '../../game/Session';
import { ui } from '../../game/UiStore';
import { t, tOr } from '../../i18n';
import { isAiAssisted } from '../../meta/aiAssist';
import { makeMidRun, replayAsync } from '../../meta/midrun';
import { recordWave, type Rewards, settleRun } from '../../meta/progress';
import { mountBoard } from '../../render';
import { holdBackground, onBackgroundTick } from '../../shared/bgclock';
import { createAiSlot, takeAiLaunch } from '../ai/launch';
import type { App, Route, Screen } from '../App';
import { audio } from '../audio';
import { h, isTypingTarget } from '../dom';
import { G } from '../icons';
import { AiMenu } from './AiMenu';
import { BoardOverlay } from './BoardOverlay';
import { BuildBar } from './BuildBar';
import { BUILD_KEYS, type GameCtx } from './context';
import { GoldFx } from './GoldFx';
import { InfoPanel } from './InfoPanel';
import { MazeGuide } from './MazeGuide';
import { branchModal, gameOverView, loadingOverlay, pauseMenu, PerkModal } from './Modals';
import { replay } from './motion';
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
      app.toast(t('ui.game.cannotStart'), 'warn');
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
        // 原因码优先按当前界面语言重译（AI 在 zh-CN 下执行指令时 reason 是中文）；带参数的原因无法重译则退回原文
        const msg = r.code ? tOr(`core.reason.${r.code}`, r.reason ?? '') : r.reason;
        if (msg && !/\{\w+\}/.test(msg)) overlay.toast(msg, 'warn');
        else if (r.reason) overlay.toast(r.reason, 'warn');
      }
      dirty = true;
      return r;
    },
    toast: (text, tone) => overlay.toast(text, tone),
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
  info.onBuild = (id) => buildBar.pick(id);
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
  // 金币飞入顶栏的特效层（不接收输入）
  const goldFx = new GoldFx(
    boardHost,
    () => topBar.goldIcon,
    (n) => topBar.goldArrive(n),
  );
  game.append(boardWrap, side, goldFx.el, modals);
  // AI 助手：每局一个 AI 插槽（任何模式都能中途启用 / 停用）。公平性标记随中途存档恢复
  const aiSlot = createAiSlot({ app, session, opts, game, modals }, { assist: route.resume?.aiAssist });
  ctx.aiAssist = aiSlot.assist;
  cleanups.push(() => aiSlot.destroy());
  // AI 参战（文档 10）：从「AI 参战」页面开的局，由同一个插槽以「AI 参战」方式挂上（从第 1 波开始）
  const aiLaunch = takeAiLaunch();
  if (aiLaunch) aiSlot.attach(aiLaunch, { dedicated: true });
  const dedicatedAi = aiSlot.dedicated;
  // 顶栏的 AI 按钮（快捷键 I）与「AI 协助」标记
  const aiMenu = new AiMenu(ctx, aiSlot, modals, () => tutorial.ack('tip-ai'));
  topBar.el.insertBefore(aiMenu.badge, topBar.pauseBtn);
  topBar.el.insertBefore(aiMenu.btn, topBar.pauseBtn);
  aiMenu.mount(game);
  cleanups.push(() => aiMenu.destroy());

  // 横竖屏切换
  const applyLayout = () => {
    const r = game.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const lay = r.width / r.height > 1.1 ? 'landscape' : 'portrait';
    if (game.dataset.layout !== lay) game.dataset.layout = lay;
    // 矮 / 窄的横屏（横置手机、小平板、放大后的小窗口）：紧凑三栏布局，见 responsive.css「紧凑横屏」
    const compact = lay === 'landscape' && (r.height <= 680 || r.width < 900);
    if (compact !== (game.dataset.compact !== undefined)) {
      if (compact) game.dataset.compact = '';
      else delete game.dataset.compact;
    }
  };
  const ro = new ResizeObserver(() => {
    applyLayout();
    goldFx.invalidate();
  });
  ro.observe(game);
  ro.observe(boardWrap);
  ro.observe(topBar.el);
  cleanups.push(() => ro.disconnect());

  // 增益选塔提示
  const perkHintText = h('span', null, t('ui.game.perkPickTower'));
  const perkHint = h(
    'div.board-hint',
    null,
    h('span.gi', { html: G.target }),
    perkHintText,
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
      t('ui.game.perkSwap'),
    ),
  );
  const perkSwapBtn = perkHint.lastElementChild as HTMLElement;
  perkHint.hidden = true;
  overlay.hintBox.appendChild(perkHint);

  // ───────────── 新手引导 ─────────────
  // 推荐迷宫（第一章摆迷宫教学的幽灵墙 + 设置「显示推荐迷宫」）
  const mazeGuide = new MazeGuide(ctx);
  cleanups.push(() => mazeGuide.destroy());
  const tutorial = new Tutorial(
    ctx,
    {
      build: (id) => buildBar.buttonFor(id),
      start: () => wavePanel.startBtn,
      info: () => (ui.state.selected !== null ? info.el : null),
      board: () => boardWrap,
      skill: (id) => skillBar.buttonFor(id),
      skills: () => skillBar.el,
      events: () => overlay.eventsEl() ?? wavePanel.el,
      ai: () => aiMenu.btn,
    },
    mazeGuide,
  );

  // 补给箱三选一（不暂停）
  overlay.onCrate = (option, name) => {
    const r = ctx.cmd({ type: 'chooseCrate', option });
    if (r.ok) {
      audio.play('crateOpen');
      overlay.toast(t('ui.game.crateGot', { name }), 'good');
    }
  };

  // ───────────── 暂停 / 生命周期 ─────────────
  function openPause(): void {
    if (pauseEl || ended || destroyed) return;
    session.togglePause(true);
    pauseEl = makePause();
    modals.appendChild(pauseEl);
  }

  function makePause(): HTMLElement {
    return pauseMenu(ctx, {
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

  // ───────────── 后台模式 ─────────────
  // 设置里开了「后台模式」且当前是 AI 在操作（AI 玩家 / 替我玩 / AI 对战）：切到后台不暂停，
  // 由后台时钟（Worker 心跳，不受浏览器后台节流）推进对局和 AI 轮询；标签页标题显示进度。
  const bgEligible = (): boolean =>
    !!app.store.get().settings.bgPlay && aiSlot.role === 'player' && !aiSlot.loading && !ended && !destroyed;
  let bg: { release: () => void; off: () => void; startWave: number; title: string } | null = null;
  let bgTitleAt = 0;
  const bgTitle = (): string => {
    const st = world.state;
    if (st.phase === 'won' || st.phase === 'lost') return t('ui.bg.titleOver', { wave: st.wave });
    return t('ui.bg.title', { wave: st.wave, lives: Math.max(0, Math.round(st.lives)) });
  };
  const stopBg = (): void => {
    if (!bg) return;
    const b = bg;
    bg = null;
    b.off();
    b.release();
    document.title = b.title;
    const n = world.state.wave - b.startWave;
    if (!destroyed && n > 0) overlay.toast(t('ui.bg.back', { n }), 'good');
  };
  const startBg = (): void => {
    if (bg) return;
    const release = holdBackground();
    const off = onBackgroundTick((dt) => {
      if (!document.hidden) return; // 前台由棋盘的渲染循环推进
      if (!bgEligible()) {
        // AI 被摘下 / 对局结束：照旧暂停
        if (!ended && !destroyed) {
          stopBg();
          session.setAutoPaused(true);
          openPause();
        } else if (bg) {
          document.title = bgTitle();
        }
        return;
      }
      session.update(dt);
      const t0 = performance.now();
      if (t0 - bgTitleAt > 500) {
        bgTitleAt = t0;
        document.title = bgTitle();
      }
    });
    bg = { release, off, startWave: world.state.wave, title: document.title };
    document.title = bgTitle();
  };
  cleanups.push(() => {
    if (bg) {
      bg.off();
      bg.release();
      document.title = bg.title;
      bg = null;
    }
  });

  const onVis = () => {
    if (document.hidden && !ended && !destroyed) {
      if (bgEligible()) {
        startBg();
        return;
      }
      session.setAutoPaused(true);
      openPause();
    } else if (!document.hidden) {
      stopBg();
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
        overlay.toast(ev.key ? tOr(ev.key, ev.text, ev.params) : ev.text, ev.tone);
        break;
      case 'waveStart':
        overlay.banner(ev.wave, ev.tags, world.state.totalWaves);
        break;
      case 'waveEnd': {
        const parts = [t('ui.game.waveDone', { wave: ev.wave })];
        const gain = ev.bonus + ev.interest + ev.piggy;
        if (gain > 0) parts.push(t('ui.game.goldGain', { n: Math.round(gain) }));
        if (ev.interest > 0) parts.push(t('ui.game.interest', { n: Math.round(ev.interest) }));
        overlay.toast(parts.join(' '), 'good');
        // AI 参战局不存档；对局中启用过 AI 的局照常存档，并带上公平性标记
        if (!dedicatedAi && !ended && world.state.phase !== 'won' && world.state.phase !== 'lost') {
          app.store.update((p) => {
            recordWave(p, opts, ev.wave);
            p.midRun = makeMidRun(world, aiSlot.assist);
          });
        }
        break;
      }
      case 'leak':
        shake();
        break;
      case 'death':
        // 击杀掉落的金币随 death 事件给出：小硬币从敌人位置飞进金币栏
        if (ev.gold > 0) goldFx.push(ev.gold, ev.x, ev.y);
        break;
      case 'gold':
        // 其他收入：有位置的（拾取、存钱罐…）飞过去，没有位置的直接在金币栏冒「+N」
        if (ev.amount > 0) goldFx.push(ev.amount, ev.x, ev.y);
        break;
      // ── 文档 09：动态战场 ──
      case 'randomEvent':
        overlay.randomEvent(ev);
        break;
      case 'spawnerDrop':
        if (ev.phase === 'land') shake();
        else if (ev.phase === 'demolish' || ev.phase === 'close') {
          if (ui.state.spawnerSelected === ev.id) ui.set({ spawnerSelected: null });
          if (ev.phase === 'demolish') overlay.toast(t('ui.game.dropDemolished'), 'good');
        }
        break;
      case 'terrainChanged':
        overlay.toast(t('ui.game.terrainChanged'), 'info');
        break;
      case 'autoWave':
        wavePanel.onCountdown(ev.secondsLeft);
        break;
      // ── 文档 11：传奇进化 ──
      case 'evolve': {
        const ti = world.getTowerInfo(ev.uid);
        const name = ti?.name ?? t('ui.game.tower');
        overlay.toast(
          ev.mythic ? t('ui.game.becameMythic', { name, tier: ti?.tierName ?? '' }) : t('ui.game.evolvedStars', { name, n: ev.stars }),
          'good',
        );
        break;
      }
      case 'sell':
        if (ui.state.selected === ev.uid) ui.set({ selected: null });
        break;
      case 'levelUp':
        if (ev.tierChanged) {
          const ti = world.getTowerInfo(ev.uid);
          if (ti) overlay.toast(t('ui.game.evolvedTier', { name: ti.name, tier: ti.tierName }), 'good');
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

  function shake(): void {
    replay(boardWrap, 'shake', 320);
  }

  function pickPerkTower(perkId: string, uid: number): void {
    const tw = world.state.towers.get(uid);
    if (!tw || tw.id === 'wall' || tw.level < 7 || tw.level >= 10) {
      audio.play('error');
      overlay.toast(t('ui.game.perkNeedTower'), 'warn');
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

  /** 结算界面按新语言重建（AI 对局的报告卡片由 AI 模块自己处理） */
  let rebuildGameOver: (() => void) | null = null;

  function onGameOver(won: boolean, wave: number, score: number): void {
    if (ended) return;
    ended = true;
    tutorial.hide();
    branchEl?.remove();
    branchEl = null;
    const st = world.state;
    const wavesSurvived = won ? wave : Math.max(0, wave - 1);
    // 对局中启用的 AI：马上停掉（照常结算）；AI 参战局稍后换成 AI 报告卡片
    aiMenu.end();
    if (!dedicatedAi) aiSlot.gameOver({ won, wave, wavesSurvived, score }, { again: () => {}, menu: () => {} });
    let rewards: Rewards = { stars: 0, starsBest: 0, ink: 0, rank: 0, newRecord: false };
    if (!aiSlot.noSettle)
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
          autoWave: st.autoWave ? !!st.autoWave.enabled : undefined,
          // 用过「让 AI 替我玩」：本地排行榜条目打上 AI 协助标记（进度 / 星星 / 墨水照常发放）
          aiAssisted: isAiAssisted(aiSlot.assist),
        });
      });
    ui.clear();
    overlay.bigText(
      won ? t('ui.game.victory') : t('ui.game.defeat'),
      won ? t('ui.game.victorySub') : t('ui.game.defeatSub'),
      won ? 'win' : 'lose',
    );
    setTimeout(() => {
      if (destroyed) return;
      pauseEl?.remove();
      pauseEl = null;
      if (dedicatedAi) {
        // AI 参战局：换成 AI 报告卡片（没有「提交到全服榜」，只能进 AI 榜）
        gameOverEl = aiSlot.gameOver(
          { won, wave, wavesSurvived, score },
          {
            again: () => (audio.play('select'), app.go({ name: 'game', opts: restartOpts(), userSeed })),
            menu: () => (audio.play('click'), app.go({ name: 'menu' })),
          },
        );
        if (gameOverEl) {
          modals.appendChild(gameOverEl);
          return;
        }
      }
      const view = () =>
        gameOverView(
          ctx,
          { won, wave, wavesSurvived, score, st, rewards },
          {
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
          },
        );
      rebuildGameOver = () => {
        const next = view();
        gameOverEl?.replaceWith(next);
        gameOverEl = next;
      };
      gameOverEl = view();
      modals.appendChild(gameOverEl);
    }, 1400);
  }

  // ───────────── 键盘 ─────────────
  const BUILD_KEY_INDEX: Record<string, number> = Object.fromEntries(BUILD_KEYS.map((k, i) => [k, i]));
  /** 按物理键兜底（不同键盘布局 / 小键盘 / Shift+= 输入 '+'） */
  const BUILD_CODE_INDEX: Record<string, number> = { Minus: 10, NumpadSubtract: 10, Equal: 11, NumpadAdd: 11 };
  const SKILL_KEY_INDEX: Record<string, number> = { q: 0, w: 1, e: 2, r: 3 };
  const SWAP_CODE_INDEX: Record<string, number> = {
    ...Object.fromEntries(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map((d, i) => [`Digit${d}`, i])),
    Minus: 10,
    Equal: 11,
  };
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
    // 选中塔时 Shift + 塔栏快捷键 = 换成那种塔（按物理键，Shift 会改变字符）
    const swapIdx = e.shiftKey && ui.state.selected !== null ? SWAP_CODE_INDEX[e.code] : undefined;
    if (swapIdx !== undefined) {
      e.preventDefault();
      if (!e.repeat) info.swapIndex(swapIdx);
      return;
    }
    const buildIdx = BUILD_KEY_INDEX[k] ?? (k === '+' ? 11 : BUILD_CODE_INDEX[e.code]);
    if (buildIdx !== undefined) {
      e.preventDefault();
      buildBar.pickIndex(buildIdx);
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
        if (e.repeat) break;
        // 电脑：悬停在掉落物上按空格收集（文档 09 §3.3）
        if (ui.state.hoverPickup !== null && world.state.pickups.some((pk) => pk.uid === ui.state.hoverPickup)) {
          ctx.cmd({ type: 'collect', uid: ui.state.hoverPickup });
          break;
        }
        wavePanel.start();
        break;
      case 'a':
        if (ui.state.selected !== null) info.castAbility();
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
      case 'Delete':
      case 'Backspace':
        if (ui.state.selected !== null) {
          e.preventDefault();
          info.sell(true);
        }
        break;
      case 'b':
        if (ui.state.selected !== null) info.placeAgain();
        break;
      case 't':
        skillBar.toggleAxis();
        break;
      case 'i':
        if (e.repeat) break;
        e.preventDefault();
        aiMenu.toggle();
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
    info.tickFast(st);
    wavePanel.tickFast(st);
    goldFx.flush();
    mazeGuide.tick();
    if (dirty || frame % 6 === 0) {
      dirty = false;
      mazeGuide.setHint(!!app.store.get().settings.mazeHint);
      const opts2 = world.getBuildOptions();
      buildBar.update(opts2);
      wavePanel.update(st);
      const sel = ui.state.selected;
      const ti = sel !== null ? world.getTowerInfo(sel) : null;
      if (sel !== null && !ti) ui.set({ selected: null });
      const bo: BuildOption | null = ui.state.build ? (opts2.find((o) => o.id === ui.state.build) ?? null) : null;
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
      overlay.toast(t('ui.game.boardFailed'), 'warn');
    }
    applyLayout();
    raf = requestAnimationFrame(loop);
    tutorial.start();
    // 配乐：开局 / 续玩从布防曲开始；之后由 audio.onGameEvent 按波次 / Boss / 结算切换
    audio.setMusicState('build');
    if (route.resume) overlay.toast(t('ui.game.resumed', { wave: world.state.wave }), 'good');
  };

  if (route.resume) {
    const run = route.resume;
    const ld = loadingOverlay(t('ui.game.resuming'));
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
        app.toast(t('ui.game.resumeFailed'), 'warn');
        app.go({ name: 'menu' });
      });
  } else {
    // 开新局即放弃旧的中途存档
    if (!dedicatedAi && app.store.get().midRun) app.store.update((p) => (p.midRun = null));
    requestAnimationFrame(begin);
  }

  /** 切换语言：就地刷新 HUD 文字，不重开对局 */
  const onLocale = (): boolean => {
    topBar.relabel();
    aiMenu.relabel();
    buildBar.relabel();
    skillBar.relabel();
    overlay.relabel();
    perkHintText.textContent = t('ui.game.perkPickTower');
    perkSwapBtn.textContent = t('ui.game.perkSwap');
    // 打开着的暂停菜单自己订阅了语言变化（停留在原来的子页面），这里不重建
    rebuildGameOver?.();
    dirty = true;
    tick();
    return true;
  };

  return {
    el,
    onLocaleChange: onLocale,
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
