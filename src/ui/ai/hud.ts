/**
 * 对局里的 AI 面板（动态分包）：状态徽标、决策流、用量 / 预算、控制按钮、军师建议卡片、结算报告。
 *
 * 手机：棋盘左上角一个小徽标，点开是底部抽屉；电脑：徽标下面的浮动面板。
 * 控制器（src/agent createAgentController）只负责「什么时候问模型、把指令下到 session」，
 * 这里负责：轮询节奏（军师模式避免在建造 / 增益阶段反复提问）、自动拾取、AI 操作时屏蔽玩家输入。
 */
import {
  actToLegacy,
  type AgentController,
  type AgentControllerEvent,
  type AgentModelConfig,
  type AgentStatus,
  AgentTrace,
  type BudgetChoice,
  type BudgetState,
  budgetTokens,
  createAgentController,
  type DecisionRecord,
  type SessionLike,
  type Suggestion,
  type TokenUsage,
  type TraceExport,
  usageLine,
  usageTotal,
} from '../../agent';
import type { Command, CommandResult } from '../../core/types';
import type { Speed } from '../../game/Session';
import { ui } from '../../game/UiStore';
import { fmtNumber, onLocaleChange, t } from '../../i18n';
import { audio } from '../audio';
import { clear, fmtNum, h, setText } from '../dom';
import { G } from '../icons';
import { applyAction, describeCall, failReason, parseAction, reasonName } from './actions';
import { demoAdvisor } from './demoAdvisor';
import { fmtCost, fmtTokens } from './format';
import type { AiAttachCtx, AiGameOverHandlers, AiGameOverInfo, AiHudHandle, AiLaunch } from './launch';
import { botShareOf } from './meta';
import { OpsRecorder, type OpsWorld, type TraceExportWithOps } from './ops';
import { type AiRunSummary, reportCard } from './report';
import { mountTracePanel, type TracePanelHandle } from './trace-panel';

const FEED_MAX = 40;
const SUGGEST_MAX = 2;

type Chip = 'loading' | 'thinking' | 'acting' | 'watching' | 'paused' | 'fallback' | 'stopped' | 'error' | 'over';

