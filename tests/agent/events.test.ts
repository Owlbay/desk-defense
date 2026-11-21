import { describe, expect, it } from 'vitest';
import { createWorld, World, type GameEvent, type RunOptions } from '../../src/core';
import {
  DecisionDetector, EVENT_DECIDE, cheatSheet, compactObservation, eventLine, eventNeedsDecision, gateDecision,
} from '../../src/agent';
import { withLocale, SOURCE_LOCALE } from '../../src/i18n';

const opts = (seed: string, gold = 150): RunOptions => ({
  mode: 'custom', map: 'ch1', difficulty: 'normal', seed, skills: ['eraser_strike', 'bell', 'whiteout_zone'], pure: true, fixedLayout: true,
  custom: { eventRate: 0, startGold: gold, lives: 1000 },
});

function inWave(seed: string, gold = 150): World {
  const w = createWorld(opts(seed, gold)) as World;
  w.command({ type: 'startWave' });
  for (let i = 0; i < 60 * 3; i++) w.step();
  w.drainEvents();
  return w;
}

const startEv = (id: 'goldbag' | 'bounty' | 'lamp_outage'): GameEvent => ({ type: 'randomEvent', uid: 1, id, phase: 'start', name: id, desc: '', tone: 'good' });

describe('agent: monster events', () => {
  it('goldbag / golden elite / medic squad always wake the model; bounty only with something to spend', () => {
    const w = inWave('ag-ev-1', 150);
    expect(eventNeedsDecision('goldbag', w)).toBe(true);
    expect(eventNeedsDecision('golden_elite', w)).toBe(true);
    expect(eventNeedsDecision('medic_squad', w)).toBe(true);
    // 有预警的事件在预警时已经叫过
    expect(eventNeedsDecision('tea_break', w)).toBe(false);
    expect(eventNeedsDecision('lamp_outage', w)).toBe(false);
    expect(eventNeedsDecision('bounty', w)).toBe(true);
    for (const k of w.state.skills) { k.ready = false; k.cd = 30; }
    w.state.gold = 0;
    expect(eventNeedsDecision('bounty', w)).toBe(false);
    expect(eventNeedsDecision('training', w)).toBe(false);
    for (const id of Object.keys(EVENT_DECIDE)) expect(['always', 'spend']).toContain(EVENT_DECIDE[id as keyof typeof EVENT_DECIDE]);
  });

  it('the detector turns a relevant event start into event_warn, which gating never skips', () => {
    const w = inWave('ag-ev-2', 150);
    const d = new DecisionDetector({ waveIntervalSec: 0, minGapSec: 0 });
    d.done(w);
    d.feed(startEv('lamp_outage'), w);
    expect(d.check(w)).toBeNull();
    d.feed(startEv('goldbag'), w);
    const r = d.check(w);
    expect(r).toContain('event_warn');
    w.state.gold = 0;
    expect(gateDecision(w, r!, 'aggressive', { goldAtLastCall: 0, seq: 5 })).toBeNull();
  });

  it('observation lists coin targets (EG) and an EVT tip line', () => {
    const w = inWave('ag-ev-3', 150);
    expect(w.forceEvent('goldbag')).toBe(true);
    expect(w.forceEvent('bounty')).toBe(true);
    for (let i = 0; i < 60 * 2 && !w.state.enemies.some((e) => e.id === 'goldbag'); i++) w.step();
    const obs = compactObservation(w);
    expect(String(obs.EG)).toMatch(/^gb#\d+/);
    const line = eventLine(w)!;
    expect(line).toMatch(/^EVT /);
    expect(line).toMatch(/bounty \d+s/);
    expect(line).toMatch(/coin targets gb#\d+/);
  });

  it('cheat sheet teaches lamps and monster events (zh-CN prefix)', () => {
    const cs = withLocale(SOURCE_LOCALE, () => cheatSheet());
    for (const s of ['Lamps <=2.5 apart link', 'boss lane', 'goldbag', 'golden elite', 'tea_break', 'shield_supply', 'medic_squad', 'frenzy', 'bounty', 'training', 'gb goldbag']) expect(cs).toContain(s);
  });
});

describe('agent: user-visible strings follow the UI locale', () => {
  it('config errors, relay advice, thinking notes (zh-CN default, en after switching)', async () => {
    const { validateConfig, validateConfigIssues, relayFailureText, claudeThinkingPlan, piThinkingPlan } = await import('../../src/agent');
    const { loadLocale, setLocale } = await import('../../src/i18n');
    expect(validateConfig({ provider: 'pi' })).toContain('缺少 model');
    expect(validateConfigIssues({ provider: 'pi', baseUrl: 'nope' }).map((e) => e.code)).toEqual(['noModel', 'badUrl']);
    expect(relayFailureText('auth')).toMatch(/Key 被拒绝/);
    await loadLocale('en');
    await setLocale('en');
    try {
      expect(validateConfig({ provider: 'pi' })).toContain('model is missing');
      expect(validateConfig({ provider: 'pi', model: 'x', effort: 'huge' as never })).toContain('effort must be one of low / medium / high / xhigh / max');
      expect(relayFailureText('auth')).toMatch(/^Key rejected/);
      expect(relayFailureText('cors')).toMatch(/CORS/);
      expect(claudeThinkingPlan('claude-opus-5-5', 'off').note).toBe('Opus 5.5 cannot turn thinking off; using the lowest effort');
      expect(piThinkingPlan('openai-completions', 'gpt-x', 'off').effective).toBe('reasoning_effort not sent (no thinking)');
      // 给模型的前缀按源语言（中文）生成，与界面语言无关
      expect(withLocale(SOURCE_LOCALE, () => cheatSheet())).toMatch(/铅笔每次命中/);
    } finally {
      await setLocale(SOURCE_LOCALE);
    }
  });
});
