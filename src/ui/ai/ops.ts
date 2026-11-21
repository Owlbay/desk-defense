/**
 * 操作解读（「思路与请求」面板右栏）的数据层：纯 TS、无 DOM、无文案（文案在 ./ops-format.ts 按当前语言生成）。
 *
 * 把「这次决策实际对局面做了什么」归到决策上：
 *  - 指令层（最准）：AI 的每条指令都经 HUD 的 Session 代理下发 → record(cmd, exec) 记下执行前后的金币、指令结果（被拒的原因码）、
 *    执行时同步冒出来的游戏事件（place / sell / levelUp / evolve …）；
 *  - 事件层（补漏）：内置兜底机器人直接调 world.command，不经代理 —— 它的事件在下一次刷新时才到，按「决策进行中 / 刚结束」归属；
 *  - 追踪层：tool_call 与 tool_result 之间下发的指令归到这次工具调用；act 的结果文字逐条对齐动作，
 *    意图（maze / build_near / reclaim …）成为组头，下面挂它实际下的指令；没走到指令的参数错误从结果文字里解析成「被拒」。
 * 没有事件的指令（setTarget、刷新增益、补给箱）由指令参数 + 结果推出。
 */
import type { Command, CommandResult, GameEvent } from '../../core/types';
import type { TraceEvent, TraceExport } from '../../agent/trace';

export type OpKind =
  | 'place' | 'sell' | 'upgrade' | 'branch' | 'evolve' | 'cast' | 'ability' | 'target'
  | 'perk' | 'reroll' | 'crate' | 'demolish' | 'collect' | 'wave' | 'end' | 'other';

export interface Cell {
  x: number;
  y: number;
}

/** 一条具体操作（语言无关的结构化数据；显示时再翻译） */
export interface Op {
  k: OpKind;
  /** false = 被拒绝 / 参数错误（没有改动对局） */
  ok: boolean;
  tower?: string;
  uid?: number;
  cells?: Cell[];
  /** 金币变化（负 = 花费，正 = 退款 / 奖励） */
  gold?: number;
  /** 升级：等级；设置目标：目标模式 */
  from?: number | string;
  to?: number | string;
  branch?: string;
  stars?: number;
  mythic?: boolean;
  skill?: string;
  ability?: string;
  perk?: string;
  option?: string;
  spawner?: string;
  pickup?: 'coin' | 'crate';
  wave?: number;
  note?: string;
  /** 被拒：原因码（core.reason.<code>）与执行时的原因文字 */
  code?: string;
  reason?: string;
  /** 参数错误（没走到游戏指令）：工具结果里的原文 */
  invalid?: boolean;
  /** 放置被自动挪位：原定格子 */
  movedFrom?: Cell;
  /** 来源：指令 / 事件（兜底机器人）/ 工具结果解析 */
  src?: 'cmd' | 'event' | 'parse';
}

export type GroupKind = 'intent' | 'act' | 'tool' | 'auto' | 'after';

export interface OpGroup {
  kind: GroupKind;
  /** 工具名（tool / act） */
  tool?: string;
  /** 意图名（maze / build_near …） */
  intent?: string;
  /** 意图参数（style / budget / tower / target / count …） */
  args?: Record<string, unknown>;
  /** 意图结果：没做成（NOOP）、路线长度变化、结果原文 */
  noop?: boolean;
  path?: [string, string];
  text?: string;
  ops: Op[];
}

export interface DecisionOps {
  d: number;
  tick?: number;
  groups: OpGroup[];
}

export interface OpsExport {
  v: 1;
  decisions: DecisionOps[];
}

/** 导出的追踪数据 + 操作解读（JSON 导出 / 结算回放） */
export type TraceExportWithOps = TraceExport & { ops?: OpsExport };

/** 面板用的只读来源（实时记录器或导出数据） */
export interface OpsSource {
  get(d: number): DecisionOps | undefined;
  all(): DecisionOps[];
  subscribe(fn: (d: number) => void): () => void;
  export(keep?: (d: number) => boolean): OpsExport;
}

