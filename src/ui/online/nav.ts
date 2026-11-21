/**
 * 跨页面的小请求：例如结算面板跳到排行榜时指定打开哪一页、哪个榜。
 * 排行榜四页：无尽 / 每日 / 战役 / AI 对战（独立的对战榜）。旧调用（'local' / 'global' + 旧榜键 'normal:auto' / 'ai:…'）按榜键归到新页面。
 */
import type { MapId } from '../../core/types';
import { normalizeBoardKey, parseBoard } from '../../shared/leaderboard';

export type LbTab = 'endless' | 'daily' | 'campaign' | 'duel';
/** 兼容旧调用方（src/ui/ai/report.ts 仍传 'global'） */
export type LbTabRequest = LbTab | 'local' | 'global';

export interface LbRequest {
  tab: LbTab;
  /** 每日挑战的日期 */
  day?: string;
  /** 战役章节 */
  map?: MapId;
}

let pending: LbRequest | null = null;

/** 由榜键推出该去哪一页 */
export function requestFor(tab: LbTabRequest, board?: string): LbRequest {
  const b = board ? parseBoard(normalizeBoardKey(board)) : null;
  if (b?.kind === 'daily') return { tab: 'daily', day: b.day };
  if (b?.kind === 'campaign') return { tab: 'campaign', map: b.map };
  if (b?.kind === 'endless') return { tab: 'endless' };
  return { tab: tab === 'daily' || tab === 'campaign' || tab === 'duel' ? tab : 'endless' };
}

export function requestLeaderboardTab(tab: LbTabRequest, board?: string): void {
  pending = requestFor(tab, board);
}

export function takeLeaderboardRequest(): LbRequest | null {
  const p = pending;
  pending = null;
  return p;
}
