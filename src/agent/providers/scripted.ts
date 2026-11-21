/**
 * 脚本策略（确定性、离线）：和模型用同一套工具（文档 10 §8.5）。
 *
 * 用途：测试（确定性 / 端到端）、无网络演示、浏览器里的默认兜底、Agent 评测的下限基线。
 * 策略很朴素：选增益 → 补给 → 小段迷宫（墙放在最能拉长路线的路格）→ 沿路线买塔（覆盖路格最多的位置）
 * → 升级最低级的塔 → 敌人逼近出口时放技能 → 手动模式开波 → end_turn。
 * 全部遍历顺序固定，无随机数：同一种子 ⇒ 同一结果。
 */
import type { IWorld, TowerId } from '../../core/types';
import { CellKind } from '../../core/types';
import { executeTool } from '../tools';
import { emptyUsage, type DecisionReason, type FallbackPolicy, type ToolResult } from '../types';
import type { DecisionContext, DecisionOutcome, LLMProvider } from './types';

type Call = (name: string, input: Record<string, unknown>) => Promise<ToolResult> | ToolResult;

const PERK_PRIORITY = ['promotion', 'sale', 'notes', 'sharpener', 'safe', 'compound', 'pocketmoney', 'quickreview', 'bulb', 'drafting', 'timemgmt'];
const ROTATION: TowerId[] = ['pencil', 'pencil', 'glue', 'stapler', 'pencil', 'lamp', 'compass', 'pencil', 'ruler', 'swatter', 'stapler', 'pen'];

function pathCells(w: IWorld): { x: number; y: number }[] {
  const seen = new Set<number>();
  const out: { x: number; y: number }[] = [];
  for (const p of w.currentPaths()) for (const c of p) {
    const k = c.y * 100 + c.x;
    if (!seen.has(k)) { seen.add(k); out.push(c); }
  }
  return out;
}

/** 覆盖路格最多的可建空格（不在路上，不改路线） */
function bestCell(w: IWorld, tower: TowerId): { x: number; y: number } | null {
  const g = w.state.grid;
  const path = pathCells(w);
  const onPath = new Set(path.map((c) => c.y * 100 + c.x));
  const r = Math.max(1.2, w.baseRange(tower).range);
  let best: { x: number; y: number; score: number } | null = null;
  for (let y = 0; y < g.rows; y++) {
    for (let x = 0; x < g.cols; x++) {
      if (g.cells[y * g.cols + x] !== CellKind.Empty || onPath.has(y * 100 + x)) continue;
      let cov = 0;
      for (const c of path) if (Math.hypot(c.x - x, c.y - y) <= r) cov++;
      // 越靠近出口越好一点（漏怪前最后一道防线）
      const score = cov + y * 0.05;
      if (cov > 0 && (!best || score > best.score) && w.canPlace(tower, x, y).ok) best = { x, y, score };
    }
  }
  return best;
}

/** 让路线变长最多的墙（只看当前路格） */
function bestWall(w: IWorld): { x: number; y: number; gain: number } | null {
  const cur = w.currentPaths().reduce((a, p) => a + p.length, 0);
  let best: { x: number; y: number; gain: number } | null = null;
  for (const c of pathCells(w)) {
    if (c.y < 1 || c.y > w.state.grid.rows - 2) continue;
    if (!w.canPlace('wall', c.x, c.y).ok) continue;
    const pv = w.previewPath('wall', c.x, c.y);
    if (!pv) continue;
    const gain = pv.reduce((a, p) => a + p.length, 0) - cur;
    if (gain >= 2 && (!best || gain > best.gain)) best = { x: c.x, y: c.y, gain };
  }
  return best;
}

/**
 * 一次决策（异步：经 call 执行每个动作，与模型完全同一路径）。
 * think：规则策略的"思路"（每条规则判断写一行，思路与请求面板里当作思考过程展示；不影响决策）。
 */
