/**
 * NEXT 行（建造阶段）：把威胁 / 漏怪缺口 / 克制 / 迷宫 / 闲置金币这些提示合成一张按紧急程度排好的动作清单，
 * 模型可以直接照抄进 act.actions。以前每条提示各带一个「→ 建议」，互相打架（修迷宫？补组合？花钱？），
 * 模型要自己权衡；现在只给一个默认答案，其余提示降为依据。
 *
 * 优先级：危险 / 吃紧的路线与飞行线 > 反复漏怪的缺口 > Boss 波缺 Boss 克制 > 其他缺的克制 > 迷宫不够长 > 花掉余钱。
 * 组合技、回收零伤害塔不进清单（不急），写在 also 里。
 * 纯函数、确定性，不改世界。
 */
import { ENEMIES } from '../config/enemies';
import type { IWorld } from '../core/types';
import { missingPurposes, type ThreatLine } from './battle';
import { bestComboPair, mazeStatus, outOfReach } from './board';
import { type Doctrine, MAZE_TARGET } from './doctrine';
import { type BattleIntel, segTarget } from './intel';
import type { MazePlan } from './maze';
import type { Purpose } from './purpose';

export type AdviceAction = Record<string, string | number | boolean>;

export interface Advice {
  /** 建议的动作（按顺序；最后一个总是 spend） */
  actions: AdviceAction[];
  /** 每个动作的理由（与 actions 一一对应） */
  why: string[];
  /** 不急的可选项（文字） */
  also: string[];
}

export interface AdviceInput {
  threat: readonly ThreatLine[];
  /** 最近漏怪带来的用途（CTR 的 leaks need） */
  extra?: Purpose[];
  intel?: BattleIntel;
  plan?: MazePlan;
  doc?: Doctrine;
}

/** 清单最多几步（含最后的 spend）：多了模型反而难取舍，钱也不够 */
export const ADVICE_MAX = 4;
/** Boss 波要求的威胁余量（火力 ÷ 来袭血量） */
export const BOSS_MARGIN = 3;

export function turnAdvice(w: IWorld, o: AdviceInput): Advice {
  const s = w.state;
  const actions: AdviceAction[] = [];
  const why: string[] = [];
  const also: string[] = [];
  const keys = new Set<string>();
  const add = (a: AdviceAction, reason: string): void => {
    const k = JSON.stringify(a);
    if (keys.has(k) || actions.length >= ADVICE_MAX - 1) return;
    keys.add(k);
    actions.push(a);
    why.push(reason);
  };
  const missing = missingPurposes(w, o.extra);
  const boss = s.nextWave.groups.some((g) => ENEMIES[g.enemy].boss);
  let urgent = false;

  // 1. 下一波打不住的路线 / 飞行线（最危险的先）
  for (const t of [...o.threat].filter((x) => x.verdict !== '安全').sort((a, b) => a.ratio - b.ratio)) {
    urgent = true;
    if (t.id.startsWith('air:')) {
      const sp = t.id.slice(4);
      add({ do: 'build_near', purpose: 'air', ...(sp !== '*' ? { route: sp } : {}) }, `${t.id} ${t.verdict} ×${t.ratio}`);
    } else {
      const p = missing[0] ?? 'dps';
      add({ do: 'build_near', purpose: p, target: t.id === '*' ? 'route' : `route:${t.id}` }, `${t.id} ${t.verdict} ×${t.ratio}`);
    }
  }
  // 2. 反复漏怪的缺口
  const hs = o.intel?.hotspots(5, 3).filter((h) => h.n >= 2) ?? [];
  for (const { gap, n } of hs.slice(0, 1)) {
    urgent = true;
    if (gap.sp.startsWith('air:')) add({ do: 'build_near', purpose: 'air', route: gap.sp.slice(4) }, `${gap.sp} leaked ${n}× in 5 waves`);
    else add({ do: 'build_near', purpose: 'dps', target: segTarget(gap.cells, s.grid.cols) }, `${gap.sp} gap leaked ${n}× in 5 waves`);
  }
  // 3. Boss 波缺 Boss 克制；4. 其他缺的克制（下一波 / 最近漏怪需要）
  // Boss 波：没有 Boss 克制，或者 Boss 那条路线余量不到 3 倍（Boss 血厚、护甲高，估算偏乐观）就补
  const bossRoutes = new Set(s.nextWave.groups.filter((g) => ENEMIES[g.enemy].boss).map((g) => g.spawner || '*'));
  const bossThin = o.threat.some((t) => !t.id.startsWith('air:') && (bossRoutes.has(t.id) || bossRoutes.has('*')) && t.ratio < BOSS_MARGIN);
  if (boss && missing.includes('boss')) add({ do: 'build_near', purpose: 'boss' }, 'boss next wave, no lamp/pen/ruler');
  else if (bossThin) add({ do: 'build_near', purpose: 'boss' }, `boss next wave, margin < ${BOSS_MARGIN}×`);
  for (const p of missing) {
    if (p === 'boss') continue;
    add({ do: 'build_near', purpose: p }, `next wave needs ${p}, none on board`);
    break;
  }
  // 5. 迷宫明显短于中心策略的目标（前期最划算的投资）
  const m = mazeStatus(w, o.plan);
  if (m.len && m.base && m.left > 0) {
    const ratio = m.len / m.base;
    const target = MAZE_TARGET[o.doc?.maze ?? 'standard'];
    if (ratio < target && ratio < 0.85 * (m.plan / m.base)) add({ do: 'maze' }, `maze ${ratio.toFixed(1)}× < ${target}×`);
  }
  // 6. 余钱全花：留 20 金每波只多 1 金利息，不如变成火力（评测：全花更稳）
  actions.push({ do: 'spend', reserve: 0 });
  why.push(urgent || boss ? 'spend the rest now' : 'spend the rest');

  // 不急的可选项
  const pair = bestComboPair(w);
  if (pair) also.push(`build_near pair:"${pair}"`);
  // 只提够不着任何路线的塔：最近 0 伤害的塔常常只是后备（前面的塔把怪打完了），不该卖
  const dead = outOfReach(w);
  if (dead.length)
    also.push(
      `reclaim idle_towers (${dead.length} out of reach: ${dead
        .slice(0, 4)
        .map((u) => `#${u}`)
        .join(' ')})`,
    );
  return { actions, why, also };
}

/** 发给模型的一行：NEXT [...JSON 动作...] ← 理由 | … ; also … */
export function adviceLine(a: Advice): string {
  const also = a.also.length ? ` ; also: ${a.also.join(', ')}` : '';
  return `NEXT ${JSON.stringify(a.actions)} ← ${a.why.join(' | ')}${also}`;
}

/** 其他提示行末尾的「→ 建议」（NEXT 已经汇总，去掉免得互相打架） */
export function stripArrow(line: string): string {
  return line
    .split('\n')
    .map((l) => l.replace(/\s*→\s*\{do:.*$/, ''))
    .join('\n');
}
