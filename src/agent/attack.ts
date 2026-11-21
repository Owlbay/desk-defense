/**
 * AI 进攻方（文档 10 §2.3）：进攻方自己的紧凑观测、每波战果台账、确定性的离线出题策略。
 *
 * - 进攻方只在建造阶段（下一波开始前）决策：读预算 / 出怪池 / 价格 / 防守方的塔与路线 / 最近几波的漏怪，
 *   调用 attack_plan 改写下一波（core 指令 overrideWave，与玩家指令同一套校验、写入指令日志，回放确定）。
 * - 防守方是真人（「出题人」模式）；无头评测里由兜底机器人防守。
 * 纯 TS，无 DOM。
 */
import { affixPrice, ATTACK, dropPrice, enemyPrice, groupCost, hpUnits } from '../config/attack';
import { AFFIXES, ENEMIES } from '../config/enemies';
import { TOWERS } from '../config/towers';
import type { AffixId, AttackContextInfo, AttackGroup, EnemyId, GameEvent, IWorld } from '../core/types';
import { groundRoutes } from './routes';

// ───────────────────────── 台账：每波战果 ─────────────────────────

export interface AttackWaveRecord {
  wave: number;
  /** 本波是否由进攻方改写 */
  planned: boolean;
  cost: number;
  leaks: number;
  livesLost: number;
  kills: number;
}

/** 按世界事件记录每波的漏怪 / 掉命 / 击杀（最近 8 波） */
export class AttackLedger {
  readonly waves: AttackWaveRecord[] = [];
  private planned = new Map<number, number>();

  /** attack_plan 成功：记下这一波的花费 */
  notePlan(wave: number, cost: number): void {
    this.planned.set(wave, cost);
  }

  onEvent(ev: GameEvent): void {
    switch (ev.type) {
      case 'waveStart': {
        const cost = this.planned.get(ev.wave);
        this.planned.delete(ev.wave);
        this.waves.push({ wave: ev.wave, planned: cost !== undefined, cost: cost ?? 0, leaks: 0, livesLost: 0, kills: 0 });
        if (this.waves.length > 8) this.waves.shift();
        break;
      }
      case 'leak': {
        const r = this.waves[this.waves.length - 1];
        if (r) {
          r.leaks++;
          r.livesLost += ev.lives;
        }
        break;
      }
      case 'death': {
        const r = this.waves[this.waves.length - 1];
        if (r) r.kills++;
        break;
      }
    }
  }
}

// ───────────────────────── 观测 ─────────────────────────

const flags = (id: EnemyId): string => {
  const d = ENEMIES[id];
  const f: string[] = [];
  if (d.flying) f.push('air');
  if (d.fast) f.push('fast');
  if (d.armor > 0) f.push(`armor${d.armor}`);
  if (d.shieldRatio) f.push('shield');
  if (d.stealthy) f.push('stealth');
  if (d.unstoppable) f.push('unstoppable');
  if (d.dodge) f.push('dodge');
  return f.length ? ` ${f.join(',')}` : '';
};

/** 防守方摘要：塔（按类型：数量 / 平均等级）、对空塔数量、地面路线长度、生命 / 金币 */
export function defenderSummary(w: IWorld): { towers: string; air: number; routes: string[]; lives: string; gold: number } {
  const s = w.state;
  const by = new Map<string, { n: number; lv: number }>();
  let air = 0;
  for (const t of s.towers.values()) {
    const e = by.get(t.id) ?? { n: 0, lv: 0 };
    e.n++;
    e.lv += t.level;
    by.set(t.id, e);
    if (TOWERS[t.id]?.hitsAir && TOWERS[t.id]?.attacks) air++;
  }
  const towers =
    [...by.entries()]
      .sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1))
      .map(([id, e]) => (id === 'wall' ? `wall×${e.n}` : `${id}×${e.n} L${(e.lv / e.n).toFixed(1)}`))
      .join(', ') || 'none';
  const routes = groundRoutes(w).map((r) => `${r.id} L${r.len}${r.status === 'warn' ? '(warn)' : ''}`);
  return { towers, air, routes, lives: `${s.lives}/${s.maxLives}`, gold: Math.floor(s.gold) };
}

/** 进攻方的紧凑观测（一行 JSON）。没有下一波可改写时返回 null */
export function attackObservation(w: IWorld, ledger?: AttackLedger): { info: AttackContextInfo; text: string } | null {
  const info = w.attackContext?.();
  if (!info) return null;
  const def = defenderSummary(w);
  const obs = {
    w: info.wave,
    open: info.open,
    budget: info.budget,
    hpCap: info.hpCap,
    baseHp: info.baseHp,
    tags: info.tags,
    boss: info.bosses,
    pool: info.pool.map((id) => `${id} $${enemyPrice(id)} hp${ENEMIES[id].hp}${flags(id)}`),
    affixes: Object.values(AFFIXES)
      .filter((a) => a.id !== 'golden')
      .map((a) => a.id),
    spawners: info.spawners.map((s) => (s.drop ? `${s.id}(drop)` : s.id)),
    default: info.base.map((g) => `${g.enemy}×${g.count}${g.elite ? ` e${g.elite}` : ''}${g.spawner ? `@${g.spawner}` : ''}`),
    ...(info.current ? { planned: info.current.cost } : {}),
    def: { hp: def.lives, g: def.gold, T: def.towers, aa: def.air, R: def.routes },
    hist: (ledger?.waves ?? [])
      .slice(-5)
      .map((r) => `w${r.wave}${r.planned ? ` plan$${r.cost}` : ' default'} leak${r.leaks} -${r.livesLost}hp kills${r.kills}`),
  };
  return { info, text: JSON.stringify(obs) };
}

