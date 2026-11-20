import type { Command, CommandResult, IWorld, RunOptions, TargetMode } from '../../core/types';
import type { Session } from '../../game/Session';
import type { App } from '../App';

export interface GameCtx {
  app: App;
  session: Session;
  world: IWorld;
  opts: RunOptions;
  /** 根元素（.game） */
  root: HTMLElement;
  /** 发送指令；失败时显示原因 */
  cmd(c: Command): CommandResult;
  toast(text: string, tone?: 'info' | 'warn' | 'good'): void;
  /** 打开传奇分支选择 */
  openBranch(uid: number): void;
  /** 当前是否横屏布局 */
  landscape(): boolean;
}

export const TARGET_NAME: Record<TargetMode, string> = {
  first: '先头',
  last: '末尾',
  strong: '最强',
  weak: '最弱',
  close: '最近',
  air: '对空',
};

export const RARITY_NAME = { common: '普通', rare: '稀有', epic: '史诗' } as const;

/** 1–9、0、-、= 对应塔栏第 1..12 个 */
export const BUILD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='];
export const SKILL_KEYS = ['Q', 'W', 'E', 'R'];

export const fmtSec = (s: number): string => (s >= 10 ? String(Math.ceil(s)) : s > 0 ? s.toFixed(1) : '0');

export function isTouchDevice(): boolean {
  try {
    return window.matchMedia('(hover: none)').matches;
  } catch {
    return false;
  }
}
