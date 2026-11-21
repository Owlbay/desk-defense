/**
 * 紧凑观测 v2 + 增量（文档 10 §5.2「上下文与成本优化」）。
 *
 * 与 observation.ts 的旧观测（get_state / MCP observe 仍在用）相比：
 *  - 键名缩短（图例在固定前缀的速查表里，只发一次、可缓存）；敌人用 2 字母代号（ENEMY_CODE）；
 *  - 进攻路线：每个出生点的航点（只留拐点）、长度、最长直线段、好位置、飞行线防空覆盖、下一波按出生点分组；
 *  - 增量：首次决策发完整观测，之后只发变化的键（塔按 uid 增删改），applyObsDelta 可逐字还原；
 *  - 地图只在地形变化（grid.version）或每 N 次决策时重发；省流模式下地图行用游程编码。
 */
import { TOWERS } from '../config/towers';
import { CellKind, type EnemyId, type GameEvent, type IWorld, type TowerState } from '../core/types';
import { TOWER_CHAR } from './observation';
import { attackRoutes, routeSummary } from './routes';

/** 敌人两字母代号（Boss 大写开头）。图例在速查表里 */
export const ENEMY_CODE: Record<EnemyId, string> = {
  crumb: 'cr',
  inkdot: 'ik',
  paperclip: 'pc',
  plane: 'pl',
  paperball: 'pb',
  sticky: 'st',
  rubberband: 'rb',
  whiteout: 'wo',
  ant: 'an',
  invisink: 'iv',
  tape: 'tp',
  moth: 'mo',
  crumbmini: 'cm',
  goldbag: 'gb',
  boss_coffee: 'Bc',
  boss_coffee_small: 'Bs',
  boss_shredder: 'Bd',
  boss_inkbottle: 'Bi',
  boss_alarm: 'Ba',
};
const code = (id: string): string => ENEMY_CODE[id as EnemyId] ?? id;

const r1 = (n: number): number => Math.round(n * 10) / 10 || 0; // || 0：不出现 -0（增量比较按 JSON，-0 与 0 相同）
/** 价格向上取整：<100 到 5、<500 到 10、其余到 25（显示价 ≥ 实价；后期每秒变化的经验折扣不再让 T+ 整表重发） */
const ceilP = (n: number): number => {
  const step = n < 100 ? 5 : n < 500 ? 10 : 25;
  return Math.ceil(n / step) * step;
};
const HEX = '0123456789ab';

export type CompactObs = Record<string, unknown> & { T?: string[] };

function towerLine(w: IWorld, t: TowerState): string {
  const parts = [`#${t.uid} ${t.id} ${t.cx},${t.cy} L${t.level}`];
  if (t.branch) parts.push(t.branch);
  if (t.stars) parts.push(`★${t.stars}`);
  // 经验进度按 25% 分档（x25 / x50 / x75），同理减少增量抖动
  if (t.xpNext > 0 && t.level >= 4) {
    const q = Math.floor((t.xp / t.xpNext) * 4) * 25;
    if (q > 0) parts.push(`x${Math.min(75, q)}`);
  }
  if (TOWERS[t.id].attacks && t.targetMode !== 'first') parts.push(`t=${t.targetMode}`);
  if (t.disabledUntil > w.state.time) parts.push('OFF');
  const info = w.getTowerInfo(t.uid);
  if (info) {
    // 价格向上取整（ceilP；经验折扣让价格每秒都在变，取整后增量里少很多"变化"；显示价 ≥ 实价，钱够就一定买得起）
    if (info.upgradeCost !== null) parts.push(info.needsBranch ? `br${ceilP(info.upgradeCost)}` : `up${ceilP(info.upgradeCost)}`);
    if (info.evolveCost !== null) parts.push(`ev${ceilP(info.evolveCost)}`);
    if (info.ability) parts.push(`ab${info.ability.ready ? 'R' : Math.ceil(info.ability.cd)}`);
  }
  return parts.join(' ');
}

function distToExit(w: IWorld, x: number, y: number, flying: boolean): number {
  const g = w.state.grid;
  if (!flying) {
    const cx = Math.max(0, Math.min(g.cols - 1, Math.floor(x)));
    const cy = Math.max(0, Math.min(g.rows - 1, Math.floor(y)));
    const d = g.dist[cy * g.cols + cx];
    if (Number.isFinite(d)) return d;
  }
  let best = Infinity;
  for (const e of g.exits) best = Math.min(best, Math.hypot(e.x + 0.5 - x, e.y + 0.5 - y));
  return best;
}

