/**
 * 本地回放：刚结束的 AI 对局不用先上传，直接用「开局参数 + 指令日志」重放一遍。
 * 与排行榜回放用同一个播放器（src/ui/replay/viewer.ts：只读的对局界面 + 可拖动的进度条），
 * 旁边另挂对局时记录的「思路与请求 / 操作解读」，随回放进度展开。
 */
import { AgentTrace, type TraceExport } from '../../agent/trace';
import type { Command, RunOptions } from '../../core/types';
import { ui } from '../../game/UiStore';
import { t } from '../../i18n';
import type { App } from '../App';
import { audio } from '../audio';
import { fmtNum, h } from '../dom';
import { openReplayView } from '../replay/viewer';
import { type DockHandle, mountDock } from './dock';
import { DOCK_SPLIT_W, paneOf } from './dock-state';
import { OpsRecorder, type TraceExportWithOps } from './ops';
import { mountTracePanel, type TracePanelHandle } from './trace-panel';

export interface LocalReplay {
  opts: RunOptions;
  log: readonly { tick: number; cmd: Command }[];
  /** 结束帧 */
  tick: number;
}

export function openLocalReplay(
  app: App,
  run: LocalReplay,
  o: {
    title: string;
    subtitle: string;
    wave: number;
    score: number;
    /** 对局时记录的思路与请求（有就在旁边显示，随回放进度展开） */ trace?: TraceExport;
  },
): () => void {
  const view = openReplayView(app, {
    title: o.title,
    subtitle: o.subtitle,
    className: 'ai-replay',
    // 思路与请求面板里的输入框 / 按钮：按键留给它们（Esc 仍然退出回放）
    keysIgnoredIn: '.tr-panel, .ai-dock',
    labels: {
      dialog: t('agent.replay.title'),
      speed: t('agent.replay.speed'),
      exit: t('agent.replay.exit'),
      exitReplay: t('agent.replay.exitReplay'),
      ended: t('agent.replay.ended'),
    },
  });
  const { root, stage } = view;

  let tp: TracePanelHandle | null = null;
  let dock: DockHandle | null = null;
  view.onClose(() => {
    tp?.destroy();
    dock?.destroy();
  });
  if (o.trace?.events?.length) {
    try {
      // 与对局同一个 AI 侧栏（只有「思路与请求 / 操作解读」两页）
      const present = (): void => {
        if (!dock || !tp) return;
        const st = dock.state();
        const p = paneOf(st);
        tp.present({
          visible: p.pane === 'trace',
          view: p.view === 'ops' ? 'ops' : p.view === 'split' ? 'split' : 'trace',
          compact: st.mode === 'sheet' || st.width < DOCK_SPLIT_W,
        });
      };
      dock = mountDock({
        host: root,
        anchor: () => stage,
        tabs: ['trace', 'ops'],
        subtitle: t('agent.replay.traceSubtitle'),
        prefKey: 'desk-defense.ai.dock.replay.v1',
        onChange: present,
      });
      const dk = dock;
      tp = mountTracePanel({
        host: root,
        embed: dk.tracePane,
        anchor: () => stage,
        trace: AgentTrace.fromExport(o.trace),
        live: false,
        subtitle: t('agent.replay.traceSubtitle'),
        onHighlight: (c) => ui.set({ aiFocus: c ? { cx: c.x, cy: c.y } : null }),
        // 对局时记录的操作解读（旧数据没有就不显示右栏）
        ops: (o.trace as TraceExportWithOps).ops ? OpsRecorder.fromExport((o.trace as TraceExportWithOps).ops) : undefined,
        onHighlightCells: (cells) => ui.set({ aiFocusCells: cells?.length ? cells.map((c) => ({ cx: c.x, cy: c.y })) : null }),
        onHighlightRoute: (r) => ui.set({ routeFocus: r }),
      });
      present();
      // 顶栏的开关：打开 / 聚焦侧栏
      const toggle = h<HTMLButtonElement>(
        'button.btn.small.tr-toggle',
        { attrs: { type: 'button', 'aria-controls': dk.el.id }, onclick: () => (audio.play('click'), dk.focus()) },
        h('span.tr-live', { attrs: { 'aria-hidden': 'true' } }),
        h('span', null, t('agent.trace.toggle')),
      );
      view.exitBtn.before(toggle);
      tp.setTickLimit(0);
    } catch (e) {
      console.error('[ai] trace panel failed to load', e);
    }
  }

  view.play(
    { opts: JSON.parse(JSON.stringify(run.opts)) as RunOptions, log: run.log, tick: run.tick },
    {
      speeds: [1, 2, 4, 8],
      defaultSpeed: 2,
      status: (st, pct) => t('agent.replay.progress', { sub: o.subtitle, wave: st.wave, score: fmtNum(Math.round(st.score)), pct }),
      result: (st) => [
        h('p', null, t('agent.replay.result', { n: o.wave, wave: o.wave, score: fmtNum(o.score) })),
        Math.round(st.score) !== o.score
          ? h('small.muted', null, t('agent.replay.mismatch'))
          : h('small.muted', null, t('agent.replay.match')),
      ],
      onFrame: (tick) => tp?.setTickLimit(tick),
    },
  );
  return view.close;
}
