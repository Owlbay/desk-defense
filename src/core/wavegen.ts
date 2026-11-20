import type { AffixId, DifficultyParams, EnemyId, MapId, ModeId, SpawnMode, WavePreview, WavePreviewGroup } from './types';
import { Rng } from './rng';
import { countScale, eliteChance } from './scaling';
import { AFFIXES, AFFIX_IDS, BOSS_ROTATION, ENDLESS_POOL, ENEMIES } from '../config/enemies';
import { CAMPAIGN, CAMPAIGN_WAVES } from '../config/campaign';
import { CAPS } from '../config/difficulty';

export interface SpawnEntry {
  /** 相对开波的秒数 */
  at: number;
  enemy: EnemyId;
  entrance: number;
  elite: boolean;
  affixes: AffixId[];
  /** 兵团合并数量 */
  group: number;
  /** 额外生命倍率（冲锋 0.8、小 Boss 0.6） */
  hpMul: number;
  /** 所属组（类型）下标；Boss 为 -1 */
  gi: number;
  /** 原始时间（包夹波会把同组敌人对齐成同时出现） */
  at0: number;
  /** 出生点 id（由 assignSpawners 写入） */
  spawner?: string;
  /** 包夹（split）分配的敌人：预告里显示为 '*' */
  split?: boolean;
}

/** 每组的出怪策略（缺省用难度的 spawnMode） */
export interface GroupSpawn {
  mode?: SpawnMode;
  /** fixed：出生点 id */
  from?: string;
}

export interface WavePlan {
  wave: number;
  /** 成长公式使用的波数（战役含章节偏移） */
  effWave: number;
  tags: WavePreview['tags'];
  entries: SpawnEntry[];
  groups: WavePreviewGroup[];
  /** 按组下标的出怪策略 */
  groupSpawn: GroupSpawn[];
  /** 最近一次分配出生点所用的键（出生点集合变化后需要重新分配） */
  assignKey?: string;
}

export interface WaveGenContext {
  seed: string;
  mode: ModeId;
  map: MapId;
  params: DifficultyParams;
  /** 旧字段：入口数量（只影响 SpawnEntry.entrance，出生点由 assignSpawners 决定） */
  entrances?: number;
}

interface TypeCount {
  enemy: EnemyId;
  count: number;
  interval: number;
  hpMul: number;
  spawn?: GroupSpawn;
}

/** 合并兵团：总数超过单波上限时，同类 k 个合并成 1 个 */
function legionK(total: number): number {
  return total > CAPS.maxPerWave ? Math.ceil(total / CAPS.maxPerWave) : 1;
}

function rollAffixes(rng: Rng, enemy: EnemyId, max: number): AffixId[] {
  const n = 1 + rng.int(Math.max(1, max));
  const out: AffixId[] = [];
  for (let tries = 0; tries < 20 && out.length < n; tries++) {
    const a = AFFIX_IDS[rng.int(AFFIX_IDS.length)];
    if (out.includes(a)) continue;
    const def = AFFIXES[a];
    if (def.notOn?.includes(enemy)) continue;
    if (def.excludes?.some((x) => out.includes(x))) continue;
    out.push(a);
  }
  return out;
}

