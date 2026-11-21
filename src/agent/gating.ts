/**
 * 决策门控（文档 10 §4.3）：决策点到了，但局面里没有任何值得叫模型的事 → 不调用模型，本地处理（手动开波模式下自动开波），
 * 追踪里记一条"跳过（无可行动作）"。
 *
 * 永远不跳过：开局、增益三选一、补给箱、随机事件 / 空降预警、Boss 出场、漏怪、有危险（敌人离出口 ≤3 格）时有就绪技能 / 能力。
 * 没有预警、直接开始的怪物类事件（金币袋怪 / 金色精英 / 急救小队 / 赏金 / 狂暴 / 加练…）在「相关」时也按 event_warn 叫模型，
 * 见 eventNeedsDecision。
 * 其余（建造阶段、波次中定期检查）按激进程度判断"有没有买得起的有用动作"：
 *   normal：金币 ≥ 最便宜的有用动作（建一座攻击塔 / 升级 / 分支 / 进化）才叫模型；
 *   aggressive：另外要求自上次真正叫模型以来新增的金币 ≥ 最便宜动作，且波次中的定期检查只有"金币 ≥ 2× 最便宜动作"才叫；
 *   off：从不跳过。
 */
import type { IWorld, RandomEventId } from '../core/types';
import { TOWERS } from '../config/towers';
import { RANDOM_EVENTS } from '../config/events';
import type { DecisionReason } from './types';

export type GatingLevel = 'aggressive' | 'normal' | 'off';

const ALWAYS: DecisionReason[] = ['game_start', 'perk', 'crate', 'event_warn', 'drop_warn', 'boss_spawn', 'leak'];

/** 最便宜的"有用"花钱动作（攻击塔 / 升级 / 分支 / 进化；墙不算——墙要配合规划，留给建造阶段的正常决策） */
export function cheapestUsefulAction(w: IWorld): number {
  let min = Infinity;
  for (const b of w.getBuildOptions()) {
    if (!b.unlocked || b.limitReached || !TOWERS[b.id].attacks) continue;
    min = Math.min(min, b.cost);
  }
  for (const t of w.state.towers.values()) {
    if (t.id === 'wall') continue;
    const info = w.getTowerInfo(t.uid);
    if (!info) continue;
    if (info.upgradeCost !== null) min = Math.min(min, info.upgradeCost);
    if (info.evolveCost !== null) min = Math.min(min, info.evolveCost);
  }
  return min;
}

/** 有敌人离出口 ≤ 3 格，或场上有 Boss */
export function inDanger(w: IWorld): boolean {
  const s = w.state;
  if (s.bossUids.length) return true;
  const g = s.grid;
  for (const e of s.enemies) {
    let d: number;
    if (e.flying) {
      d = Infinity;
      for (const ex of g.exits) d = Math.min(d, Math.hypot(ex.x + 0.5 - e.x, ex.y + 0.5 - e.y));
    } else {
      const cx = Math.max(0, Math.min(g.cols - 1, Math.floor(e.x)));
      const cy = Math.max(0, Math.min(g.rows - 1, Math.floor(e.y)));
      d = g.dist[cy * g.cols + cx];
    }
    if (d <= 3) return true;
  }
  return false;
}

/**
 * 怪物类事件开始时要不要叫模型：
 *   always：金币袋怪 / 金色精英（集火、放技能）、急救小队（先打修正液）、茶歇 / 护盾补给（爆发技能）；
 *   spend：赏金 / 狂暴 / 加练——手里的钱够做一件有用的事（花在输出上）或有就绪技能时才叫。
 */
export const EVENT_DECIDE: Partial<Record<RandomEventId, 'always' | 'spend'>> = {
  goldbag: 'always',
  golden_elite: 'always',
  medic_squad: 'always',
  tea_break: 'always',
  shield_supply: 'always',
  bounty: 'spend',
  frenzy: 'spend',
  training: 'spend',
};

/** 随机事件「开始」时是否值得叫模型（有预警的事件已在预警时叫过，这里只看没有预警的） */
export function eventNeedsDecision(id: RandomEventId, w: IWorld): boolean {
  const k = EVENT_DECIDE[id];
  if (!k || RANDOM_EVENTS[id].warn !== 0) return false;
  if (k === 'always') return true;
  return Math.floor(w.state.gold) >= cheapestUsefulAction(w) || readyAbility(w);
}

function readyAbility(w: IWorld): boolean {
  if (w.state.skills.some((k) => k.ready && k.target !== 'none' && k.id !== 'relocate')) return true;
  for (const t of w.state.towers.values()) if (t.stars >= 3 && t.abilityCd <= 0) return true;
  return false;
}

export interface GateContext {
  /** 上次真正叫模型时的金币 */
  goldAtLastCall: number;
  /** 本局第几个决策点（1 = 第一个） */
  seq: number;
  /** 预算紧张（≥90%）：只在建造阶段 / 事件 / 增益时决策，波次中的定期检查一律跳过 */
  quiet?: boolean;
}

/** 返回跳过原因（中文）；null = 需要叫模型 */
export function gateDecision(w: IWorld, reasons: DecisionReason[], level: GatingLevel, gc: GateContext): string | null {
  if (level === 'off' || gc.seq <= 1) return null;
  if (reasons.some((r) => ALWAYS.includes(r))) return null;
  const s = w.state;
  if (s.phase === 'perk' || s.crateChoice) return null;
  if (gc.quiet && reasons.every((r) => r === 'wave_interval') && !inDanger(w)) return '预算紧张：波次中的定期检查跳过';
  if (s.spawners.some((sp) => sp.kind === 'drop' && sp.active && sp.demolishCost && s.gold >= sp.demolishCost)) return null;
  const danger = inDanger(w);
  if (danger && readyAbility(w)) return null;
  const gold = Math.floor(s.gold);
  const min = cheapestUsefulAction(w);
  if (!Number.isFinite(min)) return danger ? null : '没有可买的东西';
  if (gold < min) return `无可行动作（金币 ${gold} < 最便宜动作 ${min}）`;
  if (level === 'aggressive' && reasons.every((r) => r === 'wave_interval') && !danger) {
    // 省流：波次中的定期检查要"新到手的钱够做一件事"且"手里的钱够做两件事"才叫模型；建造阶段照常
    const gained = gold - gc.goldAtLastCall;
    if (gained < min) return `无新可行动作（上次叫模型后只多了 ${Math.max(0, gained)} 金币）`;
    if (gold < 2 * min) return `波次中省流跳过（金币 ${gold} < 2×${min}）`;
  }
  return null;
}
