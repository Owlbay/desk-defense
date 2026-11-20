/**
 * 状态 → 紧凑观测（文档 10 §5）。
 *
 * 观测 = 一段紧凑 JSON（关键数值、塔摘要、按类型/距离分段聚合的敌人、下一波预告、事件、技能）
 *      + 一张 12×14 ASCII 地图（图例见 MAP_LEGEND）。
 * 目标：常规局面 ≤ ~1500 token，40 座塔的后期局面 ≤ ~2500 token。
 */
import { CellKind, type GameEvent, type IWorld, type TowerId, type TowerState } from '../core/types';
import { ENEMY_META } from '../core/meta';
import { TOWERS } from '../config/towers';

export const TOWER_CHAR: Record<TowerId, string> = {
  wall: 'W', pencil: 'P', stapler: 'T', glue: 'G', lamp: 'L', compass: 'C',
  eraser: 'E', ruler: 'R', pen: 'N', calculator: 'K', piggy: '$', swatter: 'F',
};

export const MAP_LEGEND =
  '地图图例 legend: 行=y(0..13，上→下)，列=x(0..9,a=10,b=11)。' +
  ' . 空地可建 empty | : 当前敌人路线(空地) path | # 障碍 obstacle | S 入口/开放出生点 spawn | d 空降预警(不可建) drop-warning | D 空降出生点 drop | X 出口 exit | * 有敌人的空格 enemies |' +
  ' 塔 towers: ' + Object.entries(TOWER_CHAR).map(([k, v]) => `${v}=${k}`).join(' ');

const HEX = '0123456789ab';

export interface ObservationOptions {
  /** 'compact'（默认，用于决策点）/ 'full'（get_state 工具：额外带路线格、前 12 个敌人坐标、塔的全部字段） */
  detail?: 'compact' | 'full';
  /** 自上次决策以来的事件（聚合成摘要） */
  recent?: GameEvent[];
  /** 上一次 end_turn 的备忘 */
  note?: string;
  /** 上一次决策后排队指令的失败信息（realtime 模式） */
  pendingErrors?: string[];
  /** 是否附带 ASCII 地图（默认 true） */
  map?: boolean;
}

export interface EnemyGroupObs {
  type: string;
  n: number;
  /** 剩余生命占比（同类合计） */
  hp: number;
  /** [远, 中, 近]（距出口路程 >8 / 4..8 / ≤3 格） */
  band: [number, number, number];
  air?: true;
  boss?: true;
  elite?: number;
  hidden?: number;
  affix?: string[];
}

export interface Observation {
  t: number;
  tick: number;
  phase: string;
  wave: number;
  totalWaves: number;
  gold: number;
  lives: string;
  score: number;
  autoWave: string;
  path: number[];
  towers: string[];
  enemies: { alive: number; groups: EnemyGroupObs[]; front?: string; bosses?: string[] };
  next: { wave: number; tags: string[]; groups: string[]; earlyBonus: number };
  skills: string[];
  events: string[];
  spawners: string[];
  pickups: string[];
  perks?: { choices: string[]; rerollCost: number };
  crate?: string[];
  owned: string[];
  build: string[];
  recent?: string;
  note?: string;
  pendingErrors?: string[];
  // full 才有
  paths?: number[][][];
  enemyList?: string[];
}

function r1(n: number): number {
  return Math.round(n * 10) / 10;
}

function towerLine(w: IWorld, t: TowerState, full: boolean): string {
  const parts = [`#${t.uid} ${t.id}@${t.cx},${t.cy} L${t.level}`];
  if (t.branch) parts.push(`br${t.branch}`);
  if (t.stars) parts.push(`★${t.stars}`);
  if (t.xpNext > 0) parts.push(`xp${Math.round((t.xp / t.xpNext) * 100)}%`);
  if (TOWERS[t.id].attacks && t.targetMode !== 'first') parts.push(`tgt=${t.targetMode}`);
  if (t.disabledUntil > w.state.time) parts.push('DISABLED');
  if (full || t.level >= 9 || t.stars > 0) {
    const info = w.getTowerInfo(t.uid);
    if (info) {
      if (info.upgradeCost !== null) parts.push(`up=${info.upgradeCost}${info.needsBranch ? '(needs branch)' : ''}`);
      if (info.evolveCost !== null) parts.push(`evo=${info.evolveCost}`);
      if (info.ability) parts.push(`ability=${info.ability.id}:${info.ability.ready ? 'READY' : `cd${r1(info.ability.cd)}`}/${info.ability.target}`);
      if (full) parts.push(`sell=${info.sellValue}`, `kills=${t.kills}`);
    }
  }
  return parts.join(' ');
}

/** 敌人到出口的大致路程（格）：地面用流场，飞行用直线 */
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

