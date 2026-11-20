/** 跨页面的小请求：例如结算面板跳到排行榜时指定打开「全服」页和哪个榜 */
export type LbTab = 'local' | 'global' | 'daily';

let pending: { tab: LbTab; board?: string } | null = null;

export function requestLeaderboardTab(tab: LbTab, board?: string): void {
  pending = { tab, board };
}

export function takeLeaderboardRequest(): { tab: LbTab; board?: string } | null {
  const p = pending;
  pending = null;
  return p;
}
