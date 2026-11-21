/**
 * 书桌防线 · AI 出题价格平衡模拟（文档 10 §2.3）
 *
 * 内置防守机器人（medium，与 scripts/simulate.ts 同一套驱动）对抗不同的进攻方策略，比较防守方的表现：
 *   default   不改写（基线）
 *   scripted  内置离线出题策略 scriptedAttackPlan（src/agent/attack.ts）
 *   swarm     贪心：最便宜的敌人堆满
 *   tank      贪心："每点墨水生命"最高的敌人堆满
 *   air       贪心：只出飞行敌人（池里没有就保留默认波）
 *   fast      贪心：只出最快的敌人
 *   affix     贪心：最肉的敌人 + 两个词缀
 *   stealth   贪心：最肉的敌人 + 隐身词缀
 *   drop      贪心：全部从空降点出（没有空降点就保留默认波）
 * 进攻方与真实对局一样只在建造阶段、下一波还没开始时出题（自动波次下波次重叠时会错过一些波：见 coverage）。
 *
 * 用法：
 *   npx vite-node scripts/sim-attack.ts -- [选项]
 *   --policies default,scripted,...   （默认全部）
 *   --modes endless,campaign          （默认两种都跑）
 *   --maps ch1,ch2,ch3                （默认三张）
 *   --seeds N                         每个 模式 × 地图 的种子数（默认 6；各策略用同一组种子，成对比较）
 *   --max-wave W                      无尽封顶波数（默认 100）
 *   --patch '{"hpCap":1.3}'           临时改 ATTACK 常量（只影响本进程）
 *   --json FILE                       把每局结果写成 JSON（可多进程并行后用 --merge 合并）
 *   --merge a.json,b.json             只读取已有结果并打印汇总表
 *   --quiet                           不打印每局一行
 * 输出：Markdown 汇总表（stdout）。
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { scriptedAttackPlan } from '../src/agent/attack';
import { affixPrice, ATTACK, checkAttackPlan, dropPrice, enemyPrice, hpUnits } from '../src/config/attack';
import { AFFIXES, ENEMIES } from '../src/config/enemies';
import {
  type AffixId,
  type AttackContextInfo,
  type AttackGroup,
  createWorld,
  type EnemyId,
  type IWorld,
  type MapId,
  type ModeId,
} from '../src/core';
import { BOTS, StrategyBot } from './bots';

// ───────────────────────── 参数 ─────────────────────────

const argv = process.argv.slice(2).filter((a) => a !== '--');
function arg(name: string, def?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? 'true' : v;
}

// ───────────────────────── 进攻策略 ─────────────────────────

type Policy = (w: IWorld, info: AttackContextInfo) => AttackGroup[] | null;

interface Spec {
  enemy: EnemyId;
  affixes?: AffixId[];
  spawner?: string;
  drop?: boolean;
}

const perInk = (id: EnemyId) => ENEMIES[id].hp / enemyPrice(id);
const byPerInk = (a: EnemyId, b: EnemyId) => perInk(b) - perInk(a) || (a < b ? -1 : 1);

/** 贪心填充：各规格轮流加 1 只，直到预算 / 生命上限 / 组数上限用完；所有组同时出发（delay 0） */
function fill(info: AttackContextInfo, specs: Spec[]): AttackGroup[] | null {
  if (!specs.length) return null;
  const slots = Math.max(1, Math.floor(ATTACK.maxGroups / specs.length));
  const counts = specs.map(() => 0);
  let cost = 0;
  let hp = 0;
  for (let guard = 0; guard < 10000; guard++) {
    let added = false;
    specs.forEach((s, i) => {
      const n = s.affixes?.length ?? 0;
      const unit = enemyPrice(s.enemy) + n * affixPrice(s.enemy) + (s.drop ? dropPrice(s.enemy) : 0);
      const u = hpUnits(s.enemy, 1, n > 0);
      if (counts[i] >= ATTACK.maxCount * slots || cost + unit > info.budget || hp + u > info.hpCap) return;
      counts[i]++;
      cost += unit;
      hp += u;
      added = true;
    });
    if (!added) break;
  }
  const groups: AttackGroup[] = [];
  specs.forEach((s, i) => {
    for (let left = counts[i]; left > 0; left -= ATTACK.maxCount) {
      const g: AttackGroup = { enemy: s.enemy, count: Math.min(ATTACK.maxCount, left), delay: 0 };
      if (s.affixes?.length) g.affixes = s.affixes.slice();
      if (s.spawner) g.spawner = s.spawner;
      groups.push(g);
    }
  });
  return groups.length ? groups.slice(0, ATTACK.maxGroups) : null;
}

