import { CellKind, type MapId } from '../../core/types';
import { ui } from '../../game/UiStore';
import type { GameCtx } from './context';
import { builtSegments, remainingCells } from './maze-lesson';

/** 迷宫规划的结果里这里用到的部分（src/agent/maze.ts 的 MazePlan） */
interface Plan {
  segments: number[][];
  all: number[];
}

/**
 * 推荐迷宫：用内置机器人共用的迷宫规划器（src/agent/maze.ts 的 planMaze，按需动态加载）算出
 * 「横向挡板 + 两端交替缺口」的蛇形布局，供两处使用：
 *  - 第一章摆迷宫教学：当前这一排的幽灵墙（ui.mazeLesson，可点一下放墙）与「按推荐摆放」；
 *  - 设置「显示推荐迷宫」：整套推荐墙格淡淡画在棋盘上（ui.mazeHint）。
 * 只在地形变化（grid.version / 杂物布局）时重新计算，不逐帧计算。
 */
export class MazeGuide {
  private plan: Plan | null = null;
  private planKey = '';
  private loading = false;
  private destroyed = false;
  private ver = -1;
  private hintOn = false;
  private lessonSeg: number | null = null;
  /** 规划算好 / 地形变化后（教学据此更新进度） */
  onChange: (() => void) | null = null;

  constructor(private ctx: GameCtx) {}

  private get grid() {
    return this.ctx.world.state.grid;
  }

  /** 杂物布局签名：变了就要重新规划（规划器自己也按地图 + 杂物缓存） */
  private terrainKey(): string {
    const st = this.ctx.world.state;
    return `${st.opts.map as MapId}|${st.grid.obstacles.map((o) => `${o.x},${o.y},${o.w},${o.h}`).join(';')}`;
  }

  /** 需要规划时才加载规划器（教学或设置打开时） */
  private ensurePlan(): void {
    const key = this.terrainKey();
    if (this.plan && key === this.planKey) return;
    if (this.loading) return;
    this.loading = true;
    void import('../../agent/maze')
      .then((m) => {
        if (this.destroyed) return;
        // 规划要枚举几百种布局：让出这一帧再算
        setTimeout(() => {
          if (this.destroyed) return;
          this.loading = false;
          try {
            const p = m.planMaze(this.ctx.world);
            this.plan = { segments: p.segments, all: p.all };
          } catch (e) {
            console.error(e);
            this.plan = { segments: [], all: [] };
          }
          this.planKey = this.terrainKey();
          this.ver = -1;
          this.sync();
        }, 0);
      })
      .catch((e) => {
        // 加载失败（离线换版本等）：这一局不再提示，不反复重试
        console.error(e);
        this.loading = false;
        this.plan = { segments: [], all: [] };
        this.planKey = this.terrainKey();
      });
  }

  get ready(): boolean {
    return this.plan !== null && this.planKey === this.terrainKey();
  }

  private isEmpty = (i: number): boolean => this.grid.cells[i] === CellKind.Empty;

  /** 这一格现在还能放墙吗（金币不足也算能放） */
  private placeable = (i: number): boolean => {
    const { cols } = this.grid;
    const r = this.ctx.world.canPlace('wall', i % cols, Math.floor(i / cols));
    return r.ok || r.code === 'noGold';
  };

  /** 设置「显示推荐迷宫」 */
  setHint(on: boolean): void {
    if (on === this.hintOn) return;
    this.hintOn = on;
    this.ver = -1;
    this.sync();
  }

  /** 教学当前提示的挡板段（null = 不提示） */
  setLesson(seg: number | null): void {
    if (seg === this.lessonSeg) return;
    this.lessonSeg = seg;
    this.ver = -1;
    this.sync();
  }

  /** 从入口一侧数起已经建好的推荐段数（规划还没好时为 0） */
  built(): number {
    if (!this.ready || !this.plan) return 0;
    return builtSegments(this.plan.segments, this.isEmpty, this.placeable);
  }

  /** 规划里有没有第 k 段 */
  hasSegment(k: number): boolean {
    return !!this.plan && this.ready && (this.plan.segments[k]?.length ?? 0) > 0;
  }

  /** 每帧调用：地形变了才重新计算幽灵墙 */
  tick(): void {
    if (this.grid.version !== this.ver) this.sync();
  }

  private sync(): void {
    if (this.destroyed) return;
    const need = this.hintOn || this.lessonSeg !== null;
    if (!need) {
      this.ver = this.grid.version;
      ui.set({ mazeHint: null, mazeLesson: null });
      return;
    }
    this.ensurePlan();
    if (!this.ready || !this.plan) return;
    this.ver = this.grid.version;
    const plan = this.plan;
    const lesson = this.lessonSeg !== null ? remainingCells(plan.segments[this.lessonSeg], this.isEmpty, this.placeable) : null;
    const hint = this.hintOn ? plan.all.filter(this.isEmpty) : null;
    ui.set({ mazeLesson: lesson && lesson.length ? lesson : null, mazeHint: hint && hint.length ? hint : null });
    this.onChange?.();
  }

  /**
   * 「按推荐摆放」：把当前这一排剩下的推荐墙格按顺序放下（走正常的放置指令，规则与金币照常），
   * 金币不够就停。返回 { placed, short }：放了几格、是否因金币不足没放完。
   */
  placeLesson(): { placed: number; short: boolean } {
    const cells = ui.state.mazeLesson ?? [];
    const { cols } = this.grid;
    let placed = 0;
    for (const i of cells) {
      if (!this.isEmpty(i)) continue;
      const x = i % cols;
      const y = Math.floor(i / cols);
      const chk = this.ctx.world.canPlace('wall', x, y);
      if (chk.code === 'noGold') return { placed, short: true };
      if (!chk.ok) continue;
      if (this.ctx.cmd({ type: 'place', tower: 'wall', cx: x, cy: y }).ok) placed++;
    }
    return { placed, short: false };
  }

  destroy(): void {
    this.destroyed = true;
    this.onChange = null;
    ui.set({ mazeHint: null, mazeLesson: null });
  }
}