/** 记录器读世界用的最小形状 */
export interface OpsWorld {
  state: {
    gold: number;
    wave: number;
    tick: number;
    towers: Map<number, { uid: number; id: string; cx: number; cy: number; level: number; targetMode?: string; stars?: number; branch?: string | null }>;
    spawners?: { id: string; cells: Cell[] }[];
    grid?: { cols: number; rows: number };
  };
}

// ───────────────────────── 指令 → 操作 ─────────────────────────

interface Pre {
  gold: number;
  tower?: { id: string; cx: number; cy: number; level: number; targetMode?: string };
  spawnerCells?: Cell[];
}

export interface CapturedCmd {
  cmd: Command;
  ok: boolean;
  code?: string;
  reason?: string;
  gold: number;
  pre: Pre;
  events: GameEvent[];
  /** 执行后读到的信息（波次、塔等级） */
  post: { wave: number; level?: number; stars?: number };
}

const RELEVANT = new Set<GameEvent['type']>(['place', 'sell', 'levelUp', 'evolve', 'towerAbility', 'skill', 'perkChosen', 'spawnerDrop', 'pickup', 'waveStart']);

const cellOf = (x: number | undefined, y: number | undefined): Cell[] | undefined =>
  typeof x === 'number' && typeof y === 'number' ? [{ x: Math.floor(x), y: Math.floor(y) }] : undefined;

const roundGold = (g: number): number | undefined => {
  const r = Math.round(g);
  return r === 0 ? undefined : r;
};

/** 这条事件是不是这条指令自己产生的 */
function eventOf(c: Command, e: GameEvent): boolean {
  switch (c.type) {
    case 'place': return e.type === 'place' && e.cx === c.cx && e.cy === c.cy;
    case 'sell': return e.type === 'sell' && e.uid === c.uid;
    case 'upgrade': return e.type === 'levelUp' && e.uid === c.uid && !e.byXp;
    case 'evolve': return e.type === 'evolve' && e.uid === c.uid;
    case 'towerAbility': return e.type === 'towerAbility' && e.uid === c.uid;
    case 'cast': return e.type === 'skill' && e.skill === c.skill;
    case 'choosePerk': return e.type === 'perkChosen';
    case 'startWave': return e.type === 'waveStart';
    case 'collect': return e.type === 'pickup' && e.uid === c.uid;
    case 'demolishSpawner': return e.type === 'spawnerDrop' && e.id === c.id && e.phase === 'demolish';
    default: return false;
  }
}

function lineCells(w: OpsWorld | undefined, axis: 'row' | 'col', idx: number): Cell[] {
  const g = w?.state.grid;
  if (!g) return [];
  const out: Cell[] = [];
  if (axis === 'row') for (let x = 0; x < g.cols; x++) out.push({ x, y: idx });
  else for (let y = 0; y < g.rows; y++) out.push({ x: idx, y });
  return out;
}