function buildTimeline(rng: Rng, ctx: WaveGenContext, w: number, types: TypeCount[], bosses: EnemyId[], bossHpMul: number): SpawnEntry[] {
  const D = ctx.params;
  const total = types.reduce((s, t) => s + t.count, 0) + bosses.length;
  const k = legionK(total);
  const p = eliteChance(D, w);
  const entries: SpawnEntry[] = [];
  const nEnt = Math.max(1, ctx.entrances ?? 1);
  let gi = 0;
  for (const t of types) {
    const n = Math.max(1, Math.ceil(t.count / k));
    const def = ENEMIES[t.enemy];
    const start = gi * 1.2;
    // 数量多时压缩间隔
    const ivl = t.interval * Math.min(1, Math.max(0.4, 20 / n));
    if (t.enemy === 'ant') {
      // 每次以 6～10 只为一组，组内间隔 0.2
      let left = n;
      let at = start;
      let grp = 0;
      while (left > 0) {
        const size = Math.min(left, 6 + rng.int(5));
        const ent = (gi + grp) % nEnt;
        for (let j = 0; j < size; j++) {
          entries.push(mkEntry(rng, t.enemy, at + j * 0.2, ent, p, D.maxAffix, k, t.hpMul, gi));
        }
        at += size * 0.2 + 1.5;
        left -= size;
        grp++;
      }
    } else {
      for (let j = 0; j < n; j++) {
        const ent = (gi + j) % nEnt;
        entries.push(mkEntry(rng, t.enemy, start + j * ivl, ent, def.boss ? 0 : p, D.maxAffix, k, t.hpMul, gi));
      }
    }
    gi++;
  }
  bosses.forEach((b, i) => {
    entries.push({ at: 3 + i * 2.5, at0: 3 + i * 2.5, enemy: b, entrance: i % nEnt, elite: false, affixes: [], group: 1, hpMul: bossHpMul, gi: -1 });
  });
  entries.sort((a, b) => a.at - b.at);
  return entries;
}

function mkEntry(rng: Rng, enemy: EnemyId, at: number, entrance: number, p: number, maxAffix: number, group: number, hpMul: number, gi: number): SpawnEntry {
  let elite = false;
  let affixes: AffixId[] = [];
  if (p > 0 && maxAffix > 0 && !ENEMIES[enemy].boss && rng.chance(p)) {
    affixes = rollAffixes(rng, enemy, maxAffix);
    elite = affixes.length > 0;
  }
  return { at, at0: at, enemy, entrance, elite, affixes, group, hpMul, gi };
}

/** 预告：按（敌人, 出生点）汇总；包夹分配的敌人出生点记为 '*' */
export function summarize(entries: SpawnEntry[]): WavePreviewGroup[] {
  const map = new Map<string, WavePreviewGroup>();
  for (const e of entries) {
    const sp = e.split ? '*' : (e.spawner ?? '');
    const key = `${e.enemy}|${sp}`;
    let g = map.get(key);
    if (!g) {
      g = { enemy: e.enemy, count: 0, elite: 0, affixes: [], spawner: sp };
      map.set(key, g);
    }
    g.count += e.group;
    if (e.elite) {
      g.elite += e.group;
      for (const a of e.affixes) if (!g.affixes.includes(a)) g.affixes.push(a);
    }
  }
  return [...map.values()];
}

/** 无尽 Boss 轮换：第 10/20/30/40 波依次，之后循环；50 波起 2 个、100 波起 3 个 */
export function bossesForWave(w: number): EnemyId[] {
  if (w % 10 !== 0 || w <= 0) return [];
  const idx = (w / 10 - 1) % BOSS_ROTATION.length;
  const n = w >= 100 ? 3 : w >= 50 ? 2 : 1;
  const out: EnemyId[] = [];
  for (let i = 0; i < n; i++) out.push(BOSS_ROTATION[(idx + i) % BOSS_ROTATION.length]);
  return out;
}