/** enemy 能带的第一组合法词缀 */
function affixesFor(enemy: EnemyId, prefs: AffixId[][]): AffixId[] | null {
  if (ENEMIES[enemy].flying && !ATTACK.airAffixes) return null;
  for (const p of prefs) {
    const ok = p.every((a, i) => !AFFIXES[a].notOn?.includes(enemy) && !AFFIXES[a].excludes?.some((x) => p.slice(0, i).includes(x)));
    if (ok) return p;
  }
  return null;
}

const POLICIES: Record<string, Policy | null> = {
  default: null,
  scripted: (w) => scriptedAttackPlan(w),
  swarm: (_w, info) => {
    const id = info.pool.slice().sort((a, b) => enemyPrice(a) - enemyPrice(b) || byPerInk(a, b))[0];
    return fill(info, [{ enemy: id }]);
  },
  tank: (_w, info) => fill(info, [{ enemy: info.pool.slice().sort(byPerInk)[0] }]),
  air: (_w, info) => {
    const fl = info.pool.filter((id) => ENEMIES[id].flying).sort(byPerInk);
    return fl.length
      ? fill(
          info,
          fl.slice(0, 2).map((enemy) => ({ enemy })),
        )
      : null;
  },
  fast: (_w, info) => {
    const id = info.pool.slice().sort((a, b) => ENEMIES[b].speed - ENEMIES[a].speed || byPerInk(a, b))[0];
    return fill(info, [{ enemy: id }]);
  },
  affix: (_w, info) => {
    const id = info.pool.slice().sort(byPerInk)[0];
    const affixes = affixesFor(id, [
      ['shield', 'regen'],
      ['hard', 'regen'],
      ['hard', 'shield'],
    ]);
    return affixes ? fill(info, [{ enemy: id, affixes }]) : null;
  },
  stealth: (_w, info) => {
    const id = info.pool.slice().sort(byPerInk)[0];
    const affixes = affixesFor(id, [['stealth'], ['hard']]);
    return affixes ? fill(info, [{ enemy: id, affixes }]) : null;
  },
  drop: (_w, info) => {
    const sp = info.spawners.find((s) => s.drop);
    if (!sp) return null;
    return fill(info, [{ enemy: info.pool.slice().sort(byPerInk)[0], spawner: sp.id, drop: true }]);
  },
  /** 飞行 + 两个词缀（池里没有飞行敌人就保留默认波） */
  airaffix: (_w, info) => {
    const id = info.pool.filter((x) => ENEMIES[x].flying).sort(byPerInk)[0];
    const affixes = id && affixesFor(id, [['shield', 'regen']]);
    return affixes ? fill(info, [{ enemy: id, affixes }]) : null;
  },
  /** 精英主力 + 最便宜的敌人填满剩余生命额度 */
  mixed: (_w, info) => {
    const main = info.pool.slice().sort(byPerInk)[0];
    const cheap = info.pool.slice().sort((a, b) => enemyPrice(a) - enemyPrice(b) || byPerInk(a, b))[0];
    const affixes = affixesFor(main, [['shield', 'regen']]);
    return fill(info, affixes ? [{ enemy: main, affixes }, { enemy: cheap }] : [{ enemy: cheap }]);
  },
};

/**
 * 策略名；另支持（探索用）`affix:<a>+<b>`（最肉的敌人 + 指定词缀）、`air:<a>+<b>`（最肉的飞行敌人 + 指定词缀；
 * `air:none` = 不带词缀）。
 */
function policyFor(name: string): Policy | null {
  if (name in POLICIES) return POLICIES[name];
  const m = /^(affix|air):([a-z+]+)$/.exec(name);
  if (!m) throw new Error(`unknown policy ${name}`);
  const want = m[2] === 'none' ? [] : (m[2].split('+') as AffixId[]);
  for (const a of want) if (!AFFIXES[a] || a === 'golden') throw new Error(`unknown affix ${a}`);
  const air = m[1] === 'air';
  return (_w, info) => {
    const id = info.pool.filter((x) => !air || ENEMIES[x].flying).sort(byPerInk)[0];
    const affixes = id && affixesFor(id, [want]);
    return affixes ? fill(info, [{ enemy: id, affixes }]) : null;
  };
}

