/**
 * 「思路与请求」面板（文档 10 §12.1，动态分包）：观战的人在棋盘旁边实时看到 AI 的思路与全部请求信息。
 *
 * 布局：
 *  - 宽横屏（电脑 / 平板横放，宿主宽 ≥ 960 且宽高比 ≥ 1.25）：棋盘右边一栏，可拖动改宽、可收成一条细边；
 *    宿主（.game-screen / .replay-view）加 data-trace-mode="column" 与 --trace-occupy，对局容器让出这一栏；
 *  - 其余（竖屏手机、紧凑横屏）：盖在棋盘上的抽屉（竖屏在棋盘上半部，横屏在棋盘左侧），不挡塔栏 / 技能 / 开波这些操作。
 * 性能：事件只改数据模型并标脏，渲染统一在 requestAnimationFrame 里批量做；面板收起 / 关闭时不碰 DOM；
 *       只有最近 30 张决策卡片是展开的，更早的折叠成一行（点开再渲染），总数超过 300 张丢最旧的；长文本截断显示。
 * 隐私：内容全部来自已脱敏的 AgentTrace（src/agent/trace.ts），只在本机浏览器里。
 */
import '../../styles/ai-trace.css';

import { type AgentTrace, argsLine, budgetTokens, computeTotals, emptyUsage, type TokenUsage, type TraceEvent } from '../../agent';
import { fmtNumber, onLocaleChange, t } from '../../i18n';
import { audio } from '../audio';
import { append, type Child, clear, copyText, h, setText } from '../dom';
import { G } from '../icons';
import { reasonName } from './actions';
import { fmtCost, fmtTokens, providerLabel } from './format';
import { type Cell, type DecisionOps, type Op, type OpsSource, opsTotals } from './ops';
import { groupSummary, groupTitle, opGold, opIcon, opLine, totalsItems } from './ops-format';

type Ev<K extends TraceEvent['k']> = Extract<TraceEvent, { k: K }>;

/** replaceChildren，但允许 null / false（条件子元素） */
function fill(el: Element, ...kids: Child[]): void {
  clear(el);
  append(el, kids);
}

const FULL_CARDS = 30;
const MAX_CARDS = 300;
const SHOW_CHARS = 6000;
const LIVE_TEXT_CHARS = 12_000;
const EXPAND_MAX = 400_000;
const PREF_KEY = 'desk-defense.ai.trace.v1';

export interface TracePanelOptions {
  /** 宿主：.game-screen（对局）或 .replay-view（回放） */
  host: HTMLElement;
  /** 抽屉模式下盖在哪个元素上（棋盘） */
  anchor: () => HTMLElement | null;
  trace: AgentTrace;
  /** 实时对局（有「跟随最新」与进行中状态）；回放里为 false */
  live: boolean;
  subtitle?: string;
  /** 工具调用涉及的格子（悬停时在棋盘上高亮；null = 取消） */
  onHighlight?: (cell: { x: number; y: number } | null) => void;
  /** 操作解读：每次决策实际做了什么（有就显示右栏 / 「操作」页） */
  ops?: OpsSource;
  /** 操作涉及的多个格子（悬停操作 / 意图组时高亮；null = 取消）；缺省时退回 onHighlight 的第一格 */
  onHighlightCells?: (cells: Cell[] | null) => void;
  /** 操作 / 意图涉及的进攻路线（ids = 出生点 id，null = 全部；air = 飞行线）；null = 取消。文档 10 §18-8 */
  onHighlightRoute?: (r: { ids: string[] | null; air: boolean } | null) => void;
  /** 抽屉打开 / 关闭（例如关掉同位置的 AI 面板） */
  onOpenChange?: (open: boolean, mode: 'column' | 'drawer') => void;
  /** 初始是否打开（缺省：分栏模式打开、抽屉模式关闭） */
  initialOpen?: boolean;
  /**
   * 嵌进 AI 侧栏（dock.ts）：面板放进这个容器，自己不再管位置 / 开合 / 改宽 / 页签，
   * 由侧栏经 present() 告诉它是否可见、显示哪一页（思路 / 操作 / 两栏并排）。
   */
  embed?: HTMLElement;
}

export interface TracePanelHandle {
  readonly el: HTMLElement;
  /** 放在别处的开关按钮（AI 面板徽标旁 / 回放顶栏） */
  readonly toggle: HTMLButtonElement;
  readonly mode: 'column' | 'drawer';
  isOpen(): boolean;
  setOpen(open: boolean): void;
  /** 回放：只显示游戏帧号 ≤ tick 的决策（null = 全部） */
  setTickLimit(tick: number | null): void;
  /** 对局结束：标记为不再更新 */
  setLive(live: boolean): void;
  /** 嵌入模式：侧栏的当前页（visible = 这个面板正显示着；view = 思路 / 操作 / 两栏；compact = 窄 / 抽屉） */
  present(p: { visible: boolean; view: 'trace' | 'ops' | 'split'; compact: boolean }): void;
  destroy(): void;
}

// ───────────────────────── 数据模型 ─────────────────────────

type Seg =
  | { kind: 'req'; n: number; ev: Ev<'request'>; raw?: string; rawChars?: number; el?: HTMLElement; dirty: boolean }
  | { kind: 'thinking' | 'text'; n: number; text: string; total: number; el?: HTMLElement; dirty: boolean }
  | { kind: 'tool'; call: Ev<'tool_call'>; result?: Ev<'tool_result'>; el?: HTMLElement; dirty: boolean }
  | { kind: 'resp'; ev: Ev<'response'>; el?: HTMLElement; dirty: boolean }
  | { kind: 'error'; ev: Ev<'error'>; el?: HTMLElement; dirty: boolean }
  | { kind: 'fallback'; ev: Ev<'fallback'>; el?: HTMLElement; dirty: boolean }
  | { kind: 'compact'; ev: Ev<'compact'>; el?: HTMLElement; dirty: boolean };

interface Card {
  d: number;
  start?: Ev<'decision_start'>;
  end?: Ev<'decision_end'>;
  segs: Seg[];
  tools: Map<string, Extract<Seg, { kind: 'tool' }>>;
  reqs: Map<number, Extract<Seg, { kind: 'req' }>>;
  usage: TokenUsage;
  cost: number;
  latency: number;
  search: string;
  el?: HTMLElement;
  head?: HTMLElement;
  body?: HTMLElement;
  foot?: HTMLElement;
  /** 操作解读（右栏） */
  opsEl?: HTMLElement;
  /** 玩家指令（本次决策带上的）与 AI 的回应 */
  instr?: { id: number; text: string; kind: 'once' | 'standing'; ack?: string; code?: string }[];
  instrEl?: HTMLElement;
  opsDirty: boolean;
  full: boolean;
  /** 用户手动展开的旧卡片（不会被自动折叠） */
  pinned: boolean;
  dirtyHead: boolean;
  /** 尚未渲染的新片段 */
  pending: Seg[];
}

const newCard = (d: number): Card => ({
  d,
  segs: [],
  tools: new Map(),
  reqs: new Map(),
  usage: emptyUsage(),
  cost: 0,
  latency: 0,
  search: '',
  full: true,
  pinned: false,
  dirtyHead: true,
  pending: [],
  opsDirty: true,
});

// ───────────────────────── 小组件 ─────────────────────────

/** 等宽代码块：显示前 SHOW_CHARS 字符，可「展开全部」，复制按钮复制完整内容 */
function codeBlock(label: string, get: () => string, opts: { copyText?: () => string; lang?: string } = {}): HTMLElement {
  const pre = h('pre.tr-code', { attrs: { tabindex: 0, 'data-lang': opts.lang ?? 'text' } });
  const info = h('small.muted.tr-code-size');
  const more = h<HTMLButtonElement>('button.btn.small.tr-more', { attrs: { type: 'button' } });
  more.hidden = true;
  const copyBtn = h<HTMLButtonElement>(
    'button.btn.small.tr-copy',
    { attrs: { type: 'button', 'aria-label': t('agent.trace.copyLabel', { label }) } },
    h('span.gi', { html: G.copy }),
    t('agent.trace.copy'),
  );
  let full = false;
  const paint = (): void => {
    const text = get();
    const cut = !full && text.length > SHOW_CHARS;
    pre.textContent = cut
      ? `${text.slice(0, SHOW_CHARS)}\n…`
      : text.length > EXPAND_MAX
        ? `${text.slice(0, EXPAND_MAX)}\n…${t('agent.trace.tooLong', { count: fmtNumber(EXPAND_MAX) })}`
        : text;
    setText(info, t('agent.trace.chars', { count: fmtNumber(text.length) }));
    more.hidden = !cut;
    if (cut) more.textContent = t('agent.trace.expandAll', { count: fmtNumber(text.length) });
  };
  more.onclick = () => {
    full = true;
    paint();
  };
  copyBtn.onclick = async () => {
    audio.play('click');
    const ok = await copyText(opts.copyText ? opts.copyText() : get());
    copyBtn.replaceChildren(h('span.gi', { html: ok ? G.check : G.close }), ok ? t('agent.trace.copied') : t('agent.trace.copyFailed'));
    setTimeout(() => copyBtn.replaceChildren(h('span.gi', { html: G.copy }), t('agent.trace.copy')), 1400);
  };
  const box = h('div.tr-codebox', null, h('div.tr-code-head', null, h('b', null, label), info, copyBtn), pre, more);
  paint();
  return box;
}

