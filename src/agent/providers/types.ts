/**
 * 模型适配层接口（文档 10 §8）。
 *
 * 一次 decide() = 一个决策点：适配器拿到（固定的）系统提示 + 本次 user 消息 + 工具列表，
 * 自己跑"模型 → 工具 → 模型"的循环，每个工具调用都经 ctx.callTool() 交给游戏执行，
 * 直到 end_turn / 模型不再调用工具 / 工具调用次数用完 / 中止。
 * 每次决策都是一段新对话（不跨决策累积历史）：上下文长度恒定，缓存命中靠固定前缀。
 */
import type { IWorld } from '../../core/types';
import type { AgentToolDef } from '../tools';
import type { TraceSink } from '../trace';
import type { AgentRole, DecisionPoint, TokenUsage, ToolResult } from '../types';

export interface DecisionContext {
  role: AgentRole;
  point: DecisionPoint;
  /** 固定系统提示：[规则, 资料表]（逐字节稳定，供缓存） */
  system: [string, string];
  /** 本次决策的 user 消息（开局信息 + 原因 + 观测） */
  message: string;
  tools: AgentToolDef[];
  /** 执行一个工具（不抛异常）。meta.id = 模型那边的工具调用 id（思路与请求面板里对应用） */
  callTool(name: string, input: unknown, meta?: { id?: string }): Promise<ToolResult>;
  /**
   * 每次模型请求返回后调用（realtime 模式在这里推进世界）。
   * 返回 false = 本局已结束 / 被取消，适配器应立即返回。
   */
  afterRequest(ms: number): Promise<boolean>;
  /** 本次决策最多几次工具调用（含读取类） */
  maxToolCalls: number;
  /** 整局剩余 token 预算（适配器可用来缩小 max_tokens） */
  remainingTokens: number;
  signal: AbortSignal;
  /** 只给进程内的确定性策略（scripted）读状态用；远程模型不会拿到 */
  world?: IWorld;
  /**
   * 思路与请求（文档 10 §12.1）：适配器在这里报告请求参数 / 原始请求体、流式的思路与文字、响应与用量。
   * 可选；没有时适配器照常工作。写入的内容由缓冲区统一脱敏，但适配器自己也不要把密钥放进去。
   */
  trace?: TraceSink;
}

export interface DecisionOutcome {
  usage: TokenUsage;
  /** 本次决策估算费用（美元） */
  costUsd: number;
  toolCalls: number;
  /** 模型调用了 end_turn */
  ended: boolean;
  /** 模型的文字输出（截断后存档） */
  text?: string;
  /** 失败原因（出错 / 拒答 / 超出上下文……）；有值时 runner 用内置机器人补这一回合 */
  error?: string;
  /** 模型给下次决策的备忘 */
  note?: string;
}

export interface LLMProvider {
  /** 'claude-native' | 'pi:ollama' | 'scripted' | 'bridge' … */
  readonly id: string;
  readonly model: string;
  decide(ctx: DecisionContext): Promise<DecisionOutcome>;
  dispose?(): void;
}

/** 工具调用次数用完时返回给模型的文字 */
export const LIMIT_TEXT = 'ERROR tool-call limit for this decision reached; the turn is over.';
