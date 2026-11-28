import { describe, expect, it } from 'vitest';

import { PIGGY_MAX } from '../../src/config/towers';
import { createWorld, type IWorld, type RunOptions, stateHash, type TowerId } from '../../src/core';
import { executeSwap, planSwap, swapTargets } from '../../src/ui/hud/swap';

const base = (o: Partial<RunOptions> = {}): RunOptions => ({
  mode: 'custom',
  map: 'ch1',
  difficulty: 'normal',
  seed: 'swap-seed',
  skills: ['eraser_strike', 'bell', 'whiteout_zone'],
  fixedLayout: true,
  custom: { startGold: 100000 },
  ...o,
});

function run(w: IWorld, n: number): void {
  for (let i = 0; i < n; i++) w.step();
}

/** 找一个能放下的格子并放塔，返回 uid */
function placeAny(w: IWorld, id: TowerId, skip = 0): number {
  const g = w.state.grid;
  let seen = 0;
  for (let cy = 0; cy < g.rows; cy++)
    for (let cx = 0; cx < g.cols; cx++) {
      if (!w.canPlace(id, cx, cy).ok) continue;
      if (seen++ < skip) continue;
      expect(w.command({ type: 'place', tower: id, cx, cy }).ok).toBe(true);
      return g.towerAt[cy * g.cols + cx];
    }
  throw new Error('no free cell');
}

function replay(w: IWorld, o: RunOptions): IWorld {
  const b = createWorld(o);
  const log = w.log.slice();
  let li = 0;
  while (b.state.tick < w.state.tick) {
    while (li < log.length && log[li].tick === b.state.tick) b.command(log[li++].cmd);
    b.step();
  }
  while (li < log.length && log[li].tick === b.state.tick) b.command(log[li++].cmd);
  return b;
}

describe('换塔（出售 + 原地放置）', () => {
  it('净花费 = 新造价 − 退款，执行后金币与格子都对', () => {
    const w = createWorld(base());
    const uid = placeAny(w, 'pencil');
    run(w, 60 * 8); // 过了 5 秒撤销期
    const info = w.getTowerInfo(uid)!;
    expect(info.canUndo).toBe(false);
    const plan = planSwap(w, uid, 'stapler');
    const cost = w.getBuildOptions().find((o) => o.id === 'stapler')!.cost;
    expect(plan.ok).toBe(true);
    expect(plan.refund).toBe(info.sellValue);
    expect(plan.cost).toBe(cost);
    expect(plan.net).toBe(cost - info.sellValue);
    expect(plan.commands).toEqual([
      { type: 'sell', uid },
      { type: 'place', tower: 'stapler', cx: plan.cx, cy: plan.cy },
    ]);
    const gold0 = w.state.gold;
    const r = executeSwap(w, (c) => w.command(c), uid, 'stapler');
    expect(r.ok).toBe(true);
    expect(w.state.gold).toBe(gold0 - plan.net);
    const g = w.state.grid;
    const nu = g.towerAt[plan.cy * g.cols + plan.cx];
    expect(nu).toBe(r.uid);
    expect(w.state.towers.get(nu)?.id).toBe('stapler');
    expect(w.state.towers.has(uid)).toBe(false);
  });

  it('撤销期内换塔全额退款', () => {
    const w = createWorld(base());
    const uid = placeAny(w, 'pencil');
    const plan = planSwap(w, uid, 'wall');
    expect(plan.ok).toBe(true);
    expect(plan.refund).toBe(w.getTowerInfo(uid)!.sellValue);
    expect(plan.net).toBe(plan.cost - plan.refund);
    expect(plan.net).toBeLessThan(0);
  });

  it('不可换时不发任何指令、不改状态', () => {
    const w = createWorld(base());
    const uid = placeAny(w, 'pencil');
    run(w, 60 * 8);
    const check = (to: TowerId, code: string) => {
      const h0 = stateHash(w);
      const n0 = w.log.length;
      const sent: unknown[] = [];
      expect(planSwap(w, uid, to).code).toBe(code);
      const r = executeSwap(
        w,
        (c) => {
          sent.push(c);
          return w.command(c);
        },
        uid,
        to,
      );
      expect(r.ok).toBe(false);
      expect(sent).toEqual([]);
      expect(w.log.length).toBe(n0);
      expect(stateHash(w)).toBe(h0);
      expect(w.state.towers.has(uid)).toBe(true);
    };
    // 同一种
    check('pencil', 'same');
    // 钱不够（退款也补不上）
    const gold = w.state.gold;
    w.state.gold = 0;
    check('piggy', 'noGold');
    w.state.gold = gold;
    // 未解锁
    const unl = w.state.unlockedTowers.slice();
    w.state.unlockedTowers.splice(w.state.unlockedTowers.indexOf('lamp'), 1);
    check('lamp', 'locked');
    w.state.unlockedTowers.splice(0, w.state.unlockedTowers.length, ...unl);
    // 存钱罐上限
    for (let k = 0; k < PIGGY_MAX; k++) placeAny(w, 'piggy');
    check('piggy', 'piggyLimit');
    // 不存在的塔
    expect(planSwap(w, 987654, 'wall').code).toBe('noTower');
    expect(swapTargets(w, 987654)).toEqual([]);
  });

  it('存钱罐满额时，把存钱罐换成别的塔仍然可以', () => {
    const w = createWorld(base());
    const pig = placeAny(w, 'piggy');
    for (let k = 1; k < PIGGY_MAX; k++) placeAny(w, 'piggy');
    expect(planSwap(w, pig, 'pencil').ok).toBe(true);
    const list = swapTargets(w, pig);
    expect(list.some((p) => p.to === 'piggy')).toBe(false);
    expect(list.find((p) => p.to === 'pencil')?.ok).toBe(true);
  });

  it('换塔产生的 sell + place 指令回放后状态一致', () => {
    const o = base({ seed: 'swap-replay' });
    const w = createWorld(o);
    const a = placeAny(w, 'pencil');
    const b = placeAny(w, 'wall', 3);
    w.command({ type: 'startWave' });
    run(w, 60 * 6);
    expect(executeSwap(w, (c) => w.command(c), a, 'glue').ok).toBe(true);
    run(w, 30);
    expect(executeSwap(w, (c) => w.command(c), b, 'pen').ok).toBe(true);
    run(w, 60 * 4);
    const types = w.log.map((l) => l.cmd.type);
    expect(types.filter((t) => t === 'sell').length).toBe(2);
    expect(stateHash(replay(w, o))).toBe(stateHash(w));
  });
});
