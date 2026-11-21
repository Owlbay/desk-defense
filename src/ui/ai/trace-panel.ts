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
import {
  argsLine,
  budgetTokens,
  computeTotals,
  emptyUsage,
  type AgentTrace,
  type TokenUsage,
  type TraceEvent,
} from '../../agent';
import '../../styles/ai-trace.css';
import { audio } from '../audio';
import { append, clear, copyText, h, setText, type Child } from '../dom';
import { G } from '../icons';
import { REASON_NAME } from './actions';
import { fmtCost, fmtTokens, providerLabel } from './format';

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
  /** 抽屉打开 / 关闭（例如关掉同位置的 AI 面板） */
  onOpenChange?: (open: boolean, mode: 'column' | 'drawer') => void;
  /** 初始是否打开（缺省：分栏模式打开、抽屉模式关闭） */
  initialOpen?: boolean;
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
  full: boolean;
  /** 用户手动展开的旧卡片（不会被自动折叠） */
  pinned: boolean;
  dirtyHead: boolean;
  /** 尚未渲染的新片段 */
  pending: Seg[];
}

const newCard = (d: number): Card => ({
  d, segs: [], tools: new Map(), reqs: new Map(), usage: emptyUsage(), cost: 0, latency: 0, search: '',
  full: true, pinned: false, dirtyHead: true, pending: [],
});

// ───────────────────────── 小组件 ─────────────────────────