/** 一条已执行（或被拒）的指令 → 操作 */
export function opOfCommand(c: CapturedCmd, w?: OpsWorld): Op {
  const { cmd, pre } = c;
  const own = c.events.find((e) => eventOf(cmd, e));
  const base: Op = { k: 'other', ok: c.ok, src: 'cmd', gold: c.ok ? roundGold(c.gold) : undefined };
  if (!c.ok) {
    base.code = c.code;
    base.reason = c.reason;
  }
  const preCell = pre.tower ? [{ x: pre.tower.cx, y: pre.tower.cy }] : undefined;
  switch (cmd.type) {
    case 'place':
      return { ...base, k: 'place', tower: cmd.tower, cells: [{ x: cmd.cx, y: cmd.cy }], uid: own?.type === 'place' ? own.uid : undefined };
    case 'sell':
      return { ...base, k: 'sell', tower: pre.tower?.id ?? (own?.type === 'sell' ? own.tower : undefined), uid: cmd.uid, cells: preCell ?? (own?.type === 'sell' ? [{ x: own.cx, y: own.cy }] : undefined) };
    case 'upgrade': {
      const to = own?.type === 'levelUp' ? own.level : c.post.level;
      const from = pre.tower?.level;
      if (cmd.branch) return { ...base, k: 'branch', tower: pre.tower?.id, uid: cmd.uid, cells: preCell, branch: cmd.branch, from, to: c.ok ? to : undefined };
      return { ...base, k: 'upgrade', tower: pre.tower?.id, uid: cmd.uid, cells: preCell, from, to: c.ok ? to ?? (from !== undefined ? from + 1 : undefined) : undefined };
    }
    case 'evolve':
      return { ...base, k: 'evolve', tower: pre.tower?.id, uid: cmd.uid, cells: preCell, stars: own?.type === 'evolve' ? own.stars : c.post.stars, mythic: own?.type === 'evolve' ? own.mythic : undefined };
    case 'setTarget':
      return { ...base, k: 'target', tower: pre.tower?.id, uid: cmd.uid, cells: preCell, from: pre.tower?.targetMode, to: cmd.mode };
    case 'cast': {
      let cells: Cell[] | undefined;
      if (cmd.axis) cells = lineCells(w, cmd.axis, (cmd.axis === 'row' ? cmd.cy : cmd.cx) ?? 0);
      else if (cmd.cx !== undefined && cmd.cy !== undefined) cells = [{ x: cmd.cx, y: cmd.cy }];
      else if (cmd.x !== undefined && cmd.y !== undefined) cells = cellOf(cmd.x, cmd.y);
      else if (preCell) cells = preCell;
      else if (pre.spawnerCells) cells = pre.spawnerCells;
      return { ...base, k: 'cast', skill: cmd.skill, uid: cmd.uid, spawner: cmd.spawner, cells: cells?.length ? cells : undefined };
    }
    case 'towerAbility': {
      const cells = cmd.axis !== undefined && cmd.index !== undefined ? lineCells(w, cmd.axis, cmd.index) : cellOf(cmd.x, cmd.y) ?? preCell;
      return { ...base, k: 'ability', tower: pre.tower?.id, uid: cmd.uid, ability: own?.type === 'towerAbility' ? own.ability : undefined, cells: cells?.length ? cells : undefined };
    }
    case 'choosePerk':
      return { ...base, k: 'perk', perk: cmd.id, uid: cmd.uid, branch: cmd.branch, tower: pre.tower?.id, cells: preCell };
    case 'rerollPerks':
      return { ...base, k: 'reroll' };
    case 'chooseCrate':
      return { ...base, k: 'crate', option: cmd.option };
    case 'demolishSpawner':
      return { ...base, k: 'demolish', spawner: cmd.id, cells: pre.spawnerCells ?? (own?.type === 'spawnerDrop' ? [{ x: own.x, y: own.y }] : undefined) };
    case 'collect':
      return { ...base, k: 'collect', uid: cmd.uid, pickup: own?.type === 'pickup' ? own.kind : undefined, cells: own?.type === 'pickup' ? cellOf(own.x, own.y) : undefined };
    case 'startWave':
      return { ...base, k: 'wave', wave: own?.type === 'waveStart' ? own.wave : c.post.wave };
  }
  return base;
}

/** 不经代理的事件（兜底机器人）→ 操作；不关心的事件返回 null */
export function opOfEvent(e: GameEvent, w?: OpsWorld): Op | null {
  const tw = (uid: number) => w?.state.towers.get(uid);
  const at = (uid: number): Cell[] | undefined => {
    const t = tw(uid);
    return t ? [{ x: t.cx, y: t.cy }] : undefined;
  };
  switch (e.type) {
    case 'place': return { k: 'place', ok: true, src: 'event', tower: e.tower, uid: e.uid, cells: [{ x: e.cx, y: e.cy }] };
    case 'sell': return { k: 'sell', ok: true, src: 'event', tower: e.tower, uid: e.uid, cells: [{ x: e.cx, y: e.cy }], gold: roundGold(e.refund) };
    case 'levelUp':
      if (e.byXp) return null;
      return { k: 'upgrade', ok: true, src: 'event', uid: e.uid, tower: tw(e.uid)?.id, cells: at(e.uid), from: e.level - 1, to: e.level };
    case 'evolve': return { k: 'evolve', ok: true, src: 'event', uid: e.uid, tower: tw(e.uid)?.id, cells: at(e.uid), stars: e.stars, mythic: e.mythic };
    case 'towerAbility': return { k: 'ability', ok: true, src: 'event', uid: e.uid, tower: tw(e.uid)?.id, ability: e.ability, cells: cellOf(e.x, e.y) ?? at(e.uid) };
    case 'skill': return { k: 'cast', ok: true, src: 'event', skill: e.skill, cells: e.cx !== undefined && e.cy !== undefined ? [{ x: e.cx, y: e.cy }] : cellOf(e.x, e.y) };
    case 'perkChosen': return { k: 'perk', ok: true, src: 'event', perk: e.id };
    case 'spawnerDrop': return e.phase === 'demolish' ? { k: 'demolish', ok: true, src: 'event', spawner: e.id, cells: [{ x: e.x, y: e.y }] } : null;
    case 'pickup': return e.phase === 'collect' ? { k: 'collect', ok: true, src: 'event', uid: e.uid, pickup: e.kind, gold: e.value ? roundGold(e.value) : undefined, cells: cellOf(e.x, e.y) } : null;
    default: return null;
  }
}

