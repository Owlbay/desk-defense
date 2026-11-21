import { describe, expect, it } from 'vitest';

import {
  clampWidth,
  DOCK_MAX_W,
  DOCK_MIN_W,
  DOCK_SPLIT_W,
  type DockAction,
  dockReduce,
  type DockState,
  initialDock,
  modeFor,
  paneOf,
  prefsOf,
} from '../../src/ui/ai/dock-state';

const run = (s: DockState, ...as: DockAction[]): DockState => as.reduce(dockReduce, s);

describe('AI dock state machine', () => {
  it('desktop starts as an open right column, phone as a hidden bottom sheet', () => {
    expect(modeFor(1440, 900)).toBe('column');
    expect(modeFor(390, 844)).toBe('sheet');
    expect(modeFor(900, 600)).toBe('sheet');
    expect(modeFor(1280, 720)).toBe('column');
    // 1024×768：让出侧栏后对局太窄，改用贴着棋盘的抽屉
    expect(modeFor(1024, 768)).toBe('sheet');
    const col = initialDock('column', ['status', 'trace', 'ops']);
    expect(col.open).toBe(true);
    expect(col.tab).toBe('status');
    const sheet = initialDock('sheet', ['status', 'trace', 'ops']);
    expect(sheet.open).toBe(false);
    expect(paneOf(sheet).pane).toBeNull();
  });

  it('only ever shows one pane: every reachable state has at most one visible container/tab', () => {
    const actions: DockAction[] = [
      { type: 'open' },
      { type: 'close' },
      { type: 'toggle' },
      { type: 'tab', tab: 'status' },
      { type: 'tab', tab: 'trace' },
      { type: 'tab', tab: 'ops' },
      { type: 'snap', snap: 'peek' },
      { type: 'snap', snap: 'full' },
      { type: 'cycleSnap' },
      { type: 'mode', mode: 'sheet' },
      { type: 'mode', mode: 'column' },
      { type: 'width', width: 800 },
      { type: 'width', width: 320 },
    ];
    let s = initialDock('column', ['status', 'trace', 'ops']);
    let seed = 7;
    for (let i = 0; i < 400; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      s = dockReduce(s, actions[seed % actions.length]);
      const p = paneOf(s);
      // 一个容器、一个页签：status 与 trace 面板不会同时出现
      expect(p.pane === null || p.pane === 'status' || p.pane === 'trace').toBe(true);
      if (p.pane === 'status') expect(p.view).toBeNull();
      if (!s.open) expect(p.pane).toBeNull();
      expect(s.tabs).toContain(s.tab);
    }
  });

  it('tab click opens the dock to that tab; ops shares the trace panel; split only in a wide column', () => {
    let s = initialDock('sheet', ['status', 'trace', 'ops']);
    s = dockReduce(s, { type: 'tab', tab: 'ops' });
    expect(s.open).toBe(true);
    expect(paneOf(s)).toEqual({ pane: 'trace', view: 'ops' });
    s = dockReduce(s, { type: 'tab', tab: 'trace' });
    expect(paneOf(s).view).toBe('trace');
    let c = initialDock('column', ['status', 'trace', 'ops'], { tab: 'trace', width: 420 });
    expect(paneOf(c).view).toBe('trace');
    c = dockReduce(c, { type: 'width', width: DOCK_SPLIT_W + 20 });
    expect(paneOf(c).view).toBe('split');
    // 抽屉里永远不并排
    expect(paneOf(dockReduce(c, { type: 'mode', mode: 'sheet' })).view).not.toBe('split');
  });

  it('remembers the last tab, open state per mode, snap and width', () => {
    let s = initialDock('column', ['status', 'trace', 'ops']);
    s = run(s, { type: 'tab', tab: 'ops' }, { type: 'close' }, { type: 'width', width: 520 });
    const p = prefsOf(s);
    expect(p).toMatchObject({ tab: 'ops', colOpen: false, sheetOpen: false, width: 520 });
    const back = initialDock('column', ['status', 'trace', 'ops'], p);
    expect(back.tab).toBe('ops');
    expect(back.open).toBe(false);
    // 横竖屏切换：各自的开合互不影响
    let m = run(initialDock('column', ['status', 'trace', 'ops']), { type: 'mode', mode: 'sheet' });
    expect(m.open).toBe(false);
    m = run(m, { type: 'open', snap: 'full' }, { type: 'mode', mode: 'column' });
    expect(m.open).toBe(true);
    expect(prefsOf(m)).toMatchObject({ colOpen: true, sheetOpen: true, snap: 'full' });
    // 回放没有 AI 状态页：记住的 status 退回第一页
    expect(initialDock('column', ['trace', 'ops'], { tab: 'status' }).tab).toBe('trace');
    expect(dockReduce(initialDock('column', ['trace', 'ops']), { type: 'tab', tab: 'status' }).tab).toBe('trace');
  });

  it('snap cycling and width clamping', () => {
    let s = initialDock('sheet', ['status', 'trace', 'ops'], { snap: 'peek' });
    s = dockReduce(s, { type: 'cycleSnap' });
    expect([s.snap, s.open]).toEqual(['half', true]);
    s = run(s, { type: 'cycleSnap' }, { type: 'cycleSnap' });
    expect(s.snap).toBe('peek');
    expect(clampWidth(10)).toBe(DOCK_MIN_W);
    expect(clampWidth(5000)).toBe(DOCK_MAX_W);
    expect(clampWidth(700, 1000)).toBe(400);
    expect(clampWidth(420, 1024)).toBe(410);
    expect(clampWidth(Number.NaN)).toBeGreaterThanOrEqual(DOCK_MIN_W);
  });
});
