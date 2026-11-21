/**
 * AI 侧栏（dock）的状态机（纯逻辑，无 DOM；dock.ts 负责画出来）。
 *
 * 对局里 AI 相关的一切（状态 / 用量 / 控制 / 决策流 / 军师建议 / 预算询问、思路与请求、操作解读、给 AI 下指令）
 * 只放在这一个容器里，同一时间只有一个页签可见：
 *  - column（电脑 / 平板横放）：棋盘右侧一栏，可拖宽；关上 = 收成一条细边（rail），不会消失；
 *  - sheet（手机 / 紧凑横屏）：一个底部抽屉，peek（只露页签 + 指令输入）/ half / full 三档；关上 = 隐藏，只剩棋盘上的徽标。
 * 记忆：上次的页签、各模式的开合、抽屉档位、侧栏宽度（localStorage，见 dock.ts）。
 */

export type DockTab = 'status' | 'trace' | 'ops';
export type DockMode = 'column' | 'sheet';
export type SheetSnap = 'peek' | 'half' | 'full';

export const DOCK_TABS: readonly DockTab[] = ['status', 'trace', 'ops'];
export const SNAPS: readonly SheetSnap[] = ['peek', 'half', 'full'];
export const DOCK_MIN_W = 300;
export const DOCK_MAX_W = 760;
export const DOCK_DEFAULT_W = 420;
/** 侧栏至少这么宽时，「思路与请求」页里操作解读可以并排显示 */
export const DOCK_SPLIT_W = 600;

export interface DockState {
  mode: DockMode;
  /** 本容器有的页签（回放没有「AI 状态」） */
  tabs: readonly DockTab[];
  tab: DockTab;
  /** column：展开（false = 细边）；sheet：显示（false = 隐藏） */
  open: boolean;
  snap: SheetSnap;
  width: number;
  /** 另一种模式下的开合（横竖屏切换后恢复） */
  otherOpen: boolean;
}

export interface DockPrefs {
  tab?: DockTab;
  colOpen?: boolean;
  sheetOpen?: boolean;
  snap?: SheetSnap;
  width?: number;
}

export type DockAction =
  | { type: 'mode'; mode: DockMode }
  | { type: 'open'; tab?: DockTab; snap?: SheetSnap }
  | { type: 'close' }
  | { type: 'toggle' }
  | { type: 'tab'; tab: DockTab }
  | { type: 'snap'; snap: SheetSnap }
  /** 抽屉：peek → half → full → peek */
  | { type: 'cycleSnap' }
  | { type: 'width'; width: number };

export const clampWidth = (w: number, hostW = Infinity): number =>
  Math.round(Math.max(DOCK_MIN_W, Math.min(Number.isFinite(w) ? w : DOCK_DEFAULT_W, DOCK_MAX_W, Math.max(DOCK_MIN_W, hostW * 0.55))));

const isTab = (v: unknown): v is DockTab => (DOCK_TABS as readonly unknown[]).includes(v);
const isSnap = (v: unknown): v is SheetSnap => (SNAPS as readonly unknown[]).includes(v);

export function initialDock(mode: DockMode, tabs: readonly DockTab[], prefs: DockPrefs = {}): DockState {
  const list = tabs.length ? tabs : (['trace'] as DockTab[]);
  const tab = isTab(prefs.tab) && list.includes(prefs.tab) ? prefs.tab : list[0];
  // 缺省：宽屏展开（就在棋盘旁边，不挡东西）；手机收起（只留徽标）
  const colOpen = prefs.colOpen ?? true;
  const sheetOpen = prefs.sheetOpen ?? false;
  return {
    mode,
    tabs: list,
    tab,
    open: mode === 'column' ? colOpen : sheetOpen,
    otherOpen: mode === 'column' ? sheetOpen : colOpen,
    snap: isSnap(prefs.snap) ? prefs.snap : 'half',
    width: clampWidth(prefs.width ?? DOCK_DEFAULT_W),
  };
}

export function dockReduce(s: DockState, a: DockAction): DockState {
  switch (a.type) {
    case 'mode':
      if (a.mode === s.mode) return s;
      return { ...s, mode: a.mode, open: s.otherOpen, otherOpen: s.open };
    case 'open': {
      const tab = a.tab && s.tabs.includes(a.tab) ? a.tab : s.tab;
      const snap = a.snap ?? s.snap;
      if (s.open && tab === s.tab && snap === s.snap) return s;
      return { ...s, open: true, tab, snap };
    }
    case 'close':
      return s.open ? { ...s, open: false } : s;
    case 'toggle':
      return { ...s, open: !s.open };
    case 'tab':
      if (!s.tabs.includes(a.tab)) return s;
      // 点页签总是让容器可见（细边 / 隐藏的抽屉直接打开到这一页）
      return a.tab === s.tab && s.open ? s : { ...s, tab: a.tab, open: true };
    case 'snap':
      return a.snap === s.snap && s.open ? s : { ...s, snap: a.snap, open: true };
    case 'cycleSnap': {
      const i = SNAPS.indexOf(s.snap);
      return { ...s, snap: SNAPS[(i + 1) % SNAPS.length], open: true };
    }
    case 'width': {
      const width = clampWidth(a.width);
      return width === s.width ? s : { ...s, width };
    }
  }
}

/** 存进 localStorage 的部分 */
export function prefsOf(s: DockState): DockPrefs {
  return {
    tab: s.tab,
    snap: s.snap,
    width: s.width,
    colOpen: s.mode === 'column' ? s.open : s.otherOpen,
    sheetOpen: s.mode === 'sheet' ? s.open : s.otherOpen,
  };
}

/** 当前真正可见的页签（容器关着 = 没有；column 关着是细边，也算没有） */
export function visibleTab(s: DockState): DockTab | null {
  return s.open ? s.tab : null;
}

/**
 * 页签 → 实际显示的面板。「思路与请求」与「操作解读」共用同一个追踪面板（split = 宽侧栏里两栏并排）。
 * 同一时间最多一个面板可见。
 */
export function paneOf(s: DockState): { pane: 'status' | 'trace' | null; view: 'trace' | 'ops' | 'split' | null } {
  const tab = visibleTab(s);
  if (!tab) return { pane: null, view: null };
  if (tab === 'status') return { pane: 'status', view: null };
  if (tab === 'ops') return { pane: 'trace', view: 'ops' };
  return { pane: 'trace', view: s.mode === 'column' && s.width >= DOCK_SPLIT_W ? 'split' : 'trace' };
}

/** 宿主尺寸 → 模式：宽 ≥ 960 且宽高比 ≥ 1.25 用右侧栏，否则用底部抽屉 */
export function modeFor(width: number, height: number, compact = false): DockMode {
  if (compact) return 'sheet';
  return width >= 960 && width / Math.max(1, height) >= 1.25 ? 'column' : 'sheet';
}