/** 懒渲染的折叠段：第一次打开时才生成内容 */
function lazyDetails(cls: string, summary: string, build: () => HTMLElement): HTMLDetailsElement {
  const d = h<HTMLDetailsElement>(`details.tr-details.${cls}`, null, h('summary', null, summary));
  let built = false;
  d.addEventListener('toggle', () => {
    if (d.open && !built) {
      built = true;
      d.appendChild(build());
    }
  });
  return d;
}

const prettyJson = (s: string | undefined): string => s ?? t('agent.trace.none');

const fmtMs = (ms: number): string =>
  ms >= 1000
    ? t('agent.trace.sec', { s: fmtNumber(ms / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })
    : `${Math.round(ms)} ms`;

const usageLine = (u: TokenUsage): string => {
  const parts = [`${t('agent.trace.newInput')} ${fmtTokens(u.inputTokens)}`];
  if (u.cacheReadTokens) parts.push(`${t('agent.trace.cacheRead')} ${fmtTokens(u.cacheReadTokens)}`);
  if (u.cacheWriteTokens) parts.push(`${t('agent.trace.cacheWrite')} ${fmtTokens(u.cacheWriteTokens)}`);
  parts.push(`${t('agent.trace.output')} ${fmtTokens(u.outputTokens)}`, `${t('agent.trace.budget')} ${fmtTokens(budgetTokens(u))}`);
  return parts.join(' · ');
};

/** 结束原因 → 文案 key 后缀 */
const STOP_KEY: Record<string, string> = {
  end_turn: 'endTurn',
  tool_use: 'toolUse',
  toolUse: 'toolUse',
  stop: 'endTurn',
  length: 'maxTokens',
  max_tokens: 'maxTokens',
  refusal: 'refusal',
  error: 'error',
  aborted: 'aborted',
  pause_turn: 'pause',
};
const stopName = (stop: string): string => (STOP_KEY[stop] ? t(`agent.trace.stop.${STOP_KEY[stop]}`) : stop);

interface Prefs {
  w?: number;
  collapsed?: boolean;
  raw?: boolean;
  filter?: string;
  /** 分栏模式下显示操作解读栏 */
  ops?: boolean;
  /** 操作解读栏宽度 */
  opsW?: number;
  /** 抽屉模式的当前页 */
  tab?: 'trace' | 'ops';
}
function loadPrefs(): Prefs {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') as Prefs;
  } catch {
    return {};
  }
}
function savePrefs(p: Prefs): void {
  try {
    const prev = loadPrefs();
    localStorage.setItem(PREF_KEY, JSON.stringify({ ...prev, ...p }));
  } catch {
    /* 隐私模式 */
  }
}

// ───────────────────────── 面板 ─────────────────────────

