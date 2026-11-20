import type { AffixId, DifficultyParams, EnemyId, MapId, ModeId, WavePreview, WavePreviewGroup } from './types';
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
}

export interface WavePlan {
  wave: number;
  /** 成长公式使用的波数（战役含章节偏移） */
  effWave: number;
  tags: WavePreview['tags'];
  entries: SpawnEntry[];
  groups: WavePreviewGroup[];
}

export interface WaveGenContext {
  seed: string;
  mode: ModeId;
  map: MapId;
  params: DifficultyParams;
  entrances: number;
}

interface TypeCount {
  enemy: EnemyId;
  count: number;
  interval: number;
  hpMul: number;
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
        const ent = (gi + grp) % ctx.entrances;
        for (let j = 0; j < size; j++) {
          entries.push(mkEntry(rng, t.enemy, at + j * 0.2, ent, p, D.maxAffix, k, t.hpMul));
        }
        at += size * 0.2 + 1.5;
        left -= size;
        grp++;
      }
    } else {
      for (let j = 0; j < n; j++) {
        const ent = (gi + j) % ctx.entrances;
        entries.push(mkEntry(rng, t.enemy, start + j * ivl, ent, def.boss ? 0 : p, D.maxAffix, k, t.hpMul));
      }
    }
    gi++;
  }
  bosses.forEach((b, i) => {
    entries.push({ at: 3 + i * 2.5, enemy: b, entrance: i % ctx.entrances, elite: false, affixes: [], group: 1, hpMul: bossHpMul });
  });
  entries.sort((a, b) => a.at - b.at);
  return entries;
}

function mkEntry(rng: Rng, enemy: EnemyId, at: number, entrance: number, p: number, maxAffix: number, group: number, hpMul: number): SpawnEntry {
  let elite = false;
  let affixes: AffixId[] = [];
  if (p > 0 && maxAffix > 0 && !ENEMIES[enemy].boss && rng.chance(p)) {
    affixes = rollAffixes(rng, enemy, maxAffix);
    elite = affixes.length > 0;
  }
  return { at, enemy, entrance, elite, affixes, group, hpMul };
}

function summarize(entries: SpawnEntry[]): WavePreviewGroup[] {
  const map = new Map<EnemyId, WavePreviewGroup>();
  for (const e of entries) {
    let g = map.get(e.enemy);
    if (!g) {
      g = { enemy: e.enemy, count: 0, elite: 0, affixes: [] };
      map.set(e.enemy, g);
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
      types.push({ enemy: id, count: c, interval: def.interval, hpMul });
    }
  };
  if (isAir && flyIds.length) {
    alloc(flyIds, Math.round(N * 0.6));
    if (groundIds.length) alloc(groundIds, Math.max(1, N - Math.round(N * 0.6)));
  } else {
    alloc(chosen, N);
  }
  const entries = buildTimeline(rng, ctx, w, types, bosses, 1);
  return { wave: w, effWave: w, tags, entries, groups: summarize(entries) };
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
    types.push({ enemy: g.enemy, count: c, interval: g.interval ?? ENEMIES[g.enemy].interval, hpMul: g.hpMul ?? 1 });
  }
  const entries = buildTimeline(rng, ctx, eff, types, bosses, bossHp);
  return { wave: w, effWave: eff, tags: def.tags ? [...def.tags] : [], entries, groups: summarize(entries) };
}

export function generateWave(ctx: WaveGenContext, w: number): WavePlan {
  return ctx.mode === 'campaign' ? generateCampaign(ctx, w) : generateEndless(ctx, w);
}
