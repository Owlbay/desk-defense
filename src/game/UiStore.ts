import type { SkillId, TowerId } from '../core/types';

/**
 * 界面交互状态（render 与 ui 共享）。
 * - render：处理棋盘上的指针/键盘（放塔、选塔、技能瞄准），读写本 store。
 * - ui：展示塔栏选中、信息面板、技能按钮状态，读写本 store。
 */
export interface UiState {
  /** 塔栏中选中的待建造塔 */
  build: TowerId | null;
  /** 选中的已有塔 */
  selected: number | null;
  /** 正在瞄准的技能 */
  aiming: SkillId | null;
  /** 横扫尺的方向 */
  aimAxis: 'row' | 'col';
  /** 搬家技能：已选中要搬的塔 uid，接下来选目标格 */
  relocateFrom: number | null;
  /** 增益"传奇在望"需要选塔时的增益 id */
  perkTargeting: string | null;
  /** 当前指针所在格（电脑悬停 / 手机首次点击的预览格） */
  hover: { cx: number; cy: number } | null;
  /** 手机：待确认的格（第二次点同一格才执行） */
  pending: { cx: number; cy: number } | null;
  /** 最近一次输入是否为触摸 */
  touch: boolean;
  /** 电脑：按住 Shift 连续放置 */
  shift: boolean;
  /** 文档 11：正在瞄准主动能力的神话塔 uid（null = 未瞄准） */
  abilityAiming: number | null;
  /** 方向型能力的当前瞄准角度（弧度，由棋盘写入，仅供显示） */
  abilityAngle: number | null;
  /** 文档 09：玩家点选的空降出生点 id（UI 据此显示拆除按钮） */
  spawnerSelected: string | null;
  /** 鼠标悬停中的掉落物 uid（电脑：悬停 + 空格收集） */
  hoverPickup: number | null;
  /** 文档 10：思路与请求面板里悬停的工具调用涉及的格子（棋盘上描一圈；null = 无） */
  aiFocus: { cx: number; cy: number } | null;
  /** 文档 10：操作解读里悬停的操作涉及的多个格子（一组意图 / 一行横扫等；null = 无） */
  aiFocusCells?: { cx: number; cy: number }[] | null;
  /**
   * 文档 10 §18-8：AI 操作 / 工具调用涉及的进攻路线（棋盘上画出整条路线折线 + 航点）。
   * ids = 出生点 id 列表（null = 全部开放路线）；air = 同时画飞行线（出生格中心 → 横向最近出口）。
   * 只存 id，折线由棋盘按当前世界状态现算（render 不依赖 agent）。玩家悬停 / 选中出生点时棋盘自己画，不经过这里。
   */
  routeFocus?: { ids: string[] | null; air: boolean } | null;
  /** AI 玩家操作中：棋盘只允许点选查看（塔 / 空降纸箱），不允许建造、施法、收集等会下指令的操作 */
  inspectOnly: boolean;
  /** 设置「显示推荐迷宫」：迷宫规划建议的墙格（格子索引 y*cols+x，只含当前空地；棋盘上淡淡画出；null = 不显示） */
  mazeHint?: number[] | null;
  /** 第一章摆迷宫教学：当前这一排推荐墙格（醒目的幽灵墙，点一下就放墙；null = 无） */
  mazeLesson?: number[] | null;
  /** 「给 AI 下指令」输入框聚焦时：点棋盘不下指令，而是把格子 / 塔编号插进输入框（null = 正常操作） */
  boardPick?: ((p: { cx: number; cy: number; uid: number }) => void) | null;
}

type Fn = (s: UiState) => void;

class Store {
  state: UiState = {
    build: null,
    selected: null,
    aiming: null,
    aimAxis: 'row',
    relocateFrom: null,
    perkTargeting: null,
    hover: null,
    pending: null,
    touch: false,
    shift: false,
    abilityAiming: null,
    abilityAngle: null,
    spawnerSelected: null,
    hoverPickup: null,
    aiFocus: null,
    inspectOnly: false,
  };
  private subs = new Set<Fn>();

  set(patch: Partial<UiState>): void {
    let changed = false;
    for (const k of Object.keys(patch) as (keyof UiState)[]) {
      if (this.state[k] !== patch[k]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.state = { ...this.state, ...patch };
    for (const fn of this.subs) fn(this.state);
  }

  /** 清除所有交互模式（Esc / 取消） */
  clear(): void {
    this.set({
      build: null,
      selected: null,
      aiming: null,
      relocateFrom: null,
      perkTargeting: null,
      pending: null,
      abilityAiming: null,
      abilityAngle: null,
      spawnerSelected: null,
      aiFocus: null,
      aiFocusCells: null,
      routeFocus: null,
    });
  }

  subscribe(fn: Fn): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
}

export const ui = new Store();