/** 等宽代码块：显示前 SHOW_CHARS 字符，可「展开全部」，复制按钮复制完整内容 */
function codeBlock(label: string, get: () => string, opts: { copyText?: () => string; lang?: string } = {}): HTMLElement {
  const pre = h('pre.tr-code', { attrs: { tabindex: 0, 'data-lang': opts.lang ?? 'text' } });
  const info = h('small.muted.tr-code-size');
  const more = h<HTMLButtonElement>('button.btn.small.tr-more', { attrs: { type: 'button' } });
  more.hidden = true;
  const copyBtn = h<HTMLButtonElement>('button.btn.small.tr-copy', { attrs: { type: 'button', 'aria-label': `复制${label}` } }, h('span.gi', { html: G.copy }), '复制');
  let full = false;
  const paint = (): void => {
    const text = get();
    const cut = !full && text.length > SHOW_CHARS;
    pre.textContent = cut ? `${text.slice(0, SHOW_CHARS)}\n…` : text.length > EXPAND_MAX ? `${text.slice(0, EXPAND_MAX)}\n…[太长，只显示前 ${EXPAND_MAX} 字符；复制可拿到全部]` : text;
    setText(info, `${text.length.toLocaleString('zh-CN')} 字符`);
    more.hidden = !cut;
    if (cut) more.textContent = `展开全部（${text.length.toLocaleString('zh-CN')} 字符）`;
  };
  more.onclick = () => {
    full = true;
    paint();
  };
  copyBtn.onclick = async () => {
    audio.play('click');
    const ok = await copyText(opts.copyText ? opts.copyText() : get());
    copyBtn.replaceChildren(h('span.gi', { html: ok ? G.check : G.close }), ok ? '已复制' : '复制失败');
    setTimeout(() => copyBtn.replaceChildren(h('span.gi', { html: G.copy }), '复制'), 1400);
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

const prettyJson = (s: string | undefined): string => s ?? '(无)';

const fmtMs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} 秒` : `${Math.round(ms)} ms`);

const usageLine = (u: TokenUsage): string => {
  const parts = [`新输入 ${fmtTokens(u.inputTokens)}`];
  if (u.cacheReadTokens) parts.push(`缓存读 ${fmtTokens(u.cacheReadTokens)}`);
  if (u.cacheWriteTokens) parts.push(`缓存写 ${fmtTokens(u.cacheWriteTokens)}`);
  parts.push(`输出 ${fmtTokens(u.outputTokens)}`, `折算 ${fmtTokens(budgetTokens(u))}`);
  return parts.join(' · ');
};

const zhStop: Record<string, string> = {
  end_turn: '正常结束', tool_use: '调用工具', toolUse: '调用工具', stop: '正常结束', length: '输出长度上限', max_tokens: '输出长度上限',
  refusal: '拒答', error: '出错', aborted: '已中止', pause_turn: '暂停',
};

function loadPrefs(): { w?: number; collapsed?: boolean; raw?: boolean; filter?: string } {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') as { w?: number; collapsed?: boolean; raw?: boolean; filter?: string };
  } catch {
    return {};
  }
}
function savePrefs(p: { w?: number; collapsed?: boolean; raw?: boolean; filter?: string }): void {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(p));
  } catch {
    /* 隐私模式 */
  }
}

// ───────────────────────── 面板 ─────────────────────────

export function mountTracePanel(o: TracePanelOptions): TracePanelHandle {
  const { host, trace } = o;
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

  const cards = new Map<number, Card>();
  const order: number[] = [];
  const dirty = new Set<Card>();
  let totalsDirty = true;
  let raf = 0;

  // ── DOM ──
  const liveDot = h('span.tr-live', { attrs: { 'aria-hidden': 'true' } });
  const title = h('div.tr-title', null, liveDot, h('b', null, '思路与请求'), o.subtitle ? h('small.muted', null, o.subtitle) : null);
  const followBtn = h<HTMLButtonElement>('button.btn.small.tr-follow', { attrs: { type: 'button', 'aria-pressed': 'true' } }, '跟随最新');
  followBtn.hidden = !live;
  const collapseBtn = h<HTMLButtonElement>('button.btn.icon-btn.small.tr-collapse', { attrs: { type: 'button', 'aria-label': '收起思路与请求' } }, h('span.gi', { html: G.close }));
  const toolsBtn = h<HTMLButtonElement>('button.btn.small.tr-tools-btn', { attrs: { type: 'button', 'aria-expanded': 'false' } }, '筛选');
  const head = h('div.tr-head', null, title, h('div.tr-head-actions', null, toolsBtn, followBtn, collapseBtn));

  const totals = h('div.tr-totals', { attrs: { 'aria-label': '累计' } });

  const segBtn = (v: string, label: string) =>
    h<HTMLButtonElement>(`button.seg${filter === v ? '.on' : ''}`, { attrs: { type: 'button', 'aria-pressed': filter === v ? 'true' : 'false' }, data: { v } }, label);
  const filters = h('div.segs.tr-filters', { attrs: { role: 'group', 'aria-label': '筛选' } }, segBtn('all', '全部'), segBtn('thinking', '只看思路'), segBtn('tools', '只看工具'));
  const rawToggle = h<HTMLInputElement>('input', { attrs: { type: 'checkbox' } });
  rawToggle.checked = showRaw;
  const rawLabel = h('label.tr-raw-toggle', null, rawToggle, '显示原始数据');
  const search = h<HTMLInputElement>('input.input.tr-search', { attrs: { type: 'search', placeholder: '搜索思路 / 工具 / 错误…', 'aria-label': '搜索' } });
  const exportBtn = h<HTMLButtonElement>('button.btn.small.tr-export', { attrs: { type: 'button', 'aria-expanded': 'false' } }, '导出全部 (JSON)');
  const exportBox = h('div.tr-export-box');
  exportBox.hidden = true;
  const tools = h('div.tr-tools', null, filters, h('div.tr-tools-row', null, search, rawLabel, exportBtn), exportBox);

  const list = h('ol.tr-list', { attrs: { 'aria-live': 'off' } });
  const empty = h('p.tr-empty.muted', null, live ? '等待第一次决策…' : '这局没有记录到思路与请求。');
  const scroller = h('div.tr-scroll', null, empty, list);
  const privacy = h('p.tr-privacy', null, h('span.gi', { html: G.lock }), '以上内容只在你的浏览器里，不会上传。API Key 已替换为 •••。');

  const resizer = h('div.tr-resizer', { attrs: { role: 'separator', 'aria-orientation': 'vertical', 'aria-label': '拖动调整宽度', tabindex: 0 } });
  const railCount = h('span.tr-rail-count');
  const rail = h<HTMLButtonElement>('button.tr-rail', { attrs: { type: 'button', 'aria-label': '展开思路与请求' } }, h('span.tr-live', { attrs: { 'aria-hidden': 'true' } }), h('span.tr-rail-text', null, '思路与请求'), railCount);

  const el = h(
    'section.tr-panel',
    { attrs: { role: 'complementary', 'aria-label': '思路与请求' }, data: { filter, raw: showRaw ? '1' : '0' } },
    resizer,
    rail,
    h('div.tr-inner', null, head, totals, tools, scroller, privacy),
  );
  host.appendChild(el);

  const toggle = h<HTMLButtonElement>('button.tr-toggle', { attrs: { type: 'button', 'aria-pressed': 'false' } }, h('span.tr-live', { attrs: { 'aria-hidden': 'true' } }), '思路');

  // ── 布局 ──
  const decideMode = (): 'column' | 'drawer' => {
    const r = host.getBoundingClientRect();
    if (r.width === 0) return mode;
    return r.width >= 960 && r.width / Math.max(1, r.height) >= 1.25 ? 'column' : 'drawer';
  };
  const clampW = (w: number): number => {
    const hw = host.getBoundingClientRect().width || 1200;
    return Math.round(Math.max(280, Math.min(w, Math.min(720, hw * 0.5))));
  };
  /** 分栏模式只有「展开 / 收成细边」两态；抽屉模式是「打开 / 关闭」 */
  const visible = (): boolean => (mode === 'column' ? !collapsed : open);

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
    mode = decideMode();
    el.dataset.mode = mode;
    el.dataset.open = visible() ? '1' : '0';
    el.dataset.collapsed = mode === 'column' && collapsed ? '1' : '0';
    host.dataset.traceMode = mode;
    if (mode === 'column') {
      width = clampW(width);
      host.style.setProperty('--trace-w', `${width}px`);
      host.style.setProperty('--trace-occupy', collapsed ? '40px' : `${width}px`);
    } else {
      host.style.setProperty('--trace-occupy', '0px');
      placeDrawer();
    }
    el.hidden = mode === 'drawer' && !open;
    toggle.setAttribute('aria-pressed', visible() ? 'true' : 'false');
    toggle.classList.toggle('on', visible());
    collapseBtn.setAttribute('aria-label', mode === 'column' ? '收成细边' : '关闭思路与请求');
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
      host.style.setProperty('--trace-w', `${width}px`);
      host.style.setProperty('--trace-occupy', `${width}px`);
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

  const ro = new ResizeObserver(() => applyLayout());
  ro.observe(host);
  const onWinResize = (): void => placeDrawer();
  window.addEventListener('resize', onWinResize);

  // 面板里的按键不要触发游戏快捷键
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mode === 'drawer') {
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
  scroller.addEventListener('scroll', () => {
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
  }, { passive: true });
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
    const json = JSON.stringify(trace.export(), null, 2);
    const kb = Math.max(1, Math.round(json.length / 1024));
    const status = h('small.muted', { attrs: { role: 'status' } });
    const name = `desk-defense-ai-trace-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
    let url = '';
    try {
      url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    } catch {
      url = '';
    }
    const dl = url
      ? h('a.btn.small.primary', { attrs: { href: url, download: name }, onclick: () => setTimeout(() => setText(status, '如果没有开始下载（部分内嵌页面会拦截下载），请用右边的「复制」。'), 400) }, '下载 .json')
      : null;
    const cp = h<HTMLButtonElement>('button.btn.small', {
      attrs: { type: 'button' },
      onclick: async () => {
        const ok = await copyText(json);
        setText(status, ok ? '已复制到剪贴板。' : '复制失败：浏览器不允许访问剪贴板。');
      },
    }, '复制到剪贴板');
    fill(exportBox, h('div.tr-export-row', null, dl, cp, h('small.muted', null, `${kb} KB · ${trace.events().length} 条事件${trace.dropped ? ` · 更早的 ${trace.dropped} 条已丢弃` : ''}`)), status);
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
        addSearch(c, `${e.trigger.map((r) => REASON_NAME[r] ?? r).join(' ')} ${e.provider} ${e.model}`);
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
        c.usage = { ...c.usage, inputTokens: c.usage.inputTokens + e.usage.inputTokens, outputTokens: c.usage.outputTokens + e.usage.outputTokens, cacheReadTokens: c.usage.cacheReadTokens + e.usage.cacheReadTokens, cacheWriteTokens: c.usage.cacheWriteTokens + e.usage.cacheWriteTokens, requests: c.usage.requests + 1 };
        c.cost += e.costUsd ?? 0;
        c.latency += e.ms;
        c.dirtyHead = true;
        break;
      }
      case 'compact': {
        const s: Seg = { kind: 'compact', ev: e, dirty: true };
        c.segs.push(s);
        c.pending.push(s);
        addSearch(c, `上下文已压缩 ${e.reason}`);
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
    const reasons = s ? s.trigger.map((r) => REASON_NAME[r] ?? r).join('、') : '（更早的事件已丢弃）';
    const running = live && !e;
    const tokens = budgetTokens(c.usage);
    fill(c.head, 
      h('span.tr-d', null, `#${c.d}`),
      h('b', null, s ? `第 ${Math.max(1, s.wave)} 波` : '—'),
      h('span.tr-reasons', null, reasons),
      running ? h('span.tr-running', null, h('span.ai-spinner'), '进行中') : null,
      e?.by === 'fallback' ? h('span.badge.ai-bot-badge', null, '机器人') : null,
      s?.skipped ? h('span.badge.tr-skip-badge', { attrs: { title: s.skipped } }, '跳过（无可行动作）') : null,
      s?.delta ? h('span.badge.tr-delta-badge', { attrs: { title: '只发送了变化的字段' } }, '增量') : null,
      h('span.tr-head-meta.muted', null, [e ? fmtMs(e.ms) : c.latency ? fmtMs(c.latency) : '', tokens ? `折算 ${fmtTokens(tokens)}` : '', c.cost ? fmtCost(c.cost) : ''].filter(Boolean).join(' · ')),
    );
    c.el?.classList.toggle('by-bot', e?.by === 'fallback');
    c.el?.classList.toggle('running', running);
  };

  const renderFoot = (c: Card): void => {
    if (!c.foot) return;
    const s = c.start;
    const e = c.end;
    const parts: HTMLElement[] = [];
    if (s?.skipped) parts.push(h('p.tr-sum', null, `跳过（无可行动作）：${s.skipped}——没有调用模型`));
    else if (e) {
      parts.push(h('p.tr-sum', null,
        `共 ${e.toolCalls} 次工具调用 · ${c.usage.requests} 次请求 · ${usageLine(c.usage)}${c.cost ? ` · ${fmtCost(c.cost)}` : ''} · 用时 ${fmtMs(e.ms)}`,
        e.note ? h('span.tr-note', null, ` · 备忘：${e.note}`) : null,
      ));
    }
    const extras = h('div.tr-extra');
    if (s && !s.skipped) {
      extras.append(
        lazyDetails('tr-obs', '观察（发送给模型的局面）', () => codeBlock('观察', () => trace.blob(s.observationHash) ?? '(已从缓冲区丢弃)')),
        lazyDetails('tr-sys', '系统提示词', () => {
          const sysReq = [...c.reqs.values()].find((r) => r.ev.systemHash && r.ev.systemHash !== s.systemHash);
          const box = h('div.tr-stack', null, codeBlock(`系统提示词 · ${s.systemHash ?? ''}`, () => trace.blob(s.systemHash) ?? '(已从缓冲区丢弃)'));
          if (sysReq) box.appendChild(codeBlock(`本次请求实际使用 · ${sysReq.ev.systemHash}`, () => trace.blob(sysReq.ev.systemHash) ?? '(已丢弃)'));
          return box;
        }),
        lazyDetails('tr-tooldefs', `工具定义（${s.toolNames?.length ?? 0} 个）`, () =>
          h('div.tr-stack', null, h('p.tr-chips', null, ...(s.toolNames ?? []).map((n) => h('code.tr-chip', null, n))), codeBlock('工具定义 JSON', () => trace.blob(s.toolsHash) ?? '(已丢弃)', { lang: 'json' })),
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
        const meta = [providerLabel(r.provider), r.model, r.api, r.host ? `→ ${r.host}` : '', r.thinking ? `思考：${r.thinking}` : r.effort ? `effort ${r.effort}` : '', r.messages ? `${r.messages} 条消息` : '', r.compacted ? `压缩了 ${r.compacted} 条旧结果` : ''].filter(Boolean).join(' · ');
        fill(el, 
          h('div.tr-req-line', null, h('span.tr-tag', null, `请求 ${r.n}`), h('span.muted', null, meta)),
          r.thinkingNote ? h('p.tr-effect', null, r.thinkingNote) : null,
          r.params ? h('p.tr-params', null, Object.entries(r.params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => h('code.tr-chip.tr-param', null, `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`))) : null,
          h('div.tr-rawonly', null,
            r.headers ? lazyDetails('tr-hdr', '请求头（已脱敏）', () => codeBlock('请求头', () => JSON.stringify(r.headers, null, 2), { lang: 'json' })) : null,
            lazyDetails('tr-rawreq', `原始请求 JSON${s.rawChars ? `（${s.rawChars.toLocaleString('zh-CN')} 字符）` : ''}`, () =>
              codeBlock('原始请求 JSON', () => prettyJson(s.raw), { lang: 'json', copyText: () => trace.inflate(s.raw ?? '') }),
            ),
          ),
        );
        break;
      }
      case 'thinking':
      case 'text': {
        let body = el.querySelector<HTMLElement>('.tr-txt');
        if (!body) {
          fill(el, h('span.tr-tag', null, s.kind === 'thinking' ? '思路' : '回复'), (body = h('div.tr-txt')));
        }
        const t = s.text.length > LIVE_TEXT_CHARS ? `…${s.text.slice(-LIVE_TEXT_CHARS)}` : s.text;
        setText(body, t);
        if (s.total > s.text.length && !el.querySelector('.tr-cut')) el.appendChild(h('small.muted.tr-cut', null, '（太长，已截断；完整内容在导出里）'));
        break;
      }
      case 'tool': {
        const r = s.result;
        const cls = r ? (r.ok ? 'ok' : 'bad') : 'pending';
        el.className = `tr-seg tr-tool ${cls}`;
        const chip = h('span.tr-toolchip', null, h('span.gi', { html: r ? (r.ok ? G.check : G.close) : G.hourglass }), h('b', null, s.call.name), h('code', null, argsLine(s.call.args)));
        fill(el, 
          chip,
          r ? h('p.tr-result', null, r.text.length > 400 ? `${r.text.slice(0, 400)}…` : r.text) : h('p.tr-result.muted', null, '执行中…'),
          r?.effect ? h('p.tr-effect', null, r.effect) : null,
          h('div.tr-rawonly', null, lazyDetails('tr-toolraw', '调用与结果 JSON', () => codeBlock('工具调用', () => JSON.stringify({ call: s.call, result: r }, null, 2), { lang: 'json' }))),
        );
        const cell = r?.cell ?? (s.call.args && typeof s.call.args === 'object' && typeof (s.call.args as { x?: unknown }).x === 'number' ? { x: (s.call.args as { x: number }).x, y: (s.call.args as { y: number }).y } : undefined);
        if (cell && o.onHighlight) {
          el.dataset.cell = `${cell.x},${cell.y}`;
          el.tabIndex = 0;
        }
        break;
      }
      case 'resp': {
        const r = s.ev;
        fill(el, 
          h('div.tr-req-line', null,
            h('span.tr-tag', null, `响应 ${r.n}`),
            h('span.muted', null, [r.stop ? `${zhStop[r.stop] ?? r.stop}（${r.stop}）` : '', usageLine(r.usage), fmtMs(r.ms), r.costUsd ? fmtCost(r.costUsd) : ''].filter(Boolean).join(' · ')),
          ),
          h('div.tr-rawonly', null, lazyDetails('tr-rawresp', `原始响应 JSON${r.rawChars ? `（${r.rawChars.toLocaleString('zh-CN')} 字符）` : ''}`, () => codeBlock('原始响应 JSON', () => prettyJson(r.raw), { lang: 'json' }))),
        );
        break;
      }
      case 'error':
        fill(el, h('span.gi', { html: G.warn }), h('span', null, `出错：${s.ev.message}`));
        break;
      case 'compact':
        fill(el, h('span.gi', { html: G.bolt }), h('span', null, `上下文已压缩（第 ${s.ev.n} 次）：≈${s.ev.before} → ${s.ev.after} token`), s.ev.reason ? h('small.muted', null, ` · ${s.ev.reason}`) : null);
        break;
      case 'fallback':
        fill(el, h('span.gi', { html: G.bolt }), h('span', null, s.ev.acted ? `内置机器人接手：${s.ev.reason}` : `没有拿到结果：${s.ev.reason}`), s.ev.effect ? h('small.muted', null, ` → ${s.ev.effect}`) : null);
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
      c.el.append(c.body, c.foot);
      for (const s of c.segs) {
        s.el = undefined;
        renderSeg(c, s);
      }
      renderFoot(c);
    } else {
      c.body = undefined;
      c.foot = undefined;
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
    const t = e.target as HTMLElement;
    const head = t.closest('.tr-card-head');
    const li = t.closest<HTMLElement>('.tr-card');
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
  list.addEventListener('mouseover', (e) => hl(e, true));
  list.addEventListener('mouseout', (e) => hl(e, false));
  list.addEventListener('focusin', (e) => hl(e, true));
  list.addEventListener('focusout', (e) => hl(e, false));

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
    if (query && !shown) setText(empty, '没有匹配的决策。');
  };

  const paintTotals = (): void => {
    const evs = tickLimit === null ? trace.events() : trace.events().filter((e) => (cards.get(e.d)?.start?.tick ?? 0) <= tickLimit!);
    const t = computeTotals(evs);
    const u = t.usage;
    const item = (label: string, v: string, title?: string) => h('span.tr-tot', { title }, h('small', null, label), h('b', null, v));
    fill(totals, 
      item('决策', t.skipped ? `${t.decisions - t.skipped} + 跳过 ${t.skipped}` : String(t.decisions)),
      item('请求', t.requestsPerDecision ? `${t.requests}（${t.requestsPerDecision.toFixed(1)}/次）` : String(t.requests)),
      item('新输入', fmtTokens(u.inputTokens)),
      item('缓存读', fmtTokens(u.cacheReadTokens)),
      item('缓存写', fmtTokens(u.cacheWriteTokens)),
      item('输出', fmtTokens(u.outputTokens)),
      item('折算预算', fmtTokens(budgetTokens(u)), '新输入 + 输出 + 缓存写×1.25 + 缓存读×0.1'),
      t.compactions ? item('压缩', `${t.compactions} 次`) : null,
      item('费用', fmtCost(t.costUsd), '按公开价格估算，以服务商账单为准'),
      item('平均延迟', t.avgLatencyMs ? fmtMs(t.avgLatencyMs) : '—'),
      t.fallbacks || t.errors ? item('出错/兜底', `${t.errors} / ${t.fallbacks}`) : null,
    );
    setText(railCount, String(t.decisions));
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
        c.dirtyHead = false;
      }
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
          const t = tickOf(c);
          if ((t <= prev!) !== (t <= tick!)) {
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
    setLive(v) {
      live = v;
      followBtn.hidden = !v;
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
      ro.disconnect();
      window.removeEventListener('resize', onWinResize);
      o.onHighlight?.(null);
      const url = exportBox.dataset.url;
      if (url) URL.revokeObjectURL(url);
      el.remove();
      toggle.remove();
      delete host.dataset.traceMode;
      host.style.removeProperty('--trace-w');
      host.style.removeProperty('--trace-occupy');
    },
  };
}
