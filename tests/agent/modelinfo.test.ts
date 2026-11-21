import { describe, expect, it } from 'vitest';

import {
  clampThinking,
  estimateWaveCost,
  lookupModel,
  MODELINFO_SOURCE,
  priceOf,
  thinkingSupport,
  usageCost,
} from '../../src/agent/modelinfo';
import { claudeCost } from '../../src/agent/providers/claude';
import { buildPiModel, buildRelayModel, PiProvider } from '../../src/agent/providers/pi';
import { claudeThinkingPlan, piThinkingPlan } from '../../src/agent/thinking';
import { emptyUsage } from '../../src/agent/types';

describe('modelinfo lookup', () => {
  it('has a dated snapshot with attribution', () => {
    expect(MODELINFO_SOURCE.name).toBe('modelinfo.dev');
    expect(MODELINFO_SOURCE.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(MODELINFO_SOURCE.count).toBeGreaterThan(50);
  });

  it('matches exact ids, aliases, vendor prefixes, case and date suffixes', () => {
    expect(lookupModel('deepseek-flash')?.id).toBe('deepseek-flash');
    expect(lookupModel('deepseek-v4-flash')?.id).toBe('deepseek-flash'); // 别名
    expect(lookupModel('deepseek/deepseek-flash')?.id).toBe('deepseek-flash');
    expect(lookupModel('DeepSeek-Flash')?.id).toBe('deepseek-flash');
    expect(lookupModel('anthropic/claude-opus-5-5')?.id).toBe('claude-opus-5-5');
    expect(lookupModel('us.anthropic.claude-opus-5-5')?.id).toBe('claude-opus-5-5');
    expect(lookupModel('claude-opus-5.5')?.id).toBe('claude-opus-5-5');
    expect(lookupModel('claude-opus-5-5[1m]')?.id).toBe('claude-opus-5-5');
    expect(lookupModel('gpt-5.4-2026-03-05')?.id).toBe('gpt-5.4');
    expect(lookupModel('openai/gpt-5.4:free')?.id).toBe('gpt-5.4');
    expect(lookupModel('gpt-5.6')?.id).toBe('gpt-5.6-sol'); // 官方别名
  });

  it('returns null for unknown models', () => {
    expect(lookupModel('my-local-finetune')).toBeNull();
    expect(lookupModel('')).toBeNull();
    expect(thinkingSupport('my-local-finetune').known).toBe(false);
  });
});

describe('per-model thinking levels', () => {
  it('lists only the efforts a model supports', () => {
    // DeepSeek：low / high / max，可经 thinking.type 关闭
    expect(thinkingSupport('deepseek-flash').levels).toEqual(['off', 'low', 'high', 'max']);
    // Opus 5.5 不能关思考
    expect(thinkingSupport('claude-opus-5-5').levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    // Sonnet 5.5 能关（between_tools）
    expect(thinkingSupport('claude-sonnet-5-5').levels[0]).toBe('off');
    // GPT-5.6：档位里有 none
    expect(thinkingSupport('gpt-5.6-sol').levels).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max']);
    // 未知模型：沿用通用档位
    expect(thinkingSupport('foo-bar').levels).toEqual(['off', 'low', 'medium', 'high']);
    expect(thinkingSupport('claude-something-new').levels).toContain('max');
  });

  it('clamps to the nearest supported level (ties go lower)', () => {
    const ds = thinkingSupport('deepseek-flash').levels;
    expect(clampThinking('medium', ds)).toBe('low');
    expect(clampThinking('xhigh', ds)).toBe('high'); // 平局取较低档
    expect(clampThinking('high', ds)).toBe('high');
    expect(clampThinking('off', ['low', 'high'])).toBe('low');
    expect(clampThinking('high', ['off'])).toBe('off');
  });

  it('maps levels to wire efforts for pi (OpenAI-compatible)', () => {
    const p = piThinkingPlan('openai-completions', 'deepseek-flash', 'max', { thinkingFormat: 'deepseek' });
    expect(p.wire).toBe('max');
    expect(p.reasoning).toBe('xhigh');
    const q = piThinkingPlan('openai-completions', 'deepseek-flash', 'medium', { thinkingFormat: 'deepseek' });
    expect(q.wire).toBe('low');
    expect(q.note).toBeTruthy();
    // 未知模型：行为不变（不改写线上取值）
    const u = piThinkingPlan('openai-completions', 'foo-bar', 'high');
    expect(u.wire).toBeUndefined();
    expect(u.reasoning).toBe('high');
    // 不支持思考的模型：不发推理参数
    const n = piThinkingPlan('openai-completions', 'gpt-4.1', 'high');
    expect(n.reasoning).toBeUndefined();
    expect(n.modelReasoning).toBe(false);
  });

  it('pi provider rewrites the wire value through thinkingLevelMap', () => {
    const pv = new PiProvider({
      config: {
        provider: 'pi',
        preset: 'relay',
        api: 'openai-completions',
        baseUrl: 'https://r.example/v1',
        model: 'deepseek-flash',
        thinking: 'max',
      },
    });
    const plan = pv.thinkingPlan();
    expect(plan.wire).toBe('max');
    const m = (pv as unknown as { modelFor(p: typeof plan): { thinkingLevelMap?: Record<string, string> } }).modelFor(plan);
    expect(m.thinkingLevelMap?.xhigh).toBe('max');
  });

  it('claude plan clamps non-off levels to catalog efforts and keeps off handling', () => {
    expect(claudeThinkingPlan('claude-opus-5-5', 'max').effort).toBe('max');
    expect(claudeThinkingPlan('claude-opus-5-5', 'off').note).toBeTruthy();
    expect(claudeThinkingPlan('claude-haiku-5-5', 'off').thinking).toEqual({ type: 'disabled' });
  });
});

describe('prices and cost', () => {
  it('computes cost with catalog prices and input-price fallback for missing cache prices', () => {
    const p = priceOf('deepseek-flash')!;
    expect(p.in).toBeGreaterThan(0);
    const u = { ...emptyUsage(), inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 };
    expect(usageCost(u, { in: 1, out: 2, cr: 0.1, cw: null })).toBeCloseTo(1 + 2 + 0.1 + 1);
  });

  it('manual price overrides the catalog', () => {
    expect(priceOf('deepseek-flash', { in: 9, out: 9 })?.in).toBe(9);
    expect(priceOf('unknown-model')).toBeNull();
    expect(priceOf('unknown-model', { in: 1, out: 2 })?.out).toBe(2);
  });

  it('claude cost: catalog > CLAUDE_PRICES fallback', () => {
    const u = { ...emptyUsage(), inputTokens: 1_000_000 };
    expect(claudeCost('claude-opus-5-5', u)).toBeCloseTo(4);
    expect(claudeCost('claude-opus-5-5', u, { in: 1, out: 1 })).toBeCloseTo(1);
    expect(claudeCost('claude-unknown-x', u)).toBeCloseTo(4); // 按 Opus 5.5 兜底
  });

  it('pi models get catalog prices (relay and presets) and manual overrides', () => {
    const relay = buildRelayModel({ provider: 'pi', preset: 'relay', baseUrl: 'https://r.example', model: 'deepseek-flash' });
    expect(relay.cost.input).toBe(priceOf('deepseek-flash')!.in);
    expect(relay.cost.cacheWrite).toBe(relay.cost.input); // cw 未公布 → 按输入价
    const custom = buildPiModel({ provider: 'pi', preset: 'custom', baseUrl: 'http://x/v1', model: 'my-model', price: { in: 1, out: 3 } });
    expect(custom.cost.output).toBe(3);
    const local = buildPiModel({ provider: 'pi', preset: 'ollama', model: 'qwen3:8b' });
    expect(local.cost.input).toBe(0);
  });

  it('estimates per-wave cost from weighted tokens', () => {
    // 折算 1e6：0.15 输入 + 0.75 输出 + 1.0 缓存读
    expect(estimateWaveCost(1_000_000, { in: 1, out: 1, cr: 0.1 })).toBeCloseTo(0.15 + 0.75 + 0.1);
  });
});