function generateEndless(ctx: WaveGenContext, w: number): WavePlan {
  const rng = new Rng(`${ctx.seed}|wave|${w}`);
  const D = ctx.params;
  let N = Math.max(1, Math.round(9 * countScale(D, w)));
  const tags: WavePreview['tags'] = [];
  const bosses = bossesForWave(w);
  const isBoss = bosses.length > 0;
  const isAir = !isBoss && w % 7 === 0;
  const isRush = !isBoss && !isAir && w % 5 === 0;
  if (isBoss) tags.push('boss');
  else if (isAir) tags.push('air');
  else if (isRush) tags.push('rush');
  if (isBoss) N = Math.max(3, Math.round(N * 0.3));
  const isPincer = !isBoss && !isRush && w >= 12 && w % 8 === 4;

  const avail = ENDLESS_POOL.filter((id) => ENEMIES[id].first <= w);
  const newest = avail[avail.length - 1];
  const mustNewest = w - ENEMIES[newest].first < 3;
  let kTypes = Math.min(avail.length, Math.min(4, 2 + Math.floor(w / 20) + (rng.chance(0.5) ? 1 : 0)));
  if (avail.length === 1) kTypes = 1;
  if (isBoss) kTypes = Math.min(kTypes, 2);

  const chosen: EnemyId[] = [];
  if (mustNewest) chosen.push(newest);
  if (isAir) {
    const fl = avail.filter((id) => ENEMIES[id].flying);
    for (const f of fl) if (!chosen.includes(f) && chosen.length < kTypes) chosen.push(f);
  }
  if (isRush) {
    const fast = avail.filter((id) => ENEMIES[id].fast);
    if (fast.length && !chosen.some((c) => ENEMIES[c].fast)) chosen.push(fast[0]);
  }
  const pool = avail.filter((id) => !chosen.includes(id));
  while (chosen.length < kTypes && pool.length) {
    const i = rng.weighted(pool.map((id) => ENEMIES[id].weight));
    chosen.push(pool[i]);
    pool.splice(i, 1);
  }
  // 空袭波确保至少有一种地面敌人以外的配比
  const types: TypeCount[] = [];
  const flyIds = chosen.filter((id) => ENEMIES[id].flying);
  const groundIds = chosen.filter((id) => !ENEMIES[id].flying);
  const alloc = (ids: EnemyId[], total: number) => {
    const ws = ids.reduce((s, id) => s + ENEMIES[id].weight, 0) || 1;
    for (const id of ids) {
      const def = ENEMIES[id];
      const share = (total * def.weight) / ws;
      const eq = 0.5 + 0.5 * Math.min(1, def.baseCount / 9);
      let c = Math.max(1, Math.round(share * eq));
      if (id === 'ant') c = Math.max(6, c);
      let hpMul = 1;
      if (isRush && def.fast) {
        c *= 2;
        hpMul = 0.8;
      }
      // 突袭波：快速敌人整组从同一个出生点出来；包夹波：每组平均分到各出生点
      let spawn: GroupSpawn | undefined;
      if (isRush && def.fast) spawn = { mode: 'focus' };
      else if (isPincer) spawn = { mode: 'split' };
      types.push({ enemy: id, count: c, interval: def.interval, hpMul, spawn });
    }
  };
  if (isAir && flyIds.length) {
    alloc(flyIds, Math.round(N * 0.6));
    if (groundIds.length) alloc(groundIds, Math.max(1, N - Math.round(N * 0.6)));
  } else {
    alloc(chosen, N);
  }
  const entries = buildTimeline(rng, ctx, w, types, bosses, 1);
  return { wave: w, effWave: w, tags, entries, groups: summarize(entries), groupSpawn: types.map((t) => t.spawn ?? {}) };
}

function generateCampaign(ctx: WaveGenContext, w: number): WavePlan {
  const ch = CAMPAIGN[ctx.map];
  const rng = new Rng(`${ctx.seed}|cwave|${ctx.map}|${w}`);
  const eff = w + ch.waveOffset;
  const def = ch.waves[Math.min(CAMPAIGN_WAVES, Math.max(1, w)) - 1];
  const types: TypeCount[] = [];
  const bosses: EnemyId[] = [];
  let bossHp = 1;
  for (const g of def.groups) {
    if (ENEMIES[g.enemy].boss) {
      for (let i = 0; i < g.count; i++) bosses.push(g.enemy);
      bossHp = g.hpMul ?? 1;
      continue;
    }
    const c = Math.max(1, Math.round(g.count * ctx.params.countMul));
    const spawn: GroupSpawn | undefined = g.spawn ? { mode: g.spawn, from: g.from } : g.from ? { mode: 'fixed', from: g.from } : undefined;
    types.push({ enemy: g.enemy, count: c, interval: g.interval ?? ENEMIES[g.enemy].interval, hpMul: g.hpMul ?? 1, spawn });
  }
  const entries = buildTimeline(rng, ctx, eff, types, bosses, bossHp);
  return { wave: w, effWave: eff, tags: def.tags ? [...def.tags] : [], entries, groups: summarize(entries), groupSpawn: types.map((t) => t.spawn ?? {}) };
}

