/**
 * 排行榜成绩的回放：先拉取「开局参数 + 种子 + 指令日志」，再交给通用播放器（src/ui/replay/viewer.ts）。
 * 画面与对局时相同（只读旁观），底部进度条可拖动跳转。
 */
import { fmtNumber, t } from '../../i18n';
import { fetchRun, type RunReplay } from '../../meta/online';
import { boardLabel } from '../../shared/leaderboard';
import type { App } from '../App';
import { MAP_META } from '../coreMeta';
import { h } from '../dom';
import { openReplayView } from '../replay/viewer';

/** 打开回放（先拉取数据）。返回关闭函数。 */
export function openReplay(app: App, runId: string, nickname?: string): () => void {
  const view = openReplayView(app, {
    title: nickname ? t('ui.online.replayOf', { name: nickname }) : t('ui.online.replay'),
    subtitle: t('ui.online.loading'),
    labels: {
      dialog: t('ui.online.watchReplay'),
      speed: t('ui.online.replaySpeed'),
      exit: t('ui.online.exit'),
      exitReplay: t('ui.online.exitReplay'),
      ended: t('ui.online.replayEnded'),
    },
  });
  let closed = false;
  view.onClose(() => (closed = true));

  void (async () => {
    const r = await fetchRun(runId);
    if (closed) return;
    if (!r.ok) {
      view.setSub(r.status === 'unavailable' ? t('ui.online.unavailable') : r.message || t('ui.online.loadFailed'));
      view.fail(t('ui.online.replayLoadFailed'), r.message);
      return;
    }
    start(r.data);
  })();

  function start(run: RunReplay): void {
    const map = MAP_META[run.opts.map]?.name ?? run.opts.map;
    view.play(
      { opts: { ...run.opts, seed: run.seed }, log: run.log, tick: run.result.ticks },
      {
        speeds: [1, 2, 4, 8],
        defaultSpeed: 1,
        status: (st, pct) =>
          t('ui.online.replayStatus', { board: boardLabel(run.board), map, wave: st.wave, score: fmtNumber(Math.round(st.score)), pct }),
        result: (st) => [
          h('p', null, t('ui.online.replayResult', { n: run.result.wave, score: fmtNumber(Math.round(run.result.score)) })),
          Math.round(st.score) !== run.result.score ? h('small.muted', null, t('ui.online.replayMismatch')) : null,
        ],
      },
    );
  }

  return view.close;
}
