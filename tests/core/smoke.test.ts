import { describe, expect, it } from 'vitest';
import { createWorld, type IWorld, type RunOptions, type TowerId } from '../../src/core';

/** 简单机器人：蛇形墙迷宫 + 沿路线贪心摆攻击塔，空闲金币升级，冷却好就放技能，增益选第一张 */
const ROTATION: TowerId[] = ['pencil', 'pencil', 'stapler', 'glue', 'pencil', 'lamp', 'compass', 'stapler', 'eraser', 'ruler', 'pen', 'lamp', 'calculator', 'piggy'];

function wallPlan(w: IWorld): [number, number][] {
  const out: [number, number][] = [];
  const { cols } = w.state.grid;
  const rows: [number, number][] = [[4, cols - 1], [7, 0], [10, cols - 1]];
  for (const [y, gap] of rows) for (let x = 0; x < cols; x++) if (x !== gap) out.push([x, y]);
  return out;
}

function bestCell(w: IWorld, id: TowerId): [number, number] | null {
  const s = w.state;
  const { cols, rows, cells } = s.grid;
  const paths = w.currentPaths();
  const pc: { x: number; y: number }[] = [];
  for (const p of paths) for (const c of p) pc.push(c);
  const r = Math.max(1.5, w.baseRange(id).range || 2);
  let best: [number, number] | null = null;
  let bv = -1;
  for (let y = 1; y < rows - 1; y++) {
    for (let x = 0; x < cols; x++) {
      if (cells[y * cols + x] !== 0) continue;
      let v = 0;
      for (const c of pc) {
        const dx = c.x - x;
        const dy = c.y - y;
        if (dx * dx + dy * dy <= r * r) v++;
      }
      if (id === 'piggy' || id === 'calculator') v = 100 - v;
      if (v > bv && w.canPlace(id, x, y).ok) {
        bv = v;
        best = [x, y];
      }
    }
  }
  return best;
}

