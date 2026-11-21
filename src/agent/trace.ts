/**
 * 思路与请求（文档 10 §12.1）：与厂商无关的决策追踪事件流 + 内存环形缓冲。
 *
 * 一次决策 = decision_start → (request → thinking* / text* → response)* 与 tool_call / tool_result 交错 → [error] [fallback] → decision_end。
 *  - 引擎（engine.ts）负责 decision_start / tool_call / tool_result / error / fallback / decision_end（所有适配器都有）；
 *  - 适配器经 DecisionContext.trace 补充 request / thinking / text / response（各家 API 的细节）；
 *  - 本机桥接器把桥接器那一侧的事件经 WebSocket 原样转发过来（bridge.ts 的 trace 消息）。
 * 大块且重复的文本（系统提示词、工具定义、观测）只存一份（按哈希去重的 blobs），事件里放哈希。
 * 一切字符串入库前先脱敏（./redact.ts）；缓冲区按条数 + 字符数封顶，超出时丢最旧的事件。
 * 纯 TS、无 DOM：Node（CLI / 测试）与浏览器通用。
 */
import { redactJson, redactString, redactValue } from './redact';
import { addUsage, emptyUsage, type TokenUsage } from './types';

// ───────────────────────── 事件 ─────────────────────────

export interface TraceBase {
  /** 决策编号（本缓冲区内自增，跨控制器重启也不重复） */
  d: number;
  /** 墙钟时间（epoch ms） */
  t: number;
}

export type TraceBody =
  | {
      k: 'decision_start';
      trigger: string[];
      wave: number;
      /** 游戏时间（秒） */
      time: number;
      tick: number;
      phase: string;
      provider: string;
      model: string;
      role: string;
      /** 发送给模型的局面（观测文本，含 ASCII 地图）——blob 哈希 */
      observationHash?: string;
      /** 固定系统提示词（规则 + 资料表）——blob 哈希 */
      systemHash?: string;
      /** 工具定义（完整 JSON Schema 列表）——blob 哈希 */
      toolsHash?: string;
      toolNames?: string[];
      /** 上下文模式（saver / balanced / full） */
      contextMode?: string;
      /** 本次发的是增量观测 */
      delta?: boolean;
      /** 门控跳过的原因（有值 = 没有调用模型） */
      skipped?: string;
      /** 预算分级 0..3 */
      budgetStage?: number;
    }
  | {
      /** 上下文已压缩（预算分级上升时）：before / after 为估算 token */
      k: 'compact';
      n: number;
      before: number;
      after: number;
      stage: number;
      reason: string;
    }
  | {
      k: 'request';
      /** 本次决策里的第几次请求（1 起） */
      n: number;
      provider: string;
      /** 'anthropic-messages' | 'openai-completions' | 'openai-responses' | 'google-generative-ai' | 'json-mode' | 'local' … */
      api: string;
      model: string;
      /** 请求发往的主机（只显示主机名，不含路径参数） */
      host?: string;
      effort?: string;
      /** 实际生效的思考设置（各厂商映射之后，例如 "between_tools（无思考）· effort low"） */
      thinking?: string;
      /** 思考设置的提示（例如 "Opus 5.5 不支持关闭思考，已用最低强度"） */
      thinkingNote?: string;
      /** 本次请求前把多少条较早的工具结果压成了摘要 */
      compacted?: number;
      /** 关键参数（max_tokens、thinking、tool_choice、temperature……） */
      params?: Record<string, unknown>;
      /** 本次请求实际用的系统提示词（与 decision_start 不同时才有，例如拼了 JSON 模式说明） */
      systemHash?: string;
      toolsHash?: string;
      toolNames?: string[];
      /** 对话里的消息条数（第 2 次起含助手回复与工具结果） */
      messages?: number;
      /** 请求头（已脱敏） */
      headers?: Record<string, string>;
      /** 原始请求体 JSON（已脱敏、封顶；系统提示 / 工具定义可能以 "$blob:哈希" 代替，导出 / 复制时还原） */
      raw?: string;
      rawChars?: number;
    }
  | {
      /** 适配器拿到了真正发出的请求体（pi 的 onPayload）：替换同一请求 n 的原始请求 JSON */
      k: 'request_raw';
      n: number;
      raw: string;
      rawChars: number;
    }
  | { k: 'thinking'; n: number; text: string }
  | { k: 'text'; n: number; text: string }
  | { k: 'tool_call'; id: string; name: string; args: unknown }
  | {
      k: 'tool_result';
      id: string;
      name: string;
      ok: boolean;
      text: string;
      /** 游戏里实际发生的变化摘要（金币 / 生命 / 塔数 / 阶段） */
      effect?: string;
      /** 涉及的格子（棋盘高亮用） */
      cell?: { x: number; y: number };
    }
  | {
      k: 'response';
      n: number;
      stop?: string;
      usage: TokenUsage;
      ms: number;
      costUsd?: number;
      /** 原始响应 JSON（已脱敏、封顶） */
      raw?: string;
      rawChars?: number;
    }
  | { k: 'error'; n?: number; message: string; retry?: boolean }
  | { k: 'fallback'; reason: string; acted: boolean; effect?: string }
  /** 中心策略切换（§20；模型在 act 的 end.doctrine 里改） */
  | { k: 'doctrine'; from: string; to: string; by: string; why?: string; wave: number }
  | {
      /** 本次决策带上的玩家指令（「给 AI 下指令」；once = 这次执行，standing = 长期方针） */
      k: 'instruction';
      items: { id: number; text: string; kind: 'once' | 'standing' }[];
    }
  | {
      /** 决策结束时 AI 对每条一次性指令的回应（ack = 模型原话；code = 没有原话时的状态） */
      k: 'instruction_ack';
      items: { id: number; ack?: string; code?: string }[];
    }
  | {
      k: 'decision_end';
      by: 'agent' | 'fallback' | 'local';
      /** by = local：门控跳过原因 */
      skipped?: string;
      ms: number;
      usage: TokenUsage;
      costUsd: number;
      toolCalls: number;
      note?: string;
      fallbackReason?: string;
    };

