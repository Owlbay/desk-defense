import { describe, expect, it } from 'vitest';

import { adviceLine, stripArrow, turnAdvice } from '../../src/agent/advice';
import { threatEstimate, type ThreatLine } from '../../src/agent/battle';
import { parseNext } from '../../src/agent/providers/scripted';
import { createWorld, type RunOptions } from '../../src/core';

const opts = (seed: string): RunOptions =>
  ({
    mode: 'endless',
    map: 'ch1',
    difficulty: 'normal',
    seed,
    skills: ['eraser_strike', 'bell', 'whiteout_zone'],
    pure: true,
  }) as RunOptions;

const danger = (id: string, ratio: number): ThreatLine => ({
  id,
  hp: 100,
  cap: ratio * 100,
  ratio,
  verdict: ratio < 1.2 ? '危险' : '吃紧',
  enemies: 'cr×5',
});

describe('NEXT 建议清单', () => {
  it('开局：先补没防守的路线，再修迷宫，最后把钱全花掉', () => {
    const w = createWorld(opts('adv-1'));
    const a = turnAdvice(w, { threat: threatEstimate(w) });
    expect(a.actions[0]).toMatchObject({ do: 'build_near', purpose: 'dps' });
    expect(a.actions.map((x) => x.do)).toContain('maze');
    expect(a.actions.at(-1)).toEqual({ do: 'spend', reserve: 0 });
    expect(a.why).toHaveLength(a.actions.length);
  });

  it('最危险的路线排最前，空中线用对空，清单不超过 4 步且 spend 永远在最后', () => {
    const w = createWorld(opts('adv-2'));
    const a = turnAdvice(w, { threat: [danger('north', 1.5), danger('air:west', 0.4), danger('east', 0.9), danger('*', 1)] });
    expect(a.actions).toHaveLength(4);
    expect(a.actions[0]).toEqual({ do: 'build_near', purpose: 'air', route: 'west' });
    expect(a.actions[1]).toMatchObject({ do: 'build_near', target: 'route:east' });
    expect(a.actions.at(-1)).toEqual({ do: 'spend', reserve: 0 });
  });

  it('都安全时也把钱花掉（利息太少，不值得留）', () => {
    const w = createWorld(opts('adv-3'));
    w.state.wave = 5;
    const a = turnAdvice(w, { threat: [{ id: 'north', hp: 100, cap: 500, ratio: 5, verdict: '安全', enemies: 'cr×5' }] });
    expect(a.actions.at(-1)).toEqual({ do: 'spend', reserve: 0 });
    expect(a.actions.some((x) => x.do === 'build_near')).toBe(false);
  });

  it('一行文字能被原样解析回动作（模型照抄 / scripted-next 用）', () => {
    const w = createWorld(opts('adv-4'));
    const a = turnAdvice(w, { threat: threatEstimate(w) });
    const line = adviceLine(a);
    expect(line.startsWith('NEXT [')).toBe(true);
    expect(parseNext(`foo\n${line}\nbar`)).toEqual(a.actions);
    expect(parseNext('no advice here')).toBeUndefined();
  });

  it('其他提示行去掉「→ 建议」，只留依据', () => {
    expect(stripArrow('MZ 路线 L14 偏短 → {do:"maze"}（不给 budget）')).toBe('MZ 路线 L14 偏短');
    expect(stripArrow('TH w1: north 危险 ×0 → {do:"build_near"} / maze\nCTR ik→slow')).toBe('TH w1: north 危险 ×0\nCTR ik→slow');
  });
});
