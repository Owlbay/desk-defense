import type { Command, CommandResult, IWorld, RunOptions, TargetMode } from '../../core/types';
import type { AiAssist } from '../../meta/aiAssist';
import { t } from '../../i18n';
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
  /** 本局的 AI 助手公平性标记（启用 AI 时就地更新） */
  aiAssist?: AiAssist;
}

/** 瞄准模式名（getter：每次读取都按当前语言翻译） */
export const TARGET_NAME: Record<TargetMode, string> = {
  get first() { return t('ui.game.target.first'); },
  get last() { return t('ui.game.target.last'); },
  get strong() { return t('ui.game.target.strong'); },
  get weak() { return t('ui.game.target.weak'); },
  get close() { return t('ui.game.target.close'); },
  get air() { return t('ui.game.target.air'); },
};

export const RARITY_NAME: Readonly<Record<'common' | 'rare' | 'epic', string>> = {
  get common() { return t('ui.game.rarity.common'); },
  get rare() { return t('ui.game.rarity.rare'); },
  get epic() { return t('ui.game.rarity.epic'); },
};

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
