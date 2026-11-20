import type { Session } from '../game/Session';
import { Board } from './Board';
import type { Quality } from './layout';

export type { Quality as RenderQuality } from './layout';

let quality: Quality = 'high';
const boards = new Set<Board>();

/**
 * 在 parent 容器里挂载棋盘（Phaser 画布）。容器尺寸由 UI 的 CSS 决定，
 * 棋盘自动等比缩放居中，并按 devicePixelRatio 清晰渲染。
 * 渲染层在每帧调用 session.update(dt)，订阅 session.on 的事件做特效，
 * 并处理棋盘上的指针输入（读写 ui store）。
 */
export function mountBoard(parent: HTMLElement, session: Session): { destroy(): void } {
  const b = new Board(parent, session, quality);
  boards.add(b);
  return {
    destroy() {
      boards.delete(b);
      b.destroy();
    },
  };
}

/** 画质：high（DPR 上限 3，带发光与粒子）/ low（DPR 上限 2，关闭发光与大部分粒子） */
export function setRenderQuality(q: Quality): void {
  quality = q;
  for (const b of boards) b.setQuality(q);
}

export function getRenderQuality(): Quality {
  return quality;
}
