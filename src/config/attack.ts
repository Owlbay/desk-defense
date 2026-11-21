/**
 * AI 进攻方（文档 10 §2.3）：价格表与改写校验（纯函数、确定性；core 的 overrideWave 指令与 Agent 工具共用）。
 *
 * - 预算：每波 40 + 3×波数「墨水点」（默认波的生命当量不随波数增长，预算也只缓慢增长，≈ 默认波按价买下来的 0.6～1.6 倍）；
 * - 单价 = 敌人赏金 × priceFactor（向上取整，至少 1）；每个词缀加价 单价 × affixSurcharge；从空降点出来再加 单价 × dropSurcharge + 1；
 * - 敌人必须在本波的出怪池内（无尽：已登场的敌人；战役：本章到这一波为止出现过的敌人），Boss 不能编排；
 * - 飞行敌人不能带词缀（精英飞行敌人在模拟里是一招制胜的退化打法）；
 * - 生命当量（基础生命 × 数量 × 精英倍率）≤ 默认波（非 Boss 部分）的 hpCap 倍；
 * - Boss 波的 Boss 原样保留。
 * 数值由 scripts/sim-attack.ts 的模拟定出（结果表见文档 10 §2.3）。
 */
import type { AffixId, AttackGroup, EnemyId } from '../core/types';
import { AFFIX_ROLL_IDS, AFFIXES, ELITE, ENEMIES } from './enemies';

export const ATTACK = {
  baseBudget: 40,
  perWave: 3,
  /** 单价 = 赏金 × 系数 */
  priceFactor: 1.5,
  /** 每个词缀：单价 × 系数（向上取整，至少 1） */
  affixSurcharge: 0.6,
  /** 空降点出怪：单价 × 系数 + 1 */
  dropSurcharge: 0.5,
  /** 生命当量上限 = 默认波 × 1.2 */
  hpCap: 1.2,
  maxGroups: 6,
  maxCount: 60,
  maxAffixes: 2,
  /** 飞行敌人能否带词缀（false：任何词缀的飞行敌人都会让防守方几波内崩盘） */
  airAffixes: false,
  /** 组的出发时间上限（秒） */
  maxDelay: 30,
} as const;

/** 第 wave 波的预算（墨水点） */
export function attackBudget(wave: number): number {
  return ATTACK.baseBudget + ATTACK.perWave * Math.max(1, Math.floor(wave));
}

export function enemyPrice(id: EnemyId): number {
  return Math.max(1, Math.ceil((ENEMIES[id]?.bounty ?? 0) * ATTACK.priceFactor));
}

export function affixPrice(id: EnemyId): number {
  return Math.max(1, Math.ceil(enemyPrice(id) * ATTACK.affixSurcharge));
}

export function dropPrice(id: EnemyId): number {
  return Math.ceil(enemyPrice(id) * ATTACK.dropSurcharge) + 1;
}

/** 一组的价格 */
export function groupCost(g: Pick<AttackGroup, 'enemy' | 'count' | 'affixes'>, drop: boolean): number {
  const n = g.affixes?.length ?? 0;
  return g.count * (enemyPrice(g.enemy) + n * affixPrice(g.enemy) + (drop ? dropPrice(g.enemy) : 0));
}

/** 生命当量：基础生命 × 倍率 × 数量（精英 × ELITE.hp）。与波次成长无关（同一波两边按同一系数成长） */
export function hpUnits(enemy: EnemyId, count: number, elite: boolean, hpMul = 1): number {
  return (ENEMIES[enemy]?.hp ?? 0) * hpMul * count * (elite ? ELITE.hp : 1);
}

export interface AttackCheckContext {
  wave: number;
  pool: readonly EnemyId[];
  spawners: readonly { id: string; drop: boolean }[];
  /** 默认波的生命当量（非 Boss） */
  baseHp: number;
}

export type AttackCheck =
  | { ok: true; groups: AttackGroup[]; cost: number; budget: number; hp: number; cap: number }
  | { ok: false; code: string; params?: Record<string, string | number> };

