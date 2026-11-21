/**
 * 玩家指令通道：观战 / 下棋的真人给 AI 下的指令（「给 AI 下指令」输入框与快捷短语）。
 *
 * 两种：
 *  - once（一次性）：进入下一次决策（立即触发一次决策，绕过门控），决策结束后标记完成；
 *  - standing（长期方针）：本局每次决策都带上（紧凑一行），玩家可随时移除；最多 STANDING_MAX 条。
 * 放在每次决策的 user 消息里（「玩家指令」段，紧跟决策原因之后），不进系统提示词：固定前缀逐字节稳定、缓存不受影响。
 * 安全：只是本机玩家输入的纯文本；去掉控制字符、截断到 INSTRUCTION_MAX_CHARS；模型能做的仍只有游戏工具。
 * 纯 TS、无 DOM。
 */

export const INSTRUCTION_MAX_CHARS = 200;
export const STANDING_MAX = 5;
/** 等待中的一次性指令上限（再多就挤掉最旧的） */
export const ONCE_MAX = 5;

export type InstructionKind = 'once' | 'standing';
/** pending = 等下一次决策；sent = 正在这次决策里；done = 一次性指令已处理；removed = 长期方针已移除 */
export type InstructionStatus = 'pending' | 'sent' | 'done' | 'removed';

export interface PlayerInstruction {
  id: number;
  text: string;
  kind: InstructionKind;
  status: InstructionStatus;
  /** 下达时的游戏时间（秒） */
  at: number;
  /** 处理它的决策编号（追踪里的 d） */
  decision?: number;
  /** 模型的回应（end.note / 文字里关于这条指令的那一句；原样显示） */
  ack?: string;
  /** 没有模型原话时的状态码（界面按当前语言显示）：noReply 模型没提到 / failed 模型出错 / bot 机器人代打 / replaced 被新指令挤掉 / withdrawn 撤回 */
  ackCode?: AckCode;
}

export type AckCode = 'noReply' | 'failed' | 'bot' | 'replaced' | 'withdrawn';

/** 发给模型 / 适配器的精简形状 */
export interface InstructionRef {
  id: number;
  text: string;
  kind: InstructionKind;
}

export type AddResult = { ok: true; item: PlayerInstruction } | { ok: false; reason: 'empty' | 'standing_full' };

/** 去掉控制字符、合并空白、截断 */
export function cleanInstruction(raw: string): string {
  let s = '';
  for (const ch of String(raw ?? '')) {
    const c = ch.codePointAt(0) ?? 0;
    s += c < 32 || (c >= 127 && c < 160) ? ' ' : ch;
  }
  s = s.replace(/\s+/g, ' ').trim();
  const chars = [...s];
  return chars.length > INSTRUCTION_MAX_CHARS ? `${chars.slice(0, INSTRUCTION_MAX_CHARS).join('')}…` : s;
}

/**
 * 「玩家指令」段（每次决策的 user 消息里）。没有指令时返回 ''。
 * once 用「P<id>!」，standing 用「P<id>」；模型在 end.note 里按编号回应（见系统提示词的规则）。
 */
export function instructionSection(once: readonly InstructionRef[], standing: readonly InstructionRef[], role = 'player'): string {
  if (!once.length && !standing.length) return '';
  const lines: string[] = [];
  const verb = role === 'advisor' ? '回答 / 照此给建议' : '优先执行';
  if (once.length) {
    lines.push(`玩家指令（本次${verb}，end.note 里逐条回应 "P<id> ok: …" 或 "P<id> 无法: 原因"）:`);
    for (const x of once) lines.push(`- P${x.id}! ${x.text}`);
  }
  if (standing.length)
    lines.push(`长期方针（每次都遵守，除非违反规则或会立刻输掉）: ${standing.map((x) => `P${x.id} ${x.text}`).join(' | ')}`);
  return lines.join('\n');
}

