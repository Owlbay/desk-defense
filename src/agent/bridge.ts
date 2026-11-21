/**
 * 本机桥接器协议（文档 10 §10.3）。
 *
 * 网页游戏（浏览器）只负责世界与工具执行；模型调用全部交给玩家电脑上的桥接器（scripts/agent-bridge.ts，Node）：
 *   - 桥接器用 pi / 官方 SDK 调模型：没有 CORS 问题，密钥留在本机环境变量 / `ant auth` 档案里，网页拿不到；
 *   - 默认只监听 127.0.0.1，必须先用一次性配对码握手，并校验 Origin（jjjj.games / localhost）。
 *
 * 消息（JSON 文本帧）：
 *   C→B hello {code, client, v}                    B→C welcome {provider, model, v} | error {message}
 *   C→B decide {id, role, point, system, message, tools, maxToolCalls, remainingTokens}
 *   B→C tool {id, call, name, input}                C→B tool_result {id, call, result}
 *   B→C after {id, call, ms}                        C→B after_result {id, call, alive}
 *   C→B abort {id}                                  B→C done {id, outcome}
 *   C→B ping                                        B→C pong
 *                                                   B→C trace {id, ev}（思路与请求：桥接器侧的请求 / 思路 / 响应，已脱敏；旧客户端忽略）
 * 本文件不依赖 ws 包：客户端用标准 WebSocket（浏览器 / Node 22+ 全局），服务端逻辑 createBridgeSession 只需要一个 send 函数。
 */
import type { AgentToolDef } from './tools';
import type { ThinkingLevel } from './config';
import type { AgentRole, DecisionPoint, ToolResult } from './types';
import { emptyUsage } from './types';
import { redactValue } from './redact';
import type { TraceInput } from './trace';
import type { DecisionContext, DecisionOutcome, LLMProvider } from './providers/types';

export const BRIDGE_PROTOCOL = 1;

export type BridgeClientMsg =
  | { t: 'hello'; code: string; client: string; v: number }
  | {
      t: 'decide';
      id: number;
      role: AgentRole;
      point: DecisionPoint;
      system: [string, string];
      message: string;
      tools: AgentToolDef[];
      maxToolCalls: number;
      remainingTokens: number;
      /** 可选（旧桥接器忽略）：上下文模式 / 预算分级给的输出上限、历史压缩阈值、思考覆盖 */
      maxOutputTokens?: number;
      historyCompactChars?: number;
      thinking?: ThinkingLevel;
    }
  | { t: 'tool_result'; id: number; call: number; result: ToolResult }
  | { t: 'after_result'; id: number; call: number; alive: boolean }
  | { t: 'abort'; id: number }
  | { t: 'ping' };

export type BridgeServerMsg =
  | { t: 'welcome'; provider: string; model: string; v: number }
  | { t: 'error'; message: string; id?: number }
  | { t: 'tool'; id: number; call: number; name: string; input: unknown; meta?: { id?: string } }
  | { t: 'after'; id: number; call: number; ms: number }
  | { t: 'done'; id: number; outcome: DecisionOutcome }
  | { t: 'trace'; id: number; ev: TraceInput }
  | { t: 'pong' };

/** 允许连接桥接器的网页来源（另加 --origin 参数） */
export const DEFAULT_BRIDGE_ORIGINS = ['https://jjjj.games', 'http://localhost', 'http://127.0.0.1', 'https://localhost'];

export function originAllowed(origin: string | undefined, extra: string[] = []): boolean {
  if (!origin) return true; // 非浏览器客户端（CLI、测试）不带 Origin；仍需配对码
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  const base = `${u.protocol}//${u.hostname}`;
  return [...DEFAULT_BRIDGE_ORIGINS, ...extra].some((o) => o === origin || o === base);
}

/** 6 位一次性配对码 */
export function makePairingCode(rand: () => number = Math.random): string {
  return String(Math.floor(rand() * 1e6)).padStart(6, '0');
}

// ───────────────────────── 服务端（桥接器里每个连接一个） ─────────────────────────

export interface BridgeSessionOptions {
  provider: LLMProvider;
  code: string;
  send: (m: BridgeServerMsg) => void;
  /** 配对成功后配对码作废（默认 true） */
  oneTime?: boolean;
  /** 转发思路与请求事件给网页（默认 true）。转发前脱敏；桥接器上的真实 Key 可登记在这里额外替换 */
  forwardTrace?: boolean;
  secrets?: string[];
  log?: (s: string) => void;
}