const bad = (code: string, params?: Record<string, string | number>): AttackCheck => ({ ok: false, code, params });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 生命当量上限（默认波至少按 1 个面包屑算，避免空波 / 纯 Boss 波上限为 0） */
export function attackHpCap(baseHp: number): number {
  return Math.round(Math.max(baseHp, ENEMIES.crumb.hp) * ATTACK.hpCap);
}

/**
 * 校验（输入可能来自模型 / 回放文件，按不可信数据处理）。通过时返回规整后的组（只保留已知字段）、花费与生命当量。
 * 失败 code 对应 i18n core.reason.<code>。
 */
export function checkAttackPlan(plan: unknown, ctx: AttackCheckContext): AttackCheck {
  if (!isObj(plan) || !Array.isArray(plan.groups)) return bad('attackBadPlan');
  const raw = plan.groups as unknown[];
  if (raw.length === 0) return bad('attackBadPlan');
  if (raw.length > ATTACK.maxGroups) return bad('attackGroups', { max: ATTACK.maxGroups });
  const groups: AttackGroup[] = [];
  let cost = 0;
  let hp = 0;
  for (const g of raw) {
    if (!isObj(g) || typeof g.enemy !== 'string') return bad('attackBadPlan');
    const enemy = g.enemy as EnemyId;
    const def = ENEMIES[enemy];
    if (!def || def.boss || !ctx.pool.includes(enemy)) return bad('attackEnemy', { name: def?.name ?? String(g.enemy) });
    const count = g.count;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > ATTACK.maxCount)
      return bad('attackCount', { max: ATTACK.maxCount });
    let affixes: AffixId[] = [];
    if (g.affixes !== undefined && g.affixes !== null) {
      if (!Array.isArray(g.affixes)) return bad('attackBadPlan');
      if (g.affixes.length > ATTACK.maxAffixes) return bad('attackAffixCount', { max: ATTACK.maxAffixes });
      for (const a of g.affixes as unknown[]) {
        const id = a as AffixId;
        const ad = typeof a === 'string' ? AFFIXES[id] : undefined;
        if (
          !ad ||
          !AFFIX_ROLL_IDS.includes(id) ||
          (def.flying && !ATTACK.airAffixes) ||
          ad.notOn?.includes(enemy) ||
          affixes.includes(id) ||
          ad.excludes?.some((x) => affixes.includes(x))
        )
          return bad('attackAffix', { affix: ad?.name ?? String(a), name: def.name });
        affixes.push(id);
      }
    }
    let spawner: string | undefined;
    let drop = false;
    if (g.spawner !== undefined && g.spawner !== null && g.spawner !== '') {
      const sp = ctx.spawners.find((s) => s.id === g.spawner);
      if (!sp) return bad('attackSpawner', { id: String(g.spawner) });
      spawner = sp.id;
      drop = sp.drop;
    }
    let delay: number | undefined;
    if (g.delay !== undefined && g.delay !== null) {
      if (typeof g.delay !== 'number' || !Number.isFinite(g.delay) || g.delay < 0 || g.delay > ATTACK.maxDelay)
        return bad('attackDelay', { max: ATTACK.maxDelay });
      delay = Math.round(g.delay * 10) / 10;
    }
    affixes = affixes.slice();
    const out: AttackGroup = { enemy, count };
    if (affixes.length) out.affixes = affixes;
    if (spawner) out.spawner = spawner;
    if (delay !== undefined) out.delay = delay;
    groups.push(out);
    cost += groupCost(out, drop);
    hp += hpUnits(enemy, count, affixes.length > 0);
  }
  const budget = attackBudget(ctx.wave);
  if (cost > budget) return bad('attackBudget', { cost, budget });
  const cap = attackHpCap(ctx.baseHp);
  if (hp > cap) return bad('attackHp', { hp: Math.round(hp), cap });
  return { ok: true, groups, cost, budget, hp: Math.round(hp), cap };
}
