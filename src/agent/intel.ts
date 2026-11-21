/**
 * 战场情报（文档 10 §19.8）：逐帧（节流）跟踪场上敌人，给模型"漏怪明细 / 缺口热点 / 击杀分布 / 零伤害塔"。
 *
 *  - 每只敌人：出生点（首次看到时最近的出生格）、精英词缀、是否飞行 / 被网、走过的格子（按顺序）与每格有没有塔够得着、
 *    在射程内的时间 / 总时间、每座塔分到的伤害（塔的累计伤害增量按当时射程内的敌人平分）；
 *  - 漏怪（leak 事件）→ 与"刚消失、同种、离出口最近"的跟踪记录配对，生成 LeakRecord（剩余血量、射程内占比、主伤塔、缺口段）；
 *  - 击杀（death 事件）→ 位置热度（按路线进度分前 / 中 / 后段）；
 *  - 波末快照每座塔的累计伤害 → 最近 N 波零伤害的塔。
 *
 * 只读世界状态；不发指令。浏览器（index.ts）与无头（runner.ts）都在每个世界事件上调用 onEvent。
 */
import type { AffixId, EnemyId, GameEvent, IWorld, TowerId } from '../core/types';
import { ENEMIES, AFFIXES } from '../config/enemies';
import { TOWERS } from '../config/towers';
import { shooters, type Shooter } from './routes';

/** 采样间隔（游戏秒） */
const SAMPLE_DT = 0.2;

interface Track {
  uid: number;
  id: EnemyId;
  sp: string;
  elite: boolean;
  affixes: AffixId[];
  flying: boolean;
  netted: boolean;
  hp: number;
  x: number;
  y: number;
  tTot: number;
  tIn: number;
  /** 按顺序走过的格（相邻重复合并） */
  cells: number[];
  /** 每格最多同时有几座塔够得着 */
  cov: number[];
  per: Map<number, { id: TowerId; t: number; d: number }>;
  gone?: number;
}

export interface Gap {
  /** 出生点（空中加 "air:" 前缀） */
  sp: string;
  cells: number[];
  /** 0 = 无覆盖，1 = 仅 1 座塔 */
  level: 0 | 1;
}

export interface LeakRecord {
  wave: number;
  enemy: EnemyId;
  elite: boolean;
  affixes: AffixId[];
  flying: boolean;
  netted: boolean;
  /** 出口时剩余血量（含护盾）0..1 */
  hp: number;
  sp: string;
  /** 在射程内的时间占比 0..1 */
  inRange: number;
  /** 伤害份额前几名 */
  towers: { uid: number; id: TowerId; share: number }[];
  gap: Gap | null;
}

export interface IntelStats {
  leaks: number;
  /** 发给模型的漏怪明细 / 缺口行数 */
  reports: number;
}

const pct = (v: number): number => Math.round(v * 100);

export class BattleIntel {
  private alive = new Map<number, Track>();
  private last = -1;
  private dmgPrev = new Map<number, number>();
  private shKey = '';
  private sh: Shooter[] = [];
  private wave = 0;
  /** 本窗口（上次 take 以来）的漏怪 */
  private pending: LeakRecord[] = [];
  /** 全部漏怪（缺口热点按最近几波统计） */
  readonly leaks: LeakRecord[] = [];
  /** 本窗口击杀位置（格索引 → 次数） */
  private kills = new Map<number, number>();
  /** 波末每座塔的累计伤害快照（最近 4 波） */
  private snaps: { wave: number; dmg: Map<number, number> }[] = [];
  readonly stats: IntelStats = { leaks: 0, reports: 0 };

  constructor(private readonly w: IWorld) {}