export function asciiMap(w: IWorld): string[] {
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
  for (const path of w.currentPaths()) for (const p of path) if (rows[p.y]?.[p.x] === '.') rows[p.y][p.x] = ':';
  for (const sp of s.spawners) {
    if (sp.kind !== 'drop') continue;
    for (const c of sp.cells) if (rows[c.y]) rows[c.y][c.x] = sp.active ? 'D' : 'd';
  }
  for (const e of s.enemies) {
    const x = Math.floor(e.x);
    const y = Math.floor(e.y);
    const ch = rows[y]?.[x];
    if (ch === '.' || ch === ':') rows[y][x] = '*';
  }
  return [`   ${HEX.slice(0, g.cols)}`, ...rows.map((r, y) => `${String(y).padStart(2, '0')} ${r.join('')}`)];
}

function summarizeRecent(evs: GameEvent[]): string | undefined {
  if (!evs.length) return undefined;
  let kills = 0;
  let leaks = 0;
  let gold = 0;
  const leakBy = new Map<string, number>();
  const notes: string[] = [];
  for (const e of evs) {
    if (e.type === 'death') kills++;
    else if (e.type === 'leak') { leaks++; leakBy.set(e.enemy, (leakBy.get(e.enemy) ?? 0) + 1); }
    else if (e.type === 'gold' && e.amount > 0) gold += e.amount;
    else if (e.type === 'waveEnd') notes.push(`wave${e.wave} cleared(+${e.bonus}g, interest ${e.interest})`);
    else if (e.type === 'waveStart') notes.push(`wave${e.wave} started`);
    else if (e.type === 'levelUp' && e.byXp && e.tierChanged) notes.push(`#${e.uid}→L${e.level}`);
    else if (e.type === 'randomEvent' && e.phase === 'start') notes.push(`event ${e.id} started`);
    else if (e.type === 'towerDisabled') notes.push(`#${e.uid} disabled`);
    else if (e.type === 'spawnerDrop' && e.phase === 'land') notes.push(`drop ${e.id} landed`);
  }
  const parts = [`kills ${kills}`, `gold +${Math.round(gold)}`];
  if (leaks) parts.push(`LEAKS ${leaks} (${[...leakBy].map(([k, v]) => `${k}×${v}`).join(',')})`);
  return [...parts, ...notes.slice(-8)].join('; ');
}