export type TraceEvent = TraceBase & TraceBody;
export type TraceKind = TraceBody['k'];

/** 适配器 / 引擎写入时用的形状：大文本直接给原文（system / observation / toolDefs / raw），由缓冲区去重、脱敏、封顶 */
export type TraceInput =
  | (Extract<TraceBody, { k: 'decision_start' }> & { observation?: string; system?: string; toolDefs?: unknown })
  | (Omit<Extract<TraceBody, { k: 'request' }>, 'raw' | 'rawChars' | 'headers'> & {
      system?: string;
      toolDefs?: unknown;
      raw?: unknown;
      headers?: Record<string, unknown>;
    })
  | (Omit<Extract<TraceBody, { k: 'response' }>, 'raw' | 'rawChars'> & { raw?: unknown })
  | { k: 'request_raw'; n: number; raw: unknown }
  | Exclude<TraceBody, { k: 'decision_start' | 'request' | 'response' | 'request_raw' }>;

/** 给适配器的写入口（已绑定到当前决策）。不抛异常 */
export type TraceSink = (ev: TraceInput) => void;

export interface TraceExport {
  v: 1;
  kind: 'desk-defense-agent-trace';
  exportedAt: number;
  note: string;
  blobs: Record<string, string>;
  events: TraceEvent[];
  /** 因封顶而丢掉的最旧事件数 */
  dropped: number;
}

export interface TraceTotals {
  decisions: number;
  /** 门控跳过（没有调用模型）的决策数 */
  skipped: number;
  /** 上下文压缩次数 */
  compactions: number;
  /** 平均每次（真正调用模型的）决策的请求数 */
  requestsPerDecision: number;
  requests: number;
  usage: TokenUsage;
  costUsd: number;
  avgLatencyMs: number;
  toolCalls: number;
  errors: number;
  fallbacks: number;
}

