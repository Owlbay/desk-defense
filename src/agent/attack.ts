/**
 * AI 进攻方（文档 10 §2.3）：进攻方自己的紧凑观测、每波战果台账、确定性的离线出题策略。
 *
 * - 进攻方只在建造阶段（下一波开始前）决策：读预算 / 出怪池 / 价格 / 防守方的塔与路线 / 最近几波的漏怪，
 *   调用 attack_plan 改写下一波（core 指令 overrideWave，与玩家指令同一套校验、写入指令日志，回放确定）。
 * - 防守方是真人（「出题人」模式）；无头评测里由兜底机器人防守。
 * 纯 TS，无 DOM。
 */
import { affixPrice, ATTACK, checkAttackPlan, dropPrice, enemyPrice, hpUnits } from '../config/attack';
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

/** 精英主力的词缀组合（按优先级；模拟里坚硬 + 再生对防守方压力最大，其次护盾 + 再生） */
const ELITE_AFFIXES: AffixId[][] = [
  ['hard', 'regen'],
  ['shield', 'regen'],
  ['swift', 'shield'],
  ['hard', 'shield'],
];

function eliteAffixes(id: EnemyId): AffixId[] | null {
  if ((ENEMIES[id].flying && !ATTACK.airAffixes) || ATTACK.maxAffixes < 1) return null;
  for (const pair of ELITE_AFFIXES) {
    const p = pair.slice(0, ATTACK.maxAffixes);
    const ok = p.every((a, i) => !AFFIXES[a].notOn?.includes(id) && !AFFIXES[a].excludes?.some((x) => p.slice(0, i).includes(x)));
    if (ok) return p;
  }
  return null;
}

/**
 * 确定性的离线出题策略（离线演示 / 兜底 / 测试；数值依据 scripts/sim-attack.ts，文档 10 §2.3）：
 *  1. 主力 = 地面敌人里"每点墨水生命"最高的，带两个词缀（精英）——多出来的敌人会变成防守方的赏金，
 *     精英用更少的数量给更大的压力；
 *  2. 防守方对空塔 < 2 且池里有飞行敌人 → 另配一组（不带词缀的）飞行敌人，与主力轮流加量；
 *  3. 一只精英都放不下时才用最便宜的地面敌人（不用便宜敌人填满：多出来的敌人就是防守方的赏金）；
 *  4. 有空降点、余钱够时让主力从空降点出（绕开迷宫前段）；
 *  5. 所有组开波即出发；最后用 core 同一个 checkAttackPlan 核一遍，保证不会被拒。
 * 只用世界状态，不用随机数：同一局面永远给出同一份编排。
 */
export function scriptedAttackPlan(w: IWorld): AttackGroup[] | null {
  const info = w.attackContext?.();
  if (!info || !info.open || !info.pool.length) return null;
  const def = defenderSummary(w);
  const pool = info.pool;
  const value = (id: EnemyId) => ENEMIES[id].hp / enemyPrice(id);
  const byValue = (a: EnemyId, b: EnemyId) => value(b) - value(a) || (a < b ? -1 : 1);
  const ground = pool.filter((id) => !ENEMIES[id].flying).sort(byValue);
  const flyers = pool.filter((id) => ENEMIES[id].flying).sort(byValue);
  const specs: { enemy: EnemyId; affixes: AffixId[] }[] = [];
  const main = ground.find((id) => eliteAffixes(id)) ?? ground[0];
  if (main) specs.push({ enemy: main, affixes: eliteAffixes(main) ?? [] });
  if (flyers.length && def.air < 2) specs.push({ enemy: flyers[0], affixes: [] });
  if (!specs.length) specs.push({ enemy: pool.slice().sort(byValue)[0], affixes: [] });
  const budget = info.budget;
  const cap = info.hpCap;
  let cost = 0;
  let hp = 0;
  const counts = specs.map(() => 0);
  const unitCost = (sp: (typeof specs)[number]) => enemyPrice(sp.enemy) + sp.affixes.length * affixPrice(sp.enemy);
  const perSpec = Math.max(1, Math.floor((ATTACK.maxGroups - 1) / specs.length)) * ATTACK.maxCount;
  for (let guard = 0; guard < 2000; guard++) {
    let added = false;
    specs.forEach((sp, i) => {
      const c = unitCost(sp);
      const u = hpUnits(sp.enemy, 1, sp.affixes.length > 0);
      if (counts[i] >= perSpec || cost + c > budget || hp + u > cap) return;
      counts[i]++;
      cost += c;
      hp += u;
      added = true;
    });
    if (!added) break;
  }
  // 兜底：一只精英都放不下时用最便宜的地面敌人（模拟里精英 + 填充比纯精英弱：多出来的敌人就是防守方的赏金）
  const filler = (ground.length ? ground : pool).slice().sort((a, b) => enemyPrice(a) - enemyPrice(b) || byValue(a, b))[0];
  const empty = counts.every((c) => c === 0);
  let fill = 0;
  while (empty && fill < ATTACK.maxCount && cost + enemyPrice(filler) <= budget && hp + hpUnits(filler, 1, false) <= cap) {
    fill++;
    cost += enemyPrice(filler);
    hp += hpUnits(filler, 1, false);
  }
  const groups: AttackGroup[] = [];
  specs.forEach((sp, i) => {
    for (let left = counts[i]; left > 0; left -= ATTACK.maxCount) {
      const g: AttackGroup = { enemy: sp.enemy, count: Math.min(ATTACK.maxCount, left), delay: 0 };
      if (sp.affixes.length) g.affixes = sp.affixes.slice();
      groups.push(g);
    }
  });
  if (fill > 0) groups.push({ enemy: filler, count: fill, delay: 0 });
  if (!groups.length || groups.length > ATTACK.maxGroups) return null;
  // 空降点：余钱够就让第一组从空降点出来
  const drop = info.spawners.find((s) => s.drop);
  if (drop) {
    const g = groups[0];
    if (cost + g.count * dropPrice(g.enemy) <= budget) g.spawner = drop.id;
  }
  // 最后核一遍（与 core 校验同一个函数）
  const chk = checkAttackPlan({ groups }, { wave: info.wave, pool: info.pool, spawners: info.spawners, baseHp: info.baseHp });
  return chk.ok ? groups : null;
}