/** 进攻方的决策消息 */
export function attackMessage(header: string, seq: number, obsText: string, memo?: string): string {
  const lines = [header, `Decision #${seq}: 建造阶段——为下一波出题（attack_plan），或 end_turn 保留默认波。`];
  if (memo) lines.push(`MEMO ${memo}`);
  lines.push('STATE', obsText, '现在出题：一次 attack_plan（被拒就按原因改正再试）。');
  return lines.join('\n');
}

/** 编排的文字描述（工具结果 / 面板） */
export function planLine(groups: readonly AttackGroup[]): string {
  return groups
    .map(
      (g) =>
        `${g.enemy}×${g.count}${g.affixes?.length ? `[${g.affixes.join('+')}]` : ''}${g.spawner ? `@${g.spawner}` : ''}${g.delay !== undefined ? ` +${g.delay}s` : ''}`,
    )
    .join(', ');
}

// ───────────────────────── 离线出题策略（确定性） ─────────────────────────

/**
 * 简单的确定性出题策略（离线演示 / 兜底 / 测试）：
 *  1. 防守方对空塔 < 2 且出怪池有飞行敌人 → 主攻空中；
 *  2. 否则选"每点墨水的生命当量"最高的敌人当主力，另配本波池里最新登场的敌人；
 *  3. 轮流加数量直到预算或生命上限用完；有余钱时给一小组配一个词缀；
 *  4. 有空降点、余钱够时让主力从空降点出（绕开迷宫前段）。
 * 只用世界状态，不用随机数：同一局面永远给出同一份编排。
 */
export function scriptedAttackPlan(w: IWorld): AttackGroup[] | null {
  const info = w.attackContext?.();
  if (!info || !info.open || !info.pool.length) return null;
  const def = defenderSummary(w);
  const pool = info.pool;
  const value = (id: EnemyId) => ENEMIES[id].hp / enemyPrice(id);
  const byValue = pool.slice().sort((a, b) => value(b) - value(a) || (a < b ? -1 : 1));
  const flyers = pool.filter((id) => ENEMIES[id].flying);
  const picks: EnemyId[] = [];
  if (flyers.length && def.air < 2) picks.push(flyers[flyers.length - 1]);
  for (const id of [byValue[0], pool[pool.length - 1]]) if (id && !picks.includes(id) && picks.length < 2) picks.push(id);
  if (!picks.length) return null;
  const budget = info.budget;
  const cap = info.hpCap;
  const counts = picks.map(() => 0);
  let cost = 0;
  let hp = 0;
  // 留一点预算给精英小组
  const reserve = info.wave >= 6 ? Math.floor(budget * 0.25) : 0;
  for (let guard = 0; guard < 1000; guard++) {
    let added = false;
    for (let i = 0; i < picks.length; i++) {
      const id = picks[i];
      const p = enemyPrice(id);
      const u = hpUnits(id, 1, false);
      if (counts[i] >= ATTACK.maxCount || cost + p > budget - reserve || hp + u > cap) continue;
      counts[i]++;
      cost += p;
      hp += u;
      added = true;
    }
    if (!added) break;
  }
  const groups: AttackGroup[] = [];
  picks.forEach((id, i) => {
    if (counts[i] > 0) groups.push({ enemy: id, count: counts[i] });
  });
  // 精英小组：主力敌人配一个可用词缀
  const main = picks[0];
  const affix = (['shield', 'hard', 'regen', 'swift'] as AffixId[]).find((a) => !AFFIXES[a].notOn?.includes(main));
  if (affix && groups.length < ATTACK.maxGroups) {
    const unit = enemyPrice(main) + affixPrice(main);
    const uhp = hpUnits(main, 1, true);
    let n = 0;
    while (n < ATTACK.maxCount && cost + unit <= budget && hp + uhp <= cap) {
      n++;
      cost += unit;
      hp += uhp;
    }
    if (n > 0) groups.push({ enemy: main, count: n, affixes: [affix], delay: 4 });
  }
  // 空降点：余钱够就让第一组从空降点出来
  const drop = info.spawners.find((s) => s.drop);
  if (drop && groups.length) {
    const g = groups[0];
    const extra = g.count * dropPrice(g.enemy);
    if (cost + extra <= budget) g.spawner = drop.id;
  }
  if (!groups.length) return null;
  // 最后核一遍价格（与 core 校验同一张表）
  const total = groups.reduce((s, g) => s + groupCost(g, !!info.spawners.find((x) => x.id === g.spawner)?.drop), 0);
  return total <= budget ? groups : null;
}