export interface BridgeSession {
  handle(raw: string): void;
  close(): void;
  readonly paired: boolean;
}

export function createBridgeSession(o: BridgeSessionOptions): BridgeSession {
  let paired = false;
  let used = false;
  let nextCall = 1;
  const pending = new Map<number, { kind: 'tool' | 'after'; res: (v: unknown) => void }>();
  const running = new Map<number, AbortController>();
  const wait = <T>(call: number, kind: 'tool' | 'after'): Promise<T> =>
    new Promise((res) => pending.set(call, { kind, res: res as (v: unknown) => void }));

  const runDecide = async (m: Extract<BridgeClientMsg, { t: 'decide' }>) => {
    const ac = new AbortController();
    running.set(m.id, ac);
    const ctx: DecisionContext = {
      role: m.role,
      point: m.point,
      system: m.system,
      message: m.message,
      tools: m.tools,
      maxToolCalls: Math.min(64, m.maxToolCalls),
      remainingTokens: m.remainingTokens,
      signal: ac.signal,
      ...(m.maxOutputTokens ? { maxOutputTokens: m.maxOutputTokens } : {}),
      ...(m.historyCompactChars ? { historyCompactChars: m.historyCompactChars } : {}),
      ...(m.thinking ? { thinking: m.thinking } : {}),
      callTool: async (name, input, meta) => {
        const call = nextCall++;
        o.send({ t: 'tool', id: m.id, call, name, input, ...(meta ? { meta } : {}) });
        return wait<ToolResult>(call, 'tool');
      },
      trace:
        (o.forwardTrace ?? true)
          ? (ev) => {
              try {
                // 密钥永远不离开桥接器：先脱敏再发（网页那边入库时还会再脱敏一次）
                o.send({ t: 'trace', id: m.id, ev: redactValue(ev, o.secrets ?? []) as TraceInput });
              } catch {
                /* 追踪失败不影响对局 */
              }
            }
          : undefined,
      afterRequest: async (ms) => {
        const call = nextCall++;
        o.send({ t: 'after', id: m.id, call, ms });
        return wait<boolean>(call, 'after');
      },
    };
    let outcome: DecisionOutcome;
    try {
      outcome = await o.provider.decide(ctx);
    } catch (e) {
      outcome = { usage: emptyUsage(), costUsd: 0, toolCalls: 0, ended: false, error: e instanceof Error ? e.message : String(e) };
    }
    running.delete(m.id);
    o.send({ t: 'done', id: m.id, outcome });
  };

  return {
    get paired() {
      return paired;
    },
    handle(raw: string) {
      let m: BridgeClientMsg;
      try {
        m = JSON.parse(raw) as BridgeClientMsg;
      } catch {
        o.send({ t: 'error', message: 'bad json' });
        return;
      }
      if (m.t === 'ping') {
        o.send({ t: 'pong' });
        return;
      }
      if (!paired) {
        if (m.t !== 'hello') {
          o.send({ t: 'error', message: 'not paired' });
          return;
        }
        if (used || m.code !== o.code) {
          o.send({ t: 'error', message: '配对码不对' });
          return;
        }
        paired = true;
        if (o.oneTime ?? true) used = true;
        o.log?.('paired');
        o.send({ t: 'welcome', provider: o.provider.id, model: o.provider.model, v: BRIDGE_PROTOCOL });
        return;
      }
      switch (m.t) {
        case 'decide':
          void runDecide(m);
          break;
        case 'tool_result':
          pending.get(m.call)?.res(m.result);
          pending.delete(m.call);
          break;
        case 'after_result':
          pending.get(m.call)?.res(m.alive);
          pending.delete(m.call);
          break;
        case 'abort':
          running.get(m.id)?.abort();
          break;
        default:
          break;
      }
    },
    close() {
      for (const ac of running.values()) ac.abort();
      for (const p of pending.values()) p.res(p.kind === 'after' ? false : { ok: false, text: 'ERROR bridge closed' });
      pending.clear();
    },
  };
}

// ───────────────────────── 客户端（网页里） ─────────────────────────