export interface AgentTraceOptions {
  /** 最多保留多少条事件（默认 20000） */
  maxEvents?: number;
  /** 事件总字符数上限（默认 6M） */
  maxChars?: number;
  /** blobs 总字符数上限（默认 3M） */
  maxBlobChars?: number;
  /** 单个原始请求 / 响应 JSON 上限（默认 64k 字符） */
  maxRawChars?: number;
  /** 单条思路 / 文字事件上限（默认 40k 字符） */
  maxTextChars?: number;
}

// ───────────────────────── 工具函数 ─────────────────────────

/** FNV-1a 32 位 + 长度（同步、够用来去重 / 展示） */
export function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16).padStart(8, '0')}-${s.length.toString(36)}`;
}

/** URL → 主机名（不含路径、参数） */
export function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

const now = (): number => Date.now();

function sizeOf(e: TraceEvent): number {
  let n = 120;
  switch (e.k) {
    case 'request':
      n += (e.raw?.length ?? 0) + 200;
      break;
    case 'request_raw':
      n += e.raw.length;
      break;
    case 'response':
      n += (e.raw?.length ?? 0) + 100;
      break;
    case 'thinking':
    case 'text':
      n += e.text.length;
      break;
    case 'tool_result':
      n += e.text.length + (e.effect?.length ?? 0);
      break;
    case 'tool_call':
      n += 200;
      break;
    case 'error':
      n += e.message.length;
      break;
    case 'instruction':
      n += e.items.reduce((a, x) => a + x.text.length + 20, 0);
      break;
    case 'instruction_ack':
      n += e.items.reduce((a, x) => a + (x.ack?.length ?? 0) + 20, 0);
      break;
    default:
      break;
  }
  return n;
}

const SYSTEM_BLOB_RE = /"\$blob:([0-9a-f]{8}-[0-9a-z]+)"/g;

// ───────────────────────── 缓冲区 ─────────────────────────

export class AgentTrace {
  private evs: TraceEvent[] = [];
  private chars = 0;
  private blobsMap = new Map<string, string>();
  private blobChars = 0;
  private subs = new Set<(ev: TraceEvent) => void>();
  private secrets: string[] = [];
  private nextD = 1;
  private droppedCount = 0;
  private readonly o: Required<AgentTraceOptions>;

  constructor(o: AgentTraceOptions = {}) {
    this.o = {
      maxEvents: o.maxEvents ?? 20_000,
      maxChars: o.maxChars ?? 6_000_000,
      maxBlobChars: o.maxBlobChars ?? 3_000_000,
      maxRawChars: o.maxRawChars ?? 64_000,
      maxTextChars: o.maxTextChars ?? 40_000,
    };
  }

  /** 登记一个真实密钥：之后任何位置出现都替换为 •••（密钥本身不保存到事件里） */
  addSecret(s: string | undefined): void {
    if (s && s.length >= 6 && !this.secrets.includes(s)) this.secrets.push(s);
  }

  get dropped(): number {
    return this.droppedCount;
  }

  get size(): { events: number; chars: number; blobChars: number } {
    return { events: this.evs.length, chars: this.chars, blobChars: this.blobChars };
  }

  events(): readonly TraceEvent[] {
    return this.evs;
  }

  blob(hash: string | undefined): string | undefined {
    return hash ? this.blobsMap.get(hash) : undefined;
  }

  /** 订阅新事件（思路 / 文字是增量：ev.text 只含新的一段） */
  subscribe(fn: (ev: TraceEvent) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  /** 存一段大文本（脱敏后），返回哈希 */
  intern(text: string): string {
    const clean = redactString(text, this.secrets);
    const h = hashText(clean);
    const had = this.blobsMap.get(h);
    if (had !== undefined) {
      // LRU：移到最后
      this.blobsMap.delete(h);
      this.blobsMap.set(h, had);
      return h;
    }
    this.blobsMap.set(h, clean);
    this.blobChars += clean.length;
    while (this.blobChars > this.o.maxBlobChars && this.blobsMap.size > 1) {
      const first = this.blobsMap.keys().next().value as string;
      if (first === h) break;
      this.blobChars -= this.blobsMap.get(first)!.length;
      this.blobsMap.delete(first);
    }
    return h;
  }

  private internJson(v: unknown): string {
    let s: string;
    try {
      s = JSON.stringify(redactValue(v, this.secrets), null, 2) ?? 'null';
    } catch {
      s = '"[无法序列化]"';
    }
    return this.intern(s);
  }

  /** 开始一次决策，返回绑定到这次决策的写入口 */
  begin(start: Extract<TraceInput, { k: 'decision_start' }>): TraceSink & { readonly d: number } {
    const d = this.nextD++;
    const sink = ((ev: TraceInput) => {
      try {
        this.add(d, ev);
      } catch (e) {
        // 追踪永远不能影响对局
        if (typeof console !== 'undefined') console.warn('[trace]', e);
      }
    }) as TraceSink & { d: number };
    sink.d = d;
    sink(start);
    return sink;
  }

  /** 写入一条事件（d = begin() 给的决策号） */
  add(d: number, ev: TraceInput): void {
    const t = now();
    const sec = this.secrets;
    let out: TraceEvent;
    switch (ev.k) {
      case 'decision_start': {
        const { observation, system, toolDefs, ...rest } = ev;
        out = {
          ...rest,
          d,
          t,
          observationHash: observation !== undefined ? this.intern(observation) : rest.observationHash,
          systemHash: system !== undefined ? this.intern(system) : rest.systemHash,
          toolsHash: toolDefs !== undefined ? this.internJson(toolDefs) : rest.toolsHash,
        };
        break;
      }
      case 'request': {
        const { system, toolDefs, raw, headers, ...rest } = ev;
        const r = raw !== undefined ? redactJson(raw, sec, this.o.maxRawChars) : undefined;
        out = {
          ...rest,
          d,
          t,
          params: rest.params ? (redactValue(rest.params, sec) as Record<string, unknown>) : undefined,
          systemHash: system !== undefined ? this.intern(system) : rest.systemHash,
          toolsHash: toolDefs !== undefined ? this.internJson(toolDefs) : rest.toolsHash,
          headers: headers ? (redactValue(headers, sec) as Record<string, string>) : undefined,
          raw: r?.json,
          rawChars: r?.chars,
        };
        break;
      }
      case 'request_raw': {
        const r = redactJson(ev.raw, sec, this.o.maxRawChars);
        out = { k: 'request_raw', n: ev.n, d, t, raw: r.json, rawChars: r.chars };
        break;
      }
      case 'response': {
        const { raw, ...rest } = ev;
        const r = raw !== undefined ? redactJson(raw, sec, this.o.maxRawChars) : undefined;
        out = { ...rest, d, t, raw: r?.json, rawChars: r?.chars };
        break;
      }
      case 'thinking':
      case 'text': {
        if (!ev.text) return;
        const text = redactString(ev.text, sec);
        const delta: TraceEvent = { ...ev, text, d, t };
        // 连续的同类增量合并成一条存储（订阅者仍收到增量）
        const last = this.evs[this.evs.length - 1];
        if (last && last.k === ev.k && last.d === d && (last as { n: number }).n === ev.n) {
          const l = last as Extract<TraceEvent, { k: 'thinking' | 'text' }>;
          if (l.text.length < this.o.maxTextChars) {
            const add = text.slice(0, this.o.maxTextChars - l.text.length);
            l.text += add;
            l.t = t;
            this.chars += add.length;
          }
          this.emit(delta);
          return;
        }
        out = { ...delta, text: text.slice(0, this.o.maxTextChars) };
        this.store(out);
        this.emit(delta);
        return;
      }
      case 'tool_call':
        out = { ...ev, d, t, args: redactValue(ev.args, sec) };
        break;
      case 'tool_result':
        out = { ...ev, d, t, text: redactString(ev.text, sec).slice(0, 8000), effect: ev.effect && redactString(ev.effect, sec) };
        break;
      case 'error':
        out = { ...ev, d, t, message: redactString(ev.message, sec).slice(0, 4000) };
        break;
      case 'compact':
        out = { ...ev, d, t, reason: redactString(ev.reason, sec) };
        break;
      case 'instruction':
        out = { ...ev, d, t, items: ev.items.map((x) => ({ ...x, text: redactString(x.text, sec).slice(0, 400) })) };
        break;
      case 'instruction_ack':
        out = { ...ev, d, t, items: ev.items.map((x) => ({ ...x, ack: x.ack && redactString(x.ack, sec).slice(0, 400) })) };
        break;
      case 'fallback':
        out = { ...ev, d, t, reason: redactString(ev.reason, sec), effect: ev.effect && redactString(ev.effect, sec) };
        break;
      case 'doctrine':
        out = { ...ev, d, t, why: ev.why && redactString(ev.why, sec).slice(0, 400) };
        break;
      case 'decision_end':
        out = {
          ...ev,
          d,
          t,
          note: ev.note && redactString(ev.note, sec),
          fallbackReason: ev.fallbackReason && redactString(ev.fallbackReason, sec),
        };
        break;
    }
    this.store(out);
    this.emit(out);
  }

  private store(e: TraceEvent): void {
    this.evs.push(e);
    this.chars += sizeOf(e);
    if (this.evs.length > this.o.maxEvents || this.chars > this.o.maxChars) {
      // 一次丢掉约 10%，避免每条都 O(n) 搬移
      const targetEvents = Math.floor(this.o.maxEvents * 0.9);
      const targetChars = Math.floor(this.o.maxChars * 0.9);
      let i = 0;
      let c = this.chars;
      while (i < this.evs.length - 1 && (this.evs.length - i > targetEvents || c > targetChars)) {
        c -= sizeOf(this.evs[i]);
        i++;
      }
      this.evs.splice(0, i);
      this.chars = c;
      this.droppedCount += i;
    }
  }

  private emit(e: TraceEvent): void {
    for (const fn of this.subs) {
      try {
        fn(e);
      } catch (err) {
        if (typeof console !== 'undefined') console.warn('[trace] subscriber', err);
      }
    }
  }

  /** 把原始请求里的 "$blob:哈希" 占位还原成完整文本（复制 / 导出用） */
  inflate(raw: string): string {
    return raw.replace(SYSTEM_BLOB_RE, (m, h: string) => {
      const b = this.blobsMap.get(h);
      return b === undefined ? m : JSON.stringify(b);
    });
  }

  totals(): TraceTotals {
    return computeTotals(this.evs);
  }

  /**
   * 导出（全部已脱敏）。maxChars：整体 JSON 大约不超过这么多字符——先去掉原始请求 / 响应，仍超出再丢最旧的决策。
   */
  export(o: { maxChars?: number } = {}): TraceExport {
    const blobs: Record<string, string> = {};
    for (const [k, v] of this.blobsMap) blobs[k] = v;
    let events = this.evs.slice();
    let dropped = this.droppedCount;
    const max = o.maxChars;
    if (max) {
      const est = () => events.reduce((n, e) => n + sizeOf(e), 0) + Object.values(blobs).reduce((n, b) => n + b.length, 0);
      if (est() > max) {
        events = events
          .filter((e) => e.k !== 'request_raw')
          .map((e) => ((e.k === 'request' || e.k === 'response') && e.raw ? { ...e, raw: undefined } : e));
      }
      while (events.length && est() > max) {
        const d0 = events[0].d;
        const before = events.length;
        events = events.filter((e) => e.d !== d0);
        dropped += before - events.length;
      }
      // 只保留仍被引用的 blob
      const used = new Set<string>();
      for (const e of events) {
        for (const k of ['observationHash', 'systemHash', 'toolsHash'] as const) {
          const h = (e as Partial<Record<typeof k, string>>)[k];
          if (h) used.add(h);
        }
      }
      for (const k of Object.keys(blobs)) if (!used.has(k)) delete blobs[k];
      while (Object.keys(blobs).length && est() > max) {
        const big = Object.entries(blobs).sort((a, b) => b[1].length - a[1].length)[0];
        blobs[big[0]] = `${big[1].slice(0, 2000)}\n…[导出时因大小上限截断]`;
        if (est() > max && big[1].length <= 2100) break;
      }
    }
    return {
      v: 1,
      kind: 'desk-defense-agent-trace',
      exportedAt: now(),
      note: '书桌防线 AI 思路与请求记录。API Key 等密钥已替换为 •••；内容只在你的浏览器里生成，不会上传。',
      blobs,
      events,
      dropped,
    };
  }

  /** 从导出的数据恢复（回放查看用；只读） */
  static fromExport(x: TraceExport): AgentTrace {
    const t = new AgentTrace();
    for (const [k, v] of Object.entries(x.blobs ?? {})) {
      t.blobsMap.set(k, v);
      t.blobChars += v.length;
    }
    for (const e of x.events ?? []) t.store(e);
    t.droppedCount = x.dropped ?? 0;
    t.nextD = (x.events?.reduce((m, e) => Math.max(m, e.d), 0) ?? 0) + 1;
    return t;
  }
}

export function computeTotals(evs: readonly TraceEvent[]): TraceTotals {
  let usage = emptyUsage();
  let costUsd = 0;
  let decisions = 0;
  let lat = 0;
  let latN = 0;
  let toolCalls = 0;
  let errors = 0;
  let fallbacks = 0;
  let requests = 0;
  let skipped = 0;
  let compactions = 0;
  for (const e of evs) {
    if (e.k === 'decision_start') {
      decisions++;
      if (e.skipped) skipped++;
    } else if (e.k === 'compact') compactions++;
    else if (e.k === 'request') requests++;
    else if (e.k === 'response') {
      usage = addUsage(usage, { ...e.usage, requests: 0 });
      costUsd += e.costUsd ?? 0;
      lat += e.ms;
      latN++;
    } else if (e.k === 'tool_call') toolCalls++;
    else if (e.k === 'error') errors++;
    else if (e.k === 'fallback') fallbacks++;
  }
  usage.requests = requests;
  const called = decisions - skipped;
  return {
    decisions,
    skipped,
    compactions,
    requestsPerDecision: called > 0 ? requests / called : 0,
    requests,
    usage,
    costUsd,
    avgLatencyMs: latN ? lat / latN : 0,
    toolCalls,
    errors,
    fallbacks,
  };
}

/** 工具参数 → 一行文字（tower=pencil x=3 y=5） */
export function argsLine(args: unknown): string {
  if (!args || typeof args !== 'object') return args === undefined ? '' : String(args);
  return Object.entries(args as Record<string, unknown>)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
}

/** 对局里一个工具调用涉及的格子（x/y 参数，或 uid 对应的塔） */
export function cellOfArgs(
  args: unknown,
  towerAt?: (uid: number) => { x: number; y: number } | undefined,
): { x: number; y: number } | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const a = args as Record<string, unknown>;
  // act：取第一条带格子 / uid 的动作；preview：第一处假设放置
  for (const k of ['actions', 'place'] as const) {
    if (Array.isArray(a[k])) {
      for (const x of a[k] as unknown[]) {
        const c = cellOfArgs(x, towerAt);
        if (c) return c;
      }
      return undefined;
    }
  }
  if (typeof a.x === 'number' && typeof a.y === 'number') return { x: a.x, y: a.y };
  if (typeof a.uid === 'number' && towerAt) return towerAt(a.uid);
  return undefined;
}

/** 把 "$blob:哈希" 占位写进原始请求时用 */
export const blobRef = (hash: string): string => `$blob:${hash}`;