/** 从模型的回应文字里找关于某条指令的那一句（"P3 ok: …" / "P3 无法: …"）；没有返回 undefined */
export function findAck(text: string | undefined, id: number): string | undefined {
  if (!text) return undefined;
  const re = new RegExp(`P${id}(?![0-9])!?\\s*[:：]?\\s*([^|;；\\n]*)`, 'i');
  const m = re.exec(text);
  if (!m) return undefined;
  const s = `P${id} ${m[1].trim()}`.trim();
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

/** 指令队列：浏览器里由 AI 面板持有，跨控制器重启（换成机器人）不丢 */
export class InstructionQueue {
  private items: PlayerInstruction[] = [];
  private nextId = 1;
  private subs = new Set<(list: readonly PlayerInstruction[]) => void>();

  /** 全部（含已完成 / 已移除；最多保留最近 60 条） */
  list(): readonly PlayerInstruction[] {
    return this.items;
  }

  standing(): PlayerInstruction[] {
    return this.items.filter((x) => x.kind === 'standing' && x.status !== 'removed');
  }

  pending(): PlayerInstruction[] {
    return this.items.filter((x) => x.kind === 'once' && x.status === 'pending');
  }

  /** 有没有等着下一次决策的一次性指令（控制器据此立即触发一次决策） */
  hasPending(): boolean {
    return this.items.some((x) => x.kind === 'once' && x.status === 'pending');
  }

  add(text: string, kind: InstructionKind, at = 0): AddResult {
    const clean = cleanInstruction(text);
    if (!clean) return { ok: false, reason: 'empty' };
    if (kind === 'standing' && this.standing().length >= STANDING_MAX) return { ok: false, reason: 'standing_full' };
    if (kind === 'once') {
      const p = this.pending();
      // 太多没处理的一次性指令：挤掉最旧的
      if (p.length >= ONCE_MAX) {
        p[0].status = 'done';
        p[0].ackCode = 'replaced';
      }
    }
    const item: PlayerInstruction = { id: this.nextId++, text: clean, kind, status: 'pending', at };
    this.items.push(item);
    if (this.items.length > 60) {
      const drop = this.items.findIndex((x) => x.status === 'done' || x.status === 'removed');
      if (drop >= 0) this.items.splice(drop, 1);
    }
    this.emit();
    return { ok: true, item };
  }

  /** 移除长期方针 / 撤回还没发出的一次性指令 */
  remove(id: number): boolean {
    const x = this.items.find((i) => i.id === id);
    if (!x || x.status === 'removed' || x.status === 'done') return false;
    if (x.kind === 'once' && x.status === 'sent') return false;
    x.status = x.kind === 'standing' ? 'removed' : 'done';
    if (x.kind === 'once') x.ackCode = 'withdrawn';
    this.emit();
    return true;
  }

  /**
   * 一次决策要带上的指令：等待中的一次性指令（标记 sent）+ 全部长期方针。
   * d = 决策编号（追踪），用于之后 complete。
   */
  take(d?: number): { once: InstructionRef[]; standing: InstructionRef[] } {
    const once = this.pending();
    for (const x of once) {
      x.status = 'sent';
      x.decision = d;
    }
    const standing = this.standing();
    for (const x of standing) if (x.status === 'pending') x.status = 'sent';
    if (once.length) this.emit();
    const ref = (x: PlayerInstruction): InstructionRef => ({ id: x.id, text: x.text, kind: x.kind });
    return { once: once.map(ref), standing: standing.map(ref) };
  }

  /** 决策结束：本次带上的一次性指令标记完成，记下模型的回应（reply = end.note / 文字） */
  complete(ids: readonly number[], reply: string | undefined, fallback?: AckCode): PlayerInstruction[] {
    const out: PlayerInstruction[] = [];
    for (const x of this.items) {
      if (!ids.includes(x.id)) continue;
      const ack = findAck(reply, x.id);
      if (ack) {
        x.ack = ack;
        x.ackCode = undefined;
      } else if (x.kind === 'once') x.ackCode = fallback ?? 'noReply';
      if (x.kind === 'once' && x.status === 'sent') x.status = 'done';
      out.push(x);
    }
    if (out.length) this.emit();
    return out;
  }

  /** 决策没能处理（中止 / 模型失败）：一次性指令放回等待，下次再试 */
  requeue(ids: readonly number[]): void {
    let n = 0;
    for (const x of this.items)
      if (ids.includes(x.id) && x.kind === 'once' && x.status === 'sent') {
        x.status = 'pending';
        n++;
      }
    if (n) this.emit();
  }

  subscribe(fn: (list: readonly PlayerInstruction[]) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  private emit(): void {
    for (const fn of this.subs) {
      try {
        fn(this.items);
      } catch (e) {
        if (typeof console !== 'undefined') console.warn('[instructions]', e);
      }
    }
  }
}

// ───────────────────────── 离线演示：关键词 → 意图 ─────────────────────────

/** 限制类意图：这一回合不再额外花钱建塔（离线演示只做得到这么粗） */
export const HOLD_INTENTS: readonly InstructionIntent['key'][] = ['save', 'hold_right', 'hold_left'];

/** 离线演示（脚本策略）能听懂的指令：关键词 → act 的意图动作 */
export interface InstructionIntent {
  /** 识别出的意图名（追踪 / 回应里用） */
  key: 'anti_air' | 'save' | 'maze' | 'reclaim' | 'boss' | 'aoe' | 'start_wave' | 'upgrade' | 'hold_right' | 'hold_left';
  actions: Record<string, unknown>[];
}

const KW: { key: InstructionIntent['key']; re: RegExp }[] = [
  { key: 'anti_air', re: /防空|对空|飞行|空军|anti[-\s]?air|\bair\b|flyer|対空|飛行/i },
  { key: 'save', re: /存钱|攒钱|省钱|存錢|攢錢|save|貯金|節約/i },
  { key: 'maze', re: /迷宫|拉长|绕路|迷宮|拉長|繞路|迷路|長く|maze|longer|lengthen|延ば/i },
  { key: 'reclaim', re: /拆|没用的墙|沒用的牆|reclaim|useless|remove.*wall|撤去|壊/i },
  { key: 'boss', re: /boss|ボス|集火/i },
  { key: 'aoe', re: /范围|群伤|範圍|群傷|aoe|area|splash|範囲/i },
  { key: 'start_wave', re: /开波|開波|start.*wave|next wave|ウェーブ開始|開始/i },
  { key: 'upgrade', re: /升级|升級|upgrade|強化|アップグレード/i },
  { key: 'hold_right', re: /别动右|不要动右|別動右|右半|leave.*right|right half|右側/i },
  { key: 'hold_left', re: /别动左|不要动左|別動左|左半|leave.*left|left half|左側/i },
];

/** 识别一条指令里的意图（可能多个；按关键词表顺序）。识别不了返回 [] */
export function instructionIntents(text: string, w?: { bossCells?: { x: number; y: number }[]; skill?: string }): InstructionIntent[] {
  const out: InstructionIntent[] = [];
  for (const k of KW) {
    if (!k.re.test(text)) continue;
    if (out.some((o) => o.key === k.key)) continue;
    // 「拆」与「别动」「不要」同时出现：是限制，不是拆墙
    if (k.key === 'reclaim' && /别动|不要|別動|don'?t|leave/i.test(text) && !/墙|牆|wall/i.test(text)) continue;
    switch (k.key) {
      case 'anti_air':
        out.push({ key: k.key, actions: [{ do: 'anti_air' }] });
        break;
      case 'save':
        out.push({ key: k.key, actions: [{ do: 'save', until: 200 }] });
        break;
      case 'maze':
        out.push({ key: k.key, actions: [{ do: 'maze', budget: 60 }] });
        break;
      case 'reclaim':
        out.push({ key: k.key, actions: [{ do: 'reclaim', target: 'useless_walls', max: 3 }] });
        break;
      case 'boss': {
        const c = w?.bossCells?.[0];
        out.push({ key: k.key, actions: c ? [{ do: 'cast_skill', skill: w?.skill ?? 'eraser_strike', x: c.x, y: c.y }] : [] });
        break;
      }
      case 'aoe':
        out.push({ key: k.key, actions: [{ do: 'build_near', purpose: 'aoe' }] });
        break;
      case 'start_wave':
        out.push({ key: k.key, actions: [{ do: 'start_wave' }] });
        break;
      case 'upgrade':
        out.push({ key: k.key, actions: [{ do: 'upgrade_best' }] });
        break;
      case 'hold_right':
      case 'hold_left':
        // 限制类：离线演示只能做到「这一回合不再造新塔」
        out.push({ key: k.key, actions: [] });
        break;
    }
  }
  return out;
}