/** 最小 WebSocket 形状（浏览器 / Node 全局 WebSocket 都满足） */
export interface WsLike {
  send(data: string): void;
  close(): void;
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export class BridgeProvider implements LLMProvider {
  readonly id: string;
  readonly model: string;
  private nextId = 1;
  private ctxs = new Map<number, { ctx: DecisionContext; resolve: (o: DecisionOutcome) => void }>();

  constructor(
    private readonly ws: WsLike,
    welcome: Extract<BridgeServerMsg, { t: 'welcome' }>,
  ) {
    this.id = `bridge:${welcome.provider}`;
    this.model = welcome.model;
    ws.onmessage = (ev) => void this.onMessage(String(ev.data));
    ws.onclose = () => {
      for (const { resolve } of this.ctxs.values())
        resolve({ usage: emptyUsage(), costUsd: 0, toolCalls: 0, ended: false, error: 'bridge disconnected' });
      this.ctxs.clear();
    };
  }

  private async onMessage(raw: string): Promise<void> {
    const m = JSON.parse(raw) as BridgeServerMsg;
    if (m.t === 'tool') {
      const e = this.ctxs.get(m.id);
      const result: ToolResult = e ? await e.ctx.callTool(m.name, m.input, m.meta) : { ok: false, text: 'ERROR decision is over' };
      this.ws.send(JSON.stringify({ t: 'tool_result', id: m.id, call: m.call, result } satisfies BridgeClientMsg));
    } else if (m.t === 'after') {
      const e = this.ctxs.get(m.id);
      const alive = e ? await e.ctx.afterRequest(m.ms) : false;
      this.ws.send(JSON.stringify({ t: 'after_result', id: m.id, call: m.call, alive } satisfies BridgeClientMsg));
    } else if (m.t === 'trace') {
      const e = this.ctxs.get(m.id);
      if (e?.ctx.trace && m.ev && typeof m.ev === 'object' && typeof (m.ev as { k?: unknown }).k === 'string') {
        // 桥接器那边的事件：标上经由桥接器
        const ev = m.ev.k === 'request' ? { ...m.ev, provider: `bridge:${m.ev.provider}` } : m.ev;
        e.ctx.trace(ev);
      }
    } else if (m.t === 'done') {
      this.ctxs.get(m.id)?.resolve(m.outcome);
      this.ctxs.delete(m.id);
    }
  }

  decide(ctx: DecisionContext): Promise<DecisionOutcome> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.ctxs.set(id, { ctx, resolve });
      ctx.signal.addEventListener('abort', () => this.ws.send(JSON.stringify({ t: 'abort', id } satisfies BridgeClientMsg)));
      const msg: BridgeClientMsg = {
        t: 'decide',
        id,
        role: ctx.role,
        point: ctx.point,
        system: ctx.system,
        message: ctx.message,
        tools: ctx.tools,
        maxToolCalls: ctx.maxToolCalls,
        remainingTokens: Number.isFinite(ctx.remainingTokens) ? ctx.remainingTokens : 1e12,
        ...(ctx.maxOutputTokens ? { maxOutputTokens: ctx.maxOutputTokens } : {}),
        ...(ctx.historyCompactChars ? { historyCompactChars: ctx.historyCompactChars } : {}),
        ...(ctx.thinking ? { thinking: ctx.thinking } : {}),
      };
      this.ws.send(JSON.stringify(msg));
    });
  }

  dispose(): void {
    this.ws.close();
  }
}

/** 连接本机桥接器并配对（浏览器：connectBridge('ws://127.0.0.1:8787', '123456')） */
export function connectBridge(
  url: string,
  code: string,
  makeWs: (url: string) => WsLike = (u) => new WebSocket(u) as unknown as WsLike,
  timeoutMs = 8000,
): Promise<BridgeProvider> {
  return new Promise((resolve, reject) => {
    const ws = makeWs(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('连接桥接器超时'));
    }, timeoutMs);
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('连不上桥接器：确认已运行 npm run agent:bridge，并允许本地网络访问'));
    };
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', code, client: 'desk-defense', v: BRIDGE_PROTOCOL } satisfies BridgeClientMsg));
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as BridgeServerMsg;
      clearTimeout(timer);
      if (m.t === 'welcome') resolve(new BridgeProvider(ws, m));
      else if (m.t === 'error') {
        ws.close();
        reject(new Error(m.message));
      }
    };
  });
}