  /** 每个世界事件调用一次（顺序 = 发生顺序） */
  onEvent(ev: GameEvent): void {
    const s = this.w.state;
    switch (ev.type) {
      case 'waveStart':
        this.wave = ev.wave;
        break;
      case 'death': {
        const c = this.cellOf(ev.x, ev.y);
        if (c >= 0) this.kills.set(c, (this.kills.get(c) ?? 0) + 1);
        this.alive.delete(ev.enemyUid);
        break;
      }
      case 'leak':
        this.onLeak(ev.enemy);
        break;
      case 'waveEnd': {
        this.snaps.push({ wave: ev.wave, dmg: new Map([...s.towers.values()].map((t) => [t.uid, t.damage])) });
        if (this.snaps.length > 4) this.snaps.shift();
        break;
      }
      default:
        break;
    }
    if (s.time - this.last >= SAMPLE_DT) this.sample();
  }

  private cellOf(x: number, y: number): number {
    const g = this.w.state.grid;
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    if (cx < 0 || cy < 0 || cx >= g.cols || cy >= g.rows) return -1;
    return cy * g.cols + cx;
  }

  private shootersNow(): Shooter[] {
    const s = this.w.state;
    let lv = 0;
    for (const t of s.towers.values()) lv += t.level * 7 + t.stars;
    const key = `${s.grid.version}|${s.towers.size}|${lv}|${s.perks.length}`;
    if (key !== this.shKey) {
      this.shKey = key;
      this.sh = shooters(this.w);
    }
    return this.sh;
  }

  /** 采样一次（节流由 onEvent 负责；测试可直接调用） */
  sample(): void {
    const s = this.w.state;
    const dt = this.last < 0 ? 0 : Math.min(1, Math.max(0, s.time - this.last));
    this.last = s.time;
    const sh = this.shootersNow();
    const present = new Set<number>();
    const inRangeOf = new Map<number, Track[]>();
    for (const e of s.enemies) {
      present.add(e.uid);
      let tr = this.alive.get(e.uid);
      if (!tr) {
        tr = {
          uid: e.uid,
          id: e.id,
          sp: this.spawnerNear(e.x, e.y),
          elite: e.elite,
          affixes: e.affixes.slice(),
          flying: e.flying,
          netted: false,
          hp: 1,
          x: e.x,
          y: e.y,
          tTot: 0,
          tIn: 0,
          cells: [],
          cov: [],
          per: new Map(),
        };
        this.alive.set(e.uid, tr);
      }
      tr.gone = undefined;
      const air = e.flying;
      if (e.netUntil > s.time) tr.netted = true;
      tr.x = e.x;
      tr.y = e.y;
      const max = e.maxHp + e.maxShield;
      tr.hp = max > 0 ? (e.hp + e.shield) / max : 0;
      let n = 0;
      for (const q of sh) {
        if (air ? !q.air : !q.ground) continue;
        const d = Math.hypot(e.x - (q.x + 0.5), e.y - (q.y + 0.5));
        if (d > q.range + 1e-6 || d < q.inner) continue;
        n++;
        if (q.uid === undefined) continue;
        let p = tr.per.get(q.uid);
        if (!p) tr.per.set(q.uid, (p = { id: q.id, t: 0, d: 0 }));
        p.t += dt;
        let l = inRangeOf.get(q.uid);
        if (!l) inRangeOf.set(q.uid, (l = []));
        l.push(tr);
      }
      tr.tTot += dt;
      if (n) tr.tIn += dt;
      const c = this.cellOf(e.x, e.y);
      if (c >= 0) {
        const k = tr.cells.length - 1;
        if (k >= 0 && tr.cells[k] === c) tr.cov[k] = Math.max(tr.cov[k], n);
        else {
          tr.cells.push(c);
          tr.cov.push(n);
        }
      }
    }
    // 伤害：每座塔的累计伤害增量按射程内的敌人平分
    for (const t of s.towers.values()) {
      const prev = this.dmgPrev.get(t.uid) ?? t.damage;
      const d = t.damage - prev;
      this.dmgPrev.set(t.uid, t.damage);
      if (d <= 0) continue;
      const l = inRangeOf.get(t.uid);
      if (!l?.length) continue;
      for (const tr of l) {
        const p = tr.per.get(t.uid);
        if (p) p.d += d / l.length;
      }
    }
    for (const [uid, tr] of this.alive) {
      if (present.has(uid)) continue;
      if (tr.gone === undefined) tr.gone = s.time;
      else if (s.time - tr.gone > 2) this.alive.delete(uid);
    }
  }

