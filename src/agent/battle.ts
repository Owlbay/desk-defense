/**
 * 战报、威胁估算与提示（文档 10 §19）：给模型的"打法信息"，紧凑、一次性（不进增量基线）。
 *
 *  - 战报 BR：上一次汇报以来清掉的波——漏怪（按敌人 / 出生点）、击杀、每座塔造成的伤害（前几名 + 零输出的塔）、
 *    建造阶段闲置金币、被拒动作；
 *  - 威胁 TH：下一波每条地面路线 / 飞行线的"可造成伤害 ÷ 来袭总血量"（Σ 塔秒伤 × 敌人在射程内的时间，
 *    护甲按每发伤害折减，群伤塔 ×1.5），给出 安全 / 吃紧 / 危险；
 *  - 克制 CTR：下一波敌人的克制提示（与速查表同一规则）；
 *  - 闲置 IDLE：建造阶段金币偏多时提醒花掉（save 意图生效时不提醒）。
 *
 * 只读世界状态；不发任何指令。
 */
import type { EnemyId, GameEvent, IWorld, TowerId } from '../core/types';
import { ENEMIES, ELITE } from '../config/enemies';
import { TOWERS } from '../config/towers';
import { generateWave } from '../core/wavegen';
import { hpScale, speedScale, armorAt } from '../core/scaling';
import { ENEMY_CODE } from './compact';
import { counterOf } from './prompts';
import { PURPOSE_CORE, enemyPurposes, type Purpose } from './purpose';
import { flightLines, groundRoutes, shooters, type Shooter } from './routes';
import type { PlannerState } from './planner';

const code = (id: string): string => ENEMY_CODE[id as EnemyId] ?? id;

interface WaveAcc {
  kills: number;
  leaks: Map<string, number>;
  waves: number[];
}

/** 跨决策累积的战报（引擎持有；每个决策点喂入事件，包括被门控跳过的） */
export class BattleLog {
  private acc: WaveAcc = { kills: 0, leaks: new Map(), waves: [] };
  private dmg0 = new Map<number, number>();
  /** 波号 → 每种敌人来自哪些出生点（开波前的预告） */
  private from = new Map<number, Map<string, Set<string>>>();
  private idle: number[] = [];
  private rejected: string[] = [];
  private pending: string | null = null;
  /** 全局统计（评测用） */
  readonly stats = { idleSamples: [] as number[], rejected: 0, recovered: 0 };

  constructor(private readonly w: IWorld) {
    for (const t of w.state.towers.values()) this.dmg0.set(t.uid, t.damage);
  }

  /** 每个决策点调用一次（含门控跳过的），events = 自上次以来的事件 */
  feed(events: readonly GameEvent[]): void {
    const s = this.w.state;
    const nw = s.nextWave;
    if (!this.from.has(nw.wave)) {
      const m = new Map<string, Set<string>>();
      for (const g of nw.groups) {
        if (!m.has(g.enemy)) m.set(g.enemy, new Set());
        m.get(g.enemy)!.add(g.spawner || '*');
      }
      this.from.set(nw.wave, m);
    }
    // 新塔（引擎开始之后才放的）从 0 开始计伤害：它的累计伤害全部发生在放下之后。
    // （原来按"第一次看到时"的累计伤害作基线：决策里放的塔要到下一个决策点才看到，整波的伤害被当成基线，战报误报 0dmg）
    for (const t of s.towers.values()) if (!this.dmg0.has(t.uid)) this.dmg0.set(t.uid, 0);
    let ended = false;
    for (const e of events) {
      if (e.type === 'death') this.acc.kills++;
      else if (e.type === 'leak') {
        const cur = this.acc.waves.length ? this.acc.waves[this.acc.waves.length - 1] : s.wave;
        const sp = this.from.get(cur)?.get(e.enemy);
        const where = sp && sp.size === 1 ? [...sp][0] : sp ? [...sp].join('/') : '?';
        const k = `${code(e.enemy)}${ENEMIES[e.enemy]?.flying ? '(air)' : ''}@${where}`;
        this.acc.leaks.set(k, (this.acc.leaks.get(k) ?? 0) + 1);
      } else if (e.type === 'waveStart') this.acc.waves.push(e.wave);
      else if (e.type === 'waveEnd') ended = true;
    }
    if (ended) this.close();
  }

  /** 建造阶段的决策结束时剩下的金币（闲置） */
  noteBuildGold(gold: number): void {
    this.idle.push(gold);
    this.stats.idleSamples.push(gold);
  }

