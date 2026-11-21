/**
 * AI 进攻方（文档 10 §2.3）：overrideWave 指令的校验、生效、确定性与回放。
 */
import { describe, expect, it } from 'vitest';

import { attackBudget, checkAttackPlan, enemyPrice, groupCost } from '../../src/config/attack';
import { ENEMIES } from '../../src/config/enemies';
import { type Command, createWorld, type IWorld, type RunOptions, stateHash } from '../../src/core';

const base = (o: Partial<RunOptions> = {}): RunOptions => ({
  mode: 'endless',
  map: 'ch1',
  difficulty: 'normal',
  seed: 'atk-seed',
  skills: ['eraser_strike', 'bell', 'whiteout_zone'],
  fixedLayout: true,
  ...o,
});

function run(w: IWorld, n: number): void {
  for (let i = 0; i < n; i++) w.step();
}

/** 打到第 target 波的建造阶段（不建塔，自动开波关闭；每波结束就开下一波） */
function playTo(w: IWorld, target: number, onBuild?: (w: IWorld) => void): void {
  let guard = 0;
  while (w.state.wave < target - 1 && guard++ < 60 * 60 * 30) {
    if (w.state.phase === 'build') {
      onBuild?.(w);
      w.command({ type: 'startWave' });
    }
    w.step();
    if (w.state.phase === 'lost') return;
  }
  while (w.state.phase !== 'build' && guard++ < 60 * 60 * 30) w.step();
}

describe('attack price table', () => {
  it('budget grows with the wave, prices follow bounty', () => {
    expect(attackBudget(1)).toBe(60);
    expect(attackBudget(10)).toBe(150);
    expect(enemyPrice('crumb')).toBe(Math.ceil(ENEMIES.crumb.bounty * 1.5));
    expect(groupCost({ enemy: 'crumb', count: 4, affixes: ['hard'] }, true)).toBeGreaterThan(
      groupCost({ enemy: 'crumb', count: 4 }, false),
    );
  });

  it('validates pool, counts, affixes, budget and HP cap', () => {
    const ctx = { wave: 3, pool: ['crumb', 'inkdot'] as const, spawners: [{ id: 'north', drop: false }], baseHp: 300 };
    const c = (plan: unknown) => checkAttackPlan(plan, { ...ctx, pool: [...ctx.pool] });
    expect(c({ groups: [{ enemy: 'crumb', count: 5 }] }).ok).toBe(true);
    expect(c({ groups: [] })).toMatchObject({ ok: false, code: 'attackBadPlan' });
    expect(c(null)).toMatchObject({ ok: false, code: 'attackBadPlan' });
    expect(c({ groups: [{ enemy: 'paperclip', count: 2 }] })).toMatchObject({ ok: false, code: 'attackEnemy' });
    expect(c({ groups: [{ enemy: 'boss_coffee', count: 1 }] })).toMatchObject({ ok: false, code: 'attackEnemy' });
    expect(c({ groups: [{ enemy: 'crumb', count: 0 }] })).toMatchObject({ ok: false, code: 'attackCount' });
    expect(c({ groups: [{ enemy: 'crumb', count: 2.5 }] })).toMatchObject({ ok: false, code: 'attackCount' });
    expect(c({ groups: [{ enemy: 'crumb', count: 2, affixes: ['golden'] }] })).toMatchObject({ ok: false, code: 'attackAffix' });
    expect(c({ groups: [{ enemy: 'crumb', count: 2, affixes: ['swift', 'unstoppable'] }] })).toMatchObject({
      ok: false,
      code: 'attackAffix',
    });
    expect(c({ groups: [{ enemy: 'crumb', count: 2, spawner: 'nowhere' }] })).toMatchObject({ ok: false, code: 'attackSpawner' });
    expect(c({ groups: [{ enemy: 'crumb', count: 2, delay: -1 }] })).toMatchObject({ ok: false, code: 'attackDelay' });
    // 预算 80：30 个面包屑 = 30 × 5 = 150
    expect(c({ groups: [{ enemy: 'crumb', count: 30 }] })).toMatchObject({ ok: false, code: 'attackBudget' });
    // 生命上限 450：10 只精英面包屑 = 20×10×2.5 = 500
    expect(c({ groups: [{ enemy: 'crumb', count: 10, affixes: ['hard'] }] })).toMatchObject({ ok: false, code: 'attackHp' });
    // 规整：未知字段丢弃
    const ok = c({ groups: [{ enemy: 'inkdot', count: 3, extra: 1, delay: 2.04 }] });
    expect(ok.ok && ok.groups).toEqual([{ enemy: 'inkdot', count: 3, delay: 2 }]);
  });
});