// ───────────────────────── 单局 ─────────────────────────

interface RunRow {
  policy: string;
  mode: ModeId;
  map: MapId;
  seed: string;
  result: 'won' | 'lost' | 'cap';
  wave: number;
  lives: number;
  maxLives: number;
  /** 无尽：第 20 波结束时掉的命（没撑到就是全部） */
  lost20: number;
  /** 开始的波数 / 成功改写的波数 / 被拒 / 策略放弃（保留默认波） */
  waves: number;
  planned: number;
  rejected: number;
  skipped: number;
  /** 改写波：生命当量 ≥ 95% 上限的波数；花费 / 预算、生命 / 上限 之和 */
  capBound: number;
  costRatio: number;
  hpRatio: number;
}

function runOne(policyId: string, mode: ModeId, map: MapId, seed: string, maxWave: number): RunRow {
  const policy = policyFor(policyId);
  const params = BOTS.medium({ mode, map });
  const w = createWorld({ mode, map, difficulty: 'normal', seed, skills: params.skills, pure: true });
  const bot = new StrategyBot(w, params);
  const s = w.state;
  const row: RunRow = {
    policy: policyId,
    mode,
    map,
    seed,
    result: 'cap',
    wave: 0,
    lives: 0,
    maxLives: s.maxLives,
    lost20: 0,
    waves: 0,
    planned: 0,
    rejected: 0,
    skipped: 0,
    capBound: 0,
    costRatio: 0,
    hpRatio: 0,
  };
  let tried = 0;
  const attack = () => {
    if (!policy || s.phase !== 'build' || tried === s.wave + 1) return;
    const info = w.attackContext?.();
    if (!info?.open || info.current) return;
    tried = info.wave;
    const plan = policy(w, info);
    if (!plan) {
      row.skipped++;
      return;
    }
    const chk = checkAttackPlan({ groups: plan }, { wave: info.wave, pool: info.pool, spawners: info.spawners, baseHp: info.baseHp });
    const r = w.command({ type: 'overrideWave', wave: info.wave, plan: { groups: plan } });
    if (!r.ok || !chk.ok) {
      row.rejected++;
      return;
    }
    row.planned++;
    row.costRatio += chk.cost / chk.budget;
    row.hpRatio += chk.hp / chk.cap;
    if (chk.hp >= chk.cap * 0.95) row.capBound++;
  };
  const maxTicks = 60 * 60 * 60 * 3;
  let lost20: number | null = null;
  for (let tick = 0; tick < maxTicks; tick++) {
    if (s.phase === 'won' || s.phase === 'lost') {
      row.result = s.phase;
      break;
    }
    if (s.phase === 'perk') {
      bot.act('build');
      if ((s.phase as string) === 'perk' && s.perkChoices) {
        const c = s.perkChoices.find((x) => !x.needsTower) ?? s.perkChoices[0];
        const uid = [...s.towers.values()].find((t) => t.id !== 'wall' && t.level >= 7 && t.level < 10)?.uid;
        w.command({ type: 'choosePerk', id: c.id, uid });
      }
      continue;
    }
    const auto = s.autoWave.enabled && s.autoWave.started;
    if (mode !== 'campaign' && s.wave >= maxWave && (s.phase === 'build' || auto)) break;
    if (s.phase === 'build' && !auto) {
      bot.act('build');
      attack();
      w.command({ type: 'startWave' });
    } else {
      if (tick % params.decisionTicks === 0) bot.act(s.phase === 'wave' ? 'wave' : 'build');
      attack();
    }
    bot.tick();
    w.step();
    for (const ev of w.drainEvents()) {
      if (ev.type === 'waveStart') {
        bot.onWaveStart(ev.wave);
        row.waves++;
      } else if (ev.type === 'leak') bot.onLeak(ev.enemy);
      else if (ev.type === 'waveEnd') {
        bot.onWaveEnd();
        if (ev.wave === 20) lost20 = s.maxLives - s.lives;
      }
    }
  }
  row.wave = s.wave;
  row.lives = s.lives;
  row.lost20 = lost20 ?? s.maxLives;
  return row;
}