export async function scriptedTurn(w: IWorld, call: Call, reasons: DecisionReason[], think?: (line: string) => void): Promise<string> {
  const s = w.state;
  const done: string[] = [];
  const say = (line: string): void => think?.(`${line}\n`);
  say(`决策原因：${reasons.join(', ') || '—'}；阶段 ${s.phase}，第 ${s.wave} 波，金币 ${Math.floor(s.gold)}，生命 ${s.lives}/${s.maxLives}。`);
  // 增益
  if (s.phase === 'perk' && s.perkChoices) {
    const cards = s.perkChoices.slice().sort((a, b) => rank(a.id) - rank(b.id));
    say(`增益三选一：按固定优先级排序 → ${cards.map((c) => c.id).join(' > ')}。`);
    for (const c of cards) {
      const input: Record<string, unknown> = { id: c.id };
      if (c.needsTower) {
        const t = [...s.towers.values()].find((x) => x.id !== 'wall' && x.level >= 7 && x.level < 10);
        if (!t) continue;
        input.uid = t.uid;
        input.branch = 'A';
      }
      if ((await call('choose_perk', input)).ok) { done.push(`perk ${c.id}`); break; }
    }
  }
  if (s.crateChoice) {
    const pref = ['gold', 'xp', 'lives', 'caffeine', 'cooldown', 'charge'];
    const opt = s.crateChoice.options.slice().sort((a, b) => pref.indexOf(a.id) - pref.indexOf(b.id))[0];
    if (opt) say(`补给箱：偏好顺序 ${pref.join(' > ')}，选 ${opt.id}。`);
    if (opt && (await call('choose_crate', { option: opt.id })).ok) done.push(`crate ${opt.id}`);
  }
  // 拆空降点（钱多时）
  for (const sp of s.spawners) {
    if (sp.kind === 'drop' && sp.active && sp.demolishCost && s.gold >= sp.demolishCost * 3) {
      say(`空降点 ${sp.id}：拆除费 ${sp.demolishCost}，金币超过 3 倍 → 拆掉。`);
      if ((await call('demolish_spawner', { id: sp.id })).ok) done.push(`demolish ${sp.id}`);
    }
  }
  // 花钱
  const towers = () => [...s.towers.values()];
  for (let guard = 0; guard < 10; guard++) {
    const atk = towers().filter((t) => t.id !== 'wall');
    const walls = towers().length - atk.length;
    const target = Math.min(4 + Math.floor(s.wave * 1.2), 30);
    if (guard === 0) say(`兵力：攻击塔 ${atk.length} / 目标 ${target}，墙 ${walls} / 目标 ${4 + s.wave * 2}。`);
    if (walls < 4 + s.wave * 2 && s.gold >= 25 && atk.length >= 2) {
      const wl = bestWall(w);
      if (wl) say(`迷宫：在路线 (${wl.x},${wl.y}) 放墙能让路线变长 ${wl.gain} 格 → 放墙。`);
      if (wl && (await call('place_tower', { tower: 'wall', x: wl.x, y: wl.y })).ok) { done.push(`wall ${wl.x},${wl.y}`); continue; }
    }
    if (atk.length < target) {
      const opts = w.getBuildOptions();
      let placed = false;
      for (let k = 0; k < ROTATION.length && !placed; k++) {
        const id = ROTATION[(atk.length + k) % ROTATION.length];
        const b = opts.find((o) => o.id === id);
        if (!b || !b.unlocked || !b.affordable || b.limitReached) continue;
        const cell = bestCell(w, id);
        if (cell) say(`建塔：轮到 ${id}，覆盖路格最多的空位是 (${cell.x},${cell.y})。`);
        if (cell && (await call('place_tower', { tower: id, x: cell.x, y: cell.y })).ok) { done.push(`${id} ${cell.x},${cell.y}`); placed = true; }
      }
      if (placed) continue;
    }
    // 升级最低级、买得起的塔
    const cand = atk.map((t) => ({ t, info: w.getTowerInfo(t.uid) }))
      .filter((x) => x.info && x.info.upgradeCost !== null && x.info.upgradeCost <= s.gold)
      .sort((a, b) => a.t.level - b.t.level || a.t.uid - b.t.uid)[0];
    if (cand && (atk.length >= target || s.gold > 120)) {
      say(`升级：塔数已够或金币充足（${Math.floor(s.gold)}），升级最低级的 #${cand.t.uid}（Lv${cand.t.level}，${cand.info!.upgradeCost} 金币）。`);
      const r = cand.info!.needsBranch
        ? await call('choose_branch', { uid: cand.t.uid, branch: 'A' })
        : await call('upgrade_tower', { uid: cand.t.uid });
      if (r.ok) { done.push(`up #${cand.t.uid}`); continue; }
    }
    break;
  }
  // 技能
  if (s.phase === 'wave' && s.enemies.length) {
    let near = 0;
    let front: { x: number; y: number; d: number } | null = null;
    for (const e of s.enemies) {
      const d = s.grid.dist[Math.floor(e.y) * s.grid.cols + Math.floor(e.x)];
      const dd = Number.isFinite(d) ? d : 99;
      if (dd <= 4) near++;
      if (!front || dd < front.d) front = { x: Math.floor(e.x), y: Math.floor(e.y), d: dd };
    }
    const ready = (id: string) => s.skills.some((k) => k.id === id && k.ready);
    say(`技能：离出口 ≤4 格的敌人 ${near} 个${s.bossUids.length ? '，场上有 Boss' : ''}。`);
    if (front && (near >= 3 || s.bossUids.length) && ready('eraser_strike')) {
      if ((await call('cast_skill', { skill: 'eraser_strike', x: front.x, y: front.y })).ok) done.push('eraser');
    }
    if (near >= 6 && ready('bell') && (await call('cast_skill', { skill: 'bell' })).ok) done.push('bell');
  }
  const manual = s.phase === 'build' && !(s.autoWave.enabled && s.autoWave.started);
  if (manual) say('手动开波模式、正在建造阶段 → 开下一波。');
  if (manual && (await call('start_wave', {})).ok) done.push('start');
  if (!done.length) say('没有值得做的动作，保持现状。');
  const note = done.length ? done.join('; ').slice(0, 200) : 'hold';
  await call('end_turn', { note });
  return note;
}

