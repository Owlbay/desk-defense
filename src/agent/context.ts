/**
 * 决策上下文（文档 10 §5.2）：每次决策发给模型的 user 消息 = 开局信息 + 原因 + 备忘 + 观测（完整 / 增量）+（按需）地图。
 *
 *  - 增量：第一次完整；之后只发变化的键（compact.ts diffObs）；模型调用 observe 时基线随之更新；
 *  - 地图：地形版本（grid.version）变化 / 路线变化 / 每 mapEvery 次决策 / 完整模式每次；
 *  - 备忘：结构化（plan / maze / priorities / note），总计 ≤ 300 token，act {end:{…}} 更新，未给的字段保持原值；
 *  - 门控跳过的决策点：事件累积到下一次真正的决策（rc 摘要）。
 */
import type { GameEvent, IWorld } from '../core/types';
import type { ContextModeSpec } from './config';
import { compactObservation, diffObs, terrainMap, terrainSig, type CompactObs } from './compact';
import { estimateTokens } from './observation';
import { decisionMessage } from './prompts';
import { groundRoutes, fmtWp } from './routes';
import type { DecisionPoint, ToolResult } from './types';

export const MEMO_MAX_TOKENS = 300;
export type MemoKey = 'plan' | 'maze' | 'priorities' | 'note';
const MEMO_KEYS: MemoKey[] = ['plan', 'maze', 'priorities', 'note'];

/** 结构化备忘：合并更新 + 总量封顶（按顺序给每个字段分配余量，超出的截断） */
export class Memo {
  private f: Partial<Record<MemoKey, string>> = {};

  update(m: Partial<Record<MemoKey, string>> | undefined, plainNote?: string): void {
    if (m) for (const k of MEMO_KEYS) if (typeof m[k] === 'string' && m[k]!.trim()) this.f[k] = m[k]!.trim();
    if (!m && plainNote?.trim()) this.f.note = plainNote.trim();
    this.cap();
  }

  private cap(): void {
    let left = MEMO_MAX_TOKENS - 8;
    for (const k of MEMO_KEYS) {
      const v = this.f[k];
      if (!v) continue;
      let t = v;
      while (t.length && estimateTokens(t) > left) t = t.slice(0, Math.floor(t.length * 0.85));
      if (!t) { delete this.f[k]; continue; }
      this.f[k] = t === v ? v : `${t}…`;
      left -= estimateTokens(this.f[k]!) + 2;
    }
  }

  get fields(): Readonly<Partial<Record<MemoKey, string>>> {
    return this.f;
  }

  text(): string | undefined {
    const parts = MEMO_KEYS.filter((k) => this.f[k]).map((k) => `${k}: ${this.f[k]}`);
    return parts.length ? parts.join(' | ') : undefined;
  }

  tokens(): number {
    return estimateTokens(this.text() ?? '');
  }
}

export interface BuiltMessage {
  text: string;
  /** 本次发的是完整观测（不是增量） */
  full: boolean;
  map: boolean;
  observationTokens: number;
}

export class ContextBuilder {
  readonly memo = new Memo();
  private last: CompactObs | null = null;
  private lastVersion = '';
  private lastRoutes = '';
  private sinceMap = 0;
  private carry: GameEvent[] = [];
  private skipped = 0;

  constructor(
    private readonly w: IWorld,
    private spec: ContextModeSpec,
    private readonly header: string,
  ) {}

  /** 预算分级收紧时换设置 */
  setSpec(spec: ContextModeSpec): void {
    this.spec = spec;
  }

  /** 当前增量基线的估算大小（压缩前后对比用） */
  baselineTokens(): number {
    return this.last ? estimateTokens(JSON.stringify(this.last)) : 0;
  }

  /** 门控跳过：事件攒到下一次真正决策 */
  skip(recent: readonly GameEvent[]): void {
    this.carry.push(...recent);
    if (this.carry.length > 4000) this.carry.splice(0, 2000);
    this.skipped++;
  }

  /** 工具结果回写（act end 的备忘 / observe 的新基线） */
  onToolResult(r: ToolResult): void {
    if (r.memo || r.note) this.memo.update(r.memo, r.note);
  }

  /** 模型调用了 observe：它已经看到完整状态，下次增量以它为基线 */
  onObserve(obs: CompactObs): void {
    this.last = obs;
  }

  /** 强制下次发完整观测（例如模型调用失败、兜底接管之后） */
  reset(): void {
    this.last = null;
  }

  build(point: DecisionPoint, recent: readonly GameEvent[], extra?: string): BuiltMessage {
    const w = this.w;
    const evs = this.carry.length ? [...this.carry, ...recent] : recent;
    const obs = compactObservation(w, { recent: evs });
    const routes = groundRoutes(w);
    const routeSig = routes.map((r) => `${r.id}${r.status}${fmtWp(r.wp)}`).join('|');
    const fullMode = this.spec.observation === 'full';
    const full = fullMode || !this.last;
    // 均衡 / 完整：地形版本（含放塔）变化就重发；省流：只在地形（不含塔，塔的位置在 T 里）或路线变化时重发
    const v = this.spec.rleMap ? terrainSig(w) : String(w.state.grid.version);
    this.sinceMap++;
    const map = full || v !== this.lastVersion || routeSig !== this.lastRoutes || (this.spec.mapEvery > 0 && this.sinceMap >= this.spec.mapEvery);
    let body: string;
    if (full) body = JSON.stringify(obs);
    else {
      const d = diffObs(this.last!, obs);
      // 地图会画出路线，路线没变时 R 不在增量里；地形变化时 R 在增量里并附地图
      body = JSON.stringify(d);
    }
    if (map) {
      body += `\nMAP\n${terrainMap(w, { rle: this.spec.rleMap, routes }).join('\n')}`;
      this.sinceMap = 0;
      this.lastVersion = v;
      this.lastRoutes = routeSig;
    }
    this.last = obs;
    const skipped = this.skipped;
    this.carry = [];
    this.skipped = 0;
    // 开局信息只随完整观测发（增量时模型靠 MEMO 记得局面）
    const text = decisionMessage({ header: full ? this.header : '', point, observation: body, memo: this.memo.text(), skipped, extra, delta: !full });
    return { text, full, map, observationTokens: estimateTokens(body) };
  }
}
