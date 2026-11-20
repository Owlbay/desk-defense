/**
 * 塔的性价比基准（文档 02 §3 "平衡靠模拟脚本验证"）
 *
 *   npx vite-node scripts/bench.ts -- [--waves 35] [--budget 600] [--seeds 3] [--maps ch1,ch2,ch3]
 *
 * 1) 单塔性价比：完整蛇形迷宫（墙免费），用同样的金币只买某一种塔放在最佳位置，不升级（经验照常），
 *    无限生命跑若干波，比较"打掉的敌人总生命 / 金币"。
 * 2) 辅助塔：同样金币的 一半铅笔 + 一半辅助塔，对比 全部铅笔。
 * 3) 传奇分支：每种塔 3 座直接升到 Lv10 的 A / B 分支（配 8 座 Lv5 铅笔打底），比较 25～40 波这些塔的输出与漏怪。
 */
import { createWorld, type Branch, type IWorld, type MapId, type TowerId } from '../src/core';
import { TOWERS } from '../src/config/towers';
import { airSamples, coverage, groundSamples, planMaze, targetCells } from './bots/maze';

const argv = process.argv.slice(2).filter((a) => a !== '--');
const arg = (n: string, d: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const WAVES = Number(arg('waves', '35'));
const BUDGET = Number(arg('budget', '600'));
const SEEDS = Number(arg('seeds', '3'));
const MAPS = arg('maps', 'ch1,ch2,ch3').split(',') as MapId[];
const ATTACKERS: TowerId[] = ['pencil', 'stapler', 'glue', 'lamp', 'compass', 'eraser', 'ruler', 'pen'];

function world(map: MapId, seed: string): IWorld {
  // 对比塔的输出：手动开波、关闭随机事件、固定杂物布局（文档 09 的动态因素会干扰对比）
  return createWorld({
    mode: 'custom', map, difficulty: 'normal', seed, skills: [], pure: true, autoWave: false, fixedLayout: true,
    custom: { lives: 1e6, startGold: 1e6, interestCap: 0, eventRate: 0 },
  });
}

function buildMaze(w: IWorld): void {
  const plan = planMaze(w);
  const g = w.state.grid;
  for (const i of plan.all) w.command({ type: 'place', tower: 'wall', cx: i % g.cols, cy: Math.floor(i / g.cols) });
}

/** 在迷宫墙上挑最好的位置换成塔 */
function placeBest(w: IWorld, id: TowerId, n: number): number[] {
  const g = w.state.grid;
  const scratch = new Float32Array(g.cols * g.rows);
  const plan = planMaze(w);
  const gs = groundSamples(w, targetCells(w, plan, 99, scratch), scratch);
  const as = airSamples(w);
  const d = TOWERS[id];
  const uids: number[] = [];
  for (let k = 0; k < n; k++) {
    let best = -1;
    let bv = -1;
    for (const i of plan.all) {
      const t = w.state.towers.get(g.towerAt[i]);
      if (!t || t.id !== 'wall') continue;
      const cx = i % g.cols;
      const cy = Math.floor(i / g.cols);
      let v = d.hitsGround ? coverage(cx, cy, d.range, d.inner ?? 0, gs) : 0;
      if (d.hitsAir) v += 0.3 * coverage(cx, cy, d.range, 0, as);
      if (id === 'calculator') {
        v = 0;
        for (const o of w.state.towers.values()) if (o.id !== 'wall' && (o.cx - cx) ** 2 + (o.cy - cy) ** 2 <= 4) v++;
      }
      if (v > bv) { bv = v; best = i; }
    }
    if (best < 0) break;
    const cx = best % g.cols;
    const cy = Math.floor(best / g.cols);
    w.command({ type: 'sell', uid: g.towerAt[best] });
    if (!w.command({ type: 'place', tower: id, cx, cy }).ok) break;
    uids.push(g.towerAt[best]);
  }
  return uids;
}

interface RunOut { hpRemoved: number; hpSpawned: number; leaks: number; dmgBy: Map<number, number> }

function runWaves(w: IWorld, from: number, to: number, onWave?: (wave: number) => void): RunOut {
  const s = w.state;
  let hpSpawned = 0;
  let leaks = 0;
  const dmg0 = new Map<number, number>();
  for (let guard = 0; guard < 60 * 60 * 60 * 2; guard++) {
    if (s.phase === 'perk') {
      // 只选不影响战斗的增益，避免干扰对比
      const neutral = ['pocketmoney', 'earlybird', 'thickcover', 'safe', 'quickreview', 'compound', 'tradein', 'pocket'];
      const c = s.perkChoices!.find((x) => neutral.includes(x.id)) ?? s.perkChoices!.find((x) => !x.needsTower)!;
      w.command({ type: 'choosePerk', id: c.id });
      continue;
    }
    if (s.phase === 'build') {
      if (s.wave === from - 1) for (const t of s.towers.values()) dmg0.set(t.uid, t.damage);
      if (s.wave >= to) break;
      onWave?.(s.wave + 1);
      w.command({ type: 'startWave' });
    }
    w.step();
    for (const ev of w.drainEvents()) {
      if (s.wave < from) continue;
      if (ev.type === 'spawn') {
        const e = s.enemies.find((x) => x.uid === ev.enemyUid);
        if (e) hpSpawned += e.maxHp + e.maxShield;
      } else if (ev.type === 'leak') leaks++;
    }
  }
  const dmgBy = new Map<number, number>();
  let hpRemoved = 0;
  for (const t of s.towers.values()) {
    const d = t.damage - (dmg0.get(t.uid) ?? 0);
    dmgBy.set(t.uid, d);
    hpRemoved += d;
  }
  return { hpRemoved, hpSpawned, leaks, dmgBy };
}

function pad(s: string | number, n: number): string { return String(s).padStart(n); }

function soloBench(): void {
  console.log(`\n## 1) 单塔性价比：预算 ${BUDGET} 金币只买一种塔（不升级），第 1～${WAVES} 波，无限生命`);
  console.log(`${'塔'.padEnd(10)}${pad('数量', 6)}${pad('打掉生命', 12)}${pad('每金币', 9)}${pad('漏怪', 7)}${pad('平均等级', 9)}`);
  const rows: { id: TowerId; per: number }[] = [];
  for (const id of ATTACKERS) {
    let removed = 0;
    let leaks = 0;
    let lv = 0;
    let n = 0;
    let runs = 0;
    for (const map of MAPS) for (let k = 0; k < SEEDS; k++) {
      const w = world(map, `bench-${map}-${k}`);
      buildMaze(w);
      const count = Math.floor(BUDGET / TOWERS[id].cost);
      const uids = placeBest(w, id, count);
      const r = runWaves(w, 1, WAVES);
      removed += r.hpRemoved;
      leaks += r.leaks;
      n += uids.length;
      lv += uids.reduce((a, u) => a + (w.state.towers.get(u)?.level ?? 0), 0) / Math.max(1, uids.length);
      runs++;
    }
    const per = removed / runs / BUDGET;
    rows.push({ id, per });
    console.log(`${(TOWERS[id].name + '(' + id + ')').padEnd(10)}${pad(Math.round(n / runs), 6)}${pad(Math.round(removed / runs), 12)}${pad(per.toFixed(1), 9)}${pad(Math.round(leaks / runs), 7)}${pad((lv / runs).toFixed(1), 9)}`);
  }
  const med = rows.map((r) => r.per).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
  console.log(`  相对中位数：${rows.map((r) => `${r.id} ${(r.per / med).toFixed(2)}`).join(' · ')}`);
}

function supportBench(): void {
  console.log(`\n## 2) 辅助塔：${BUDGET / 2} 金币铅笔 + ${BUDGET / 2} 金币辅助塔 vs ${BUDGET} 金币全铅笔（第 1～${WAVES} 波）`);
  for (const id of ['pencil', 'glue', 'eraser', 'lamp', 'stapler', 'compass', 'pen', 'ruler', 'calculator'] as TowerId[]) {
    let removed = 0;
    let leaks = 0;
    let runs = 0;
    for (const map of MAPS) for (let k = 0; k < SEEDS; k++) {
      const w = world(map, `bench-${map}-${k}`);
      buildMaze(w);
      placeBest(w, 'pencil', Math.floor(BUDGET / 2 / TOWERS.pencil.cost));
      placeBest(w, id, Math.max(1, Math.floor(BUDGET / 2 / TOWERS[id].cost)));
      const r = runWaves(w, 1, WAVES);
      removed += r.hpRemoved;
      leaks += r.leaks;
      runs++;
    }
    console.log(`  铅笔 + ${(TOWERS[id].name).padEnd(5)} 打掉生命 ${pad(Math.round(removed / runs), 8)}  漏怪 ${pad(Math.round(leaks / runs), 5)}`);
  }
}

function branchBench(): void {
  const from = 25;
  const to = Math.max(WAVES, 40);
  console.log(`\n## 3) 传奇分支：3 座 Lv10（A / B）+ 8 座 Lv5 铅笔打底，统计第 ${from}～${to} 波`);
  for (const id of [...ATTACKERS, 'calculator'] as TowerId[]) {
    const out: Record<Branch, { dmg: number; leaks: number; base: number }> = { A: { dmg: 0, leaks: 0, base: 0 }, B: { dmg: 0, leaks: 0, base: 0 } };
    for (const br of ['A', 'B'] as Branch[]) {
      for (const map of MAPS) for (let k = 0; k < SEEDS; k++) {
        const w = world(map, `branch-${map}-${k}`);
        buildMaze(w);
        const base = placeBest(w, 'pencil', 8);
        for (const u of base) for (let l = 1; l < 5; l++) w.command({ type: 'upgrade', uid: u });
        const uids = placeBest(w, id, 3);
        for (const u of uids) for (let l = 1; l < 10; l++) w.command({ type: 'upgrade', uid: u, branch: br });
        const r = runWaves(w, from, to);
        out[br].dmg += uids.reduce((a, u) => a + (r.dmgBy.get(u) ?? 0), 0);
        out[br].base += base.reduce((a, u) => a + (r.dmgBy.get(u) ?? 0), 0);
        out[br].leaks += r.leaks;
      }
    }
    const n = MAPS.length * SEEDS;
    const d = TOWERS[id];
    console.log(`  ${(d.name + '(' + id + ')').padEnd(12)} A·${d.A.name.padEnd(6)} 本塔 ${pad(Math.round(out.A.dmg / n), 8)} 铅笔 ${pad(Math.round(out.A.base / n), 8)} 漏 ${pad(Math.round(out.A.leaks / n), 4)} | B·${d.B.name.padEnd(5)} 本塔 ${pad(Math.round(out.B.dmg / n), 8)} 铅笔 ${pad(Math.round(out.B.base / n), 8)} 漏 ${pad(Math.round(out.B.leaks / n), 4)}  B/A 总 ${((out.B.dmg + out.B.base) / Math.max(1, out.A.dmg + out.A.base)).toFixed(2)}`);
  }
}

const which = arg('only', 'all');
const t0 = performance.now();
if (which === 'all' || which === 'solo') soloBench();
if (which === 'all' || which === 'support') supportBench();
if (which === 'all' || which === 'branch') branchBench();
console.log(`\n(${((performance.now() - t0) / 1000).toFixed(1)}s)`);
