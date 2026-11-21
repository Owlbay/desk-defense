/**
 * AI 侧栏（dock）：对局 / 回放里 AI 相关内容的唯一容器（状态机见 dock-state.ts）。
 *
 *  - column：宿主（.game-screen / .replay-view）右侧一栏；宿主加 data-dock="column" 与 --dock-occupy，对局容器让出这一栏；
 *    左边缘拖动改宽（键盘 ←→），收起时是一条细边（点一下展开）；
 *  - sheet：底部抽屉，左右与棋盘对齐、底边贴着棋盘底边（竖屏手机上塔栏 / 技能 / 开波 / 速度都在棋盘下面，不会被挡）；
 *    peek 只露页签条 + 底部插槽（指令输入），half 约六成棋盘高，full 从屏幕顶到棋盘底。拖动把手或点「展开」切换档位。
 * 页签：AI 状态 / 思路与请求 / 操作解读（后两个共用追踪面板）。底部插槽（footer）各页签共用。
 */
import '../../styles/ai-dock.css';

import { onLocaleChange, t } from '../../i18n';
import { audio } from '../audio';
import { h, setText } from '../dom';
import { G } from '../icons';
import {
  clampWidth,
  type DockAction,
  type DockMode,
  type DockPrefs,
  dockReduce,
  type DockState,
  type DockTab,
  initialDock,
  modeFor,
  paneOf,
  prefsOf,
  type SheetSnap,
} from './dock-state';

const PREF_KEY = 'desk-defense.ai.dock.v1';
let seq = 0;

function loadPrefs(key: string): DockPrefs {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}') as DockPrefs;
  } catch {
    return {};
  }
}
function savePrefs(key: string, p: DockPrefs): void {
  try {
    localStorage.setItem(key, JSON.stringify(p));
  } catch {
    /* 隐私模式 */
  }
}

export interface DockOptions {
  /** .game-screen（对局）或 .replay-view（回放） */
  host: HTMLElement;
  /** 抽屉模式对齐的元素（棋盘） */
  anchor: () => HTMLElement | null;
  tabs: readonly DockTab[];
  /** 副标题（模型名） */
  subtitle?: string;
  /** 偏好存储键（回放单独一份） */
  prefKey?: string;
  /** 状态变化（页签 / 开合 / 模式 / 宽度） */
  onChange?: (s: DockState) => void;
}

export interface DockHandle {
  readonly el: HTMLElement;
  /** 「AI 状态」页的内容容器 */
  readonly statusPane: HTMLElement;
  /** 追踪面板（思路与请求 / 操作解读）的容器 */
  readonly tracePane: HTMLElement;
  /** 底部插槽（各页签共用；对局里放「给 AI 下指令」） */
  readonly footer: HTMLElement;
  state(): DockState;
  dispatch(a: DockAction): void;
  /** 打开到某页并把焦点移进去 */
  focus(tab?: DockTab): void;
  /** 页签上的未读数（0 = 不显示） */
  setBadge(tab: DockTab, n: number): void;
  /** 状态点（细边 / 页签条上的小圆点）：thinking / acting / paused / error … */
  setStatus(kind: string): void;
  setSubtitle(text: string): void;
  destroy(): void;
}

const TAB_KEY: Record<DockTab, string> = { status: 'agent.dock.tab.status', trace: 'agent.dock.tab.trace', ops: 'agent.dock.tab.ops' };
const TAB_ICON: Record<DockTab, string> = { status: G.eye, trace: G.list, ops: G.hammer };