/**
 * 意图版脚本策略（确定性）：像模型那样每个决策点只发一次 act，用高层意图（anti_air / spend / 技能），
 * 选位与迷宫全部交给规划器。用于离线评测规划器本身（scripts/agent-eval.ts 的 scripted-intents 变体）。
 */
export async function scriptedIntentTurn(w: IWorld, call: Call, reasons: DecisionReason[], think?: (line: string) => void): Promise<string> {
  const s = w.state;
  const say = (line: string): void => think?.(`${line}\n`);
  const actions: Record<string, unknown>[] = [];
  if (s.phase === 'perk' && s.perkChoices) {
    const c = s.perkChoices.slice().sort((a, b) => rank(a.id) - rank(b.id)).find((x) => !x.needsTower) ?? s.perkChoices[0];
    actions.push({ do: 'choose_perk', id: c.id });
  }
  if (s.crateChoice) {
    const pref = ['gold', 'xp', 'lives', 'caffeine', 'cooldown', 'charge'];
    const opt = s.crateChoice.options.slice().sort((a, b) => pref.indexOf(a.id) - pref.indexOf(b.id))[0];
    if (opt) actions.push({ do: 'choose_crate', option: opt.id });
  }
  if (s.pickups.length) actions.push({ do: 'collect' });
  if (s.nextWave.tags.includes('air')) actions.push({ do: 'anti_air' });
  actions.push({ do: 'spend', reserve: 0 });
  if (s.phase === 'wave' && s.enemies.length) {
    let near = 0;
    let front: { x: number; y: number; d: number } | null = null;
    for (const e of s.enemies) {
      const d = s.grid.dist[Math.floor(e.y) * s.grid.cols + Math.floor(e.x)];
      const dd = Number.isFinite(d) ? d : 99;
      if (dd <= 4) near++;
      if (!front || dd < front.d) front = { x: Math.floor(e.x), y: Math.floor(e.y), d: dd };
    }
    const ready = (id: string) => s.skills.some((k) => k.id === id && k.ready);
    if (front && (near >= 3 || s.bossUids.length) && ready('eraser_strike')) actions.push({ do: 'cast_skill', skill: 'eraser_strike', x: front.x, y: front.y });
    if (near >= 6 && ready('bell')) actions.push({ do: 'cast_skill', skill: 'bell' });
  }
  if (s.phase === 'build' && !(s.autoWave.enabled && s.autoWave.started)) actions.push({ do: 'start_wave' });
  say(`决策原因：${reasons.join(', ') || '—'}；金币 ${Math.floor(s.gold)} → ${actions.map((a) => a.do).join(', ')}`);
  const r = await call('act', { actions, end: { plan: 'serpentine maze + spend', note: `w${s.wave}` } });
  return r.text.split('\n').slice(0, -1).join('; ').slice(0, 200) || 'hold';
}