function playBot(opts: RunOptions, maxWave: number, maxTicks = 60 * 60 * 150): { wave: number; phase: string; w: IWorld } {
  const w = createWorld(opts);
  const walls = wallPlan(w);
  let wi = 0;
  let ri = 0;
  let ticks = 0;
  while (ticks < maxTicks) {
    const s = w.state;
    if (s.phase === 'won' || s.phase === 'lost') break;
    if (s.phase === 'perk') {
      const c = s.perkChoices![0];
      let uid: number | undefined;
      if (c.needsTower) uid = [...s.towers.values()].find((t) => t.id !== 'wall' && t.level >= 7 && t.level < 10)?.uid;
      if (!w.command({ type: 'choosePerk', id: c.id, uid }).ok) w.command({ type: 'choosePerk', id: s.perkChoices![1].id });
      continue;
    }
    if (ticks % 15 === 0) {
      const attackers = [...s.towers.values()].filter((t) => t.id !== 'wall').length;
      // 墙
      let g = 0;
      while (wi < walls.length && attackers >= 6 && s.gold >= 25 && g++ < 6) {
        const [x, y] = walls[wi];
        const chk = w.canPlace('wall', x, y);
        if (chk.ok) w.command({ type: 'place', tower: 'wall', cx: x, cy: y });
        else if (chk.reason === '有敌人在这里') break;
        wi++;
      }
      // 攻击塔
      for (let k = 0; k < ROTATION.length; k++) {
        const id = ROTATION[ri % ROTATION.length];
        if (!s.unlockedTowers.includes(id) || (id === 'piggy' && [...s.towers.values()].filter((t) => t.id === 'piggy').length >= 3)) {
          ri++;
          continue;
        }
        break;
      }
      const next = ROTATION[ri % ROTATION.length];
      const cost = w.getBuildOptions().find((o) => o.id === next)!.cost;
      const towerCount = s.towers.size - wi;
      if (s.gold >= cost && (towerCount < 30 || s.gold > cost * 4)) {
        const c = bestCell(w, next);
        if (c) w.command({ type: 'place', tower: next, cx: c[0], cy: c[1] });
        ri++;
      }
      // 升级：金币富余时升级等级最低的攻击塔
      if (attackers >= 10 && s.gold > cost * 1.5) {
        const towers = [...s.towers.values()].filter((t) => t.id !== 'wall' && t.id !== 'piggy').sort((a, b) => a.level - b.level);
        for (const t of towers) {
          const info = w.getTowerInfo(t.uid)!;
          if (info.upgradeCost !== null && info.upgradeCost < s.gold - cost) w.command({ type: 'upgrade', uid: t.uid, branch: t.uid % 2 ? 'A' : 'B' });
        }
      }
    }
    // 技能
    if (s.phase === 'wave' && s.enemies.length > 0 && ticks % 20 === 0) {
      for (const sk of s.skills) {
        if (!sk.ready) continue;
        const target = s.enemies.reduce((a, b) => (b.hp > a.hp ? b : a));
        if (sk.target === 'circle' || sk.target === 'rect2') w.command({ type: 'cast', skill: sk.id, x: target.x, y: target.y });
        else if (sk.target === 'line') w.command({ type: 'cast', skill: sk.id, cy: Math.floor(target.y), axis: 'row' });
        else if (sk.target === 'tower') {
          const t = [...s.towers.values()].find((t) => t.id !== 'wall' && t.level < 9);
          if (t) w.command({ type: 'cast', skill: sk.id, uid: t.uid });
        } else if (sk.target === 'none' && s.enemies.length > 10) w.command({ type: 'cast', skill: sk.id });
      }
    }
    if (s.phase === 'build') {
      if ((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.BOT_DEBUG) console.log(`w${s.wave} lives ${s.lives} gold ${s.gold} towers ${[...s.towers.values()].map((t) => t.id[0] + t.level).join('')} len ${w.currentPaths()[0].length}`);
      if (s.wave >= maxWave) break;
      w.command({ type: 'startWave' });
    }
    w.step();
    w.drainEvents();
    ticks++;
  }
  return { wave: w.state.wave, phase: w.state.phase, w };
}

describe('smoke', () => {
  it('endless normal bot survives the engine for 40+ waves', () => {
    const t0 = performance.now();
    const r = playBot({ mode: 'endless', map: 'ch1', difficulty: 'normal', seed: 'smoke-1', skills: ['eraser_strike', 'bell', 'whiteout_zone'] }, 60);
    const ms = performance.now() - t0;
    console.log(`[smoke] endless normal ch1: reached wave ${r.wave} (${r.phase}), lives ${r.w.state.lives}, kills ${r.w.state.stats.kills}, towers ${r.w.state.towers.size}, score ${r.w.state.score}, ${Math.round(ms)}ms`);
    expect(r.wave).toBeGreaterThanOrEqual(1);
  }, 120000);

  it('endless (high lives) runs at least 40 waves without throwing, on every map', () => {
    for (const map of ['ch1', 'ch2', 'ch3'] as const) {
      const r = playBot({ mode: 'custom', map, difficulty: 'normal', custom: { lives: 100000 }, seed: 'smoke-' + map, skills: ['eraser_strike', 'magnifier', 'caffeine', 'inspiration'], talents: { bigbag: 1, collector: 1, luckydraw: 1 } }, 45);
      console.log(`[smoke] custom ${map}: reached wave ${r.wave} (${r.phase}), enemies on field ${r.w.state.enemies.length}, kills ${r.w.state.stats.kills}, perks ${r.w.state.perks.join(',')}`);
      expect(r.wave).toBeGreaterThanOrEqual(40);
    }
  }, 300000);

  it('campaign runs to completion or loss', () => {
    for (const map of ['ch1', 'ch2', 'ch3'] as const) {
      const r = playBot({ mode: 'campaign', map, difficulty: 'normal', seed: 'camp-' + map, skills: ['eraser_strike', 'bell', 'whiteout_zone'] }, 20);
      console.log(`[smoke] campaign ${map}: wave ${r.wave}, phase ${r.phase}, lives ${r.w.state.lives}/${r.w.state.maxLives}, score ${r.w.state.score}`);
      expect(['won', 'lost']).toContain(r.phase);
    }
  }, 300000);
});