export function generateWave(ctx: WaveGenContext, w: number): WavePlan {
  return ctx.mode === 'campaign' ? generateCampaign(ctx, w) : generateEndless(ctx, w);
}

// ───────────────────────── 出生点分配（文档 09 §1.2） ─────────────────────────

export interface SpawnSlot {
  id: string;
  weight: number;
  /** 空降点：本波改从这里出来的比例 */
  dropRatio?: number;
}

/**
 * 给计划里的每个敌人分配出生点（就地修改 plan.entries / plan.groups）。
 * open：开放的边缘 / 隐藏出生点；drops：已落地的空降点。
 * 随机结果只取决于 rng，因此预告即实际。
 */
export function assignSpawners(plan: WavePlan, open: SpawnSlot[], drops: SpawnSlot[], mode: SpawnMode, rng: Rng): void {
  const slots = open.length ? open : drops.length ? drops : [{ id: '', weight: 1 }];
  const n = slots.length;
  const weights = slots.map((s) => s.weight);
  const pick = () => slots[rng.weighted(weights)].id;
  const byGroup = new Map<number, SpawnEntry[]>();
  for (const e of plan.entries) {
    e.at = e.at0;
    e.split = false;
    let arr = byGroup.get(e.gi);
    if (!arr) byGroup.set(e.gi, (arr = []));
    arr.push(e);
  }
  const gis = [...byGroup.keys()].sort((a, b) => a - b);
  for (const gi of gis) {
    const list = byGroup.get(gi)!;
    if (gi < 0) {
      list.forEach((e, k) => { e.spawner = slots[(k + plan.wave) % n].id; });
      continue;
    }
    const gs = plan.groupSpawn[gi] ?? {};
    let gm: SpawnMode = gs.mode ?? mode;
    if (gm === 'split' && n < 2) gm = 'roundRobin';
    switch (gm) {
      case 'fixed': {
        const id = slots.find((s) => s.id === gs.from)?.id ?? slots[gi % n].id;
        for (const e of list) e.spawner = id;
        break;
      }
      case 'focus': {
        const id = pick();
        for (const e of list) e.spawner = id;
        break;
      }
      case 'random':
        for (const e of list) e.spawner = pick();
        break;
      case 'split':
        list.forEach((e, j) => {
          e.spawner = slots[j % n].id;
          e.at = list[j - (j % n)].at0;
          e.split = true;
        });
        break;
      default:
        list.forEach((e, j) => { e.spawner = slots[(gi + j) % n].id; });
    }
  }
  // 空降点分走一部分敌人（Boss 除外）
  if (drops.length && open.length) {
    let total = 0;
    for (const d of drops) total += d.dropRatio ?? 0.4;
    const scale = total > 0.8 ? 0.8 / total : 1;
    for (const e of plan.entries) {
      if (e.gi < 0) continue;
      let r = rng.next();
      for (const d of drops) {
        r -= (d.dropRatio ?? 0.4) * scale;
        if (r < 0) {
          e.spawner = d.id;
          e.split = false;
          break;
        }
      }
    }
  }
  plan.entries.sort((a, b) => a.at - b.at || a.at0 - b.at0);
  plan.groups = summarize(plan.entries);
}