describe('overrideWave command', () => {
  it('replaces the next wave in the build phase only', () => {
    const w = createWorld(base());
    const info = w.attackContext!()!;
    expect(info).toMatchObject({ wave: 1, open: true, budget: 60 });
    expect(info.pool).toContain('crumb');
    expect(info.pool.some((id) => ENEMIES[id].boss)).toBe(false);
    const before = JSON.stringify(w.state.nextWave.groups);
    expect(w.command({ type: 'overrideWave', wave: 2, plan: { groups: [{ enemy: 'crumb', count: 3 }] } })).toMatchObject({
      ok: false,
      code: 'attackWave',
    });
    expect(w.command({ type: 'overrideWave', wave: 1, plan: { groups: [{ enemy: 'paperclip', count: 1 }] } }).code).toBe('attackEnemy');
    expect(JSON.stringify(w.state.nextWave.groups)).toBe(before);
    expect(w.state.nextWave.override).toBeUndefined();
    const r = w.command({ type: 'overrideWave', wave: 1, plan: { groups: [{ enemy: 'crumb', count: 4, affixes: ['hard'] }] } });
    expect(r.ok).toBe(true);
    expect(w.state.nextWave.override).toEqual({ cost: 4 * (enemyPrice('crumb') + 3), budget: 60 });
    expect(w.state.nextWave.groups.map((g) => [g.enemy, g.count, g.elite])).toEqual([['crumb', 4, 4]]);
    expect(w.attackContext!()!.current).toBeDefined();
    w.drainEvents();
    w.command({ type: 'startWave' });
    expect(w.state.nextWave.override).toBeUndefined();
    // 波次进行中不能改写
    expect(w.command({ type: 'overrideWave', wave: 2, plan: { groups: [{ enemy: 'crumb', count: 3 }] } }).code).toBe('attackPhase');
    const spawned: string[] = [];
    for (let i = 0; i < 60 * 40 && w.state.wave === 1; i++) {
      w.step();
      for (const e of w.drainEvents()) if (e.type === 'spawn') spawned.push(e.enemy);
    }
    expect(spawned.slice(0, 4)).toEqual(['crumb', 'crumb', 'crumb', 'crumb']);
  });

  it('keeps the boss on boss waves', () => {
    const w = createWorld(base({ mode: 'custom', custom: { lives: 100000, eventRate: 0 } }));
    playTo(w, 10);
    expect(w.state.nextWave.wave).toBe(10);
    const info = w.attackContext!()!;
    expect(info.bosses.length).toBe(1);
    const r = w.command({ type: 'overrideWave', wave: 10, plan: { groups: [{ enemy: info.pool[0], count: 2 }] } });
    expect(r.ok).toBe(true);
    expect(w.state.nextWave.tags).toContain('boss');
    expect(w.state.nextWave.groups.some((g) => g.enemy === info.bosses[0])).toBe(true);
  });

  it('is deterministic and replays from the command log', () => {
    const script = (): IWorld => {
      const w = createWorld(base({ seed: 'atk-replay', fixedLayout: false }));
      w.command({ type: 'place', tower: 'pencil', cx: 4, cy: 2 });
      w.command({ type: 'place', tower: 'pencil', cx: 7, cy: 2 });
      playTo(w, 4, (x) => {
        const info = x.attackContext!()!;
        const enemy = info.pool[info.pool.length - 1];
        const sp = info.spawners[0]?.id;
        x.command({
          type: 'overrideWave',
          wave: info.wave,
          plan: {
            groups: [
              { enemy, count: 2, spawner: sp },
              { enemy: 'crumb', count: 3, delay: 1 },
            ],
          },
        });
      });
      run(w, 600);
      return w;
    };
    const a = script();
    const b = script();
    expect(a.log.filter((e) => e.cmd.type === 'overrideWave').length).toBeGreaterThanOrEqual(3);
    expect(stateHash(a)).toBe(stateHash(b));
    // 回放
    const c = createWorld(base({ seed: 'atk-replay', fixedLayout: false }));
    const log = JSON.parse(JSON.stringify(a.log)) as { tick: number; cmd: Command }[];
    let li = 0;
    while (c.state.tick < a.state.tick) {
      while (li < log.length && log[li].tick === c.state.tick) expect(c.command(log[li++].cmd).ok).toBe(true);
      c.step();
    }
    expect(stateHash(c)).toBe(stateHash(a));
  });

  it('does not change runs without overrides', () => {
    const plain = (probe: boolean): string => {
      const w = createWorld(base({ seed: 'atk-plain' }));
      playTo(w, 3, (x) => {
        // 只读查询不影响结果
        if (probe) x.attackContext!();
      });
      run(w, 300);
      return stateHash(w);
    };
    expect(plain(true)).toBe(plain(false));
  });
});