export function mountTracePanel(o: TracePanelOptions): TracePanelHandle {
  const { host, trace } = o;
  const embed = o.embed ?? null;
  let embedVisible = false;
  let embedView: 'trace' | 'ops' | 'split' = 'trace';
  let embedCompact = false;
  const prefs = loadPrefs();
  let live = o.live;
  let destroyed = false;
  let mode: 'column' | 'drawer' = 'drawer';
  /** 抽屉模式：是否打开 */
  let open = false;
  let collapsed = !!prefs.collapsed;
  let width = prefs.w ?? 380;
  let follow = true;
  let tickLimit: number | null = null;
  let filter = prefs.filter === 'thinking' || prefs.filter === 'tools' ? prefs.filter : 'all';
  let showRaw = !!prefs.raw;
  let query = '';
  const opsSrc = o.ops ?? null;
  let opsOn = prefs.ops !== false;
  let opsW = prefs.opsW ?? 300;
  let tab: 'trace' | 'ops' = prefs.tab === 'ops' ? 'ops' : 'trace';
  /** 'split' = 两栏（分栏模式）；'trace' / 'ops' = 只显示一边 */
  let view: 'split' | 'trace' | 'ops' = 'trace';

  const cards = new Map<number, Card>();
  const order: number[] = [];
  const dirty = new Set<Card>();
  let totalsDirty = true;
  let raf = 0;

  // ── DOM ──
  const liveDot = h('span.tr-live', { attrs: { 'aria-hidden': 'true' } });
  /** 静态文字：切换语言时整体重设 */
  const labels: (() => void)[] = [];
  const L = (fn: () => void): void => {
    labels.push(fn);
    fn();
  };
  const titleText = h('b');
  L(() => setText(titleText, t('agent.trace.title')));
  const title = h('div.tr-title', null, liveDot, titleText, o.subtitle ? h('small.muted', null, o.subtitle) : null);
  const followBtn = h<HTMLButtonElement>('button.btn.small.tr-follow', { attrs: { type: 'button', 'aria-pressed': 'true' } });
  L(() => setText(followBtn, t('agent.trace.follow')));
  followBtn.hidden = !live;
  const collapseBtn = h<HTMLButtonElement>(
    'button.btn.icon-btn.small.tr-collapse',
    { attrs: { type: 'button' } },
    h('span.gi', { html: G.close }),
  );
  const toolsBtn = h<HTMLButtonElement>('button.btn.small.tr-tools-btn', { attrs: { type: 'button', 'aria-expanded': 'false' } });
  L(() => setText(toolsBtn, t('agent.trace.filter')));
  const opsBtn = h<HTMLButtonElement>('button.btn.small.tr-ops-btn', { attrs: { type: 'button', 'aria-pressed': 'false' } });
  L(() => {
    setText(opsBtn, t('agent.ops.toggle'));
    opsBtn.title = t('agent.ops.toggleTip');
  });
  opsBtn.hidden = !opsSrc;
  const head = h('div.tr-head', null, title, h('div.tr-head-actions', null, opsBtn, toolsBtn, followBtn, collapseBtn));

  const totals = h('div.tr-totals');
  L(() => totals.setAttribute('aria-label', t('agent.trace.totals')));
  // 本局操作汇总（建造 / 拆除 / 升级 / 技能 / 被拒 / 花费 / 退款）
  const opsSum = h('div.tr-ops-sum');
  L(() => opsSum.setAttribute('aria-label', t('agent.ops.sumLabel')));
  opsSum.hidden = !opsSrc;
  // 抽屉（窄屏）：思路 | 操作 两页
  const tabBtn = (v: 'trace' | 'ops', key: string) => {
    const b = h<HTMLButtonElement>(`button.seg${tab === v ? '.on' : ''}`, {
      attrs: { type: 'button', role: 'tab', 'aria-selected': tab === v ? 'true' : 'false' },
      data: { v },
    });
    L(() => setText(b, t(key)));
    return b;
  };
  const tabs = h(
    'div.segs.tr-view-tabs',
    { attrs: { role: 'tablist' } },
    tabBtn('trace', 'agent.ops.tab.trace'),
    tabBtn('ops', 'agent.ops.tab.ops'),
  );
  L(() => tabs.setAttribute('aria-label', t('agent.ops.tabsLabel')));
  // 分栏：两栏的列标题 + 中间的拖动条（改操作解读栏宽度）
  const colTraceText = h('b');
  const colOpsText = h('b');
  L(() => {
    setText(colTraceText, t('agent.ops.colTrace'));
    setText(colOpsText, t('agent.ops.title'));
    colOpsText.title = t('agent.ops.hlHint');
  });
  const splitter = h('div.tr-splitter', { attrs: { role: 'separator', 'aria-orientation': 'vertical', tabindex: 0 } });
  L(() => splitter.setAttribute('aria-label', t('agent.ops.resizeCol')));
  const colHead = h(
    'div.tr-colhead',
    { attrs: { 'aria-hidden': 'false' } },
    h('div.tr-colhead-trace', null, colTraceText),
    splitter,
    h('div.tr-colhead-ops', null, colOpsText),
  );

  const segBtn = (v: string, key: string) => {
    const b = h<HTMLButtonElement>(`button.seg${filter === v ? '.on' : ''}`, {
      attrs: { type: 'button', 'aria-pressed': filter === v ? 'true' : 'false' },
      data: { v },
    });
    L(() => setText(b, t(key)));
    return b;
  };
  const filters = h(
    'div.segs.tr-filters',
    { attrs: { role: 'group' } },
    segBtn('all', 'agent.trace.filterAll'),
    segBtn('thinking', 'agent.trace.filterThinking'),
    segBtn('tools', 'agent.trace.filterTools'),
  );
  L(() => filters.setAttribute('aria-label', t('agent.trace.filter')));
  const rawToggle = h<HTMLInputElement>('input', { attrs: { type: 'checkbox' } });
  rawToggle.checked = showRaw;
  const rawText = h('span');
  L(() => setText(rawText, t('agent.trace.showRaw')));
  const rawLabel = h('label.tr-raw-toggle', null, rawToggle, rawText);
  const search = h<HTMLInputElement>('input.input.tr-search', { attrs: { type: 'search' } });
  L(() => {
    search.placeholder = t('agent.trace.searchPh');
    search.setAttribute('aria-label', t('agent.trace.search'));
  });
  const exportBtn = h<HTMLButtonElement>('button.btn.small.tr-export', { attrs: { type: 'button', 'aria-expanded': 'false' } });
  L(() => setText(exportBtn, t('agent.trace.exportAll')));
  const exportBox = h('div.tr-export-box');
  exportBox.hidden = true;
  const tools = h('div.tr-tools', null, filters, h('div.tr-tools-row', null, search, rawLabel, exportBtn), exportBox);

  const list = h('ol.tr-list', { attrs: { 'aria-live': 'off' } });
  const empty = h('p.tr-empty.muted');
  const paintEmpty = (): void =>
    setText(empty, query ? t('agent.trace.noMatch') : live ? t('agent.trace.emptyLive') : t('agent.trace.emptyDone'));
  L(paintEmpty);
  const scroller = h('div.tr-scroll', null, empty, list);
  const privacyText = h('span');
  L(() => setText(privacyText, t('agent.trace.privacy')));
  const privacy = h('p.tr-privacy', null, h('span.gi', { html: G.lock }), privacyText);

  const resizer = h('div.tr-resizer', { attrs: { role: 'separator', 'aria-orientation': 'vertical', tabindex: 0 } });
  L(() => resizer.setAttribute('aria-label', t('agent.trace.resize')));
  const railCount = h('span.tr-rail-count');
  const railText = h('span.tr-rail-text');
  const rail = h<HTMLButtonElement>(
    'button.tr-rail',
    { attrs: { type: 'button' } },
    h('span.tr-live', { attrs: { 'aria-hidden': 'true' } }),
    railText,
    railCount,
  );
  L(() => {
    rail.setAttribute('aria-label', t('agent.trace.expand'));
    setText(railText, t('agent.trace.title'));
  });

  const el = h(
    'section.tr-panel',
    { attrs: { role: 'complementary' }, data: { filter, raw: showRaw ? '1' : '0' } },
    resizer,
    rail,
    h('div.tr-inner', null, head, totals, opsSum, tools, tabs, colHead, scroller, privacy),
  );
  L(() => el.setAttribute('aria-label', t('agent.trace.title')));
  (embed ?? host).appendChild(el);

  const toggleText = h('span');
  L(() => setText(toggleText, t('agent.trace.toggle')));
  const toggle = h<HTMLButtonElement>(
    'button.tr-toggle',
    { attrs: { type: 'button', 'aria-pressed': 'false' } },
    h('span.tr-live', { attrs: { 'aria-hidden': 'true' } }),
    toggleText,
  );

  // ── 布局 ──
  const decideMode = (): 'column' | 'drawer' => {
    if (embed) return 'column';
    const r = host.getBoundingClientRect();
    if (r.width === 0) return mode;
    return r.width >= 960 && r.width / Math.max(1, r.height) >= 1.25 ? 'column' : 'drawer';
  };
  const clampW = (w: number): number => {
    const hw = host.getBoundingClientRect().width || 1200;
    return Math.round(Math.max(280, Math.min(w, Math.min(720, hw * 0.5))));
  };
  const clampOpsW = (w: number): number => {
    if (embed) {
      const ew = embed.getBoundingClientRect().width || 640;
      return Math.round(Math.max(200, Math.min(w, ew * 0.48)));
    }
    const hw = host.getBoundingClientRect().width || 1200;
    return Math.round(Math.max(220, Math.min(w, Math.min(560, hw * 0.3))));
  };
  /** 分栏且显示操作解读时，面板总宽 = 思路栏 + 操作栏 */
  const totalW = (): number => (view === 'split' ? width + opsW : width);
  const applyView = (): void => {
    if (embed) view = !opsSrc ? 'trace' : embedView === 'split' ? (opsOn ? 'split' : 'trace') : embedView;
    else view = !opsSrc ? 'trace' : mode === 'column' ? (opsOn ? 'split' : 'trace') : tab;
    el.dataset.view = view;
    opsBtn.hidden = !opsSrc || mode !== 'column' || (!!embed && embedView !== 'split');
    opsBtn.setAttribute('aria-pressed', opsOn ? 'true' : 'false');
    opsBtn.classList.toggle('on', opsOn);
    tabs.hidden = !opsSrc || mode === 'column' || !!embed;
    colHead.hidden = view !== 'split';
    for (const b of tabs.querySelectorAll<HTMLButtonElement>('button')) {
      const on = b.dataset.v === tab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    el.style.setProperty('--tr-ops-w', `${opsW}px`);
  };
  /** 分栏模式只有「展开 / 收成细边」两态；抽屉模式是「打开 / 关闭」 */
  const visible = (): boolean => (embed ? embedVisible : mode === 'column' ? !collapsed : open);

  const placeDrawer = (): void => {
    if (mode !== 'drawer' || !open) return;
    const a = o.anchor();
    const ar = a?.getBoundingClientRect();
    const portrait = window.innerWidth / Math.max(1, window.innerHeight) <= 1.1;
    el.dataset.side = portrait ? 'top' : 'left';
    if (!ar || ar.width < 50) {
      el.style.removeProperty('--tr-x');
      return;
    }
    el.style.setProperty('--tr-x', `${Math.round(ar.left)}px`);
    el.style.setProperty('--tr-y', `${Math.round(ar.top)}px`);
    el.style.setProperty('--tr-w', `${Math.round(portrait ? ar.width : Math.min(440, Math.max(280, ar.width * 0.72)))}px`);
    // 竖屏手机：盖住整个棋盘（底部的塔栏 / 技能 / 开波仍然露在外面）；棋盘太矮时至少 340px
    el.style.setProperty('--tr-h', `${Math.round(portrait ? Math.max(340, ar.height) : ar.height)}px`);
  };

  const applyLayout = (): void => {
    if (embed) {
      mode = 'column';
      el.dataset.mode = 'embed';
      el.dataset.compact = embedCompact ? '1' : '0';
      el.dataset.open = embedVisible ? '1' : '0';
      el.hidden = false;
      collapseBtn.hidden = true;
      applyView();
      opsW = clampOpsW(opsW);
      el.style.setProperty('--tr-ops-w', `${opsW}px`);
      if (visible()) schedule();
      return;
    }
    mode = decideMode();
    el.dataset.mode = mode;
    el.dataset.open = visible() ? '1' : '0';
    el.dataset.collapsed = mode === 'column' && collapsed ? '1' : '0';
    host.dataset.traceMode = mode;
    applyView();
    if (mode === 'column') {
      width = clampW(width);
      opsW = clampOpsW(opsW);
      el.style.setProperty('--tr-ops-w', `${opsW}px`);
      host.style.setProperty('--trace-w', `${totalW()}px`);
      host.style.setProperty('--trace-occupy', collapsed ? '40px' : `${totalW()}px`);
    } else {
      host.style.setProperty('--trace-occupy', '0px');
      placeDrawer();
    }
    el.hidden = mode === 'drawer' && !open;
    toggle.setAttribute('aria-pressed', visible() ? 'true' : 'false');
    toggle.classList.toggle('on', visible());
    collapseBtn.setAttribute('aria-label', mode === 'column' ? t('agent.trace.collapse') : t('agent.trace.closePanel'));
    if (visible()) schedule();
  };
  mode = decideMode();
  open = o.initialOpen ?? false;
  if (o.initialOpen === true) collapsed = false;

  const setOpen = (v: boolean): void => {
    if (mode === 'column') collapsed = !v;
    else open = v;
    savePrefs({ w: width, collapsed, raw: showRaw, filter });
    applyLayout();
    o.onOpenChange?.(visible(), mode);
    if (visible()) {
      for (const c of cards.values()) dirty.add(c);
      totalsDirty = true;
      schedule(true);
    }
  };

  toggle.onclick = () => {
    audio.play('click');
    setOpen(!visible());
  };
  collapseBtn.onclick = () => {
    audio.play('click');
    setOpen(false);
    if (mode === 'drawer') toggle.focus({ preventScroll: true });
  };
  rail.onclick = () => {
    audio.play('click');
    setOpen(true);
  };

  // 拖动改宽（指针 / 键盘 ←→）
  resizer.addEventListener('pointerdown', (e) => {
    if (mode !== 'column') return;
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const w0 = width;
    el.classList.add('resizing');
    const move = (ev: PointerEvent): void => {
      width = clampW(w0 + (x0 - ev.clientX));
      host.style.setProperty('--trace-w', `${totalW()}px`);
      host.style.setProperty('--trace-occupy', `${totalW()}px`);
    };
    const up = (): void => {
      resizer.removeEventListener('pointermove', move);
      resizer.removeEventListener('pointerup', up);
      resizer.removeEventListener('pointercancel', up);
      el.classList.remove('resizing');
      savePrefs({ w: width, collapsed, raw: showRaw, filter });
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', up);
    resizer.addEventListener('pointercancel', up);
  });
  resizer.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    width = clampW(width + (e.key === 'ArrowLeft' ? 24 : -24));
    applyLayout();
    savePrefs({ w: width, collapsed, raw: showRaw, filter });
  });

  // 两栏中间的拖动条：总宽不变，左右两栏此消彼长
  splitter.addEventListener('pointerdown', (e) => {
    if (view !== 'split') return;
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const o0 = opsW;
    const tot = width + opsW;
    el.classList.add('resizing');
    const move = (ev: PointerEvent): void => {
      opsW = clampOpsW(o0 + (x0 - ev.clientX));
      width = Math.max(280, tot - opsW);
      el.style.setProperty('--tr-ops-w', `${opsW}px`);
      host.style.setProperty('--trace-w', `${totalW()}px`);
      host.style.setProperty('--trace-occupy', `${totalW()}px`);
    };
    const up = (): void => {
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
      splitter.removeEventListener('pointercancel', up);
      el.classList.remove('resizing');
      savePrefs({ w: width, opsW });
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
    splitter.addEventListener('pointercancel', up);
  });
  splitter.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    const d = e.key === 'ArrowLeft' ? 24 : -24;
    const tot = width + opsW;
    opsW = clampOpsW(opsW + d);
    width = Math.max(280, tot - opsW);
    applyLayout();
    savePrefs({ w: width, opsW });
  });
  opsBtn.onclick = () => {
    audio.play('click');
    opsOn = !opsOn;
    savePrefs({ ops: opsOn });
    applyLayout();
    markAllOps();
  };
  tabs.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-v]');
    if (!b) return;
    audio.play('click');
    tab = b.dataset.v === 'ops' ? 'ops' : 'trace';
    savePrefs({ tab });
    applyView();
    markAllOps();
  });
  tabs.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    tab = tab === 'ops' ? 'trace' : 'ops';
    savePrefs({ tab });
    applyView();
    markAllOps();
    tabs.querySelector<HTMLButtonElement>(`button[data-v="${tab}"]`)?.focus();
  });
  const markAllOps = (): void => {
    for (const c of cards.values()) {
      c.opsDirty = true;
      dirty.add(c);
    }
    totalsDirty = true;
    if (visible()) schedule();
  };

  const ro = new ResizeObserver(() => applyLayout());
  ro.observe(embed ?? host);
  const onWinResize = (): void => placeDrawer();
  window.addEventListener('resize', onWinResize);

  // 面板里的按键不要触发游戏快捷键
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mode === 'drawer' && !embed) {
      setOpen(false);
      toggle.focus({ preventScroll: true });
    }
    e.stopPropagation();
  });

  // ── 工具栏 ──
  filters.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-v]');
    if (!b) return;
    audio.play('click');
    filter = b.dataset.v!;
    for (const x of filters.querySelectorAll<HTMLButtonElement>('button')) {
      x.classList.toggle('on', x === b);
      x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
    }
    el.dataset.filter = filter;
    savePrefs({ w: width, collapsed, raw: showRaw, filter });
  });
  rawToggle.onchange = () => {
    showRaw = rawToggle.checked;
    el.dataset.raw = showRaw ? '1' : '0';
    savePrefs({ w: width, collapsed, raw: showRaw, filter });
  };
  let searchT = 0;
  search.oninput = () => {
    clearTimeout(searchT);
    searchT = window.setTimeout(() => {
      query = search.value.trim().toLowerCase();
      applySearch();
    }, 150);
  };
  // 抽屉模式下工具栏默认收起（屏幕小），点「筛选」展开
  toolsBtn.onclick = () => {
    audio.play('click');
    const on = el.dataset.tools !== '1';
    el.dataset.tools = on ? '1' : '0';
    toolsBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
    toolsBtn.classList.toggle('on', on);
  };
  followBtn.onclick = () => {
    audio.play('click');
    follow = !follow;
    followBtn.setAttribute('aria-pressed', follow ? 'true' : 'false');
    followBtn.classList.toggle('on', follow);
    if (follow) scrollToEnd();
  };
  followBtn.classList.add('on');
  // 只有用户自己滚动（滚轮 / 触摸 / 拖滚动条 / 键盘）才会取消「跟随最新」；内容折叠、展开引起的滚动不算
  let userScrollAt = 0;
  const intent = (): void => {
    userScrollAt = Date.now();
  };
  for (const ev of ['wheel', 'touchmove', 'pointerdown', 'keydown']) scroller.addEventListener(ev, intent, { passive: true });
  scroller.addEventListener(
    'scroll',
    () => {
      if (!live) return;
      const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
      if (follow && !atEnd && !autoScrolling && Date.now() - userScrollAt < 1000) {
        follow = false;
        followBtn.setAttribute('aria-pressed', 'false');
        followBtn.classList.remove('on');
      } else if (!follow && atEnd) {
        follow = true;
        followBtn.setAttribute('aria-pressed', 'true');
        followBtn.classList.add('on');
      }
    },
    { passive: true },
  );
  let autoScrolling = false;
  const scrollToEnd = (): void => {
    autoScrolling = true;
    scroller.scrollTop = scroller.scrollHeight;
    requestAnimationFrame(() => (autoScrolling = false));
  };

  exportBtn.onclick = () => {
    audio.play('click');
    exportBox.hidden = !exportBox.hidden;
    exportBtn.setAttribute('aria-expanded', exportBox.hidden ? 'false' : 'true');
    if (!exportBox.hidden) buildExport();
  };
  const buildExport = (): void => {
    const prev = exportBox.dataset.url;
    if (prev) URL.revokeObjectURL(prev);
    const tx = trace.export();
    const keep = new Set(tx.events.map((e) => e.d));
    const json = JSON.stringify(opsSrc ? { ...tx, ops: opsSrc.export((d) => keep.has(d)) } : tx, null, 2);
    const kb = Math.max(1, Math.round(json.length / 1024));
    const status = h('small.muted', { attrs: { role: 'status' } });
    const name = `desk-defense-ai-trace-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
    let url: string;
    try {
      url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    } catch {
      url = '';
    }
    const dl = url
      ? h(
          'a.btn.small.primary',
          { attrs: { href: url, download: name }, onclick: () => setTimeout(() => setText(status, t('agent.trace.dlHint')), 400) },
          t('agent.trace.download'),
        )
      : null;
    const cp = h<HTMLButtonElement>(
      'button.btn.small',
      {
        attrs: { type: 'button' },
        onclick: async () => {
          const ok = await copyText(json);
          setText(status, ok ? t('agent.trace.clipOk') : t('agent.trace.clipFailed'));
        },
      },
      t('agent.trace.copyToClip'),
    );
    fill(
      exportBox,
      h(
        'div.tr-export-row',
        null,
        dl,
        cp,
        h(
          'small.muted',
          null,
          `${kb} KB · ${t('agent.trace.events', { n: trace.events().length })}${trace.dropped ? ` · ${t('agent.trace.droppedN', { n: trace.dropped })}` : ''}`,
        ),
      ),
      status,
    );
    exportBox.dataset.url = url;
  };

  // ── 渲染 ──
  const schedule = (now = false): void => {
    if (destroyed || raf) return;
    if (now) {
      flush();
      return;
    }
    raf = requestAnimationFrame(() => {
      raf = 0;
      flush();
    });
  };

  const cardFor = (d: number): Card => {
    let c = cards.get(d);
    if (!c) {
      c = newCard(d);
      cards.set(d, c);
      order.push(d);
      // 丢最旧的卡片
      while (order.length > MAX_CARDS) {
        const old = cards.get(order.shift()!);
        if (old) {
          old.el?.remove();
          cards.delete(old.d);
          dirty.delete(old);
        }
      }
    }
    return c;
  };

  const addSearch = (c: Card, s: string): void => {
    if (c.search.length < 20_000) c.search += ` ${s.toLowerCase().slice(0, 4000)}`;
  };

  const ingest = (e: TraceEvent): void => {
    const c = cardFor(e.d);
    switch (e.k) {
      case 'decision_start':
        c.start = e;
        c.dirtyHead = true;
        addSearch(c, `${e.trigger.map((r) => reasonName(r) ?? r).join(' ')} ${e.provider} ${e.model}`);
        break;
      case 'request': {
        const s: Seg = { kind: 'req', n: e.n, ev: e, raw: e.raw, rawChars: e.rawChars, dirty: true };
        c.reqs.set(e.n, s);
        c.segs.push(s);
        c.pending.push(s);
        break;
      }
      case 'request_raw': {
        const r = c.reqs.get(e.n);
        if (r) {
          r.raw = e.raw;
          r.rawChars = e.rawChars;
          r.dirty = true;
        }
        break;
      }
      case 'thinking':
      case 'text': {
        const last = c.segs[c.segs.length - 1];
        if (last && last.kind === e.k && last.n === e.n) {
          last.total += e.text.length;
          if (last.text.length < LIVE_TEXT_CHARS * 4) last.text += e.text;
          last.dirty = true;
        } else {
          const s: Seg = { kind: e.k, n: e.n, text: e.text, total: e.text.length, dirty: true };
          c.segs.push(s);
          c.pending.push(s);
        }
        addSearch(c, e.text);
        break;
      }
      case 'tool_call': {
        const s: Extract<Seg, { kind: 'tool' }> = { kind: 'tool', call: e, dirty: true };
        c.tools.set(e.id, s);
        c.segs.push(s);
        c.pending.push(s);
        addSearch(c, `${e.name} ${argsLine(e.args)}`);
        break;
      }
      case 'tool_result': {
        const s = c.tools.get(e.id);
        if (s) {
          s.result = e;
          s.dirty = true;
        }
        addSearch(c, `${e.text} ${e.effect ?? ''}`);
        break;
      }
      case 'response': {
        const s: Seg = { kind: 'resp', ev: e, dirty: true };
        c.segs.push(s);
        c.pending.push(s);
        c.usage = {
          ...c.usage,
          inputTokens: c.usage.inputTokens + e.usage.inputTokens,
          outputTokens: c.usage.outputTokens + e.usage.outputTokens,
          cacheReadTokens: c.usage.cacheReadTokens + e.usage.cacheReadTokens,
          cacheWriteTokens: c.usage.cacheWriteTokens + e.usage.cacheWriteTokens,
          requests: c.usage.requests + 1,
        };
        c.cost += e.costUsd ?? 0;
        c.latency += e.ms;
        c.dirtyHead = true;
        break;
      }
      case 'compact': {
        const s: Seg = { kind: 'compact', ev: e, dirty: true };
        c.segs.push(s);
        c.pending.push(s);
        addSearch(c, `${t('agent.trace.compactSearch')} ${e.reason}`);
        break;
      }
      case 'error':
      case 'fallback': {
        const s = (e.k === 'error' ? { kind: 'error', ev: e, dirty: true } : { kind: 'fallback', ev: e, dirty: true }) as Seg;
        c.segs.push(s);
        c.pending.push(s);
        addSearch(c, e.k === 'error' ? e.message : e.reason);
        break;
      }
      case 'decision_end':
        c.end = e;
        c.dirtyHead = true;
        if (e.note) addSearch(c, e.note);
        break;
      case 'instruction':
        c.instr = e.items.map((x) => ({ ...x }));
        c.dirtyHead = true;
        addSearch(c, `${t('agent.dock.instrTag')} ${e.items.map((x) => x.text).join(' ')}`);
        break;
      case 'instruction_ack':
        for (const a of e.items) {
          const x = c.instr?.find((i) => i.id === a.id);
          if (x) {
            x.ack = a.ack;
            x.code = a.code;
          }
        }
        c.dirtyHead = true;
        break;
    }
    dirty.add(c);
    totalsDirty = true;
  };

  // 已有的事件（回放 / 面板晚于控制器挂载 / 换模型后重挂）
  for (const e of trace.events()) ingest(e);
  const unsub = trace.subscribe((e) => {
    if (destroyed) return;
    ingest(e);
    if (visible()) schedule();
    else if (mode === 'column' && collapsed) scheduleRail();
  });
  const unsubOps = opsSrc
    ? opsSrc.subscribe((d) => {
        if (destroyed) return;
        const c = cards.get(d);
        if (c) {
          c.opsDirty = true;
          c.dirtyHead = true;
          dirty.add(c);
        }
        totalsDirty = true;
        if (visible()) schedule();
      })
    : () => {};
  let railRaf = 0;
  const scheduleRail = (): void => {
    if (railRaf) return;
    railRaf = requestAnimationFrame(() => {
      railRaf = 0;
      setText(railCount, String(cards.size));
    });
  };

  const tickOf = (c: Card): number => c.start?.tick ?? 0;
  const shownByTick = (c: Card): boolean => tickLimit === null || tickOf(c) <= tickLimit;

  const renderHead = (c: Card): void => {
    if (!c.head) return;
    const s = c.start;
    const e = c.end;
    const reasons = s ? s.trigger.map((r) => reasonName(r) ?? r).join(t('agent.trace.listSep')) : t('agent.trace.droppedEarlier');
    const running = live && !e;
    const tokens = budgetTokens(c.usage);
    fill(
      c.head,
      h('span.tr-d', null, `#${c.d}`),
      h('b', null, s ? t('agent.trace.wave', { n: Math.max(1, s.wave) }) : '—'),
      h('span.tr-reasons', null, reasons),
      running ? h('span.tr-running', null, h('span.ai-spinner'), t('agent.trace.running')) : null,
      e?.by === 'fallback' ? h('span.badge.ai-bot-badge', null, t('agent.trace.bot')) : null,
      s?.skipped ? h('span.badge.tr-skip-badge', { attrs: { title: s.skipped } }, t('agent.trace.skipped')) : null,
      s?.delta ? h('span.badge.tr-delta-badge', { attrs: { title: t('agent.trace.deltaTip') } }, t('agent.trace.delta')) : null,
      opsBadge(c),
      c.instr?.some((x) => x.kind === 'once')
        ? h('span.badge.tr-instr-badge', null, t('agent.dock.instrBadge', { n: c.instr.filter((x) => x.kind === 'once').length }))
        : null,
      h(
        'span.tr-head-meta.muted',
        null,
        [
          e ? fmtMs(e.ms) : c.latency ? fmtMs(c.latency) : '',
          tokens ? `${t('agent.trace.budget')} ${fmtTokens(tokens)}` : '',
          c.cost ? fmtCost(c.cost) : '',
        ]
          .filter(Boolean)
          .join(' · '),
      ),
    );
    c.el?.classList.toggle('by-bot', e?.by === 'fallback');
    c.el?.classList.toggle('running', running);
  };

  /** 卡片标题上的操作数（「操作」页 / 折叠卡片也看得到这次决策做了多少事） */
  const opsBadge = (c: Card): HTMLElement | null => {
    const d = opsSrc?.get(c.d);
    if (!d) return null;
    let n = 0;
    let bad = 0;
    for (const g of d.groups)
      for (const op of g.ops)
        if (op.k !== 'end') {
          if (op.ok) n++;
          else bad++;
        }
    if (!n && !bad) return null;
    return h(
      `span.badge.tr-ops-badge${bad ? '.has-bad' : ''}`,
      null,
      [n ? t('agent.ops.count', { n }) : '', bad ? t('agent.ops.countRejected', { n: bad }) : ''].filter(Boolean).join(' · '),
    );
  };

  const cellsAttr = (cells: readonly Cell[] | undefined): string | null =>
    cells?.length
      ? cells
          .slice(0, 64)
          .map((x) => `${x.x},${x.y}`)
          .join(';')
      : null;

  /**
   * 操作 / 意图组涉及的路线 → data-route（"*" = 全部开放路线；"north,drop-3"；带 "|air" = 同时画飞行线）。
   * 来源：意图参数 route / target / near（route、route:<id>、air、airline:<id>），maze / rebuild_maze / anti_air 意图，
   * 施法 / 拆除的出生点。
   */
  const routeAttr = (args: Record<string, unknown> | undefined, intent: string | undefined, ops: readonly Op[]): string | null => {
    const ids = new Set<string>();
    let all = false;
    let air = false;
    const ref = (v: unknown): void => {
      if (typeof v !== 'string') return;
      const m = /^(route|airline)(?::(.+))?$/.exec(v);
      if (m) {
        if (m[1] === 'airline') air = true;
        if (m[2]) ids.add(m[2]);
        else all = true;
      } else if (v === 'air') {
        air = true;
        all = true;
      }
    };
    if (args) {
      if (typeof args.route === 'string' && args.route) ids.add(args.route);
      ref(args.target);
      ref(args.near);
    }
    if (intent === 'maze' || intent === 'rebuild_maze') {
      if (!ids.size) all = true;
    } else if (intent === 'anti_air') {
      air = true;
      if (!ids.size) all = true;
    }
    for (const op of ops) if (op.spawner) ids.add(op.spawner);
    if (!all && !ids.size) return null;
    return `${all ? '*' : [...ids].join(',')}${air ? '|air' : ''}`;
  };

  /** 玩家指令块：「玩家指令」+ 每条指令与 AI 的回应（思路页在卡片顶部，操作页在操作列表上方） */
  const instrBlock = (c: Card): HTMLElement | null => {
    if (!c.instr?.length) return null;
    const running = live && !c.end;
    return h(
      'div.tr-instr',
      null,
      h('span.tr-tag.tr-instr-tag', null, t('agent.dock.instrTag')),
      h(
        'ul.tr-instr-list',
        null,
        c.instr.map((x) => {
          const ack =
            x.kind === 'standing'
              ? t('agent.dock.standingTag')
              : (x.ack ?? (x.code ? t(`agent.dock.ack.${x.code}`) : running ? t('agent.dock.ack.pending') : t('agent.dock.ack.noReply')));
          const bad = !!x.ack && /无法|cannot|can't|できない|無法/i.test(x.ack);
          return h(
            `li.k-${x.kind}`,
            null,
            h('b.tr-instr-id', null, `P${x.id}${x.kind === 'once' ? '!' : ''}`),
            h('span.tr-instr-text', null, x.text),
            h(`small.tr-instr-ack${x.ack ? (bad ? '.no' : '.ok') : '.muted'}`, null, x.kind === 'once' && x.ack ? `→ ${ack}` : ack),
          );
        }),
      ),
    );
  };
  const renderInstr = (c: Card): void => {
    if (!c.instrEl) return;
    const b = instrBlock(c);
    if (b) c.instrEl.replaceChildren(b);
    else c.instrEl.replaceChildren();
  };

  /** 操作解读：这次决策的全部操作（按意图分组） */
  const renderOps = (c: Card): void => {
    c.opsDirty = false;
    const box = c.opsEl;
    if (!box) return;
    if (view === 'trace') {
      // 不显示时不渲染（切过来时 markAllOps 会补）
      c.opsDirty = true;
      return;
    }
    const d: DecisionOps | undefined = opsSrc?.get(c.d);
    const groups = d?.groups.filter((g) => g.ops.length || g.kind === 'intent') ?? [];
    if (!groups.length) {
      const running = live && !c.end;
      fill(
        box,
        h('div.tr-ops-inner', null, instrBlock(c), h('p.tr-ops-empty.muted', null, running ? t('agent.ops.running') : t('agent.ops.none'))),
      );
      return;
    }
    const out: HTMLElement[] = [];
    // 玩家指令放在最上面：下面的操作就是 AI 这次为它（和自己的计划）做的事
    const ib = instrBlock(c);
    if (ib) out.push(ib);
    for (const g of groups) {
      const items = g.ops.map((op) => {
        const gold = opGold(op);
        const cells = cellsAttr(op.cells);
        const route = op.spawner ? routeAttr(undefined, undefined, [op]) : null;
        const li = h(
          `li.tr-op.k-${op.k}${op.ok ? '' : '.bad'}`,
          {
            attrs: {
              ...(cells || route ? { tabindex: 0 } : {}),
              ...(cells ? { 'data-cells': cells } : {}),
              ...(route ? { 'data-route': route } : {}),
            },
          },
          h('span.gi', { html: G[opIcon(op) as keyof typeof G] ?? G.list }),
          h('span.tr-op-text', null, opLine(op)),
          gold ? h(`span.tr-op-gold${op.gold! < 0 ? '.spend' : '.gain'}`, null, gold) : null,
        );
        if (!op.ok && op.reason && op.code) li.title = op.reason;
        return li;
      });
      const titleText = groupTitle(g);
      const sum = groupSummary(g);
      const allCells = cellsAttr(g.ops.flatMap((op) => (op.ok ? (op.cells ?? []) : [])));
      const gRoute = routeAttr(g.args, g.intent, g.ops);
      const gh = titleText
        ? h(
            `div.tr-opg-head${g.noop ? '.noop' : ''}`,
            {
              attrs: {
                ...(allCells || gRoute ? { tabindex: 0 } : {}),
                ...(allCells ? { 'data-cells': allCells } : {}),
                ...(gRoute ? { 'data-route': gRoute } : {}),
              },
            },
            h('b', null, titleText),
            sum ? h('span.tr-opg-sum', null, ` → ${sum}`) : null,
          )
        : null;
      if (gh && g.text) gh.title = g.text;
      out.push(h(`div.tr-opg.kind-${g.kind}`, null, gh, items.length ? h('ol.tr-op-list', null, items) : null));
    }
    fill(box, h('div.tr-ops-inner', null, out));
  };

  const renderFoot = (c: Card): void => {
    if (!c.foot) return;
    const s = c.start;
    const e = c.end;
    const parts: HTMLElement[] = [];
    if (s?.skipped) parts.push(h('p.tr-sum', null, t('agent.trace.skippedSum', { reason: s.skipped })));
    else if (e) {
      parts.push(
        h(
          'p.tr-sum',
          null,
          `${t('agent.trace.toolCalls', { n: e.toolCalls })} · ${t('agent.trace.requestsN', { n: c.usage.requests })} · ${usageLine(c.usage)}${c.cost ? ` · ${fmtCost(c.cost)}` : ''} · ${t('agent.trace.took', { time: fmtMs(e.ms) })}`,
          e.note ? h('span.tr-note', null, ` · ${t('agent.trace.note', { note: e.note })}`) : null,
        ),
      );
    }
    const extras = h('div.tr-extra');
    if (s && !s.skipped) {
      extras.append(
        lazyDetails('tr-obs', t('agent.trace.obs'), () =>
          codeBlock(t('agent.trace.obsLabel'), () => trace.blob(s.observationHash) ?? t('agent.trace.droppedBuf')),
        ),
        lazyDetails('tr-sys', t('agent.trace.sys'), () => {
          const sysReq = [...c.reqs.values()].find((r) => r.ev.systemHash && r.ev.systemHash !== s.systemHash);
          const box = h(
            'div.tr-stack',
            null,
            codeBlock(`${t('agent.trace.sys')} · ${s.systemHash ?? ''}`, () => trace.blob(s.systemHash) ?? t('agent.trace.droppedBuf')),
          );
          if (sysReq)
            box.appendChild(
              codeBlock(
                `${t('agent.trace.sysActual')} · ${sysReq.ev.systemHash}`,
                () => trace.blob(sysReq.ev.systemHash) ?? t('agent.trace.dropped'),
              ),
            );
          return box;
        }),
        lazyDetails('tr-tooldefs', t('agent.trace.toolDefs', { n: s.toolNames?.length ?? 0 }), () =>
          h(
            'div.tr-stack',
            null,
            h('p.tr-chips', null, ...(s.toolNames ?? []).map((n) => h('code.tr-chip', null, n))),
            codeBlock(t('agent.trace.toolDefsJson'), () => trace.blob(s.toolsHash) ?? t('agent.trace.dropped'), { lang: 'json' }),
          ),
        ),
      );
    }
    fill(c.foot, ...parts, extras);
  };

  const renderSeg = (c: Card, s: Seg): void => {
    if (!s.el) {
      s.el = h(`li.tr-seg.tr-${s.kind === 'req' ? 'req' : s.kind === 'resp' ? 'resp' : s.kind}`);
      c.body!.appendChild(s.el);
    }
    const el = s.el;
    switch (s.kind) {
      case 'req': {
        const r = s.ev;
        const meta = [
          providerLabel(r.provider),
          r.model,
          r.api,
          r.host ? `→ ${r.host}` : '',
          r.thinking ? t('agent.trace.thinkingMeta', { v: r.thinking }) : r.effort ? `effort ${r.effort}` : '',
          r.messages ? t('agent.trace.messages', { n: r.messages }) : '',
          r.compacted ? t('agent.trace.compactedOld', { n: r.compacted }) : '',
        ]
          .filter(Boolean)
          .join(' · ');
        fill(
          el,
          h('div.tr-req-line', null, h('span.tr-tag', null, t('agent.trace.request', { n: r.n })), h('span.muted', null, meta)),
          r.thinkingNote ? h('p.tr-effect', null, r.thinkingNote) : null,
          r.params
            ? h(
                'p.tr-params',
                null,
                Object.entries(r.params)
                  .filter(([, v]) => v !== undefined && v !== null)
                  .map(([k, v]) => h('code.tr-chip.tr-param', null, `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)),
              )
            : null,
          h(
            'div.tr-rawonly',
            null,
            r.headers
              ? lazyDetails('tr-hdr', t('agent.trace.headers'), () =>
                  codeBlock(t('agent.trace.headersLabel'), () => JSON.stringify(r.headers, null, 2), { lang: 'json' }),
                )
              : null,
            lazyDetails(
              'tr-rawreq',
              `${t('agent.trace.rawReq')}${s.rawChars ? t('agent.trace.charsParen', { count: fmtNumber(s.rawChars) }) : ''}`,
              () =>
                codeBlock(t('agent.trace.rawReq'), () => prettyJson(s.raw), { lang: 'json', copyText: () => trace.inflate(s.raw ?? '') }),
            ),
          ),
        );
        break;
      }
      case 'thinking':
      case 'text': {
        let body = el.querySelector<HTMLElement>('.tr-txt');
        if (!body) {
          fill(
            el,
            h('span.tr-tag', null, s.kind === 'thinking' ? t('agent.trace.thinkingTag') : t('agent.trace.replyTag')),
            (body = h('div.tr-txt')),
          );
        }
        const txt = s.text.length > LIVE_TEXT_CHARS ? `…${s.text.slice(-LIVE_TEXT_CHARS)}` : s.text;
        setText(body, txt);
        if (s.total > s.text.length && !el.querySelector('.tr-cut'))
          el.appendChild(h('small.muted.tr-cut', null, t('agent.trace.truncated')));
        break;
      }
      case 'tool': {
        const r = s.result;
        const cls = r ? (r.ok ? 'ok' : 'bad') : 'pending';
        el.className = `tr-seg tr-tool ${cls}`;
        const chip = h(
          'span.tr-toolchip',
          null,
          h('span.gi', { html: r ? (r.ok ? G.check : G.close) : G.hourglass }),
          h('b', null, s.call.name),
          h('code', null, argsLine(s.call.args)),
        );
        fill(
          el,
          chip,
          r
            ? h('p.tr-result', null, r.text.length > 400 ? `${r.text.slice(0, 400)}…` : r.text)
            : h('p.tr-result.muted', null, t('agent.trace.toolRunning')),
          r?.effect ? h('p.tr-effect', null, r.effect) : null,
          h(
            'div.tr-rawonly',
            null,
            lazyDetails('tr-toolraw', t('agent.trace.toolRaw'), () =>
              codeBlock(t('agent.trace.toolCall'), () => JSON.stringify({ call: s.call, result: r }, null, 2), { lang: 'json' }),
            ),
          ),
        );
        const cell =
          r?.cell ??
          (s.call.args && typeof s.call.args === 'object' && typeof (s.call.args as { x?: unknown }).x === 'number'
            ? { x: (s.call.args as { x: number }).x, y: (s.call.args as { y: number }).y }
            : undefined);
        if (cell && o.onHighlight) {
          el.dataset.cell = `${cell.x},${cell.y}`;
          el.tabIndex = 0;
        }
        break;
      }
      case 'resp': {
        const r = s.ev;
        fill(
          el,
          h(
            'div.tr-req-line',
            null,
            h('span.tr-tag', null, t('agent.trace.response', { n: r.n })),
            h(
              'span.muted',
              null,
              [r.stop ? `${stopName(r.stop)} (${r.stop})` : '', usageLine(r.usage), fmtMs(r.ms), r.costUsd ? fmtCost(r.costUsd) : '']
                .filter(Boolean)
                .join(' · '),
            ),
          ),
          h(
            'div.tr-rawonly',
            null,
            lazyDetails(
              'tr-rawresp',
              `${t('agent.trace.rawResp')}${r.rawChars ? t('agent.trace.charsParen', { count: fmtNumber(r.rawChars) }) : ''}`,
              () => codeBlock(t('agent.trace.rawResp'), () => prettyJson(r.raw), { lang: 'json' }),
            ),
          ),
        );
        break;
      }
      case 'error':
        fill(el, h('span.gi', { html: G.warn }), h('span', null, t('agent.trace.error', { msg: s.ev.message })));
        break;
      case 'compact':
        fill(
          el,
          h('span.gi', { html: G.bolt }),
          h('span', null, t('agent.trace.compacted', { n: s.ev.n, before: s.ev.before, after: s.ev.after })),
          s.ev.reason ? h('small.muted', null, ` · ${s.ev.reason}`) : null,
        );
        break;
      case 'fallback':
        fill(
          el,
          h('span.gi', { html: G.bolt }),
          h(
            'span',
            null,
            s.ev.acted ? t('agent.trace.botTook', { reason: s.ev.reason }) : t('agent.trace.noResult', { reason: s.ev.reason }),
          ),
          s.ev.effect ? h('small.muted', null, ` → ${s.ev.effect}`) : null,
        );
        break;
    }
    s.dirty = false;
  };

  const buildCard = (c: Card): void => {
    c.head = h('div.tr-card-head');
    c.el = h(`li.tr-card${c.full ? '' : '.folded'}`, { data: { d: String(c.d) } }, c.head);
    if (c.full) {
      c.body = h('ol.tr-body');
      c.foot = h('div.tr-foot');
      c.opsEl = opsSrc ? h('div.tr-ops') : undefined;
      c.instrEl = h('div.tr-instr-slot');
      c.el.append(
        opsSrc
          ? h('div.tr-card-cols', null, h('div.tr-card-main', null, c.instrEl, c.body, c.foot), c.opsEl)
          : h('div.tr-card-main', null, c.instrEl, c.body, c.foot),
      );
      renderInstr(c);
      for (const s of c.segs) {
        s.el = undefined;
        renderSeg(c, s);
      }
      renderFoot(c);
      renderOps(c);
    } else {
      c.body = undefined;
      c.foot = undefined;
      c.opsEl = undefined;
      c.instrEl = undefined;
      for (const s of c.segs) s.el = undefined;
    }
    c.pending = [];
    renderHead(c);
    c.dirtyHead = false;
    c.el.hidden = !shownByTick(c) || !matches(c);
    // 按顺序插入
    const idx = order.indexOf(c.d);
    let next: Element | null = null;
    for (let i = idx + 1; i < order.length; i++) {
      const n = cards.get(order[i])?.el;
      if (n?.isConnected) {
        next = n;
        break;
      }
    }
    list.insertBefore(c.el, next);
  };

  const fold = (c: Card): void => {
    if (!c.full || c.pinned) return;
    c.full = false;
    c.el?.remove();
    c.el = undefined;
    buildCard(c);
  };

  list.addEventListener('click', (e) => {
    const tg = e.target as HTMLElement;
    const head = tg.closest('.tr-card-head');
    const li = tg.closest<HTMLElement>('.tr-card');
    if (!head || !li) return;
    const c = cards.get(Number(li.dataset.d));
    if (!c) return;
    audio.play('click');
    c.full = !c.full;
    c.pinned = c.full;
    c.el?.remove();
    c.el = undefined;
    buildCard(c);
  });
  // 悬停工具调用 → 棋盘高亮
  const hl = (e: Event, on: boolean): void => {
    if (!o.onHighlight) return;
    const seg = (e.target as HTMLElement).closest<HTMLElement>('.tr-tool[data-cell]');
    if (!seg) return;
    if (!on) {
      o.onHighlight(null);
      return;
    }
    const [x, y] = seg.dataset.cell!.split(',').map(Number);
    o.onHighlight({ x, y });
  };
  // 悬停 / 聚焦一条操作（或意图组头）→ 棋盘上标出它涉及的全部格子
  const hlOps = (e: Event, on: boolean): boolean => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.tr-ops [data-cells], .tr-ops [data-route]');
    if (!row) return false;
    if (o.onHighlightRoute) {
      const r = on ? row.dataset.route : undefined;
      if (r) {
        const [ids, air] = r.split('|');
        o.onHighlightRoute({ ids: ids === '*' ? null : ids.split(','), air: air === 'air' });
      } else o.onHighlightRoute(null);
    }
    if (!row.dataset.cells) {
      if (o.onHighlightCells) o.onHighlightCells(null);
      else o.onHighlight?.(null);
      return true;
    }
    const cells = on
      ? row.dataset.cells.split(';').map((p) => {
          const [x, y] = p.split(',').map(Number);
          return { x, y };
        })
      : null;
    if (o.onHighlightCells) o.onHighlightCells(cells);
    else o.onHighlight?.(cells ? cells[0] : null);
    return true;
  };
  const onOver = (e: Event, on: boolean): void => {
    if (hlOps(e, on)) return;
    hl(e, on);
  };
  list.addEventListener('mouseover', (e) => onOver(e, true));
  list.addEventListener('mouseout', (e) => onOver(e, false));
  list.addEventListener('focusin', (e) => onOver(e, true));
  list.addEventListener('focusout', (e) => onOver(e, false));

  const matches = (c: Card): boolean => !query || c.search.includes(query) || `#${c.d}` === query;
  const applySearch = (): void => {
    let shown = 0;
    for (const c of cards.values()) {
      if (!c.el) continue;
      const v = shownByTick(c) && matches(c);
      c.el.hidden = !v;
      if (v) shown++;
    }
    empty.hidden = shown > 0;
    paintEmpty();
  };

  const paintTotals = (): void => {
    const evs = tickLimit === null ? trace.events() : trace.events().filter((e) => (cards.get(e.d)?.start?.tick ?? 0) <= tickLimit!);
    const tt = computeTotals(evs);
    const u = tt.usage;
    const item = (label: string, v: string, title?: string) => h('span.tr-tot', { title }, h('small', null, label), h('b', null, v));
    fill(
      totals,
      item(
        t('agent.trace.decisions'),
        tt.skipped ? t('agent.trace.decisionsSkipped', { a: tt.decisions - tt.skipped, b: tt.skipped }) : String(tt.decisions),
      ),
      item(
        t('agent.trace.requests'),
        tt.requestsPerDecision
          ? t('agent.trace.perDecision', {
              total: tt.requests,
              avg: fmtNumber(tt.requestsPerDecision, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
            })
          : String(tt.requests),
      ),
      item(t('agent.trace.newInput'), fmtTokens(u.inputTokens)),
      item(t('agent.trace.cacheRead'), fmtTokens(u.cacheReadTokens)),
      item(t('agent.trace.cacheWrite'), fmtTokens(u.cacheWriteTokens)),
      item(t('agent.trace.output'), fmtTokens(u.outputTokens)),
      item(t('agent.trace.budgetLabel'), fmtTokens(budgetTokens(u)), t('agent.trace.budgetTip')),
      tt.compactions ? item(t('agent.trace.compactions'), t('agent.trace.times', { n: tt.compactions })) : null,
      item(t('agent.trace.cost'), fmtCost(tt.costUsd), t('agent.trace.costTip')),
      item(t('agent.trace.avgLatency'), tt.avgLatencyMs ? fmtMs(tt.avgLatencyMs) : '—'),
      tt.fallbacks || tt.errors ? item(t('agent.trace.errFallback'), `${tt.errors} / ${tt.fallbacks}`) : null,
    );
    setText(railCount, String(tt.decisions));
    if (opsSrc) {
      const list = opsSrc.all().filter((d) => {
        if (tickLimit === null) return true;
        const c = cards.get(d.d);
        return (c?.start?.tick ?? d.tick ?? 0) <= tickLimit;
      });
      const ot = opsTotals(list);
      fill(
        opsSum,
        h('b.tr-ops-sum-title', null, t('agent.ops.sumLabel')),
        ...totalsItems(ot).map((x) =>
          h(`span.tr-ops-tot${x.tone ? `.${x.tone}` : ''}`, null, h('small', null, x.label), h('b', null, x.value)),
        ),
      );
    }
  };

  function flush(): void {
    if (destroyed) return;
    if (!visible()) return;
    for (const c of dirty) {
      if (!c.el) {
        buildCard(c);
        continue;
      }
      if (c.full && c.body) {
        for (const s of c.pending) if (!s.el) renderSeg(c, s);
        c.pending = [];
        for (const s of c.segs) if (s.dirty && s.el) renderSeg(c, s);
      } else c.pending = [];
      if (c.dirtyHead) {
        renderHead(c);
        if (c.full && c.foot) renderFoot(c);
        if (c.full) renderInstr(c);
        if (c.full) c.opsDirty = true;
        c.dirtyHead = false;
      }
      if (c.full && c.opsDirty) renderOps(c);
      c.el.hidden = !shownByTick(c) || !matches(c);
    }
    dirty.clear();
    // 只保留最近 FULL_CARDS 张展开
    let fullCount = 0;
    for (let i = order.length - 1; i >= 0; i--) {
      const c = cards.get(order[i]);
      if (!c?.el) continue;
      if (c.full && !c.pinned) {
        fullCount++;
        if (fullCount > FULL_CARDS) fold(c);
      }
    }
    if (totalsDirty) {
      paintTotals();
      totalsDirty = false;
    }
    empty.hidden = cards.size > 0 && !(query && !list.querySelector('.tr-card:not([hidden])'));
    if (live && follow) scrollToEnd();
  }

  // 切换语言：重设静态文字，所有卡片按新语言重建
  const offLocale = onLocaleChange(() => {
    if (destroyed) return;
    for (const fn of labels) fn();
    applyLayout();
    exportBox.hidden = true;
    exportBtn.setAttribute('aria-expanded', 'false');
    for (const c of cards.values()) {
      c.el?.remove();
      c.el = undefined;
      dirty.add(c);
    }
    totalsDirty = true;
    if (visible()) schedule(true);
  });

  applyLayout();
  if (visible()) schedule(true);

  return {
    el,
    toggle,
    get mode() {
      return mode;
    },
    isOpen: visible,
    setOpen,
    setTickLimit(tick) {
      if (tick === tickLimit) return;
      const prev = tickLimit;
      tickLimit = tick;
      // 只在跨过某次决策时更新
      let changed = prev === null || tick === null;
      if (!changed) {
        for (const c of cards.values()) {
          const tc = tickOf(c);
          if (tc <= prev! !== tc <= tick!) {
            changed = true;
            break;
          }
        }
      }
      if (!changed) return;
      for (const c of cards.values()) dirty.add(c);
      totalsDirty = true;
      if (visible()) {
        schedule();
        // 回放：自动滚到最近一次已发生的决策
        requestAnimationFrame(() => {
          const shown = [...list.querySelectorAll<HTMLElement>('.tr-card:not([hidden])')];
          const last = shown[shown.length - 1];
          if (last && follow) scroller.scrollTop = last.offsetTop - 8;
        });
      }
    },
    present(p) {
      if (!embed) return;
      const was = embedVisible;
      const changed = p.view !== embedView || p.compact !== embedCompact;
      embedVisible = p.visible;
      embedView = p.view;
      embedCompact = p.compact;
      if (!changed && was === p.visible) return;
      applyLayout();
      if (p.visible && (!was || changed)) markAllOps();
      if (p.visible && !was) {
        for (const c of cards.values()) dirty.add(c);
        totalsDirty = true;
        schedule(true);
      }
    },
    setLive(v) {
      live = v;
      followBtn.hidden = !v;
      paintEmpty();
      el.classList.toggle('ended', !v);
      for (const c of cards.values()) {
        c.dirtyHead = true;
        dirty.add(c);
      }
      schedule();
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(railRaf);
      clearTimeout(searchT);
      unsub();
      unsubOps();
      offLocale();
      ro.disconnect();
      window.removeEventListener('resize', onWinResize);
      o.onHighlight?.(null);
      o.onHighlightCells?.(null);
      o.onHighlightRoute?.(null);
      const url = exportBox.dataset.url;
      if (url) URL.revokeObjectURL(url);
      el.remove();
      toggle.remove();
      if (embed) return;
      delete host.dataset.traceMode;
      host.style.removeProperty('--trace-w');
      host.style.removeProperty('--trace-occupy');
    },
  };
}