// ───────────────────────── 汇总 ─────────────────────────

function quantile(a: number[], q: number): number {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const f1 = (x: number) => (Math.round(x * 10) / 10).toFixed(1);

function report(rows: RunRow[]): string {
  const policies = [...new Set(rows.map((r) => r.policy))];
  const base = rows.filter((r) => r.policy === 'default');
  const endBase = mean(base.filter((r) => r.mode === 'endless').map((r) => r.wave));
  const lines = [
    '| 策略 | 无尽 中位波 (P25–P75) | 无尽 均值 Δ | 无尽 W20 掉命 | 战役 通关率 | 战役 掉命 | 改写覆盖 | 顶到上限 | 预算用量 | 生命/上限 |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const p of policies) {
    const rs = rows.filter((r) => r.policy === p);
    const en = rs.filter((r) => r.mode === 'endless');
    const ca = rs.filter((r) => r.mode === 'campaign');
    const ew = en.map((r) => r.wave);
    const planned = rs.reduce((a, r) => a + r.planned, 0);
    const waves = rs.reduce((a, r) => a + r.waves, 0);
    const cells = [
      p,
      en.length ? `${f1(quantile(ew, 0.5))} (${f1(quantile(ew, 0.25))}–${f1(quantile(ew, 0.75))})` : '—',
      en.length && endBase ? `${mean(ew) >= endBase ? '+' : ''}${pct(mean(ew) / endBase - 1)}` : '—',
      en.length ? f1(mean(en.map((r) => r.lost20))) : '—',
      ca.length ? pct(ca.filter((r) => r.result === 'won').length / ca.length) : '—',
      ca.length ? f1(mean(ca.map((r) => r.maxLives - r.lives))) : '—',
      p === 'default' ? '—' : pct(waves ? planned / waves : 0),
      p === 'default' || !planned ? '—' : pct(rs.reduce((a, r) => a + r.capBound, 0) / planned),
      p === 'default' || !planned ? '—' : pct(rs.reduce((a, r) => a + r.costRatio, 0) / planned),
      p === 'default' || !planned ? '—' : pct(rs.reduce((a, r) => a + r.hpRatio, 0) / planned),
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  }
  const rej = rows.reduce((a, r) => a + r.rejected, 0);
  lines.push('', `局数 ${rows.length}（每策略 ${base.length || rows.length / policies.length}），被拒的编排 ${rej}`);
  return lines.join('\n');
}

// ───────────────────────── 主程序 ─────────────────────────

function main(): void {
  const merge = arg('merge');
  if (merge && merge !== 'true') {
    const rows = merge.split(',').flatMap((f) => JSON.parse(readFileSync(f, 'utf8')) as RunRow[]);
    console.log(report(rows));
    return;
  }
  const patch = arg('patch');
  if (patch && patch !== 'true') Object.assign(ATTACK as Record<string, unknown>, JSON.parse(patch) as Record<string, unknown>);
  const policies = arg('policies', Object.keys(POLICIES).join(','))!.split(',');
  for (const p of policies) policyFor(p);
  const modes = arg('modes', 'endless,campaign')!.split(',') as ModeId[];
  const maps = arg('maps', 'ch1,ch2,ch3')!.split(',') as MapId[];
  const seeds = Number(arg('seeds', '6'));
  const maxWave = Number(arg('max-wave', '100'));
  const quiet = arg('quiet') === 'true';
  const rows: RunRow[] = [];
  const t0 = performance.now();
  for (const p of policies)
    for (const mode of modes)
      for (const map of maps)
        for (let i = 1; i <= seeds; i++) {
          const r = runOne(p, mode, map, `atk-${mode}-${map}-${i}`, maxWave);
          rows.push(r);
          if (!quiet)
            console.log(
              `${p.padEnd(8)} ${mode.padEnd(8)} ${map} #${i} ${r.result.padEnd(4)} wave ${String(r.wave).padStart(3)} lives ${r.lives}/${r.maxLives} planned ${r.planned}/${r.waves} skip ${r.skipped} rej ${r.rejected} cap ${r.capBound}`,
            );
        }
  const json = arg('json');
  if (json && json !== 'true') writeFileSync(json, JSON.stringify(rows));
  console.log(`\n${rows.length} runs in ${((performance.now() - t0) / 1000).toFixed(1)}s\n`);
  console.log(report(rows));
}

main();
