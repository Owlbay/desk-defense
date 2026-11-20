/**
 * 对局里的 AI 面板（动态分包）：状态徽标、决策流、用量 / 预算、控制按钮、军师建议卡片、结算报告。
 *
 * 手机：棋盘左上角一个小徽标，点开是底部抽屉；电脑：徽标下面的浮动面板。
 * 控制器（src/agent createAgentController）只负责「什么时候问模型、把指令下到 session」，
 * 这里负责：轮询节奏（军师模式避免在建造 / 增益阶段反复提问）、自动拾取、AI 操作时屏蔽玩家输入。
 */
import {
  AgentTrace,
  createAgentController,
  usageTotal,
  type AgentController,
  type AgentControllerEvent,
  type AgentModelConfig,
  type AgentStatus,
  type DecisionRecord,
  type SessionLike,
  type Suggestion,
  type TokenUsage,
} from '../../agent';
import type { Command, CommandResult } from '../../core/types';
import type { Speed } from '../../game/Session';
import { ui } from '../../game/UiStore';
import { audio } from '../audio';
import { clear, fmtNum, h, setText } from '../dom';
import { G } from '../icons';
import { fmtCost, fmtTokens } from './format';
import { applyAction, describeCall, failReason, parseAction, REASON_NAME } from './actions';
import { demoAdvisor } from './demoAdvisor';
import { botShareOf } from './meta';
import type { AiAttachCtx, AiGameOverHandlers, AiGameOverInfo, AiHudHandle, AiLaunch } from './launch';
import { reportCard, type AiRunSummary } from './report';
import { mountTracePanel, type TracePanelHandle } from './trace-panel';

const FEED_MAX = 40;
const SUGGEST_MAX = 2;

type Chip = 'loading' | 'thinking' | 'acting' | 'watching' | 'paused' | 'fallback' | 'stopped' | 'error' | 'over';

const CHIP_TEXT: Record<Chip, string> = {
  loading: '正在加载模型…',
  thinking: '思考中…',
  acting: '执行中',
  watching: '观察中',
  paused: '已暂停',
  fallback: '兜底机器人',
  stopped: '已停止',
  error: '出错了',
  over: '对局结束',
};

