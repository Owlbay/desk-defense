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
  | 'build' // 建造阶段（开局、手动开波前、自动模式下本波结束）
  | 'wave_interval' // 波次进行中每 N 秒
  | 'event_warn' // 随机事件预警
  | 'drop_warn' // 空降出生点预警
  | 'boss_spawn' // Boss 出场
  | 'perk' // 增益三选一（世界已暂停）
  | 'crate' // 补给箱待选择
  | 'leak' // 本轮有漏怪（只作附加原因，不单独触发）
  | 'player'; // 玩家下了一次性指令（立即决策，绕过门控）

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

/** 原始 token 总数：全部输入（含缓存读写）+ 输出（不加权，只用于展示 / 对账） */
export const usageTotal = (u: TokenUsage): number => u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
export const usageRaw = usageTotal;

/**
 * 预算折算权重（按真实成本）：新输入 1、输出 1、缓存写 1.25、缓存读 0.1。
 * 实测（中转 deepseek-flash）57% 的 token 是缓存读：按原始总数计预算会让网页默认 1M 预算在第 12 波左右就耗尽。
 * 输出的单价通常是输入的数倍，这里仍记 1×——预算只是"量"的上限，费用另由 budget.usd 控制。
 */
export const BUDGET_WEIGHTS = { input: 1, output: 1, cacheWrite: 1.25, cacheRead: 0.1 } as const;

/** 折算预算 token = 新输入 + 输出 + 缓存写×1.25 + 缓存读×0.1（budget.tokens 按这个比较） */
export function budgetTokens(u: TokenUsage): number {
  const w = BUDGET_WEIGHTS;
  return Math.round(
    u.inputTokens * w.input + u.outputTokens * w.output + u.cacheWriteTokens * w.cacheWrite + u.cacheReadTokens * w.cacheRead,
  );
}

/** 用量分解（面板 / 报告用） */
export interface UsageBreakdown {
  /** 新输入（未命中缓存） */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** 原始总数 */
  raw: number;
  /** 折算预算 */
  weighted: number;
  requests: number;
}

export function usageBreakdown(u: TokenUsage): UsageBreakdown {
  return {
    input: u.inputTokens,
    cacheRead: u.cacheReadTokens,
    cacheWrite: u.cacheWriteTokens,
    output: u.outputTokens,
    raw: usageTotal(u),
    weighted: budgetTokens(u),
    requests: u.requests,
  };
}

/** 中文一行：新输入 / 缓存读 / 缓存写 / 输出 / 折算预算 */
export function usageLine(u: TokenUsage, fmt: (n: number) => string = (n) => String(n)): string {
  return `新输入 ${fmt(u.inputTokens)} · 缓存读 ${fmt(u.cacheReadTokens)} · 缓存写 ${fmt(u.cacheWriteTokens)} · 输出 ${fmt(u.outputTokens)} · 折算预算 ${fmt(budgetTokens(u))}`;
}

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
  /** agent：模型自己完成；fallback：超时 / 出错 / 预算耗尽后由内置机器人接管；local：决策门控判定无可行动作，未调用模型 */
  by: 'agent' | 'fallback' | 'local';
  /** by = local 时的跳过原因 */
  skipped?: string;
  fallbackReason?: string;
  toolCalls: ToolCallRecord[];
  usage: TokenUsage;
  ms: number;
  /** end_turn 的备忘（下一次决策时会回显给模型） */
  note?: string;
  observationTokens: number;
  /** 这次决策带上的玩家指令（「给 AI 下指令」）与 AI 的回应 */
  instructions?: { id: number; text: string; kind: 'once' | 'standing'; ack?: string; ackCode?: string }[];
  /** AI 对战（双模型，文档 10 §2.3）：这条记录属于进攻方还是防守方；单模型对局不设 */
  side?: DuelSide;
}

/** AI 对战里的一方：attack = 进攻方（改写下一波），defend = 防守方（AI 玩家） */
export type DuelSide = 'attack' | 'defend';

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
  /** AI 对战：进攻方模型（防守方在 agent 里）；回放只看指令日志，与它无关 */
  attacker?: { provider: string; model: string };
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
  /** act {end:{plan,maze,priorities}}：结构化备忘（跨决策记忆） */
  memo?: Partial<Record<'plan' | 'maze' | 'priorities' | 'note', string>>;
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
  /** 截至本波结束的累计 token（原始总数）与费用估算 */
  tokens: number;
  /** 截至本波结束的累计折算预算 token */
  weighted: number;
  /** 截至本波结束的累计模型请求数 */
  requests: number;
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