// ───────────────────────── act 结果对齐 ─────────────────────────

/** act 的底层动作 → 期望的指令类型 */
const LOW: Record<string, Command['type']> = {
  place: 'place', upgrade: 'upgrade', branch: 'upgrade', evolve: 'evolve', sell: 'sell', target: 'setTarget',
  cast_skill: 'cast', tower_ability: 'towerAbility', collect: 'collect', choose_perk: 'choosePerk',
  reroll_perks: 'rerollPerks', choose_crate: 'chooseCrate', demolish: 'demolishSpawner', start_wave: 'startWave',
};
/** 底层动作 → 操作种类（参数错误时用） */
const LOW_KIND: Record<string, OpKind> = {
  place: 'place', upgrade: 'upgrade', branch: 'branch', evolve: 'evolve', sell: 'sell', target: 'target', cast_skill: 'cast',
  tower_ability: 'ability', collect: 'collect', choose_perk: 'perk', reroll_perks: 'reroll', choose_crate: 'crate', demolish: 'demolish', start_wave: 'wave',
};
/** 旧版细粒度工具名 → 操作种类（参数错误时用） */
const LEGACY_KIND: Record<string, OpKind> = {
  place_tower: 'place', upgrade_tower: 'upgrade', choose_branch: 'branch', evolve_tower: 'evolve', sell_tower: 'sell', set_target_mode: 'target',
  cast_skill: 'cast', tower_ability: 'ability', collect_pickup: 'collect', choose_perk: 'perk', reroll_perks: 'reroll', choose_crate: 'crate',
  demolish_spawner: 'demolish', start_wave: 'wave',
};

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** 某个底层动作与某条指令是否精确对应（类型 + 格子 / uid） */
function exact(a: Record<string, unknown>, c: Command): boolean {
  const want = LOW[String(a.do)];
  if (!want || c.type !== want) return false;
  switch (c.type) {
    case 'place': return c.cx === num(a.x) && c.cy === num(a.y) && (a.tower === undefined || c.tower === a.tower);
    case 'upgrade': return c.uid === num(a.uid) && (a.do === 'branch') === !!c.branch;
    case 'evolve':
    case 'sell':
    case 'setTarget':
    case 'towerAbility': return c.uid === num(a.uid);
    case 'collect': return num(a.uid) === undefined || c.uid === num(a.uid);
    case 'cast': return c.skill === a.skill;
    case 'choosePerk': return c.id === a.id;
    case 'chooseCrate': return c.option === a.option;
    case 'demolishSpawner': return c.id === (str(a.id) ?? str(a.spawner));
    default: return true;
  }
}