  private spawnerNear(x: number, y: number): string {
    let best = '?';
    let bd = Infinity;
    for (const sp of this.w.state.spawners) {
      for (const c of sp.cells) {
        const d = Math.hypot(x - (c.x + 0.5), y - (c.y + 0.5));
        if (d < bd) {
          bd = d;
          best = sp.id;
        }
      }
    }
    return best;
  }

  private exitDist(tr: Track): number {
    const g = this.w.state.grid;
    let m = Infinity;
    for (const ex of g.exits) m = Math.min(m, Math.hypot(tr.x - (ex.x + 0.5), tr.y - (ex.y + 0.5)));
    return m;
  }

  private onLeak(enemy: EnemyId): void {
    const s = this.w.state;
    const present = new Set(s.enemies.map((e) => e.uid));
    let best: Track | null = null;
    let bd = Infinity;
    for (const tr of this.alive.values()) {
      if (present.has(tr.uid) || tr.id !== enemy) continue;
      const d = this.exitDist(tr);
      if (d < bd) {
        bd = d;
        best = tr;
      }
    }
    const def = ENEMIES[enemy];
    const rec: LeakRecord = best
      ? this.record(best)
      : {
          wave: this.wave || s.wave,
          enemy,
          elite: false,
          affixes: [],
          flying: !!def?.flying,
          netted: false,
          hp: 1,
          sp: '?',
          inRange: 0,
          towers: [],
          gap: null,
        };
    if (best) this.alive.delete(best.uid);
    this.leaks.push(rec);
    if (this.leaks.length > 400) this.leaks.splice(0, 100);
    this.pending.push(rec);
    this.stats.leaks++;
  }

  private record(tr: Track): LeakRecord {
    const tot = [...tr.per.values()].reduce((a, p) => a + p.d, 0);
    const towers = [...tr.per]
      .filter(([, p]) => p.d > 0)
      .sort((a, b) => b[1].d - a[1].d || a[0] - b[0])
      .slice(0, 2)
      .map(([uid, p]) => ({ uid, id: p.id, share: tot > 0 ? p.d / tot : 0 }));
    return {
      wave: this.wave || this.w.state.wave,
      enemy: tr.id,
      elite: tr.elite,
      affixes: tr.affixes,
      flying: tr.flying,
      netted: tr.netted,
      hp: Math.max(0, Math.min(1, tr.hp)),
      sp: tr.sp,
      inRange: tr.tTot > 0 ? tr.tIn / tr.tTot : 0,
      towers,
      gap: findGap(tr.cells, tr.cov, tr.flying && !tr.netted ? `air:${tr.sp}` : tr.sp),
    };
  }

  hasPendingLeaks(): boolean {
    return this.pending.length > 0;
  }