/** 状态徽标文字（当前语言） */
const chipLabel = (k: Chip): string => t(`agent.hud.chip.${k}`);

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

  // 操作解读：AI 的每条指令（经下面的代理）与兜底机器人的事件，按决策归档（思路与请求面板右栏 / 导出 / 回放）
  const opsRec = new OpsRecorder({ world: world as unknown as OpsWorld, eventOps: isPlayer });
  const offOpsEvents = session.on((ev) => opsRec.onGameEvent(ev));

  // ───────────── 控制器用的 Session 代理 ─────────────
  const proxy: SessionLike = {
    world,
    get paused() {
      return session.paused;
    },
    command(cmd: Command): CommandResult {
      // 停用 / 接管之后还在途的模型回复：不再替玩家下指令
      if (destroyed || takenOver) return { ok: false, reason: t('agent.hud.line.stoppedPlayer') };
      const r = opsRec.record(cmd, () => session.command(cmd));
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
  const chip = h<HTMLButtonElement>(
    'button.ai-chip',
    { attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': 'ai-panel' } },
    dot,
    chipText,
    chipUsage,
  );
  const statusLine = h('p.ai-status-line', { attrs: { role: 'status', 'aria-live': 'polite' } });
  const usageNums = h('div.ai-usage-nums');
  const budgetFill = h('span.ai-budget-fill');
  // 分级刻度：70% 省流 · 90% 低思考 · 100% 最省（或按设置交给机器人 / 询问）
  const marks = [70, 90].map((p) => h('span.ai-budget-mark', { attrs: { 'aria-hidden': 'true' }, style: { left: `${p}%` } }));
  const budgetBar = h('div.ai-budget', { attrs: { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100 } }, budgetFill, ...marks);
  const budgetMode = h('span.badge.ai-mode-chip');
  const budgetText = h('small.muted.ai-budget-text');
  const budgetAsk = h('div.ai-budget-ask', { attrs: { role: 'group' } });
  budgetAsk.hidden = true;
  let budgetState: BudgetState | null = null;
  const errorBox = h('div.ai-error');
  errorBox.hidden = true;

  const pauseBtn = h<HTMLButtonElement>('button.btn.small', { attrs: { type: 'button' } });
  const stopBtn = h<HTMLButtonElement>('button.btn.small.ai-stop', { attrs: { type: 'button' } });
  const speedBtn = h<HTMLButtonElement>('button.btn.small', { attrs: { type: 'button' } });
  const controls = h('div.ai-controls', null, pauseBtn, stopBtn, speedBtn);

  const feedList = h('ol.ai-feed-list');
  const feedCount = h('span.ai-feed-count');
  const feedTitle = h('span.ai-feed-title');
  const feed = h<HTMLDetailsElement>('details.ai-feed', null, h('summary', null, feedTitle, feedCount), feedList);
  feed.open = true;

  const closeBtn = h('button.btn.icon-btn.ai-close', { attrs: { type: 'button' } }, h('span.gi', { html: G.close }));
  const panelTitle = h('b');
  const panel = h(
    'div.ai-panel',
    { attrs: { id: 'ai-panel', role: 'region' } },
    h('div.ai-panel-head', null, h('div.ai-panel-title', null, panelTitle, h('small.muted', null, launch.label)), closeBtn),
    statusLine,
    errorBox,
    h('div.ai-usage', null, usageNums, budgetBar, h('div.ai-budget-row', null, budgetMode, budgetText), budgetAsk),
    controls,
    feed,
  );
  const suggestBox = h('div.ai-suggest', { attrs: { 'aria-live': 'polite' } });
  /** 创建后不再变化的文字：切换语言时重新写一遍 */
  const paintStatic = (): void => {
    marks.forEach((m, i) => (m.title = t(i === 0 ? 'agent.hud.mark70' : 'agent.hud.mark90')));
    budgetBar.setAttribute('aria-label', t('agent.hud.budgetBar'));
    budgetMode.title = t('agent.hud.modeTip');
    budgetAsk.setAttribute('aria-label', t('agent.hud.budgetOut'));
    speedBtn.setAttribute('aria-label', t('agent.hud.speed'));
    setText(feedTitle, t('agent.hud.feed'));
    closeBtn.setAttribute('aria-label', t('agent.hud.closePanel'));
    panel.setAttribute('aria-label', t('agent.hud.panel'));
    setText(panelTitle, isPlayer ? t('agent.hud.player') : t('agent.hud.advisor'));
    suggestBox.setAttribute('aria-label', t('agent.hud.suggestions'));
  };
  paintStatic();
  // 思路与请求（文档 10 §12.1）：同一个缓冲区贯穿整局（换成内置策略重启控制器也不断档）
  const trace = new AgentTrace();
  const offOpsTrace = trace.subscribe((e) => opsRec.onTrace(e));
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
      ops: opsRec,
      onHighlightCells: (cells) => ui.set({ aiFocusCells: cells?.length ? cells.map((c) => ({ cx: c.x, cy: c.y })) : null }),
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
    console.error('[ai] trace panel failed to load', e);
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
    const drv = driving();
    game.classList.toggle('ai-driving', drv);
    // AI 操作中：棋盘只能点选查看（信息面板照常显示，按钮禁用）
    if (ui.state.inspectOnly !== drv)
      ui.set(drv ? { inspectOnly: true, build: null, aiming: null, abilityAiming: null, pending: null } : { inspectOnly: false });
    if (k !== shownChip) {
      shownChip = k;
      root.dataset.status = k;
      setText(
        chipText,
        switchedToBot && (k === 'watching' || k === 'thinking') ? t('agent.hud.chipBot', { status: chipLabel(k) }) : chipLabel(k),
      );
    }
    let line: string;
    switch (k) {
      case 'loading':
        line = t('agent.hud.line.loading');
        break;
      case 'thinking': {
        const why =
          statusDetail
            .split(',')
            .filter(Boolean)
            .map((r) => reasonName(r) ?? r)
            .join(t('agent.hud.listSep')) || '…';
        line = t(pauseMode ? 'agent.hud.line.thinkingPaused' : 'agent.hud.line.thinking', { reasons: why });
        break;
      }
      case 'acting':
        line = t('agent.hud.line.acting');
        break;
      case 'paused':
        line = ctl?.budgetPending ? t('agent.hud.line.budgetPending') : t('agent.hud.line.paused');
        break;
      case 'fallback':
        line = t('agent.hud.line.fallback');
        break;
      case 'stopped':
        line = isPlayer ? t('agent.hud.line.stoppedPlayer') : t('agent.hud.line.stoppedAdvisor');
        break;
      case 'error':
        line = t('agent.hud.line.error');
        break;
      case 'over':
        line = t('agent.hud.line.over');
        break;
      default:
        line = isPlayer ? t('agent.hud.line.waitPlayer') : t('agent.hud.line.waitAdvisor');
    }
    setText(statusLine, line);
    pauseBtn.replaceChildren(
      h('span.gi', { html: status === 'paused' ? G.play : G.pause }),
      status === 'paused' ? t('agent.hud.resume') : t('agent.hud.pause'),
    );
    pauseBtn.setAttribute('aria-label', status === 'paused' ? t('agent.hud.resumeAll') : t('agent.hud.pauseAll'));
    const dead = over || status === 'stopped' || status === 'error';
    pauseBtn.disabled = dead || status === 'loading' || status === 'idle';
    stopBtn.disabled = dead;
  };

  const paintUsage = (): void => {
    // 预算按"折算"计（新输入 + 输出 + 缓存写×1.25 + 缓存读×0.1）；原始总数单独显示，避免把便宜的缓存读当成预算
    const weighted = budgetTokens(usage);
    const raw = usageTotal(usage);
    setText(chipUsage, weighted > 0 ? `${fmtTokens(weighted)}${costUsd > 0 ? ` · ${fmtCost(costUsd)}` : ''}` : '');
    chipUsage.title = weighted > 0 ? t('agent.hud.usageTip', { weighted: fmtNum(weighted), raw: fmtNum(raw) }) : '';
    usageNums.replaceChildren(
      h('span', { title: usageLine(usage, fmtNum) }, h('b', null, fmtTokens(weighted)), ` ${t('agent.hud.weighted')}`),
      h('span.muted', { title: t('agent.hud.rawTip') }, t('agent.hud.raw', { n: fmtTokens(raw) })),
      h('span', { title: t('agent.hud.costTip') }, h('b', null, fmtCost(costUsd)), ` ${t('agent.hud.estimated')}`),
      h('span', null, h('b', null, String(usage.requests)), ` ${t('agent.hud.requestsUnit', { n: usage.requests })}`),
    );
    const bt = config.budget?.tokens;
    const bu = config.budget?.usd;
    const limit = budgetState?.limit ?? bt;
    const ratio = budgetState?.ratio ?? Math.max(limit ? weighted / limit : 0, bu ? costUsd / bu : 0);
    budgetBar.hidden = !limit && !bu;
    budgetText.hidden = !limit && !bu;
    budgetMode.hidden = !budgetState;
    if (budgetState) setText(budgetMode, budgetState.modeLabel);
    if (limit || bu) {
      const pct = Math.round(ratio * 100);
      budgetFill.style.transform = `scaleX(${Math.min(1, ratio).toFixed(3)})`;
      budgetBar.dataset.level = ratio >= 1 ? 'out' : ratio >= 0.9 ? 'high' : ratio >= 0.7 ? 'mid' : 'ok';
      budgetBar.setAttribute('aria-valuenow', String(Math.min(100, pct)));
      const parts = [
        limit ? t('agent.hud.weightedOf', { used: fmtTokens(weighted), limit: fmtTokens(limit) }) : '',
        bu ? `${fmtCost(costUsd)} / ${fmtCost(bu)}` : '',
      ].filter(Boolean);
      const policy = budgetState?.policy ?? config.budget?.mode ?? 'soft';
      const msg =
        ratio >= 1
          ? policy === 'hard' || ctl?.report().decisions.some((d) => d.fallbackReason?.includes('budget'))
            ? t('agent.hud.budgetBot')
            : t('agent.hud.budgetOver')
          : (budgetState?.message ?? t('agent.hud.budgetPct', { pct }));
      setText(budgetText, t('agent.hud.budgetLine', { msg, detail: parts.join(' · ') }));
    }
  };

  /** 暂停并询问：继续（最省模式）/ 追加预算（+500k）/ 交给机器人 */
  const showBudgetAsk = (b: BudgetState): void => {
    budgetAsk.hidden = false;
    const choose = (c: BudgetChoice): void => {
      audio.play('click');
      budgetAsk.hidden = true;
      ctl?.resolveBudget(c);
      if (c === 'bot') lastBy = 'fallback';
      paintStatus();
    };
    budgetAsk.replaceChildren(
      h(
        'p',
        null,
        t('agent.hud.askText', {
          used: b.limit
            ? t('agent.hud.weightedOf', { used: fmtTokens(b.weighted), limit: fmtTokens(b.limit) })
            : `${fmtTokens(b.weighted)} ${t('agent.hud.weighted')}`,
        }),
      ),
      h(
        'div.ai-error-actions',
        null,
        h('button.btn.small.primary', { attrs: { type: 'button' }, onclick: () => choose('continue') }, t('agent.hud.askContinue')),
        h('button.btn.small', { attrs: { type: 'button' }, onclick: () => choose('extend') }, t('agent.hud.askExtend')),
        h('button.btn.small', { attrs: { type: 'button' }, onclick: () => choose('bot') }, t('agent.hud.askBot')),
      ),
    );
    if (!open) {
      open = true;
      paintOpen();
    }
  };

  const paintSpeed = (): void => {
    speedBtn.replaceChildren(h('span.gi', { html: G.fast }), `${session.speed}×`);
  };

  // ───────────── 决策流 ─────────────
  let feedTotal = 0;
  let skippedCount = 0;
  const addFeed = (rec: DecisionRecord): void => {
    if (rec.by === 'local') {
      // 门控跳过：不刷屏，只计数（思路与请求面板里每条都有）
      skippedCount++;
      paintFeedCount();
      return;
    }
    feedTotal++;
    const acts: HTMLElement[] = [];
    let reads = 0;
    for (const c of rec.toolCalls) {
      if (c.name === 'act') {
        // 批量动作：逐条展开（每条的成败按结果里的行号）
        const list = Array.isArray((c.input as { actions?: unknown })?.actions)
          ? (c.input as { actions: Record<string, unknown>[] }).actions
          : [];
        const lines = c.result.split('\n');
        list.forEach((a, i) => {
          const m = actToLegacy(a);
          const text = 'error' in m ? null : describeCall(world, m.name, m.input);
          if (!text) return;
          const line = lines.find((l) => l.startsWith(`${i + 1} `)) ?? '';
          const ok = /^\d+ (OK|QUEUED)/.test(line);
          acts.push(
            h(
              `li.${ok ? 'ok' : 'bad'}`,
              null,
              h('span.gi', { html: ok ? G.check : G.close }),
              h('span', null, text, ok ? null : h('small', null, ` — ${line.replace(/^\d+ /, '').slice(0, 80)}`)),
            ),
          );
        });
        continue;
      }
      const text = describeCall(world, c.name, c.input);
      if (!text) {
        if (c.name !== 'end_turn' && c.name !== 'suggest' && c.name !== 'act') reads++;
        continue;
      }
      acts.push(
        h(
          `li.${c.ok ? 'ok' : 'bad'}`,
          null,
          h('span.gi', { html: c.ok ? G.check : G.close }),
          h('span', null, text, c.ok ? null : h('small', null, ` — ${failReason(c)}`)),
        ),
      );
    }
    const reasons = rec.point.reasons.map((r) => reasonName(r) ?? r).join(t('agent.hud.listSep'));
    const tokens = budgetTokens(rec.usage);
    const meta = [
      t('agent.hud.seconds', { s: fmtNumber(rec.ms / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }),
      tokens ? `${fmtTokens(tokens)} ${t('agent.hud.weighted')}` : '',
      rec.usage.requests ? t('agent.hud.requests', { n: rec.usage.requests }) : '',
      reads ? t('agent.hud.reads', { n: reads }) : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const item = h(
      `li.ai-feed-item${rec.by === 'fallback' ? '.by-bot' : ''}`,
      null,
      h(
        'div.ai-feed-head',
        null,
        h('b', null, t('agent.hud.wave', { n: Math.max(1, rec.point.wave) })),
        h('span.muted', null, reasons),
        rec.by === 'fallback' ? h('span.badge.ai-bot-badge', null, t('agent.hud.bot')) : null,
      ),
      rec.note ? h('p.ai-feed-note', null, rec.note) : null,
      acts.length
        ? h('ul.ai-feed-acts', null, acts)
        : rec.by === 'agent' && isPlayer
          ? h('p.muted.small', null, t('agent.hud.noActions'))
          : null,
      rec.fallbackReason ? h('p.ai-feed-why', null, fallbackText(rec.fallbackReason)) : null,
      h('small.muted', null, meta),
    );
    feedList.prepend(item);
    while (feedList.children.length > FEED_MAX) feedList.lastElementChild?.remove();
    paintFeedCount();
  };
  function paintFeedCount(): void {
    setText(feedCount, `${feedTotal}${skippedCount ? ` · ${t('agent.hud.skipped', { n: skippedCount })}` : ''}`);
  }

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
          attrs: { type: 'button', 'aria-label': t('agent.hud.adoptLabel', { action: label }) },
          onclick: () => {
            const r = applyAction(world, cmdAsPlayer, a);
            if (r.ok) {
              audio.play('select');
              adopted++;
              btn.disabled = true;
              btn.textContent = t('agent.hud.adopted');
              li.classList.add('done');
              if (!card.querySelector('li:not(.done):not(.unparsed) button')) setTimeout(dismiss, 700);
            } else app.toast(t('agent.hud.adoptFailed', { reason: r.reason ?? '' }), 'warn');
          },
        },
        t('agent.hud.adopt'),
      );
      const li = h('li', null, h('span', null, label), btn);
      return li;
    });
    card.append(
      h(
        'div.ai-suggest-head',
        null,
        h('span.gi', { html: G.eye }),
        h('b', null, t('agent.hud.suggestTitle')),
        h('small.muted', null, t('agent.hud.wave', { n: Math.max(1, s.wave) })),
        h(
          'button.btn.small.ai-suggest-dismiss',
          { attrs: { type: 'button', 'aria-label': t('agent.hud.dismissLabel') }, onclick: () => (audio.play('click'), dismiss()) },
          t('agent.hud.dismiss'),
        ),
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
          showError(ev.detail ?? t('agent.hud.unknownError'));
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
      case 'budget':
        budgetState = ev.budget;
        if (ev.budget.message && ev.budget.stage > 0) app.toast(ev.budget.message, 'info');
        paintUsage();
        break;
      case 'budget_ask':
        budgetState = ev.budget;
        paintUsage();
        showBudgetAsk(ev.budget);
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
      h('p', null, t('agent.hud.startFailed', { message })),
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
              startController(
                { ...launch.config, provider: 'scripted', model: 'scripted-v1', apiKey: undefined, bridge: undefined },
                isPlayer ? undefined : demoAdvisor(world),
              );
            },
          },
          t('agent.hud.useBot'),
        ),
        isPlayer
          ? h(
              'button.btn.small',
              { attrs: { type: 'button' }, onclick: () => (audio.play('click'), (errorBox.hidden = true), stop()) },
              t('agent.hud.takeOver'),
            )
          : h(
              'button.btn.small',
              { attrs: { type: 'button' }, onclick: () => (audio.play('click'), (errorBox.hidden = true), launch.onStop?.()) },
              launch.onStop ? t('ui.assist.stop') : t('agent.hud.gotIt'),
            ),
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

  /** 停止：对局中启用的 AI（有 onStop）→ 整个拆掉、交还控制；AI 参战局 → 接管（面板留着，结算出报告） */
  function stop(): void {
    if (launch.onStop) launch.onStop();
    else takeOver();
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
    stopBtn.textContent = armed
      ? isPlayer
        ? t('agent.hud.confirmTakeOver')
        : t('agent.hud.confirmStop')
      : isPlayer
        ? t('agent.hud.stopPlayer')
        : t('agent.hud.stopAdvisor');
  };
  stopBtn.onclick = () => {
    audio.play('click');
    if (Date.now() < stopArmed) {
      stopArmed = 0;
      stop();
      app.toast(isPlayer ? t('agent.hud.tookOver') : t('agent.hud.advisorStopped'), 'info');
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
    // I：AI 菜单（随时可以停止 / 切换 AI）
    if (k === 'p' || k === 'f' || k === 'i' || k === 'Escape' || k === 'Tab' || k === 'Enter' || k === 'Shift') return;
    const t = e.target;
    // 思路与请求面板（搜索框等）：按键原样交给它
    if (t instanceof HTMLElement && t.closest('.tr-panel, .ai-config-overlay, .ai-menu, .confirm-overlay')) return;
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
  // 切换语言（对局中从暂停菜单切换）：就地刷新面板文字；已有的决策记录 / 建议卡保持原样
  const offLocale = onLocaleChange(() => {
    if (destroyed) return;
    paintStatic();
    shownChip = null;
    paintStatus();
    paintUsage();
    paintStop();
    paintFeedCount();
  });
  // 离线演示 + 军师：脚本策略本身不会提建议，换成「预演后给建议」的演示版
  startController(launch.config, !isPlayer && launch.config.provider === 'scripted' ? demoAdvisor(world) : launch.provider);

  // ───────────── 结算 ─────────────
  /** 导出 / 回放用的追踪数据带上操作解读（只保留仍在导出里的决策） */
  function withOps(x: TraceExport): TraceExportWithOps {
    const keep = new Set(x.events.map((e) => e.d));
    return { ...x, ops: opsRec.export((d) => keep.has(d)) };
  }
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
      trace: withOps(rep?.trace ?? trace.export({ maxChars: 1_500_000 })),
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
    finish() {
      if (over) return;
      over = true;
      try {
        ctl?.stop();
      } catch {
        /* ignore */
      }
      clear(suggestBox);
      paintStatus();
      tp?.setLive(false);
    },
    takeOver() {
      if (!takenOver && !over) takeOver();
    },
    destroy() {
      destroyed = true;
      offLocale();
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
      offOpsTrace();
      offOpsEvents();
      ui.set({ aiFocus: null, aiFocusCells: null, inspectOnly: false });
      root.remove();
    },
  };
}

/** 兜底原因（引擎里是英文）→ 当前语言 */
function fallbackText(reason: string): string {
  return reason
    .split('; ')
    .map((r) => {
      if (r.startsWith('auto perk')) return t('agent.hud.fb.autoPerk', { perk: r.slice(10) });
      if (r === 'auto start_wave') return t('agent.hud.fb.autoWave');
      if (r.startsWith('timeout')) return t('agent.hud.fb.timeout');
      if (r.startsWith('token budget')) return t('agent.hud.fb.tokenBudget');
      if (r.startsWith('cost budget')) return t('agent.hud.fb.costBudget');
      if (r.startsWith('disabled after'))
        return t('agent.hud.fb.disabled', { detail: r.replace(/^disabled after \d+ consecutive errors \(last: /, '').replace(/\)$/, '') });
      if (r.includes('advisor: no advice')) return t('agent.hud.fb.noAdvice', { detail: r.replace(' (advisor: no advice this time)', '') });
      return t('agent.hud.fb.error', { detail: r });
    })
    .join(t('agent.hud.fb.sep'));
}