/** 意图大概会下哪些指令（用于在两个意图之间切分；未知意图什么都收） */
function fits(intent: string, a: Record<string, unknown>, c: Command): boolean {
  switch (intent) {
    case 'maze': return c.type === 'place' && c.tower === 'wall';
    case 'build_near': return (c.type === 'place' && (a.tower === undefined || c.tower === a.tower)) || c.type === 'upgrade';
    case 'upgrade_best': return c.type === 'upgrade' || c.type === 'evolve';
    case 'anti_air': return c.type === 'place' || c.type === 'upgrade';
    case 'save': return false;
    case 'reclaim': return c.type === 'sell';
    case 'rebuild_maze': return c.type === 'sell' || (c.type === 'place' && c.tower === 'wall');
    case 'economy': return c.type === 'place' || c.type === 'upgrade';
    case 'support': return c.type === 'place' || c.type === 'upgrade';
    case 'combo': return c.type === 'place' || c.type === 'upgrade';
    default: return c.type !== 'startWave';
  }
}

/** 参数错误 → 操作（从动作参数取格子等） */
function invalidOp(kind: OpKind, a: Record<string, unknown>, reason: string): Op {
  const x = num(a.x);
  const y = num(a.y);
  return {
    k: kind, ok: false, invalid: true, src: 'parse', reason: reason.trim().slice(0, 200),
    tower: str(a.tower), uid: num(a.uid), skill: str(a.skill), perk: kind === 'perk' ? str(a.id) : undefined, option: str(a.option),
    spawner: kind === 'demolish' ? str(a.id) ?? str(a.spawner) : undefined, branch: str(a.branch), to: kind === 'target' ? str(a.mode) : undefined,
    cells: x !== undefined && y !== undefined ? [{ x, y }] : undefined,
  };
}

/** act 结果文字：「序号 内容」→ Map（序号从 1 起） */
export function parseActLines(text: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of text.split('\n')) {
    const m = /^(\d+) (.*)$/.exec(line);
    if (m) out.set(Number(m[1]), m[2]);
  }
  return out;
}

const PATH_RE = /path ([\d/]+)\s*→\s*([\d/]+)/;
const MOVED_RE = /^MOVED (\d+),(\d+)/;

/**
 * act 一次调用 → 若干组：意图成组（组头 + 它下的指令），相邻的底层动作合成一组；
 * cmds 是这次调用期间按顺序下发的指令（含被拒的）。
 */
export function alignAct(args: unknown, resultText: string, cmds: CapturedCmd[], w?: OpsWorld): OpGroup[] {
  const a0 = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const actions = Array.isArray(a0.actions) ? (a0.actions as unknown[]).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [];
  const lines = parseActLines(resultText);
  const groups: OpGroup[] = [];
  let plain: OpGroup | null = null;
  const pushPlain = (op: Op): void => {
    if (!plain) {
      plain = { kind: 'act', tool: 'act', ops: [] };
      groups.push(plain);
    }
    plain.ops.push(op);
  };
  let p = 0;
  const nextLow = (from: number): Record<string, unknown> | undefined => {
    for (let j = from; j < actions.length; j++) if (LOW[String(actions[j].do)]) return actions[j];
    return undefined;
  };
  actions.slice(0, 16).forEach((a, i) => {
    const kind = String(a.do);
    const line = lines.get(i + 1) ?? '';
    if (kind === 'end_turn') {
      pushPlain({ k: 'end', ok: true, src: 'parse', note: str(a.note) });
      return;
    }
    const low = LOW[kind];
    if (low) {
      if (line.startsWith('ERROR')) {
        pushPlain(invalidOp(LOW_KIND[kind] ?? 'other', a, line.replace(/^ERROR\s*/, '')));
        return;
      }
      if (p >= cmds.length) return;
      if (kind === 'collect' && num(a.uid) === undefined) {
        while (p < cmds.length && cmds[p].cmd.type === 'collect') pushPlain(opOfCommand(cmds[p++], w));
        return;
      }
      if (cmds[p].cmd.type !== low) return;
      const first = cmds[p++];
      const moved = MOVED_RE.exec(line);
      if (moved && first.cmd.type === 'place' && !first.ok) {
        // 原格被拒 → 规划器挪到附近：只显示挪位后的结果
        const second = p < cmds.length && cmds[p].cmd.type === 'place' ? cmds[p++] : null;
        const op = opOfCommand(second ?? first, w);
        if (second) op.movedFrom = { x: Number(moved[1]), y: Number(moved[2]) };
        pushPlain(op);
        return;
      }
      pushPlain(opOfCommand(first, w));
      // 被拒的放置：自动挪位也失败时多出一条内部尝试，不单独显示
      if (first.cmd.type === 'place' && !first.ok && p < cmds.length) {
        const c = cmds[p];
        const nl = nextLow(i + 1);
        if (c.cmd.type === 'place' && !c.ok && c.cmd.tower === first.cmd.tower && !(nl && exact(nl, c.cmd))) p++;
      }
      return;
    }
    // 意图
    const g: OpGroup = { kind: 'intent', intent: kind, args: intentArgs(a), ops: [], text: line.replace(/^(OK|NOOP)\s*/, '').slice(0, 600) };
    if (/^NOOP\b/.test(line) || line.startsWith('ERROR')) g.noop = true;
    if (line.startsWith('ERROR')) g.ops.push(invalidOp('other', a, line.replace(/^ERROR\s*/, '')));
    const pm = PATH_RE.exec(line);
    if (pm) g.path = [pm[1], pm[2]];
    const nl = nextLow(i + 1);
    while (p < cmds.length && fits(kind, a, cmds[p].cmd) && !(nl && exact(nl, cmds[p].cmd))) g.ops.push(opOfCommand(cmds[p++], w));
    groups.push(g);
    plain = null;
  });
  // 没对上的指令
  while (p < cmds.length) pushPlain(opOfCommand(cmds[p++], w));
  if (a0.end && typeof a0.end === 'object' && !actions.some((a) => a.do === 'end_turn')) {
    const e = a0.end as Record<string, unknown>;
    pushPlain({ k: 'end', ok: true, src: 'parse', note: str(e.note) ?? str(e.plan) });
  }
  return groups;
}

