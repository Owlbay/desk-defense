import { CELL_PX, GRID_COLS, GRID_ROWS } from '../../core/types';
import { h } from '../dom';
import { G } from '../icons';
import { anim, reduced } from './motion';

interface Geo {
  /** 棋盘左上角相对特效层的位置、每格像素 */
  ox: number;
  oy: number;
  cell: number;
  /** 落点（金币图标中心） */
  tx: number;
  ty: number;
}

const MAX_ALIVE = 8;
const MAX_PER_FRAME = 2;

/**
 * 金币飞入顶栏：击杀 / 拾取位置冒出一枚小硬币，飞进金币数字。
 * 性能：几何信息缓存（只在尺寸变化后的下一次使用时读一次布局）；
 * 同屏最多 8 枚、每帧最多起飞 2 枚，多出来的直接合并入账；硬币节点复用。
 */
export class GoldFx {
  readonly el: HTMLElement;
  private queue: { x: number; y: number; amount: number }[] = [];
  private pool: HTMLElement[] = [];
  private alive = 0;
  private geo: Geo | null = null;

  constructor(
    private boardHost: HTMLElement,
    private target: () => HTMLElement,
    private onArrive: (amount: number) => void,
  ) {
    this.el = h('div.g-fx', { attrs: { 'aria-hidden': 'true' } });
  }

  /** 布局变了（横竖屏、窗口尺寸、面板高度）：下次用到时重新测量 */
  invalidate(): void {
    this.geo = null;
  }

  /** x/y 为格坐标；没有位置的金币直接入账 */
  push(amount: number, x?: number, y?: number): void {
    if (amount <= 0) return;
    if (x === undefined || y === undefined || reduced() || document.hidden) {
      this.onArrive(amount);
      return;
    }
    this.queue.push({ x, y, amount });
  }

  /** 每帧调用一次（HUD 的 rAF 里） */
  flush(): void {
    const q = this.queue;
    if (q.length === 0) return;
    const geo = this.geo ?? this.measure();
    let started = 0;
    let merged = 0;
    for (const it of q) {
      if (geo && started < MAX_PER_FRAME && this.alive < MAX_ALIVE) {
        started++;
        this.fly(geo, it.x, it.y, it.amount);
      } else merged += it.amount;
    }
    q.length = 0;
    if (merged > 0) this.onArrive(merged);
  }

  private measure(): Geo | null {
    const host = this.el.getBoundingClientRect();
    const b = this.boardHost.getBoundingClientRect();
    const t = this.target().getBoundingClientRect();
    if (b.width <= 0 || b.height <= 0 || t.width <= 0) return null;
    const bw = GRID_COLS * CELL_PX;
    const bh = GRID_ROWS * CELL_PX;
    const s = Math.min(b.width / bw, b.height / bh);
    this.geo = {
      ox: b.left - host.left + (b.width - bw * s) / 2,
      oy: b.top - host.top + (b.height - bh * s) / 2,
      cell: CELL_PX * s,
      tx: t.left - host.left + t.width / 2,
      ty: t.top - host.top + t.height / 2,
    };
    return this.geo;
  }

  private fly(g: Geo, x: number, y: number, amount: number): void {
    const coin = this.pool.pop() ?? h('span.gold-fly', { html: G.coin });
    const x0 = g.ox + x * g.cell;
    const y0 = g.oy + y * g.cell;
    const dx = g.tx - x0;
    const dy = g.ty - y0;
    // 先向上弹一下，再加速飞向金币栏
    const a = anim(
      coin,
      [
        {
          transform: `translate(${x0.toFixed(1)}px, ${y0.toFixed(1)}px) scale(0.3)`,
          opacity: 0,
          easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
        },
        {
          transform: `translate(${(x0 + dx * 0.06).toFixed(1)}px, ${(y0 - 20).toFixed(1)}px) scale(1)`,
          opacity: 1,
          offset: 0.28,
          easing: 'cubic-bezier(0.55, 0, 0.85, 0.4)',
        },
        { transform: `translate(${g.tx.toFixed(1)}px, ${g.ty.toFixed(1)}px) scale(0.55)`, opacity: 0.9 },
      ],
      { duration: 460 + Math.min(240, Math.hypot(dx, dy) * 0.35), fill: 'both' },
    );
    if (!a) {
      this.onArrive(amount);
      return;
    }
    this.alive++;
    this.el.appendChild(coin);
    const done = () => {
      a.onfinish = a.oncancel = null;
      this.alive--;
      coin.remove();
      a.cancel();
      if (this.pool.length < MAX_ALIVE) this.pool.push(coin);
      this.onArrive(amount);
    };
    a.onfinish = a.oncancel = done;
  }
}