export function mountAiHud(ctx: AiAttachCtx, launch: AiLaunch): AiHudHandle {
  const { session, game, app } = ctx;
  const world = session.world;
  const role = launch.role;
  const isPlayer = role === 'player';
  const pauseMode = launch.mode === 'pause';
  let destroyed = false;
  let over = false;
  /** 玩家中途接管 / 停掉了 AI：这局不能再进 AI 榜 */
  let takenOver = false;
  /** 模型加载失败后改用内置策略 */
  let switchedToBot = false;
  let config: Partial<AgentModelConfig> = launch.config;
  let status: AgentStatus = 'idle';
  let statusDetail = '';
  let actingUntil = 0;
  let lastBy: DecisionRecord['by'] = 'agent';
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 };
  let costUsd = 0;
  let adopted = 0;
  let errorCount = 0;
  const startedAt = Date.now();
  /** 军师：上一次提问时的局面（建造 / 增益阶段同一局面只问一次） */
  let advisorKey = '';

  const board = game.querySelector<HTMLElement>('.g-board') ?? game;
  const pauseMenuOpen = (): boolean => !!game.querySelector('.pause-overlay');
  let releasing = false;

  // ───────────── 控制器用的 Session 代理 ─────────────
  const proxy: SessionLike = {
    world,
    get paused() {
      return session.paused;
    },
    command(cmd: Command): CommandResult {
      const r = session.command(cmd);
      if (r.ok && cmd.type !== 'collect') actingUntil = Date.now() + 900;
      return r;
    },
    togglePause(force?: boolean) {
      // 暂停菜单开着时不替玩家恢复（玩家点「继续」时再恢复）
      if (force === false && pauseMenuOpen()) return;
      // 控制器是先恢复游戏、再把状态改回 running：恢复的这一下不能被下面的「思考中保持暂停」拦回去
      releasing = force === false;
      try {
        session.togglePause(force);
      } finally {
        releasing = false;
      }
    },
    on: (fn) => session.on(fn),
  };

  // ───────────── DOM ─────────────
  const dot = h('span.ai-dot', { attrs: { 'aria-hidden': 'true' } });
  const chipText = h('span.ai-chip-text');
  const chipUsage = h('span.ai-chip-usage');
  const chip = h<HTMLButtonElement>('button.ai-chip', { attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': 'ai-panel' } }, dot, chipText, chipUsage);
  const statusLine = h('p.ai-status-line', { attrs: { role: 'status', 'aria-live': 'polite' } });
  const usageNums = h('div.ai-usage-nums');
  const budgetFill = h('span.ai-budget-fill');
  const budgetBar = h('div.ai-budget', { attrs: { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': '预算使用' } }, budgetFill);
  const budgetText = h('small.muted.ai-budget-text');
  const errorBox = h('div.ai-error');
  errorBox.hidden = true;

  const pauseBtn = h<HTMLButtonElement>('button.btn.small', { attrs: { type: 'button' } });
  const stopBtn = h<HTMLButtonElement>('button.btn.small.ai-stop', { attrs: { type: 'button' } });
  const speedBtn = h<HTMLButtonElement>('button.btn.small', { attrs: { type: 'button', 'aria-label': '游戏速度' } });
  const controls = h('div.ai-controls', null, pauseBtn, stopBtn, speedBtn);

  const feedList = h('ol.ai-feed-list');
  const feedCount = h('span.ai-feed-count');
  const feed = h<HTMLDetailsElement>('details.ai-feed', null, h('summary', null, '决策记录', feedCount), feedList);
  feed.open = true;

  const closeBtn = h('button.btn.icon-btn.ai-close', { attrs: { type: 'button', 'aria-label': '收起 AI 面板' } }, h('span.gi', { html: G.close }));
  const panel = h(
    'div.ai-panel',
    { attrs: { id: 'ai-panel', role: 'region', 'aria-label': 'AI 面板' } },
    h('div.ai-panel-head', null, h('div.ai-panel-title', null, h('b', null, isPlayer ? 'AI 玩家' : 'AI 军师'), h('small.muted', null, launch.label)), closeBtn),
    statusLine,
    errorBox,
    h('div.ai-usage', null, usageNums, budgetBar, budgetText),
    controls,
    feed,
  );
  const suggestBox = h('div.ai-suggest', { attrs: { 'aria-live': 'polite', 'aria-label': 'AI 军师的建议' } });
  // 思路与请求（文档 10 §12.1）：同一个缓冲区贯穿整局（换成内置策略重启控制器也不断档）
  const trace = new AgentTrace();
  const chipRow = h('div.ai-chip-row', null, chip);
  const root = h('div.ai-hud', { data: { role } }, chipRow, suggestBox, panel);
  board.appendChild(root);
  let tp: TracePanelHandle | null = null;
  try {
    tp = mountTracePanel({
      host: game.parentElement ?? game,
      anchor: () => board,
      trace,
      live: true,
      subtitle: launch.label,
      onHighlight: (c) => ui.set({ aiFocus: c ? { cx: c.x, cy: c.y } : null }),
      onOpenChange: (o, mode) => {
        // 抽屉模式：和 AI 面板（同样是抽屉）不同时打开
        if (o && mode === 'drawer' && open && !wide()) {
          open = false;
          paintOpen();
        }
      },
    });
    chipRow.appendChild(tp.toggle);
  } catch (e) {
    console.error('[ai] 思路与请求面板加载失败', e);
  }

  const wide = (): boolean => game.dataset.layout === 'landscape' && game.dataset.compact === undefined;
  let open = wide();
  const paintOpen = (): void => {
    root.dataset.open = open ? '1' : '0';
    chip.setAttribute('aria-expanded', open ? 'true' : 'false');
    panel.hidden = !open;
  };
  chip.onclick = () => {
    audio.play('click');
    open = !open;
    paintOpen();
    if (open && tp?.mode === 'drawer' && tp.isOpen() && !wide()) tp.setOpen(false);
  };
  closeBtn.onclick = () => {
    audio.play('click');
    open = false;
    paintOpen();
    chip.focus({ preventScroll: true });
  };
  paintOpen();

  // ───────────── 状态 ─────────────
  const driving = (): boolean => isPlayer && !takenOver && !over && status !== 'stopped';
  const chipKind = (): Chip => {
    if (over) return 'over';
    if (status === 'error') return 'error';
    if (status === 'stopped') return 'stopped';
    if (status === 'loading' || status === 'idle') return 'loading';
    if (status === 'paused') return 'paused';
    if (status === 'thinking') return Date.now() < actingUntil ? 'acting' : 'thinking';
    if (Date.now() < actingUntil) return 'acting';
    return lastBy === 'fallback' ? 'fallback' : 'watching';
  };
  let shownChip: Chip | null = null;
  const paintStatus = (): void => {
    const k = chipKind();
    game.classList.toggle('ai-driving', driving());
    if (k !== shownChip) {
      shownChip = k;
      root.dataset.status = k;
      setText(chipText, switchedToBot && (k === 'watching' || k === 'thinking') ? `内置策略 · ${CHIP_TEXT[k]}` : CHIP_TEXT[k]);
    }
    let line: string;
    switch (k) {
      case 'loading': line = '正在加载模型适配器，首次需要下载一小段代码…'; break;
      case 'thinking': line = `正在决策：${statusDetail.split(',').map((r) => REASON_NAME[r] ?? r).join('、') || '…'}${pauseMode ? '（游戏已暂停等待）' : ''}`; break;
      case 'acting': line = '正在下达指令…'; break;
      case 'paused': line = 'AI 和游戏都已暂停。'; break;
      case 'fallback': line = '上一次决策由内置机器人代做（模型超时 / 出错 / 预算用完）。'; break;
      case 'stopped': line = isPlayer ? 'AI 已停止，现在由你操作。这局不再计入 AI 榜。' : '军师已停止提建议。'; break;
      case 'error': line = '模型没能启动。'; break;
      case 'over': line = '对局结束。'; break;
      default: line = isPlayer ? '等待下一个决策点。' : '军师在观察局面，有想法时会给出建议。';
    }
    setText(statusLine, line);
    pauseBtn.replaceChildren(h('span.gi', { html: status === 'paused' ? G.play : G.pause }), status === 'paused' ? '继续' : '暂停');
    pauseBtn.setAttribute('aria-label', status === 'paused' ? '继续 AI 和游戏' : '暂停 AI 和游戏');
    const dead = over || status === 'stopped' || status === 'error';
    pauseBtn.disabled = dead || status === 'loading' || status === 'idle';
    stopBtn.disabled = dead;
  };

  const paintUsage = (): void => {
    const total = usageTotal(usage);
    setText(chipUsage, total > 0 ? `${fmtTokens(total)}${costUsd > 0 ? ` · ${fmtCost(costUsd)}` : ''}` : '');
    usageNums.replaceChildren(
      h('span', { title: `输入 ${fmtNum(usage.inputTokens)} · 输出 ${fmtNum(usage.outputTokens)} · 缓存读 ${fmtNum(usage.cacheReadTokens)} · 缓存写 ${fmtNum(usage.cacheWriteTokens)}` }, h('b', null, fmtTokens(total)), ' token'),
      h('span', { title: '按公开价格估算，以服务商账单为准' }, h('b', null, fmtCost(costUsd)), ' 估算'),
      h('span', null, h('b', null, String(usage.requests)), ' 次请求'),
    );
    const bt = config.budget?.tokens;
    const bu = config.budget?.usd;
    const ratio = Math.max(bt ? total / bt : 0, bu ? costUsd / bu : 0);
    budgetBar.hidden = !bt && !bu;
    budgetText.hidden = !bt && !bu;
    if (bt || bu) {
      const pct = Math.min(100, Math.round(ratio * 100));
      budgetFill.style.transform = `scaleX(${Math.min(1, ratio).toFixed(3)})`;
      budgetBar.dataset.level = ratio >= 1 ? 'out' : ratio >= 0.8 ? 'high' : 'ok';
      budgetBar.setAttribute('aria-valuenow', String(pct));
      const parts = [bt ? `${fmtTokens(total)} / ${fmtTokens(bt)} token` : '', bu ? `${fmtCost(costUsd)} / ${fmtCost(bu)}` : ''].filter(Boolean);
      setText(budgetText, ratio >= 1 ? `预算已用完，余下由内置机器人接管（${parts.join(' · ')}）` : `预算 ${pct}% · ${parts.join(' · ')}`);
    }
  };

  const paintSpeed = (): void => {
    speedBtn.replaceChildren(h('span.gi', { html: G.fast }), `${session.speed}×`);
  };

  // ───────────── 决策流 ─────────────
  let feedTotal = 0;
  const addFeed = (rec: DecisionRecord): void => {
    feedTotal++;
    const acts: HTMLElement[] = [];
    let reads = 0;
    for (const c of rec.toolCalls) {
      const text = describeCall(world, c.name, c.input);
      if (!text) {
        if (c.name !== 'end_turn' && c.name !== 'suggest') reads++;
        continue;
      }
      acts.push(h(`li.${c.ok ? 'ok' : 'bad'}`, null, h('span.gi', { html: c.ok ? G.check : G.close }), h('span', null, text, c.ok ? null : h('small', null, ` — ${failReason(c)}`))));
    }
    const reasons = rec.point.reasons.map((r) => REASON_NAME[r] ?? r).join('、');
    const tokens = usageTotal(rec.usage);
    const meta = [`${(rec.ms / 1000).toFixed(1)} 秒`, tokens ? `${fmtTokens(tokens)} token` : '', reads ? `查看 ×${reads}` : ''].filter(Boolean).join(' · ');
    const item = h(
      `li.ai-feed-item${rec.by === 'fallback' ? '.by-bot' : ''}`,
      null,
      h('div.ai-feed-head', null, h('b', null, `第 ${Math.max(1, rec.point.wave)} 波`), h('span.muted', null, reasons), rec.by === 'fallback' ? h('span.badge.ai-bot-badge', null, '机器人') : null),
      rec.note ? h('p.ai-feed-note', null, rec.note) : null,
      acts.length ? h('ul.ai-feed-acts', null, acts) : rec.by === 'agent' && isPlayer ? h('p.muted.small', null, '这次没有下指令') : null,
      rec.fallbackReason ? h('p.ai-feed-why', null, zhFallback(rec.fallbackReason)) : null,
      h('small.muted', null, meta),
    );
    feedList.prepend(item);
    while (feedList.children.length > FEED_MAX) feedList.lastElementChild?.remove();
    setText(feedCount, `${feedTotal}`);
  };

  // ───────────── 军师建议 ─────────────
  const cmdAsPlayer = (c: Command): CommandResult => {
    const r = session.command(c);
    if (!r.ok) audio.play('error');
    return r;
  };
  const addSuggestion = (s: Suggestion): void => {
    const parsed = s.actions.map((raw) => ({ raw, a: parseAction(raw) }));
    const card = h('div.ai-suggest-card');
    const dismiss = (): void => {
      card.classList.add('out');
      setTimeout(() => card.remove(), 200);
    };
    const rows = parsed.map(({ raw, a }) => {
      const label = a ? (describeCall(world, a.name, a.input) ?? raw) : raw;
      if (!a) return h('li.unparsed', null, h('span', null, label));
      const btn = h<HTMLButtonElement>(
        'button.btn.small.primary',
        {
          attrs: { type: 'button', 'aria-label': `采纳：${label}` },
          onclick: () => {
            const r = applyAction(world, cmdAsPlayer, a);
            if (r.ok) {
              audio.play('select');
              adopted++;
              btn.disabled = true;
              btn.textContent = '已采纳';
              li.classList.add('done');
              if (!card.querySelector('li:not(.done):not(.unparsed) button')) setTimeout(dismiss, 700);
            } else app.toast(`没能执行：${r.reason ?? ''}`, 'warn');
          },
        },
        '采纳',
      );
      const li = h('li', null, h('span', null, label), btn);
      return li;
    });
    card.append(
      h(
        'div.ai-suggest-head',
        null,
        h('span.gi', { html: G.eye }),
        h('b', null, '军师建议'),
        h('small.muted', null, `第 ${Math.max(1, s.wave)} 波`),
        h('button.btn.small.ai-suggest-dismiss', { attrs: { type: 'button', 'aria-label': '忽略这条建议' }, onclick: () => (audio.play('click'), dismiss()) }, '忽略'),
      ),
      h('p', null, s.text),
      rows.length ? h('ul.ai-suggest-acts', null, rows) : '',
    );
    suggestBox.prepend(card);
    while (suggestBox.children.length > SUGGEST_MAX) suggestBox.lastElementChild?.remove();
    audio.play('click');
  };

  // ───────────── 控制器 ─────────────
  let ctl: AgentController | null = null;
  const onEvent = (ev: AgentControllerEvent): void => {
    if (destroyed) return;
    switch (ev.type) {
      case 'status':
        status = ev.status;
        statusDetail = ev.detail ?? '';
        if (ev.status === 'error') {
          // AI 玩家没能启动：先停住游戏，等玩家决定（改用内置策略 / 自己接管）
          if (isPlayer) session.togglePause(true);
          showError(ev.detail ?? '未知错误');
        }
        if (ev.status === 'thinking' && !isPlayer) advisorKey = stateKey();
        break;
      case 'decision':
        lastBy = ev.record.by;
        addFeed(ev.record);
        break;
      case 'usage':
        usage = ev.usage;
        costUsd = ev.costUsd;
        paintUsage();
        break;
      case 'suggestion':
        addSuggestion(ev.suggestion);
        break;
      case 'error':
        errorCount++;
        break;
    }
    paintStatus();
  };

  const stateKey = (): string => {
    const s = world.state;
    return `${s.phase}:${s.wave}:${s.perkChoices?.map((c) => c.id).join(',') ?? ''}:${s.crateChoice?.uid ?? ''}`;
  };

  const makeController = (cfg: Partial<AgentModelConfig>, provider = launch.provider): AgentController =>
    createAgentController({ config: cfg, session: proxy, mode: launch.mode, provider, onEvent, pollMs: 0, trace });

  const startController = (cfg: Partial<AgentModelConfig>, provider = launch.provider): void => {
    config = cfg;
    try {
      ctl = makeController(cfg, provider);
    } catch (e) {
      status = 'error';
      showError(e instanceof Error ? e.message : String(e));
      paintStatus();
      return;
    }
    void ctl.start().catch((e: unknown) => {
      status = 'error';
      showError(e instanceof Error ? e.message : String(e));
      paintStatus();
    });
  };

  function showError(message: string): void {
    errorBox.hidden = false;
    clear(errorBox);
    errorBox.append(
      h('p', null, `模型没能启动：${message}`),
      h(
        'div.ai-error-actions',
        null,
        h(
          'button.btn.small.primary',
          {
            attrs: { type: 'button' },
            onclick: () => {
              audio.play('click');
              errorBox.hidden = true;
              switchedToBot = true;
              shownChip = null;
              ctl?.stop();
              if (session.paused && !pauseMenuOpen()) session.togglePause(false);
              startController({ ...launch.config, provider: 'scripted', model: 'scripted-v1', apiKey: undefined, bridge: undefined }, isPlayer ? undefined : demoAdvisor(world));
            },
          },
          '改用内置策略',
        ),
        isPlayer
          ? h('button.btn.small', { attrs: { type: 'button' }, onclick: () => (audio.play('click'), (errorBox.hidden = true), takeOver()) }, '我来操作')
          : h('button.btn.small', { attrs: { type: 'button' }, onclick: () => (audio.play('click'), (errorBox.hidden = true)) }, '知道了'),
      ),
    );
    if (!open) {
      open = true;
      paintOpen();
    }
  }

  function takeOver(): void {
    takenOver = true;
    try {
      ctl?.stop();
    } catch {
      /* ignore */
    }
    status = 'stopped';
    // 暂停模式下模型思考时游戏是停着的：交还给玩家时恢复
    if (session.paused && !pauseMenuOpen()) session.togglePause(false);
    paintStatus();
  }

  pauseBtn.onclick = () => {
    if (!ctl) return;
    audio.play('click');
    if (status === 'paused') ctl.resume();
    else ctl.pause();
  };
  let stopArmed = 0;
  const paintStop = (): void => {
    const armed = Date.now() < stopArmed;
    stopBtn.classList.toggle('danger', armed);
    stopBtn.textContent = armed ? (isPlayer ? '确认接管？' : '确认停止？') : isPlayer ? '停止 AI，我来玩' : '停止建议';
  };
  stopBtn.onclick = () => {
    audio.play('click');
    if (Date.now() < stopArmed) {
      stopArmed = 0;
      takeOver();
      app.toast(isPlayer ? '已接管：现在由你操作' : '军师已停止', 'info');
    } else {
      stopArmed = Date.now() + 3000;
      setTimeout(paintStop, 3100);
    }
    paintStop();
  };
  speedBtn.onclick = () => {
    audio.play('click');
    session.setSpeed(((session.speed % 3) + 1) as Speed);
  };

  // ───────────── 轮询 / 输入屏蔽 ─────────────
  const timer = window.setInterval(() => {
    if (destroyed || over || !ctl) return;
    const s = world.state;
    if (s.phase === 'won' || s.phase === 'lost') return;
    if (ctl.status === 'running') {
      // AI 玩家：自动拾取硬币 / 补给箱（文档 10 §4.3，拾取同样写进指令日志）
      if (driving() && !session.paused && s.pickups.length) {
        for (const pk of s.pickups.slice()) {
          if (pk.kind === 'crate' && s.crateChoice) continue;
          proxy.command({ type: 'collect', uid: pk.uid });
        }
      }
      // 军师：建造 / 增益阶段同一局面只问一次（世界不会自己前进，否则会反复提问烧 token）
      if (!isPlayer && (s.phase === 'build' || s.phase === 'perk') && stateKey() === advisorKey) return;
      if (pauseMenuOpen() || session.autoPaused) return;
      ctl.poll();
    }
    if (shownChip === 'acting' || shownChip === 'thinking') paintStatus();
  }, 100);

  const offChange = session.onChange(() => {
    paintSpeed();
    // 暂停模式：模型思考期间玩家从暂停菜单点了「继续」→ 游戏仍然等模型
    if (pauseMode && !releasing && ctl?.status === 'thinking' && !session.paused && !pauseMenuOpen() && !over) session.togglePause(true);
    // AI 玩家没能启动、玩家还没做选择：保持暂停
    if (isPlayer && status === 'error' && !takenOver && !session.paused && !pauseMenuOpen() && !over) session.togglePause(true);
  });

  /** AI 操作期间屏蔽会下指令的快捷键（暂停 P、速度 F、Esc 仍可用） */
  const onKey = (e: KeyboardEvent): void => {
    if (!driving() || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === 'p' || k === 'f' || k === 'Escape' || k === 'Tab' || k === 'Enter' || k === 'Shift') return;
    const t = e.target;
    // 思路与请求面板（搜索框等）：按键原样交给它
    if (t instanceof HTMLElement && t.closest('.tr-panel')) return;
    if (t instanceof HTMLElement && t.closest('.ai-hud, .overlay, .replay-view')) {
      if (k === ' ' && t.closest('button, summary')) return;
    }
    e.stopImmediatePropagation();
    if (k === ' ') e.preventDefault();
  };
  window.addEventListener('keydown', onKey, true);

  paintStatus();
  paintUsage();
  paintSpeed();
  paintStop();
  // 离线演示 + 军师：脚本策略本身不会提建议，换成「预演后给建议」的演示版
  startController(launch.config, !isPlayer && launch.config.provider === 'scripted' ? demoAdvisor(world) : launch.provider);

  // ───────────── 结算 ─────────────
  function summary(d: AiGameOverInfo): AiRunSummary {
    const rep = ctl?.report() ?? null;
    const decisions = rep?.decisions ?? [];
    return {
      launch,
      info: d,
      opts: ctx.opts,
      world,
      agent: rep?.agent ?? { provider: 'none', model: 'none', role },
      mode: launch.mode,
      usage: rep?.usage ?? usage,
      costUsd: rep?.costUsd ?? costUsd,
      decisions: decisions.length,
      botShare: switchedToBot || rep?.agent.provider === 'scripted' ? 1 : botShareOf(decisions),
      toolCalls: decisions.reduce((n, r) => n + r.toolCalls.length, 0),
      errors: rep?.errors.length ?? errorCount,
      suggestions: rep?.suggestions.length ?? 0,
      adopted,
      takenOver,
      switchedToBot,
      replay: rep?.replay ?? null,
      seconds: Math.round((Date.now() - startedAt) / 1000),
      trace: rep?.trace ?? trace.export({ maxChars: 1_500_000 }),
    };
  }

  return {
    gameOverCard(d: AiGameOverInfo, hd: AiGameOverHandlers): HTMLElement {
      over = true;
      const sum = summary(d);
      try {
        ctl?.stop();
      } catch {
        /* ignore */
      }
      clear(suggestBox);
      open = false;
      paintOpen();
      paintStatus();
      tp?.setLive(false);
      return reportCard(app, sum, hd);
    },
    destroy() {
      destroyed = true;
      clearInterval(timer);
      offChange();
      window.removeEventListener('keydown', onKey, true);
      try {
        ctl?.stop();
      } catch {
        /* ignore */
      }
      game.classList.remove('ai-driving');
      tp?.destroy();
      ui.set({ aiFocus: null });
      root.remove();
    },
  };
}

/** 兜底原因（引擎里是英文）→ 中文 */
function zhFallback(reason: string): string {
  return reason
    .split('; ')
    .map((r) => {
      if (r.startsWith('auto perk')) return `自动选了增益 ${r.slice(10)}`;
      if (r === 'auto start_wave') return '模型没有开波，已自动开波';
      if (r.startsWith('timeout')) return '模型超时，本次由机器人代做';
      if (r.startsWith('token budget')) return 'token 预算用完，由机器人接管';
      if (r.startsWith('cost budget')) return '费用预算用完，由机器人接管';
      if (r.startsWith('disabled after')) return `连续出错，模型已停用（${r.replace(/^disabled after \d+ consecutive errors \(last: /, '').replace(/\)$/, '')}）`;
      if (r.includes('advisor: no advice')) return `这次没拿到建议（${r.replace(' (advisor: no advice this time)', '')}）`;
      return `模型出错：${r}`;
    })
    .join('；');
}