  /** 取走未发过的漏怪 */
  takeLeaks(): LeakRecord[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  /** 取走本窗口的击杀分布（每波发一次） */
  takeKills(): Map<number, number> {
    const out = this.kills;
    this.kills = new Map();
    return out;
  }

  /** 最近 n 个完整波次里伤害为 0 的攻击塔（n 波前就已存在） */
  idleTowers(n = 2): number[] {
    const s = this.w.state;
    if (this.snaps.length < n + 1) return [];
    const a = this.snaps[this.snaps.length - 1 - n].dmg;
    const b = this.snaps[this.snaps.length - 1].dmg;
    const out: number[] = [];
    for (const t of s.towers.values()) {
      if (!TOWERS[t.id].attacks || !a.has(t.uid) || !b.has(t.uid)) continue;
      if ((b.get(t.uid) ?? 0) - (a.get(t.uid) ?? 0) <= 0) out.push(t.uid);
    }
    return out.sort((x, y) => x - y);
  }

  /** 最近 waves 波的缺口热点（重叠的缺口合并计数），前 k 个 */
  hotspots(waves = 5, k = 3): { gap: Gap; n: number }[] {
    const cur = this.wave || this.w.state.wave;
    const recent = this.leaks.filter((l) => l.gap && l.wave > cur - waves);
    const uniq: Gap[] = [];
    for (const l of recent) if (!uniq.some((u) => u.sp === l.gap!.sp && sameCells(u.cells, l.gap!.cells))) uniq.push(l.gap!);
    const scored = uniq.map((g) => ({ gap: g, n: recent.filter((l) => l.gap!.sp === g.sp && overlap(l.gap!.cells, g.cells)).length }));
    scored.sort((a, b) => b.n - a.n || b.gap.cells.length - a.gap.cells.length);
    const out: { gap: Gap; n: number }[] = [];
    for (const sc of scored) {
      if (out.some((o) => o.gap.sp === sc.gap.sp && overlap(o.gap.cells, sc.gap.cells))) continue;
      out.push(sc);
      if (out.length >= k) break;
    }
    return out;
  }
}

const sameCells = (a: number[], b: number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
const overlap = (a: number[], b: number[]): boolean => {
  const s = new Set(a);
  return b.some((v) => s.has(v));
};

/** 走过的格里最长的一段"无覆盖"（≥2 格）；没有则最长的"仅 1 塔"段（≥3 格） */
export function findGap(cells: readonly number[], cov: readonly number[], sp: string): Gap | null {
  const longest = (maxCov: number): number[] => {
    let best: number[] = [];
    let cur: number[] = [];
    for (let i = 0; i < cells.length; i++) {
      if (cov[i] <= maxCov) cur.push(cells[i]);
      else cur = [];
      if (cur.length > best.length) best = cur.slice();
    }
    return best;
  };
  const z = longest(0);
  if (z.length >= 2) return { sp, cells: z, level: 0 };
  const o = longest(1);
  if (o.length >= 3) return { sp, cells: o, level: 1 };
  return null;
}

/** 缺口段的文字："x5 y9..12" / "y9 x3..7" / "3,4>6,9" */
export function segText(cells: readonly number[], cols: number): string {
  const xs = cells.map((i) => i % cols);
  const ys = cells.map((i) => Math.floor(i / cols));
  const mn = (a: number[]) => Math.min(...a);
  const mx = (a: number[]) => Math.max(...a);
  if (mn(xs) === mx(xs)) return `x${xs[0]} y${mn(ys)}..${mx(ys)}`;
  if (mn(ys) === mx(ys)) return `y${ys[0]} x${mn(xs)}..${mx(xs)}`;
  return `${xs[0]},${ys[0]}>${xs[xs.length - 1]},${ys[ys.length - 1]}`;
}

/** build_near 的 target：缺口段外接矩形 "seg:x1,y1-x2,y2" */
export function segTarget(cells: readonly number[], cols: number): string {
  const xs = cells.map((i) => i % cols);
  const ys = cells.map((i) => Math.floor(i / cols));
  return `seg:${Math.min(...xs)},${Math.min(...ys)}-${Math.max(...xs)},${Math.max(...ys)}`;
}

const enemyLabel = (l: LeakRecord): string => {
  const name = ENEMIES[l.enemy]?.name ?? l.enemy;
  const aff = l.affixes.length ? `[${l.affixes.map((a) => AFFIXES[a]?.name ?? a).join(',')}]` : '';
  return `${l.elite ? '精英' : ''}${name}${aff}${l.flying ? (l.netted ? '(空,被网)' : '(空)') : ''}`;
};

/**
 * 漏怪明细（一行，最多 cap 组；同种 / 同精英 / 同出生点合并）：
 * "LK w7 漏4: 橡皮屑×3(均剩40%血 射程内35% north x5 y9..12 无覆盖 主伤#4pencil 70%) 纸飞机(空)×1(…)"
 */
export function leakLine(w: IWorld, leaks: readonly LeakRecord[], cap = 4): string | undefined {
  if (!leaks.length) return undefined;
  const cols = w.state.grid.cols;
  const groups = new Map<string, LeakRecord[]>();
  for (const l of leaks) {
    const k = `${enemyLabel(l)}@${l.sp}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(l);
  }
  const waves = [...new Set(leaks.map((l) => l.wave))].sort((a, b) => a - b);
  const parts = [...groups]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, cap)
    .map(([k, ls]) => {
      const n = ls.length;
      const hp = pct(ls.reduce((a, l) => a + l.hp, 0) / n);
      const inR = pct(ls.reduce((a, l) => a + l.inRange, 0) / n);
      const gaps = ls.map((l) => l.gap).filter((g): g is Gap => !!g);
      const g = gaps.sort((a, b) => b.cells.length - a.cells.length)[0];
      const top = new Map<number, { id: TowerId; s: number }>();
      for (const l of ls)
        for (const t of l.towers) {
          const v = top.get(t.uid) ?? { id: t.id, s: 0 };
          v.s += t.share / n;
          top.set(t.uid, v);
        }
      const best = [...top].sort((a, b) => b[1].s - a[1].s)[0];
      const bits = [`${n > 1 ? '均' : ''}剩${hp}%血`, `射程内${inR}%`];
      bits.push(g ? `${g.sp} ${segText(g.cells, cols)} ${g.level ? '仅1塔' : '无覆盖'}` : `${ls[0].sp}`);
      bits.push(best ? `主伤#${best[0]}${best[1].id} ${pct(best[1].s)}%` : '无塔打到');
      return `${k.split('@')[0]}×${n}(${bits.join(' ')})`;
    });
  const more = groups.size > cap ? ` +${groups.size - cap}种` : '';
  return `LK w${waves.join(',')} 漏${leaks.length}: ${parts.join(' ')}${more}`;
}

/** 缺口热点 + 建议意图 */
export function gapLine(w: IWorld, intel: BattleIntel, waves = 5): string | undefined {
  const hs = intel.hotspots(waves, 3);
  if (!hs.length) return undefined;
  const cols = w.state.grid.cols;
  const fix: string[] = [];
  const parts = hs.map(({ gap, n }) => {
    if (gap.sp.startsWith('air:')) fix.push(`{do:"anti_air",route:"${gap.sp.slice(4)}"}`);
    else fix.push(`{do:"build_near",purpose:"dps",target:"${segTarget(gap.cells, cols)}"}`);
    return `${gap.sp} ${segText(gap.cells, cols)}${gap.level ? '(仅1塔)' : ''} ×${n}`;
  });
  return `GAP 近${waves}波缺口热点: ${parts.join(', ')} → ${[...new Set(fix)].slice(0, 3).join(' ')}`;
}

/** 击杀位置分布：按到出口的路程分前 / 中 / 后段（相对出生点），外加最热的 3×3 区块 */
export function killLine(w: IWorld, kills: ReadonlyMap<number, number>): string | undefined {
  const tot = [...kills.values()].reduce((a, b) => a + b, 0);
  if (tot < 3) return undefined;
  const g = w.state.grid;
  let dMax = 0;
  for (const sp of w.state.spawners) {
    if (!sp.active || sp.kind === 'drop') continue;
    const c = sp.cells[0];
    const d = g.dist[c.y * g.cols + c.x];
    if (Number.isFinite(d)) dMax = Math.max(dMax, d);
  }
  if (dMax <= 0) return undefined;
  const band = [0, 0, 0];
  const blocks = new Map<string, number>();
  for (const [i, n] of kills) {
    const d = g.dist[i];
    const f = Number.isFinite(d) ? 1 - Math.min(1, d / dMax) : 0.5;
    band[f < 1 / 3 ? 0 : f < 2 / 3 ? 1 : 2] += n;
    const bx = Math.floor((i % g.cols) / 3) * 3;
    const by = Math.floor(Math.floor(i / g.cols) / 3) * 3;
    const k = `x${bx}-${bx + 2} y${by}-${by + 2}`;
    blocks.set(k, (blocks.get(k) ?? 0) + n);
  }
  const hot = [...blocks].sort((a, b) => b[1] - a[1])[0];
  const late = band[2] / tot > 0.45 ? '（多死在后段：前中段火力不足）' : '';
  return `KH 击杀 ${tot}: 前/中/后段 ${band.map((b) => pct(b / tot)).join('/')}%，最热 ${hot[0]} ${pct(hot[1] / tot)}%${late}`;
}
