/**
 * Agent 参战（文档 10）—— 公共类型。
 *
 * 本目录（src/agent/）是纯 TS，不引用 DOM / Phaser，可在 Node（CLI、MCP、测试）与浏览器（之后的 UI）中复用。
 * 所有游戏操作最终都走 IWorld.command()，与玩家点击完全同一套校验。
 */
import type { Command, CommandResult, RunOptions } from '../core/types';

/** AI 玩家（真正下指令）/ AI 军师（只读 + 建议）/ AI 进攻方（设计阶段，协议桩） */
export type AgentRole = 'player' | 'advisor' | 'attacker';

/** pause：在决策点暂停世界等待 Agent；realtime：世界不等人，指令排队并在"思考延迟"之后落地 */
export type DecisionMode = 'pause' | 'realtime';

export type DecisionReason =
  | 'game_start'
  | 'build'          // 建造阶段（开局、手动开波前、自动模式下本波结束）
  | 'wave_interval'  // 波次进行中每 N 秒
  | 'event_warn'     // 随机事件预警
  | 'drop_warn'      // 空降出生点预警
  | 'boss_spawn'     // Boss 出场
  | 'perk'           // 增益三选一（世界已暂停）
  | 'crate'          // 补给箱待选择
  | 'leak';          // 本轮有漏怪（只作附加原因，不单独触发）

export interface DecisionPoint {
  seq: number;
  tick: number;
  time: number;
  wave: number;
  phase: string;
  reasons: DecisionReason[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  requests: number;
}

export const emptyUsage = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 });

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    requests: a.requests + b.requests,
  };
}

/** 计入预算的 token：全部输入（含缓存读写）+ 输出 */
export const usageTotal = (u: TokenUsage): number => u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;

/** 一次工具调用的记录 */
export interface ToolCallRecord {
  name: string;
  input: unknown;
  ok: boolean;
  /** 给模型看的结果文本（截断后存档） */
  result: string;
  /** 实际下达（或排队）的指令 */
  cmd?: Command;
  /** realtime 模式：排队后在哪一帧落地 */
  queuedFor?: number;
}

/** 军师的建议 */
export interface Suggestion {
  tick: number;
  wave: number;
  text: string;
  actions: string[];
}

export interface DecisionRecord {
  point: DecisionPoint;
  /** agent：模型自己完成；fallback：超时 / 出错 / 预算耗尽后由内置机器人接管 */
  by: 'agent' | 'fallback';
  fallbackReason?: string;
  toolCalls: ToolCallRecord[];
  usage: TokenUsage;
  ms: number;
  /** end_turn 的备忘（下一次决策时会回显给模型） */
  note?: string;
  observationTokens: number;
}

/** 内置机器人兜底（CLI 里接 scripts/bots 的 StrategyBot；浏览器里可接简单策略） */
export interface FallbackPolicy {
  readonly name: string;
  /** 在一个决策点替 Agent 做决定（直接调用 world.command，或经工具执行器） */
  decide(reasons: DecisionReason[]): void | Promise<void>;
  /** 每步调用（可选，例如捡硬币） */
  tick?(): void;
  onWaveStart?(wave: number): void;
  onWaveEnd?(wave: number): void;
  onLeak?(enemy: string): void;
}

/** 回放文件：与 src/meta/midrun.ts 的 MidRun 同形，额外带 agent 标记 */
export interface AgentReplay {
  v: 1;
  opts: RunOptions;
  tick: number;
  log: { tick: number; cmd: Command }[];
  wave: number;
  savedAt: number;
  agent: { provider: string; model: string; role: AgentRole };
}

export type CommandSink = (cmd: Command) => CommandResult & { queuedFor?: number };

// ───────────────────────── 运行配置 / 报告（runner / index 共用） ─────────────────────────

/** 一次工具执行的结果（给模型看的文本 + 结构化信息） */
export interface ToolResult {
  ok: boolean;
  text: string;
  cmd?: Command;
  /** end_turn：结束本次决策 */
  endTurn?: boolean;
  note?: string;
  queuedFor?: number;
}

/** 每波一行（CLI 进度与报告） */
export interface AgentWaveRow {
  wave: number;
  tick: number;
  gold: number;
  lives: number;
  leaks: number;
  towers: number;
  score: number;
  /** 截至本波结束的累计 token 与费用估算 */
  tokens: number;
  costUsd: number;
  decisions: number;
  fallbacks: number;
}

export interface AgentRunResult {
  outcome: 'won' | 'lost' | 'cap' | 'cancelled' | 'timeout';
  wave: number;
  cleared: number;
  score: number;
  lives: number;
  maxLives: number;
  kills: number;
  leaks: number;
  gold: number;
  ticks: number;
  seconds: number;
}
