/**
 * AI 助手的公平性标记（纯数据 / 纯函数，无 DOM）。
 *
 * 每局记录用过哪些 AI 角色：
 *  - advisor（军师）：只给建议，真人自己操作 → 没有任何限制；
 *  - player（替我玩）：AI 下过指令 → 本局标记为「AI 协助」：不上传全服榜 / 每日挑战榜，
 *    本地排行榜条目打上标记（默认不显示）；战役进度 / 星星 / 墨水照常发放。
 * 标记随中途存档（MidRun.aiAssist）保存，读档后保留。
 */
export interface AiAssist {
  /** 本局用过「让 AI 替我玩」 */
  player: boolean;
  /** 本局用过「让 AI 给建议」 */
  advisor: boolean;
  /** 最近一次启用的模型（界面显示用，例如「离线演示」「Claude · claude-sonnet-5-5」） */
  model?: string;
}

export type AiAssistRole = 'player' | 'advisor';

export function emptyAssist(): AiAssist {
  return { player: false, advisor: false };
}

/** 启用某个角色时调用（一经标记，本局不再清除） */
export function markAssist(a: AiAssist, role: AiAssistRole, model?: string): AiAssist {
  if (role === 'player') a.player = true;
  else a.advisor = true;
  if (model) a.model = model.slice(0, 120);
  return a;
}

export const usedAi = (a: AiAssist | null | undefined): boolean => !!a && (a.player || a.advisor);

/** 本局是否算「AI 协助」（替我玩过；只用过军师不算） */
export const isAiAssisted = (a: AiAssist | null | undefined): boolean => !!a?.player;

/** 存档里读出的任意值 → 合法标记；没用过 AI 时返回 undefined（不写进存档） */
export function sanitizeAssist(x: unknown): AiAssist | undefined {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return undefined;
  const o = x as Record<string, unknown>;
  const a: AiAssist = { player: o.player === true, advisor: o.advisor === true };
  if (typeof o.model === 'string' && o.model) a.model = o.model.slice(0, 120);
  return usedAi(a) ? a : undefined;
}

/** 复制一份（写进存档时用） */
export function cloneAssist(a: AiAssist | null | undefined): AiAssist | undefined {
  return usedAi(a) ? sanitizeAssist(a) : undefined;
}