const rank = (id: string): number => {
  const i = PERK_PRIORITY.indexOf(id);
  return i < 0 ? 99 : i;
};

/** 作为 LLMProvider：所有动作经 ctx.callTool（记录、realtime 时间推进与模型完全一致） */
export class ScriptedProvider implements LLMProvider {
  readonly id = 'scripted';
  readonly model: string;
  /** intents = 意图版（一次 act + 规划器），否则旧版逐个细粒度工具 */
  constructor(private readonly o: { intents?: boolean } = {}) {
    this.model = o.intents ? 'scripted-intents' : 'scripted-v1';
  }

  async decide(ctx: DecisionContext): Promise<DecisionOutcome> {
    const out: DecisionOutcome = { usage: emptyUsage(), costUsd: 0, toolCalls: 0, ended: false };
    if (!ctx.world) return { ...out, error: 'scripted provider needs in-process world access' };
    const tr = ctx.trace;
    const t0 = Date.now();
    // 合成的"请求"：离线演示没有网络请求，但面板照样能看到发给"模型"的局面与工具
    tr?.({
      k: 'request', n: 1, provider: this.id, api: 'local', model: this.model, host: '本机（离线，无网络请求）',
      params: { 说明: '内置规则策略：不调用任何模型，下面的"思路"是规则判断过程' },
      messages: 1,
      raw: { provider: 'scripted', model: this.model, note: '离线演示：没有发出任何网络请求', messages: [{ role: 'user', content: '(见「观察」)' }] },
    });
    let seq = 0;
    const call: Call = async (name, input) => {
      out.toolCalls++;
      const r = await ctx.callTool(name, input, { id: `scripted_${++seq}` });
      if (r.endTurn) { out.ended = true; out.note = r.note; }
      return r;
    };
    const turn = this.o.intents ? scriptedIntentTurn : scriptedTurn;
    const note = await turn(ctx.world, call, ctx.point.reasons, tr ? (line) => tr({ k: 'thinking', n: 1, text: line }) : undefined);
    tr?.({ k: 'text', n: 1, text: `本回合：${note}` });
    tr?.({ k: 'response', n: 1, stop: 'end_turn', usage: emptyUsage(), ms: Date.now() - t0, costUsd: 0, raw: { stop_reason: 'end_turn', note, tool_calls: out.toolCalls } });
    return out;
  }
}

/** 作为兜底策略（同步执行器，直接下指令；浏览器里无脚本机器人时的默认兜底） */
export function scriptedFallback(w: IWorld): FallbackPolicy {
  return {
    name: 'scripted',
    decide: async (reasons) => {
      await scriptedTurn(w, (name, input) => executeTool({ world: w, role: 'player' }, name, input), reasons);
    },
  };
}