function intentArgs(a: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) if (k !== 'do' && v !== undefined && v !== null && (typeof v === 'string' || typeof v === 'number')) out[k] = v;
  return out;
}

/** 非 act 工具（旧版细粒度工具等）→ 一组 */
export function toolGroup(name: string, args: unknown, ok: boolean, text: string, cmds: CapturedCmd[], w?: OpsWorld): OpGroup | null {
  const ops = cmds.map((c) => opOfCommand(c, w));
  if (name === 'end_turn') {
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
    ops.push({ k: 'end', ok: true, src: 'parse', note: str(a.note) });
  } else if (!ok && !cmds.length && LEGACY_KIND[name] && /^ERROR\b/.test(text)) {
    ops.push(invalidOp(LEGACY_KIND[name], (args ?? {}) as Record<string, unknown>, text.replace(/^ERROR\s*/, '')));
  }
  if (!ops.length) return null;
  // 细粒度动作工具（place_tower …）与 end_turn：和 act 的底层动作一样不加组头
  return { kind: LEGACY_KIND[name] || name === 'end_turn' ? 'act' : 'tool', tool: name, ops };
}

// ───────────────────────── 记录器 ─────────────────────────

export interface OpsRecorderOptions {
  world?: OpsWorld;
  /** 收不经代理的游戏事件（兜底机器人）；军师模式下关掉（那时动手的是玩家） */
  eventOps?: boolean;
  /** 决策结束后多久内的事件 / 指令仍算这次决策（自动推进、兜底机器人延迟到下一帧的事件） */
  afterMs?: number;
  now?: () => number;
}

interface OpenTool {
  id: string;
  name: string;
  args: unknown;
  cmds: CapturedCmd[];
}

export class OpsRecorder implements OpsSource {
  private map = new Map<number, DecisionOps>();
  private order: number[] = [];
  private subs = new Set<(d: number) => void>();
  private cur: number | null = null;
  private lastD: number | null = null;
  private lastEnd = 0;
  private tools = new Map<string, OpenTool>();
  private openTool: OpenTool | null = null;
  private capture: GameEvent[] | null = null;
  private readonly now: () => number;
  private readonly max = 400;

  constructor(private readonly o: OpsRecorderOptions = {}) {
    this.now = o.now ?? (() => Date.now());
  }

  static fromExport(x: OpsExport | undefined | null): OpsRecorder {
    const r = new OpsRecorder();
    for (const d of x?.decisions ?? []) {
      if (!d || typeof d.d !== 'number' || !Array.isArray(d.groups)) continue;
      r.map.set(d.d, d);
      r.order.push(d.d);
    }
    return r;
  }