/** 自上次决策以来的事件 → 一行摘要 */
export function recentLine(evs: readonly GameEvent[]): string | undefined {
  if (!evs.length) return undefined;
  let kills = 0;
  let gold = 0;
  const leaks = new Map<string, number>();
  const notes: string[] = [];
  for (const e of evs) {
    if (e.type === 'death') kills++;
    else if (e.type === 'leak') leaks.set(code(e.enemy), (leaks.get(code(e.enemy)) ?? 0) + 1);
    else if (e.type === 'gold' && e.amount > 0) gold += e.amount;
    else if (e.type === 'waveEnd') notes.push(`w${e.wave} clear +${e.bonus}g i${e.interest}`);
    else if (e.type === 'levelUp' && e.byXp && e.tierChanged) notes.push(`#${e.uid}→L${e.level}`);
    else if (e.type === 'randomEvent' && e.phase === 'start') notes.push(`ev ${e.id}`);
    else if (e.type === 'towerDisabled') notes.push(`#${e.uid} off`);
    else if (e.type === 'spawnerDrop' && e.phase === 'land') notes.push(`drop ${e.id} landed`);
  }
  const parts = [`k${kills}`, `+${Math.round(gold)}g`];
  if (leaks.size) parts.push(`LEAK ${[...leaks].map(([k, v]) => `${k}×${v}`).join(',')}`);
  return [...parts, ...notes.slice(-6)].join(' ');
}

export interface CompactOptions {
  recent?: readonly GameEvent[];
  pendingErrors?: string[];
  /** 加上每座塔的覆盖（observe full） */
  coverage?: string[];
}

/** 当前局面 → 紧凑观测（键见速查表 "STATE keys"） */
export function compactObservation(w: IWorld, o: CompactOptions = {}): CompactObs {
  const s = w.state;
  const obs: CompactObs = {
    t: r1(s.time),
    ph: s.phase,
    w: `${s.wave}/${s.totalWaves || '∞'}`,
    g: Math.floor(s.gold),
    hp: `${s.lives}/${s.maxLives}`,
    sc: s.score,
  };
  const au = s.autoWave;
  obs.aw = !au.enabled
    ? 'manual'
    : !au.started
      ? 'auto-after-first'
      : au.nextAt !== null
        ? `next ${Math.ceil(Math.max(0, au.nextAt - s.time))}s`
        : au.blocked
          ? 'blocked'
          : 'on';
  const towers = [...s.towers.values()].sort((a, b) => a.uid - b.uid);
  const walls = towers.filter((t) => t.id === 'wall');
  obs.T = towers.filter((t) => t.id !== 'wall').map((t) => towerLine(w, t));
  if (walls.length) obs.W = walls.map((t) => `${t.uid}@${t.cx},${t.cy}${t.level > 1 ? `L${t.level}` : ''}`).join(' ');
  // 敌人：按类型聚合
  if (s.enemies.length) {
    const groups = new Map<
      string,
      { n: number; hp: number; max: number; band: [number, number, number]; air: boolean; boss: boolean; elite: number; hidden: number }
    >();
    let front: { d: number; txt: string } | null = null;
    const bosses: string[] = [];
    const gold: string[] = [];
    for (const e of s.enemies) {
      const d = distToExit(w, e.x, e.y, e.flying);
      const k = code(e.id);
      let g = groups.get(k);
      if (!g) groups.set(k, (g = { n: 0, hp: 0, max: 0, band: [0, 0, 0], air: e.flying, boss: e.boss, elite: 0, hidden: 0 }));
      const n = Math.max(1, e.group);
      g.n += n;
      g.hp += (e.hp + e.shield) * n;
      g.max += (e.maxHp + e.maxShield) * n;
      g.band[d <= 3 ? 2 : d <= 8 ? 1 : 0] += n;
      if (e.elite) g.elite++;
      if (e.hidden) g.hidden++;
      const txt = `${k}#${e.uid} ${r1(e.x)},${r1(e.y)} d${r1(d)} ${Math.round(e.hp + e.shield)}hp`;
      if (!front || d < front.d) front = { d, txt };
      if (e.boss) bosses.push(txt);
      // 金币袋怪 / 金色精英：击杀掉硬币（事件，值得集火 / 放技能）
      if (e.id === 'goldbag' || e.affixes.includes('golden')) gold.push(txt);
    }
    obs.E = [...groups]
      .sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1))
      .map(
        ([k, g]) =>
          `${k}×${g.n} ${Math.round((g.hp / Math.max(1, g.max)) * 100)}% ${g.band.join('/')}${g.air ? ' A' : ''}${g.boss ? ' B' : ''}${g.elite ? ` e${g.elite}` : ''}${g.hidden ? ` h${g.hidden}` : ''}`,
      );
    if (front) obs.Ef = front.txt;
    if (bosses.length) obs.EB = bosses;
    if (gold.length) obs.EG = gold;
  }
  const nw = s.nextWave;
  const rs = routeSummary(w);
  obs.nx = `w${nw.wave}${nw.tags.length ? ` [${nw.tags.join(',')}]` : ''}${nw.earlyBonus ? ` early+${nw.earlyBonus}g` : ''}`;
  // 进攻路线（§19.12）：每条地面路线 / 飞行线 + 下一波走它的组 + 航点 + 无覆盖路段；取代原来的 R / Ra 与 nx 里按出生点的列表
  obs.AR = attackRoutes(w, code);
  if (rs.segs.length) obs.Rs = rs.segs;
  if (rs.spots.length) obs.Rp = rs.spots.join(' ');
  obs.sk = s.skills.map((k) => `${k.id}:${k.ready ? 'R' : Math.ceil(k.cd)}${k.charges !== undefined ? `c${k.charges}` : ''}`).join(' ');
  const evs = s.events.filter((e) => e.phase !== 'done');
  if (evs.length) {
    obs.ev = evs.map(
      (e) =>
        `${e.id}(${e.tone}) ${e.phase === 'warn' ? `in ${Math.ceil(Math.max(0, e.startsAt - s.time))}s` : `ends ${Math.ceil(Math.max(0, e.endsAt - s.time))}s`}${e.area ? ` @${e.area.x},${e.area.y} ${e.area.w}x${e.area.h}` : ''}`,
    );
  }
  const drops = s.spawners.filter((sp) => sp.kind === 'drop' && (sp.active || (sp.warnUntil ?? 0) > s.time));
  if (drops.length) {
    obs.sp = drops.map((sp) => {
      const c = sp.cells[0];
      let t = `${sp.id}@${c.x},${c.y} ${sp.active ? 'open' : `lands ${Math.ceil(Math.max(0, (sp.warnUntil ?? 0) - s.time))}s`}`;
      if (sp.demolishCost) t += ` demolish${sp.demolishCost}`;
      if (sp.expiresAfterWave) t += ` until w${sp.expiresAfterWave}`;
      return t;
    });
  }
  if (s.pickups.length) obs.pu = s.pickups.map((p) => `#${p.uid} ${p.kind}${p.kind === 'coin' ? p.value : ''}`).join(' ');
  if (s.perkChoices)
    obs.perk = s.perkChoices
      .map((c) => `${c.id}(${c.rarity}${c.needsTower ? ',uid+branch' : ''}): ${c.desc}`)
      .concat(`reroll ${s.perkRerollCost}g`);
  if (s.crateChoice) obs.crate = s.crateChoice.options.map((c) => `${c.id}: ${c.desc}`);
  if (s.perks.length) obs.own = s.perks.join(',');
  // 建造价：与速查表相同时只写 "base"（钱够不够模型自己比 g）；有折扣 / 未解锁 / 达上限时列出差异
  const diffs: string[] = [];
  for (const b of w.getBuildOptions()) {
    if (!b.unlocked) diffs.push(`${b.id}:locked`);
    else if (b.limitReached) diffs.push(`${b.id}:max`);
    else if (b.cost !== TOWERS[b.id].cost) diffs.push(`${b.id}${b.cost}`);
  }
  obs.b = diffs.length ? diffs.join(' ') : 'base';
  const rc = recentLine(o.recent ?? []);
  if (rc && rc !== 'k0 +0g') obs.rc = rc;
  if (o.pendingErrors?.length) obs.pe = o.pendingErrors.slice(0, 6);
  if (o.coverage) obs.cov = o.coverage;
  return obs;
}

