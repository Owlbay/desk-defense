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
    });
  }

  subscribe(fn: Fn): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
}

export const ui = new Store();