export function observe(w: IWorld, o: ObservationOptions = {}): Observation {
  const s = w.state;
  const full = o.detail === 'full';
  const groups = new Map<string, EnemyGroupObs & { maxHp: number; curHp: number }>();
  let front: { d: number; txt: string } | null = null;
  const bosses: string[] = [];
  const list: { d: number; txt: string }[] = [];
  for (const e of s.enemies) {
    const d = distToExit(w, e.x, e.y, e.flying);
    let g = groups.get(e.id);
    if (!g) {
      g = { type: e.id, n: 0, hp: 0, band: [0, 0, 0], maxHp: 0, curHp: 0 };
      if (e.flying) g.air = true;
      if (e.boss) g.boss = true;
      groups.set(e.id, g);
    }
    const n = Math.max(1, e.group);
    g.n += n;
    g.maxHp += (e.maxHp + e.maxShield) * n;
    g.curHp += (e.hp + e.shield) * n;
    g.band[d <= 3 ? 2 : d <= 8 ? 1 : 0] += n;
    if (e.elite) g.elite = (g.elite ?? 0) + 1;
    if (e.hidden) g.hidden = (g.hidden ?? 0) + 1;
    if (e.affixes.length) g.affix = [...new Set([...(g.affix ?? []), ...e.affixes])];
    const txt = `${e.id}#${e.uid}@${r1(e.x)},${r1(e.y)} hp${Math.round(e.hp + e.shield)}/${Math.round(e.maxHp + e.maxShield)} d${r1(d)}`;
    if (!front || d < front.d) front = { d, txt };
    if (e.boss) bosses.push(txt);
    if (full) list.push({ d, txt });
  }
  const enemyGroups: EnemyGroupObs[] = [...groups.values()]
    .sort((a, b) => b.n - a.n)
    .map(({ maxHp, curHp, ...g }) => ({ ...g, hp: maxHp > 0 ? Math.round((curHp / maxHp) * 100) / 100 : 0 }));

  const towers = [...s.towers.values()];
  // 墙很多时压缩成一行
  const walls = towers.filter((t) => t.id === 'wall' && t.level === 1);
  const towerLines = towers.filter((t) => !(t.id === 'wall' && t.level === 1)).map((t) => towerLine(w, t, full));
  if (walls.length) towerLines.push(`walls L1 ×${walls.length}: ${walls.map((t) => `#${t.uid}@${t.cx},${t.cy}`).join(' ')}`);

  const au = s.autoWave;
  const autoTxt = !au.enabled ? 'manual (you must start_wave)'
    : !au.started ? 'auto after first start_wave'
      : au.nextAt !== null ? `next wave in ${r1(Math.max(0, au.nextAt - s.time))}s` : au.blocked ? 'blocked (too many waves)' : 'running';

  const obs: Observation = {
    t: r1(s.time),
    tick: s.tick,
    phase: s.phase,
    wave: s.wave,
    totalWaves: s.totalWaves,
    gold: Math.floor(s.gold),
    lives: `${s.lives}/${s.maxLives}`,
    score: s.score,
    autoWave: autoTxt,
    path: w.currentPaths().map((p) => p.length),
    towers: towerLines,
    enemies: { alive: s.enemies.length, groups: enemyGroups },
    next: {
      wave: s.nextWave.wave,
      tags: s.nextWave.tags.slice(),
      groups: s.nextWave.groups.map((g) => `${g.enemy}×${g.count}${g.elite ? ` (elite ${g.elite})` : ''}${g.affixes.length ? ` [${g.affixes.join(',')}]` : ''} from ${g.spawner}`),
      earlyBonus: s.nextWave.earlyBonus,
    },
    skills: s.skills.map((k) => `${k.id}:${k.ready ? 'READY' : `cd${r1(k.cd)}`}${k.charges !== undefined ? ` charges${k.charges}` : ''} target=${k.target}`),
    events: s.events.filter((e) => e.phase !== 'done').map((e) => {
      const when = e.phase === 'warn' ? `in ${r1(Math.max(0, e.startsAt - s.time))}s` : `ends in ${r1(Math.max(0, e.endsAt - s.time))}s`;
      return `${e.id}(${e.tone}) ${e.phase} ${when}${e.area ? ` area x${e.area.x} y${e.area.y} ${e.area.w}×${e.area.h}` : ''}`;
    }),
    spawners: s.spawners.filter((sp) => sp.active || sp.kind === 'drop').map((sp) => {
      const c = sp.cells[0];
      let t = `${sp.id}(${sp.kind})@${c.x},${c.y} ${sp.active ? 'open' : 'closed'}`;
      if (sp.kind === 'drop') {
        if (sp.warnUntil !== undefined && sp.warnUntil > s.time) t += ` lands in ${r1(sp.warnUntil - s.time)}s`;
        if (sp.demolishCost) t += ` demolish=${sp.demolishCost}g`;
        if (sp.expiresAfterWave) t += ` closes after wave ${sp.expiresAfterWave}`;
      }
      return t;
    }),
    pickups: s.pickups.map((p) => `#${p.uid} ${p.kind}${p.kind === 'coin' ? ` ${p.value}g` : ''} ttl${r1(p.until - s.time)}s`),
    owned: s.perks.slice(),
    build: w.getBuildOptions().filter((b) => b.unlocked).map((b) => `${b.id}=${b.cost}${b.affordable && !b.limitReached ? '' : '✗'}`),
  };
  if (front) obs.enemies.front = (front as { txt: string }).txt;
  if (bosses.length) obs.enemies.bosses = bosses;
  if (s.perkChoices) {
    obs.perks = {
      choices: s.perkChoices.map((c) => `${c.id}(${c.rarity}${c.needsTower ? ', needs uid+branch' : ''}): ${c.desc}`),
      rerollCost: s.perkRerollCost,
    };
  }
  if (s.crateChoice) obs.crate = s.crateChoice.options.map((c) => `${c.id}: ${c.desc}`);
  const rec = summarizeRecent(o.recent ?? []);
  if (rec) obs.recent = rec;
  if (o.note) obs.note = o.note;
  if (o.pendingErrors?.length) obs.pendingErrors = o.pendingErrors.slice(0, 8);
  if (full) {
    obs.paths = w.currentPaths().map((p) => p.map((c) => [c.x, c.y]));
    obs.enemyList = list.sort((a, b) => a.d - b.d).slice(0, 12).map((x) => x.txt);
  }
  return obs;
}

/** 观测 → 发给模型的文本（JSON + 地图） */
export function renderObservation(w: IWorld, o: ObservationOptions = {}): string {
  const obs = observe(w, o);
  const json = JSON.stringify(obs);
  if (o.map === false) return json;
  return `${json}\nMAP\n${asciiMap(w).join('\n')}`;
}

/** 粗略 token 估算：ASCII 约 3.5 字符 / token，CJK 约 1 字 / token（只做预算与测试，计费以 API usage 为准） */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 3.5 + other * 1.1);
}

export const enemyName = (id: string): string => ENEMY_META[id as keyof typeof ENEMY_META]?.name ?? id;