  get(d: number): DecisionOps | undefined {
    return this.map.get(d);
  }

  all(): DecisionOps[] {
    return this.order.map((d) => this.map.get(d)!).filter(Boolean);
  }

  subscribe(fn: (d: number) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  export(keep?: (d: number) => boolean): OpsExport {
    return { v: 1, decisions: this.all().filter((x) => (keep ? keep(x.d) : true)).filter((x) => x.groups.length > 0) };
  }

  private emit(d: number): void {
    for (const fn of this.subs) {
      try {
        fn(d);
      } catch (e) {
        if (typeof console !== 'undefined') console.warn('[ops]', e);
      }
    }
  }

  private dec(d: number): DecisionOps {
    let x = this.map.get(d);
    if (!x) {
      x = { d, groups: [] };
      this.map.set(d, x);
      this.order.push(d);
      while (this.order.length > this.max) this.map.delete(this.order.shift()!);
    }
    return x;
  }

  /** 当前该归到哪次决策、哪种组（没有 = 不记） */
  private target(): { d: number; kind: 'auto' | 'after' } | null {
    if (this.cur !== null) return { d: this.cur, kind: 'auto' };
    if (this.lastD !== null) return { d: this.lastD, kind: 'after' };
    return null;
  }

  private addLoose(ops: Op[], kind: 'auto' | 'after', d: number): void {
    if (!ops.length) return;
    const x = this.dec(d);
    let g = x.groups[x.groups.length - 1];
    if (!g || g.kind !== kind) {
      g = { kind, ops: [] };
      x.groups.push(g);
    }
    g.ops.push(...ops);
    this.emit(d);
  }

  /** 追踪事件（与面板订阅同一个 AgentTrace） */
  onTrace(e: TraceEvent): void {
    switch (e.k) {
      case 'decision_start': {
        this.cur = e.d;
        const x = this.dec(e.d);
        x.tick = e.tick;
        break;
      }
      case 'tool_call': {
        const t: OpenTool = { id: e.id, name: e.name, args: e.args, cmds: [] };
        this.tools.set(e.id, t);
        this.openTool = t;
        break;
      }
      case 'tool_result': {
        const t = this.tools.get(e.id) ?? { id: e.id, name: e.name, args: undefined, cmds: [] };
        this.tools.delete(e.id);
        if (this.openTool?.id === e.id) this.openTool = null;
        const groups = e.name === 'act' ? alignAct(t.args, e.text, t.cmds, this.o.world) : [toolGroup(e.name, t.args, e.ok, e.text, t.cmds, this.o.world)].filter((g): g is OpGroup => !!g);
        if (groups.length) {
          const x = this.dec(e.d);
          for (const g of groups) {
            // 相邻的无组头动作合成一组（旧版细粒度工具一次一条）
            const last = x.groups[x.groups.length - 1];
            if (g.kind === 'act' && last?.kind === 'act') last.ops.push(...g.ops);
            else x.groups.push(g);
          }
          this.emit(e.d);
        }
        break;
      }
      case 'decision_end':
        // 万一还有没收尾的工具调用：把指令照原样放进去
        for (const t of this.tools.values()) {
          const g = toolGroup(t.name, t.args, true, '', t.cmds, this.o.world);
          if (g) this.dec(e.d).groups.push(g);
        }
        this.tools.clear();
        this.openTool = null;
        this.cur = null;
        this.lastD = e.d;
        this.lastEnd = this.now();
        this.emit(e.d);
        break;
      default:
        break;
    }
  }

  /** 经代理下发一条指令：记录执行前后的金币、结果、同步冒出的事件 */
  record(cmd: Command, exec: () => CommandResult): CommandResult {
    const w = this.o.world;
    const st = w?.state;
    const uid = 'uid' in cmd && typeof cmd.uid === 'number' ? cmd.uid : undefined;
    const t = uid !== undefined ? st?.towers.get(uid) : undefined;
    const spId = cmd.type === 'demolishSpawner' ? cmd.id : cmd.type === 'cast' ? cmd.spawner : undefined;
    const sp = spId ? st?.spawners?.find((s) => s.id === spId) : undefined;
    const pre: Pre = {
      gold: st?.gold ?? 0,
      tower: t ? { id: t.id, cx: t.cx, cy: t.cy, level: t.level, targetMode: t.targetMode } : undefined,
      spawnerCells: sp?.cells?.length ? sp.cells.map((c) => ({ x: c.x, y: c.y })) : undefined,
    };
    const prevCap = this.capture;
    const cap: GameEvent[] = [];
    this.capture = cap;
    let r: CommandResult;
    try {
      r = exec();
    } finally {
      this.capture = prevCap;
    }
    try {
      const t2 = uid !== undefined ? st?.towers.get(uid) : undefined;
      const c: CapturedCmd = {
        cmd, ok: r.ok, code: r.code, reason: r.reason, gold: (st?.gold ?? 0) - pre.gold, pre, events: cap,
        post: { wave: st?.wave ?? 0, level: t2?.level, stars: t2?.stars },
      };
      // 不是这条指令产生的事件（兜底机器人之前直接下的指令，这时才被刷出来）
      const stray = cap.filter((e) => RELEVANT.has(e.type) && !eventOf(cmd, e));
      const strayOps = this.o.eventOps ? stray.map((e) => opOfEvent(e, w)).filter((x): x is Op => !!x && x.k !== 'wave') : [];
      if (this.openTool) {
        if (strayOps.length) {
          const tg = this.target();
          if (tg) this.addLoose(strayOps, 'auto', tg.d);
        }
        this.openTool.cmds.push(c);
        return r;
      }
      const tg = this.target();
      if (!tg) return r;
      this.addLoose([...strayOps, opOfCommand(c, w)], tg.kind, tg.d);
    } catch (e) {
      if (typeof console !== 'undefined') console.warn('[ops]', e);
    }
    return r;
  }

  /** 游戏事件（session.on）：指令执行中的先收着；其余只在开启 eventOps 且决策进行中 / 刚结束时记 */
  onGameEvent(e: GameEvent): void {
    if (this.capture) {
      this.capture.push(e);
      return;
    }
    if (!this.o.eventOps || !RELEVANT.has(e.type) || e.type === 'waveStart') return;
    let d: number | null = null;
    let kind: 'auto' | 'after' = 'auto';
    if (this.cur !== null) d = this.cur;
    else if (this.lastD !== null && this.now() - this.lastEnd <= (this.o.afterMs ?? 1500)) {
      d = this.lastD;
      kind = 'after';
    }
    if (d === null) return;
    const op = opOfEvent(e, this.o.world);
    if (op) this.addLoose([op], kind, d);
  }
}

// ───────────────────────── 汇总 ─────────────────────────

export interface OpsTotals {
  build: number;
  sell: number;
  upgrade: number;
  skill: number;
  rejected: number;
  spent: number;
  refunded: number;
  total: number;
}

export function opsTotals(list: readonly DecisionOps[]): OpsTotals {
  const t: OpsTotals = { build: 0, sell: 0, upgrade: 0, skill: 0, rejected: 0, spent: 0, refunded: 0, total: 0 };
  for (const d of list) {
    for (const g of d.groups) {
      for (const op of g.ops) {
        if (op.k === 'end') continue;
        if (!op.ok) {
          t.rejected++;
          continue;
        }
        t.total++;
        if (op.k === 'place') t.build++;
        else if (op.k === 'sell' || op.k === 'demolish') t.sell++;
        else if (op.k === 'upgrade' || op.k === 'branch' || op.k === 'evolve') t.upgrade++;
        else if (op.k === 'cast' || op.k === 'ability') t.skill++;
        if (op.gold && op.gold < 0) t.spent -= op.gold;
        else if (op.gold && op.gold > 0 && (op.k === 'sell' || op.k === 'demolish')) t.refunded += op.gold;
      }
    }
  }
  return t;
}

/** 一组里所有操作涉及的格子 */
export const groupCells = (g: OpGroup): Cell[] => g.ops.flatMap((o) => o.cells ?? []);