  /** act 结果里的被拒 / 自动修正行 */
  noteActResult(text: string): void {
    for (const line of text.split('\n')) {
      const m = /^\d+ (REJECTED|ERROR)(.*)$/.exec(line);
      if (m) {
        this.stats.rejected++;
        this.rejected.push(m[2].replace(/\{[^}]*"cx":(\d+),"cy":(\d+)[^}]*\}/, '$1,$2').trim().slice(0, 60));
      }
      if (/MOVED/.test(line)) this.stats.recovered++;
    }
  }

  private close(): void {
    const s = this.w.state;
    const rows: { uid: number; id: TowerId; d: number; old: boolean }[] = [];
    for (const t of s.towers.values()) {
      if (!TOWERS[t.id].attacks) continue;
      // old：上次汇报前就在（或本窗口开始时已在）且放了 10 秒以上——这样的塔 0 伤害才算"放错了地方"
      rows.push({ uid: t.uid, id: t.id, d: Math.round(t.damage - (this.dmg0.get(t.uid) ?? t.damage)), old: this.dmg0.has(t.uid) && s.time - t.placedAt > 10 });
    }
    this.dmg0 = new Map([...s.towers.values()].map((t) => [t.uid, t.damage]));
    rows.sort((a, b) => b.d - a.d || a.uid - b.uid);
    const a = this.acc;
    const leaks = [...a.leaks.values()].reduce((x, y) => x + y, 0);
    const waves = a.waves.length ? `w${a.waves.join(',')}` : `w${s.wave}`;
    const parts = [`BR ${waves}: ${leaks ? `LEAK ${leaks} ${[...a.leaks].map(([k, v]) => k.replace('@', `×${v}@`)).join(' ')}` : 'no leaks'}`, `kills ${a.kills}`];
    if (rows.length) parts.push(`dmg ${rows.slice(0, 4).map((r) => `#${r.uid}${r.id}:${r.d}`).join(' ')}`);
    const zero = rows.filter((r) => r.d === 0 && r.old);
    if (zero.length) parts.push(`0dmg ${zero.slice(0, 5).map((r) => `#${r.uid}`).join(',')} (out of reach?)`);
    if (this.idle.length) parts.push(`idle@build ${Math.round(this.idle.reduce((x, y) => x + y, 0) / this.idle.length)}g`);
    if (this.rejected.length) parts.push(`rejected ${this.rejected.length}: ${this.rejected.slice(-2).join('; ')}`);
    this.pending = parts.join(' | ');
    this.acc = { kills: 0, leaks: new Map(), waves: [] };
    this.idle = [];
    this.rejected = [];
  }

  /** 取走未发过的战报（每份只发一次） */
  take(): string | undefined {
    const p = this.pending;
    this.pending = null;
    return p ?? undefined;
  }
}

// ───────────────────────── 威胁估算 ─────────────────────────

const parseNum = (v: string | undefined): number => {
  const m = v ? /-?\d+(\.\d+)?/.exec(v) : null;
  return m ? Number(m[0]) : 0;
};

/** 一座塔的秒伤（来自 getTowerInfo 的"秒伤"，台灯 A 用持续伤害）、每发伤害、是否群伤 */
export function towerDps(w: IWorld, uid: number): { dps: number; hit: number; aoe: boolean } {
  const info = w.getTowerInfo(uid);
  if (!info) return { dps: 0, hit: 0, aoe: false };
  const st = (label: string) => info.stats.find((x) => x.label === label)?.value;
  const dpsTxt = st('秒伤');
  const dps = dpsTxt ? parseNum(dpsTxt) : parseNum(st('持续伤害'));
  return { dps, hit: parseNum(st('伤害')) || dps, aoe: !!dpsTxt && dpsTxt.includes('×N') };
}

export interface ThreatLine {
  /** 出生点 id；空中线为 "air:<id>" */
  id: string;
  hp: number;
  cap: number;
  ratio: number;
  verdict: '安全' | '吃紧' | '危险';
  enemies: string;
}

export const THREAT_SAFE = 2;
export const THREAT_TIGHT = 1.2;

const inRange = (q: Shooter, px: number, py: number): boolean => {
  const d = Math.hypot(px - (q.x + 0.5), py - (q.y + 0.5));
  return d <= q.range + 1e-6 && d >= q.inner;
};

/**
 * 下一波威胁：每条路线 cap = Σ_塔 秒伤 × 护甲折减 × 群伤系数 × 有效时间，
 * 有效时间 = Σ_组 min(n × 射程内格数 / 速度, 出怪跨度 + 射程内格数 / 速度)。ratio = cap / 来袭总血量（含护盾、精英）。
 */
export function threatEstimate(w: IWorld): ThreatLine[] {
  const s = w.state;
  const nw = s.nextWave;
  if (!nw.groups.length) return [];
  const D = s.params;
  const eff = generateWave({ seed: s.seed, mode: s.opts.mode, map: s.opts.map, params: D }, nw.wave).effWave;
  const sh = shooters(w);
  const dps = new Map(sh.map((q) => [q.key, q.uid !== undefined ? towerDps(w, q.uid) : { dps: 0, hit: 0, aoe: false }]));
  const routes = groundRoutes(w);
  const lines = flightLines(w, sh);
  const bySp = new Map<string, { enemy: EnemyId; count: number; elite: number }[]>();
  for (const g of nw.groups) {
    const air = ENEMIES[g.enemy].flying;
    const k = `${air ? 'air:' : ''}${g.spawner || '*'}`;
    if (!bySp.has(k)) bySp.set(k, []);
    bySp.get(k)!.push({ enemy: g.enemy, count: g.count, elite: g.elite });
  }
  const out: ThreatLine[] = [];
  for (const [k, groups] of bySp) {
    const air = k.startsWith('air:');
    const spId = air ? k.slice(4) : k;
    let hp = 0;
    let cap = 0;
    // 射程内"长度"（格）：地面 = 路线格数；空中 = 飞行线在射程内的长度
    const reach = new Map<string, number>();
    if (air) {
      const ls = spId === '*' ? lines : lines.filter((l) => l.id === spId);
      for (const q of sh) {
        if (!q.air) continue;
        let len = 0;
        for (const l of ls) {
          const n = Math.max(1, Math.ceil(l.len / 0.25));
          let c = 0;
          for (let i = 0; i <= n; i++) if (inRange(q, l.from.x + ((l.to.x - l.from.x) * i) / n, l.from.y + ((l.to.y - l.from.y) * i) / n)) c++;
          len += (l.len * c) / (n + 1);
        }
        if (len > 0) reach.set(q.key, len / Math.max(1, ls.length));
      }
    } else {
      const rs = spId === '*' ? routes.filter((r) => r.status === 'open') : routes.filter((r) => r.id === spId);
      for (const q of sh) {
        if (!q.ground) continue;
        let c = 0;
        for (const r of rs) for (const p of r.cells) if (inRange(q, p.x + 0.5, p.y + 0.5)) c++;
        if (c > 0) reach.set(q.key, c / Math.max(1, rs.length));
      }
    }
    for (const g of groups) {
      const def = ENEMIES[g.enemy];
      let one = def.hp * hpScale(D, eff) * (def.boss ? D.bossHpMul : 1);
      one *= 1 + (def.shieldRatio ?? 0);
      const elites = Math.min(g.elite, g.count);
      hp += one * (g.count - elites) + one * ELITE.hp * elites;
      const v = Math.max(0.3, def.speed * speedScale(D, eff));
      const armor = armorAt(D, def.armor, eff);
      for (const q of sh) {
        const L = reach.get(q.key);
        if (!L) continue;
        const d = dps.get(q.key)!;
        if (d.dps <= 0) continue;
        const armorK = d.hit > 0 ? Math.max(0.2, (d.hit - armor) / d.hit) : 1;
        const t = Math.min(g.count * (L / v), g.count * (def.interval ?? 1) + L / v);
        cap += d.dps * armorK * (d.aoe ? 1.5 : 1) * t;
      }
    }
    const ratio = hp > 0 ? cap / hp : 99;
    out.push({
      id: k, hp: Math.round(hp), cap: Math.round(cap), ratio: Math.round(ratio * 10) / 10,
      verdict: ratio >= THREAT_SAFE ? '安全' : ratio >= THREAT_TIGHT ? '吃紧' : '危险',
      enemies: groups.map((g) => `${code(g.enemy)}×${g.count}`).join(' '),
    });
  }
  return out;
}

/**
 * 克制：下一波每种敌人需要的用途 + 最近漏怪的精英词缀带来的用途；缺主力塔的用途给出建议意图。
 * "CTR pc→armor ik→slow+aoe | 缺 armor,aoe → {do:"build_near",purpose:"armor"} …"
 */
export function counterLine(w: IWorld, extra: Purpose[] = []): string | undefined {
  const nw = w.state.nextWave;
  const need = new Map<Purpose, string[]>();
  const per: string[] = [];
  for (const id of [...new Set(nw.groups.map((g) => g.enemy))]) {
    const def = ENEMIES[id];
    const c = counterOf(def);
    if (c !== 'any') per.push(`${code(id)}→${c}`);
    for (const p of enemyPurposes(def)) {
      if (!need.has(p)) need.set(p, []);
      need.get(p)!.push(code(id));
    }
  }
  for (const p of extra) {
    if (!need.has(p)) need.set(p, []);
    need.get(p)!.push('leak');
  }
  if (!per.length && !extra.length) return undefined;
  const have = new Set([...w.state.towers.values()].map((t) => t.id));
  const missing = [...need.keys()].filter((p) => p !== 'dps' && p !== 'air' && !PURPOSE_CORE[p].some((id) => have.has(id)));
  const fix = missing.slice(0, 3).map((p) => `{do:"build_near",purpose:"${p}"}`);
  const ex = extra.length ? ` | leaks need ${[...new Set(extra)].join(',')}` : '';
  return `CTR ${per.join(' ')}${ex}${missing.length ? ` | 缺 ${missing.join(',')} → ${fix.join(' ')}` : ''}`;
}

/** 威胁 + 克制 → 一行（给模型）；危险时附带建议的意图 */
export function threatLine(w: IWorld, extra: Purpose[] = []): string | undefined {
  const th = threatEstimate(w);
  if (!th.length) return undefined;
  const nw = w.state.nextWave;
  const parts = th.map((t) => `${t.id} ${t.verdict} ×${t.ratio} (${t.enemies} hp${t.hp})`);
  const fix: string[] = [];
  for (const t of th) {
    if (t.verdict === '安全') continue;
    if (t.id.startsWith('air:')) fix.push(`{do:"anti_air",line:"${t.id.slice(4)}"}`);
    else fix.push(`{do:"build_near",purpose:"dps",target:"route${t.id === '*' ? '' : `:${t.id}`}"} / maze / upgrade_best`);
  }
  const ctr = counterLine(w, extra);
  return `TH w${nw.wave}: ${parts.join(' | ')}${fix.length ? ` → ${[...new Set(fix)].join(' ')}` : ''}${ctr ? `\n${ctr}` : ''}`;
}

/** 建造阶段金币闲置提醒（save 生效时不提醒） */
export const IDLE_GOLD = 60;

export function idleLine(w: IWorld, ps?: PlannerState): string | undefined {
  const s = w.state;
  const g = Math.floor(s.gold);
  if (ps?.saveUntil !== undefined) {
    if (g < ps.saveUntil && s.wave - (ps.saveWave ?? s.wave) < 2) return undefined;
    ps.saveUntil = undefined;
  }
  if (g < IDLE_GOLD) return undefined;
  const interest = Math.min(s.params.interestCap, Math.floor(g * 0.05));
  return `IDLE ${g}g unspent (interest only +${interest}/wave): put it to work, e.g. {do:"spend",reserve:20} or maze/build_near/upgrade_best; {do:"save",until:N} if saving on purpose.`;
}

/** 需要模型应对的怪物类事件（ev 行的补充，按当前局面给一句话；速查表里有对策） */
const EVENT_HINT: Record<string, string> = {
  tea_break: 'enemies heal: burst skills / pen ink',
  shield_supply: 'shields up: eraser / burst skills',
  medic_squad: 'healers: kill wo first (pen/aoe)',
  frenzy: 'fast enemies, +50% kill gold: slow, buy DPS',
  bounty: '2x kill gold: buy DPS now',
  training: '2x XP: keep towers firing',
};

/**
 * EVT 行：进行中的怪物类事件 + 金色目标（金币袋怪 / 金色精英，击杀掉硬币）+ 就绪的爆发技能。
 * 没有相关事件时返回 undefined。
 */
export function eventLine(w: IWorld): string | undefined {
  const s = w.state;
  const parts: string[] = [];
  for (const e of s.events) {
    if (e.phase === 'done') continue;
    const h = EVENT_HINT[e.id];
    if (!h) continue;
    const left = e.phase === 'warn' ? `in ${Math.ceil(Math.max(0, e.startsAt - s.time))}s` : `${Math.ceil(Math.max(0, e.endsAt - s.time))}s`;
    parts.push(`${e.id} ${left}: ${h}`);
  }
  const gold = s.enemies.filter((e) => e.hp > 0 && (e.id === 'goldbag' || e.affixes.includes('golden')));
  if (gold.length) {
    const ready = s.skills.filter((k) => k.ready && (k.target === 'circle' || k.target === 'line')).map((k) => k.id);
    parts.push(`coin targets ${gold.slice(0, 3).map((e) => `${code(e.id)}#${e.uid} ${Math.round(e.x)},${Math.round(e.y)} ${Math.round(e.hp + e.shield)}hp`).join(', ')}: focus${ready.length ? ` (${ready.join('/')} R)` : ''}`);
  }
  return parts.length ? `EVT ${parts.join(' | ')}` : undefined;
}
