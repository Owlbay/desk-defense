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

/** 一次决策（异步：经 call 执行每个动作，与模型完全同一路径） */
export async function scriptedTurn(w: IWorld, call: Call, reasons: DecisionReason[]): Promise<string> {
  const s = w.state;
  const done: string[] = [];
  // 增益
  if (s.phase === 'perk' && s.perkChoices) {
    const cards = s.perkChoices.slice().sort((a, b) => rank(a.id) - rank(b.id));
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
    if (opt && (await call('choose_crate', { option: opt.id })).ok) done.push(`crate ${opt.id}`);
  }
  // 拆空降点（钱多时）
  for (const sp of s.spawners) {
    if (sp.kind === 'drop' && sp.active && sp.demolishCost && s.gold >= sp.demolishCost * 3) {
      if ((await call('demolish_spawner', { id: sp.id })).ok) done.push(`demolish ${sp.id}`);
    }
  }
  // 花钱
  const towers = () => [...s.towers.values()];
  for (let guard = 0; guard < 10; guard++) {
    const atk = towers().filter((t) => t.id !== 'wall');
    const walls = towers().length - atk.length;
    const target = Math.min(4 + Math.floor(s.wave * 1.2), 30);
    if (walls < 4 + s.wave * 2 && s.gold >= 25 && atk.length >= 2) {
      const wl = bestWall(w);
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
        if (cell && (await call('place_tower', { tower: id, x: cell.x, y: cell.y })).ok) { done.push(`${id} ${cell.x},${cell.y}`); placed = true; }
      }
      if (placed) continue;
    }
    // 升级最低级、买得起的塔
    const cand = atk.map((t) => ({ t, info: w.getTowerInfo(t.uid) }))
      .filter((x) => x.info && x.info.upgradeCost !== null && x.info.upgradeCost <= s.gold)
      .sort((a, b) => a.t.level - b.t.level || a.t.uid - b.t.uid)[0];
    if (cand && (atk.length >= target || s.gold > 120)) {
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
    if (front && (near >= 3 || s.bossUids.length) && ready('eraser_strike')) {
      if ((await call('cast_skill', { skill: 'eraser_strike', x: front.x, y: front.y })).ok) done.push('eraser');
    }
    if (near >= 6 && ready('bell') && (await call('cast_skill', { skill: 'bell' })).ok) done.push('bell');
  }
  const manual = s.phase === 'build' && !(s.autoWave.enabled && s.autoWave.started);
  if (manual && (await call('start_wave', {})).ok) done.push('start');
  void reasons;
  const note = done.length ? done.join('; ').slice(0, 200) : 'hold';
  await call('end_turn', { note });
  return note;
}

const rank = (id: string): number => {
  const i = PERK_PRIORITY.indexOf(id);
  return i < 0 ? 99 : i;
};

/** 作为 LLMProvider：所有动作经 ctx.callTool（记录、realtime 时间推进与模型完全一致） */
export class ScriptedProvider implements LLMProvider {
  readonly id = 'scripted';
  readonly model = 'scripted-v1';

  async decide(ctx: DecisionContext): Promise<DecisionOutcome> {
    const out: DecisionOutcome = { usage: emptyUsage(), costUsd: 0, toolCalls: 0, ended: false };
    if (!ctx.world) return { ...out, error: 'scripted provider needs in-process world access' };
    const call: Call = async (name, input) => {
      out.toolCalls++;
      const r = await ctx.callTool(name, input);
      if (r.endTurn) { out.ended = true; out.note = r.note; }
      return r;
    };
    await scriptedTurn(ctx.world, call, ctx.point.reasons);
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
