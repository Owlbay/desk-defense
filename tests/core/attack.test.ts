/**
 * AI 进攻方（文档 10 §2.3）：overrideWave 指令的校验、生效、确定性与回放。
 */
import { describe, expect, it } from 'vitest';

import { scriptedAttackPlan } from '../../src/agent/attack';
import { affixPrice, ATTACK, attackBudget, checkAttackPlan, enemyPrice, groupCost } from '../../src/config/attack';
import { ENEMIES } from '../../src/config/enemies';
import { type Command, createWorld, type IWorld, type RunOptions, stateHash } from '../../src/core';
import { resolveParams } from '../../src/core/scaling';
import { generateWave, planHpUnits } from '../../src/core/wavegen';

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
    expect(attackBudget(1)).toBe(43);
    expect(attackBudget(10)).toBe(70);
    expect(enemyPrice('crumb')).toBe(Math.ceil(ENEMIES.crumb.bounty * 1.5));
    expect(groupCost({ enemy: 'crumb', count: 4, affixes: ['hard'] }, true)).toBeGreaterThan(
      groupCost({ enemy: 'crumb', count: 4 }, false),
    );
  });

  it('validates pool, counts, affixes, budget and HP cap', () => {
    const ctx = { wave: 3, pool: ['crumb', 'inkdot', 'plane'] as const, spawners: [{ id: 'north', drop: false }], baseHp: 100 };
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
    // 飞行敌人不能带词缀
    expect(c({ groups: [{ enemy: 'plane', count: 1, affixes: ['hard'] }] })).toMatchObject({ ok: false, code: 'attackAffix' });
    expect(c({ groups: [{ enemy: 'plane', count: 2 }] }).ok).toBe(true);
    // 预算 49：30 个面包屑 = 30 × 5 = 150
    expect(c({ groups: [{ enemy: 'crumb', count: 30 }] })).toMatchObject({ ok: false, code: 'attackBudget' });
    // 生命上限 120：3 只精英面包屑 = 20×3×2.5 = 150（花费 24，预算够）
    expect(c({ groups: [{ enemy: 'crumb', count: 3, affixes: ['hard'] }] })).toMatchObject({ ok: false, code: 'attackHp' });
    // 规整：未知字段丢弃
    const ok = c({ groups: [{ enemy: 'inkdot', count: 3, extra: 1, delay: 2.04 }] });
    expect(ok.ok && ok.groups).toEqual([{ enemy: 'inkdot', count: 3, delay: 2 }]);
  });
});

describe('overrideWave command', () => {
  it('replaces the next wave in the build phase only', () => {
    const w = createWorld(base());
    const info = w.attackContext!()!;
    expect(info).toMatchObject({ wave: 1, open: true, budget: attackBudget(1) });
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
    expect(w.state.nextWave.override).toEqual({ cost: 4 * (enemyPrice('crumb') + affixPrice('crumb')), budget: attackBudget(1) });
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

/**
 * 价格平衡（scripts/sim-attack.ts 的结论，文档 10 §2.3）：钉住几条关键不变量。
 */
describe('attack balance invariants', () => {
  /** 默认波按价格表"买下来"要多少墨水（非 Boss） */
  const defaultCost = (mode: 'endless' | 'campaign', map: 'ch1' | 'ch2' | 'ch3', seed: string, w: number): number => {
    const params = resolveParams({ mode, map, difficulty: 'normal', seed } as RunOptions);
    let cost = 0;
    for (const e of generateWave({ seed, mode, map, params }, w).entries) {
      if (e.gi < 0 || ENEMIES[e.enemy].boss) continue;
      cost += e.group * (enemyPrice(e.enemy) + e.affixes.length * affixPrice(e.enemy));
    }
    return cost;
  };

  it('budget tracks the default wave instead of outgrowing it', () => {
    // 默认波的生命当量不随波数增长（成长在生成时另乘），预算也只能缓慢增长：
    // 平均而言预算 ≈ 默认波的 0.6～1.6 倍（预算远大于默认波 → 生命上限永远先顶住，词缀 / 空降几乎免费）
    for (const mode of ['endless', 'campaign'] as const) {
      const waves = mode === 'endless' ? [1, 5, 12, 18, 25, 35, 45, 60] : [1, 3, 5, 8, 12, 15, 18, 20];
      let ratio = 0;
      let n = 0;
      for (const map of ['ch1', 'ch2', 'ch3'] as const)
        for (const w of waves)
          for (let i = 0; i < 3; i++) {
            ratio += attackBudget(w) / Math.max(1, defaultCost(mode, map, `bal${i}`, w));
            n++;
          }
      expect(ratio / n).toBeGreaterThan(0.6);
      expect(ratio / n).toBeLessThan(1.6);
    }
  });

  it('caps a full-budget tank plan by HP on typical waves', () => {
    // "每点墨水生命最高"的敌人（tape）把预算花光：生命当量应超过上限（上限对堆血计划生效）
    for (const w of [25, 35, 45]) {
      const params = resolveParams({ mode: 'endless', map: 'ch1', difficulty: 'normal', seed: 'cap' } as RunOptions);
      const base = generateWave({ seed: 'cap', mode: 'endless', map: 'ch1', params }, w);
      const count = Math.floor(attackBudget(w) / enemyPrice('tape'));
      const r = checkAttackPlan(
        { groups: [{ enemy: 'tape', count }] },
        { wave: w, pool: ['crumb', 'tape'], spawners: [], baseHp: planHpUnits(base) },
      );
      expect(r).toMatchObject({ ok: false, code: 'attackHp' });
    }
    expect(ATTACK.hpCap).toBeLessThanOrEqual(1.5);
  });

  it('scriptedAttackPlan never produces a rejected plan', () => {
    let planned = 0;
    for (const map of ['ch1', 'ch2', 'ch3'] as const)
      for (const seed of ['s1', 's2']) {
        const w = createWorld(base({ mode: 'custom', map, seed, custom: { lives: 100000, eventRate: 0 } }));
        // 有时没有对空塔（主攻飞行，验证飞行敌人不带词缀），有时有
        if (seed === 's2')
          for (const [cx, cy] of [
            [4, 2],
            [7, 2],
            [10, 2],
          ])
            w.command({ type: 'place', tower: 'pencil', cx, cy });
        for (let guard = 0; w.state.wave < 25 && guard < 60 * 60 * 60; guard++) {
          const s = w.state;
          if (s.phase === 'perk' && s.perkChoices) {
            const c = s.perkChoices.find((x) => !x.needsTower) ?? s.perkChoices[0];
            w.command({ type: 'choosePerk', id: c.id });
          } else if (s.phase === 'build') {
            const plan = scriptedAttackPlan(w);
            if (plan) {
              const info = w.attackContext!()!;
              const r = w.command({ type: 'overrideWave', wave: info.wave, plan: { groups: plan } });
              expect(r.ok, `${map}/${seed} wave ${info.wave}: ${r.code}`).toBe(true);
              planned++;
            }
            w.command({ type: 'startWave' });
          }
          w.step();
        }
        expect(w.state.wave).toBe(25);
      }
    expect(planned).toBeGreaterThan(120);
  });
});