// ───────────────────────── 增量 ─────────────────────────

/** 地形签名（不含塔）：障碍 / 出生点 / 出口 / 空降箱。省流模式只在它或路线变化时重发地图 */
export function terrainSig(w: IWorld): string {
  const s = w.state;
  const g = s.grid;
  let h = 0;
  for (let i = 0; i < g.cells.length; i++) {
    const c = g.cells[i] === CellKind.Tower ? CellKind.Empty : g.cells[i];
    h = (Math.imul(h, 31) + c + 1) | 0;
  }
  const drops = s.spawners
    .filter((sp) => sp.kind === 'drop' && (sp.active || (sp.warnUntil ?? 0) > s.time))
    .map((sp) => `${sp.id}${sp.active ? 'D' : 'd'}`)
    .join(',');
  return `${h}|${drops}`;
}

const uidOf = (line: string): number => Number(/^#(\d+)/.exec(line)?.[1] ?? NaN);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** 增量：只含变化的键；塔按 uid：T+ = 新增 / 变化的行，T- = 消失的 uid；_unset = 消失的键 */
export function diffObs(prev: CompactObs, next: CompactObs): CompactObs {
  const d: CompactObs = {};
  for (const [k, v] of Object.entries(next)) {
    if (k === 'T') continue;
    // rc / pe 是"自上次以来"的一次性内容：有就发
    if (k === 'rc' || k === 'pe' || !same(prev[k], v)) d[k] = v;
  }
  const unset = Object.keys(prev).filter((k) => k !== 'T' && !(k in next));
  // 波次内每次都变的时间 / 分数也算变化；rc / pe 是一次性的，不进 _unset
  const gone = unset.filter((k) => k !== 'rc' && k !== 'pe');
  if (gone.length) d._unset = gone;
  const pt = new Map((prev.T ?? []).map((l) => [uidOf(l), l]));
  const nt = new Map((next.T ?? []).map((l) => [uidOf(l), l]));
  const plus = [...nt].filter(([u, l]) => pt.get(u) !== l).map(([, l]) => l);
  const minus = [...pt.keys()].filter((u) => !nt.has(u));
  if (plus.length) d['T+'] = plus;
  if (minus.length) d['T-'] = minus;
  return d;
}

/** 旧观测 + 增量 → 新观测（与 compactObservation 的结果逐键相等；一次性键 rc / pe 以增量里的为准） */
export function applyObsDelta(prev: CompactObs, d: CompactObs): CompactObs {
  const out: CompactObs = { ...prev };
  delete out.rc;
  delete out.pe;
  for (const k of (d._unset as string[] | undefined) ?? []) delete out[k];
  for (const [k, v] of Object.entries(d)) if (k !== '_unset' && k !== 'T+' && k !== 'T-') out[k] = v;
  const t = new Map((prev.T ?? []).map((l) => [uidOf(l), l]));
  for (const u of (d['T-'] as number[] | undefined) ?? []) t.delete(u);
  for (const l of (d['T+'] as string[] | undefined) ?? []) t.set(uidOf(l), l);
  out.T = [...t].sort((a, b) => a[0] - b[0]).map(([, l]) => l);
  return out;
}

// ───────────────────────── 地图 ─────────────────────────

const ROUTE_CH = 'abcefghjkm';

/**
 * 地形地图（不含敌人，便于缓存 / 只在地形变化时重发）。路线叠加：第 i 条地面路线的空格画成 ROUTE_CH[i]
 * （首行图例 "routes a=north b=west"），多条重叠画 '+'，预警中的空降路线画 '~'。rle = 每行游程编码（"3.2#S" = "...##S"）。
 */
export function terrainMap(
  w: IWorld,
  o: { rle?: boolean; routes?: { id: string; status: string; cells: { x: number; y: number }[] }[] } = {},
): string[] {
  const s = w.state;
  const g = s.grid;
  const rows: string[][] = [];
  for (let y = 0; y < g.rows; y++) {
    const r: string[] = [];
    for (let x = 0; x < g.cols; x++) {
      const i = y * g.cols + x;
      const c = g.cells[i];
      if (c === CellKind.Obstacle) r.push('#');
      else if (c === CellKind.Spawn) r.push('S');
      else if (c === CellKind.Exit) r.push('X');
      else if (c === CellKind.Tower) {
        const t = s.towers.get(g.towerAt[i]);
        r.push(t ? TOWER_CHAR[t.id] : '?');
      } else r.push('.');
    }
    rows.push(r);
  }
  const legend: string[] = [];
  (o.routes ?? []).forEach((rt, idx) => {
    const ch = rt.status === 'warn' ? '~' : ROUTE_CH[idx % ROUTE_CH.length];
    legend.push(`${ch}=${rt.id}`);
    for (const p of rt.cells) {
      const cur = rows[p.y]?.[p.x];
      if (cur === '.') rows[p.y][p.x] = ch;
      else if (cur !== undefined && cur !== ch && (ROUTE_CH.includes(cur) || cur === '~')) rows[p.y][p.x] = '+';
    }
  });
  for (const sp of s.spawners) {
    if (sp.kind !== 'drop') continue;
    if (!sp.active && !((sp.warnUntil ?? 0) > s.time)) continue;
    for (const c of sp.cells) if (rows[c.y]) rows[c.y][c.x] = sp.active ? 'D' : 'd';
  }
  const enc = (r: string[]): string => (o.rle ? rle(r.join('')) : r.join(''));
  const head = `   ${HEX.slice(0, g.cols)}${legend.length ? `  routes ${legend.join(' ')}` : ''}${o.rle ? ' (RLE)' : ''}`;
  return [head, ...rows.map((r, y) => `${String(y).padStart(2, '0')} ${enc(r)}`)];
}

/** 游程编码：连续 ≥3 个相同字符写成 "数字+字符" */
export function rle(row: string): string {
  let out = '';
  for (let i = 0; i < row.length;) {
    let j = i;
    while (j < row.length && row[j] === row[i]) j++;
    const n = j - i;
    out += n >= 3 ? `${n}${row[i]}` : row[i].repeat(n);
    i = j;
  }
  return out;
}

export function unrle(s: string): string {
  return s.replace(/(\d+)(\D)/g, (_m, n: string, c: string) => c.repeat(Number(n)));
}
