/**
 * 已连接的本机桥接器（跨页面 / 跨对局保留：从对局回到设置页、或在对局里启用 AI 时不需要重新配对）。
 * 只在内存里；配对码不落盘。
 */
import type { LLMProvider } from '../../agent/providers/types';

export interface BridgeConn {
  provider: LLMProvider;
  url: string;
  code: string;
  alive: boolean;
  close(): void;
}

let current: BridgeConn | null = null;

export const getBridge = (): BridgeConn | null => current;

export function setBridge(b: BridgeConn | null): void {
  current = b;
}

/** 给控制器用的适配器：不带 dispose（一局结束 / 重开时连接保留，由设置里的「断开」负责关闭） */
export function bridgeProvider(): LLMProvider | undefined {
  const b = current;
  if (!b?.alive) return undefined;
  return { id: b.provider.id, model: b.provider.model, decide: (c) => b.provider.decide(c) };
}