export function mountDock(o: DockOptions): DockHandle {
  const { host } = o;
  const key = o.prefKey ?? PREF_KEY;
  const uid = `ai-dock-${++seq}`;
  let destroyed = false;
  const hr = host.getBoundingClientRect();
  let st: DockState = initialDock(modeFor(hr.width || window.innerWidth, hr.height || window.innerHeight), o.tabs, loadPrefs(key));

  // ── DOM ──
  const dot = h('span.dock-dot', { attrs: { 'aria-hidden': 'true' } });
  const badges = new Map<DockTab, HTMLElement>();
  const tabBtns = new Map<DockTab, HTMLButtonElement>();
  const tabTexts = new Map<DockTab, HTMLElement>();
  const tablist = h('div.dock-tabs', { attrs: { role: 'tablist' } });
  for (const tb of st.tabs) {
    const badge = h('span.dock-badge');
    badge.hidden = true;
    const text = h('span.dock-tab-text');
    const b = h<HTMLButtonElement>(
      'button.dock-tab',
      {
        attrs: { type: 'button', role: 'tab', id: `${uid}-tab-${tb}`, 'aria-controls': `${uid}-pane-${tb === 'ops' ? 'trace' : tb}` },
        data: { tab: tb },
      },
      h('span.gi', { html: TAB_ICON[tb] }),
      text,
      badge,
    );
    badges.set(tb, badge);
    tabBtns.set(tb, b);
    tabTexts.set(tb, text);
    tablist.appendChild(b);
  }
  const grab = h<HTMLButtonElement>(
    'button.dock-grab',
    { attrs: { type: 'button' } },
    h('span.dock-grab-bar', { attrs: { 'aria-hidden': 'true' } }),
  );
  const snapBtn = h<HTMLButtonElement>('button.btn.icon-btn.small.dock-snap', { attrs: { type: 'button' } });
  const closeBtn = h<HTMLButtonElement>(
    'button.btn.icon-btn.small.dock-close',
    { attrs: { type: 'button' } },
    h('span.gi', { html: G.close }),
  );
  const subtitle = h('small.dock-sub.muted', null, o.subtitle ?? '');
  const head = h(
    'div.dock-head',
    null,
    grab,
    h('div.dock-head-row', null, dot, tablist, h('div.dock-head-actions', null, snapBtn, closeBtn)),
    subtitle,
  );

  const statusPane = h('div.dock-pane', {
    attrs: { role: 'tabpanel', id: `${uid}-pane-status`, 'aria-labelledby': `${uid}-tab-status` },
    data: { pane: 'status' },
  });
  const tracePane = h('div.dock-pane', { attrs: { role: 'tabpanel', id: `${uid}-pane-trace` }, data: { pane: 'trace' } });
  const body = h('div.dock-body', null, st.tabs.includes('status') ? statusPane : null, tracePane);
  const footer = h('div.dock-foot');

  const resizer = h('div.dock-resizer', { attrs: { role: 'separator', 'aria-orientation': 'vertical', tabindex: 0 } });
  const railBadge = h('span.dock-badge');
  railBadge.hidden = true;
  const railText = h('span.dock-rail-text');
  const rail = h<HTMLButtonElement>(
    'button.dock-rail',
    { attrs: { type: 'button' } },
    h('span.dock-dot', { attrs: { 'aria-hidden': 'true' } }),
    railText,
    railBadge,
  );
  const inner = h('div.dock-inner', null, head, body, footer);
  const el = h('section.ai-dock', { attrs: { role: 'complementary', id: uid } }, resizer, rail, inner);
  // 侧栏里的按键不要触发对局快捷键（数字建塔等）；Esc 关抽屉
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && st.mode === 'sheet' && st.open) {
      e.preventDefault();
      dispatch({ type: 'close' });
    }
    e.stopPropagation();
  });
  host.appendChild(el);

  const paintLabels = (): void => {
    for (const [tb, txt] of tabTexts) setText(txt, t(TAB_KEY[tb]));
    tablist.setAttribute('aria-label', t('agent.dock.tabs'));
    el.setAttribute('aria-label', t('agent.dock.title'));
    resizer.setAttribute('aria-label', t('agent.dock.resize'));
    rail.setAttribute('aria-label', t('agent.dock.expand'));
    setText(railText, t('agent.dock.rail'));
    grab.setAttribute('aria-label', t('agent.dock.grab'));
    paintChrome();
  };

  /** 页签选中态、按钮文字（随状态变化） */
  function paintChrome(): void {
    for (const [tb, b] of tabBtns) {
      const on = tb === st.tab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
    const sheet = st.mode === 'sheet';
    snapBtn.hidden = !sheet;
    grab.hidden = !sheet;
    const next: SheetSnap = st.snap === 'full' ? 'peek' : st.snap === 'peek' ? 'half' : 'full';
    snapBtn.replaceChildren(h('span.gi', { html: G.up }));
    snapBtn.dataset.dir = next === 'peek' ? 'down' : 'up';
    snapBtn.setAttribute('aria-label', t(next === 'peek' ? 'agent.dock.shrink' : 'agent.dock.grow'));
    snapBtn.title = snapBtn.getAttribute('aria-label') ?? '';
    closeBtn.setAttribute('aria-label', t(sheet ? 'agent.dock.close' : 'agent.dock.collapse'));
    closeBtn.title = closeBtn.getAttribute('aria-label') ?? '';
  }

  // ── 布局 ──
  const occupy = (): number => (st.mode !== 'column' ? 0 : st.open ? st.width : 40);
  function placeSheet(): void {
    if (st.mode !== 'sheet') return;
    const a = o.anchor();
    const ar = a?.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const ok = !!ar && ar.width > 50 && ar.height > 50;
    const left = ok ? Math.max(0, Math.round(ar.left)) : 0;
    const width = ok ? Math.round(Math.min(vw - left, ar.width)) : vw;
    const bottom = ok ? Math.max(0, Math.round(vh - ar.bottom)) : 0;
    const boardH = ok ? ar.height : vh * 0.6;
    const top = ok ? ar.top : 0;
    el.style.setProperty('--dk-x', `${left}px`);
    el.style.setProperty('--dk-w', `${width}px`);
    el.style.setProperty('--dk-bottom', `${bottom}px`);
    // half：约八成棋盘高（至少 300，不超过棋盘顶）；full：从屏幕顶（安全区）一直到棋盘底，左右铺满
    el.style.setProperty('--dk-half', `${Math.round(Math.min(Math.max(300, boardH * 0.8), top + boardH - 8))}px`);
    el.style.setProperty('--dk-full', `${Math.round(Math.max(240, vh - bottom))}px`);
  }
  function layout(): void {
    if (destroyed) return;
    const r = host.getBoundingClientRect();
    if (r.width > 0) {
      const mode: DockMode = modeFor(r.width, r.height);
      if (mode !== st.mode) st = dockReduce(st, { type: 'mode', mode });
      if (st.mode === 'column') {
        const w = clampWidth(st.width, r.width);
        if (w !== st.width) st = { ...st, width: w };
      }
    }
    paint();
  }
  function paint(): void {
    const { pane, view } = paneOf(st);
    el.dataset.mode = st.mode;
    el.dataset.open = st.open ? '1' : '0';
    el.dataset.snap = st.snap;
    el.dataset.tab = st.tab;
    el.dataset.view = view ?? '';
    statusPane.hidden = pane !== 'status';
    tracePane.hidden = pane !== 'trace';
    host.dataset.dock = st.mode;
    host.style.setProperty('--dock-w', `${st.width}px`);
    host.style.setProperty('--dock-occupy', `${occupy()}px`);
    el.hidden = st.mode === 'sheet' && !st.open;
    if (st.mode === 'sheet') placeSheet();
    paintChrome();
    o.onChange?.(st);
  }

  function dispatch(a: DockAction): void {
    const prev = st;
    st = dockReduce(st, a);
    if (st === prev) return;
    savePrefs(key, prefsOf(st));
    paint();
  }

  // ── 交互 ──
  tablist.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-tab]');
    if (!b) return;
    audio.play('click');
    const tab = b.dataset.tab as DockTab;
    // 抽屉 peek：点页签顺便升到 half（peek 看不到页内容）
    dispatch(st.mode === 'sheet' && st.snap === 'peek' ? { type: 'open', tab, snap: 'half' } : { type: 'tab', tab });
  });
  tablist.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const i = st.tabs.indexOf(st.tab);
    const n = st.tabs.length;
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + (e.key === 'ArrowLeft' ? n - 1 : 1)) % n;
    dispatch({ type: 'tab', tab: st.tabs[j] });
    tabBtns.get(st.tab)?.focus();
  });
  closeBtn.onclick = () => {
    audio.play('click');
    dispatch({ type: 'close' });
    if (st.mode === 'column') rail.focus({ preventScroll: true });
  };
  rail.onclick = () => {
    audio.play('click');
    dispatch({ type: 'open' });
  };
  snapBtn.onclick = () => {
    audio.play('click');
    dispatch({ type: 'cycleSnap' });
  };
  grab.onclick = () => {
    if (dragMoved) return;
    audio.play('click');
    dispatch({ type: 'cycleSnap' });
  };
  // 拖动把手：松手时就近吸附到 peek / half / full（往下拖过 peek = 关上）
  let dragMoved = false;
  grab.addEventListener('pointerdown', (e) => {
    if (st.mode !== 'sheet') return;
    dragMoved = false;
    const y0 = e.clientY;
    const h0 = el.getBoundingClientRect().height;
    grab.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent): void => {
      const dy = y0 - ev.clientY;
      if (Math.abs(dy) > 6) dragMoved = true;
      if (dragMoved) {
        el.classList.add('dragging');
        el.style.setProperty('--dk-drag', `${Math.max(56, h0 + dy)}px`);
      }
    };
    const up = (ev: PointerEvent): void => {
      grab.removeEventListener('pointermove', move);
      grab.removeEventListener('pointerup', up);
      grab.removeEventListener('pointercancel', up);
      el.classList.remove('dragging');
      el.style.removeProperty('--dk-drag');
      if (!dragMoved) return;
      const hNow = h0 + (y0 - ev.clientY);
      const cs = getComputedStyle(el);
      const half = parseFloat(cs.getPropertyValue('--dk-half')) || 300;
      const full = parseFloat(cs.getPropertyValue('--dk-full')) || 600;
      const peek = Math.min(h0, 140);
      if (hNow < peek * 0.6) dispatch({ type: 'close' });
      else {
        const c: [SheetSnap, number][] = [
          ['peek', peek],
          ['half', half],
          ['full', full],
        ];
        c.sort((a, b) => Math.abs(a[1] - hNow) - Math.abs(b[1] - hNow));
        dispatch({ type: 'snap', snap: c[0][0] });
      }
      setTimeout(() => (dragMoved = false), 0);
    };
    grab.addEventListener('pointermove', move);
    grab.addEventListener('pointerup', up);
    grab.addEventListener('pointercancel', up);
  });
  // 左边缘拖动改宽
  resizer.addEventListener('pointerdown', (e) => {
    if (st.mode !== 'column') return;
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const w0 = st.width;
    el.classList.add('resizing');
    const hostW = host.getBoundingClientRect().width;
    const move = (ev: PointerEvent): void => {
      st = { ...st, width: clampWidth(w0 + (x0 - ev.clientX), hostW) };
      paint();
    };
    const up = (): void => {
      resizer.removeEventListener('pointermove', move);
      resizer.removeEventListener('pointerup', up);
      resizer.removeEventListener('pointercancel', up);
      el.classList.remove('resizing');
      savePrefs(key, prefsOf(st));
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', up);
    resizer.addEventListener('pointercancel', up);
  });
  resizer.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    dispatch({ type: 'width', width: clampWidth(st.width + (e.key === 'ArrowLeft' ? 32 : -32), host.getBoundingClientRect().width) });
  });

  const ro = new ResizeObserver(() => layout());
  ro.observe(host);
  const onWin = (): void => {
    if (st.mode === 'sheet') placeSheet();
  };
  window.addEventListener('resize', onWin);
  // 棋盘位置会随顶栏 / 塔栏高度变化：抽屉打开时低频跟随
  const follow = window.setInterval(() => {
    if (st.mode === 'sheet' && st.open) placeSheet();
  }, 500);
  const offLocale = onLocaleChange(() => {
    if (!destroyed) paintLabels();
  });
  paintLabels();
  layout();

  return {
    el,
    statusPane,
    tracePane,
    footer,
    state: () => st,
    dispatch,
    focus(tab) {
      dispatch({ type: 'open', tab, snap: st.mode === 'sheet' && st.snap === 'peek' && tab ? 'half' : undefined });
      requestAnimationFrame(() => tabBtns.get(st.tab)?.focus({ preventScroll: true }));
    },
    setBadge(tab, n) {
      const b = badges.get(tab);
      if (!b) return;
      b.hidden = n <= 0;
      setText(b, n > 9 ? '9+' : String(n));
      let total = 0;
      for (const x of badges.values()) if (!x.hidden) total += Number(x.textContent?.replace('+', '') || 0);
      railBadge.hidden = total <= 0;
      setText(railBadge, total > 9 ? '9+' : String(total));
    },
    setStatus(kind) {
      el.dataset.status = kind;
    },
    setSubtitle(text) {
      setText(subtitle, text);
    },
    destroy() {
      destroyed = true;
      ro.disconnect();
      clearInterval(follow);
      window.removeEventListener('resize', onWin);
      offLocale();
      el.remove();
      delete host.dataset.dock;
      host.style.removeProperty('--dock-w');
      host.style.removeProperty('--dock-occupy');
    },
  };
}
