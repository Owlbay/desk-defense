import { describe, expect, it } from 'vitest';

import { ScriptedProvider } from '../../src/agent/providers/scripted';
import { runAgentGame } from '../../src/agent/runner';
import { createWorld, type RunOptions, stateHash } from '../../src/core';
import { replaySync } from '../../src/meta/midrun';
import { verifyRun } from '../../src/shared/replay-verify';

const opts: RunOptions = {
  mode: 'endless',
  map: 'ch1',
  difficulty: 'normal',
  seed: 'resume-1',
  skills: ['eraser_strike', 'bell', 'whiteout_zone'],
  pure: true,
};
const cfg = { config: { provider: 'scripted' as const, model: 'scripted-intents' } };

describe('从存档接着打（runAgentGame resume）', () => {
  it('续打的回放 = 原局指令 + 新指令，是能通过校验的一整局', { timeout: 120_000 }, async () => {
    const first = await runAgentGame(opts, { ...cfg, provider: new ScriptedProvider({ intents: true }), maxWaves: 2 });
    expect(first.result.outcome).toBe('cap');
    const prefix = first.replay.log;
    const cont = await runAgentGame(opts, {
      ...cfg,
      provider: new ScriptedProvider({ intents: true }),
      maxWaves: 4,
      resume: { log: prefix, tick: first.replay.tick },
    });
    expect(cont.result.wave).toBeGreaterThan(first.result.wave);
    // 前缀原样保留
    expect(cont.replay.log.slice(0, prefix.length)).toEqual(prefix);
    // 整局回放与续打结束时的局面一致，并能通过服务端同款校验
    const w = createWorld(opts);
    replaySync(w, cont.replay);
    const v = verifyRun({
      opts,
      seed: 'resume-1',
      log: cont.replay.log,
      result: { wave: 0, score: 0, kills: 0, lives: 0, gold: 0, won: false, ticks: cont.replay.tick },
    });
    expect(v.replayed?.ticks).toBe(cont.replay.tick);
    expect(v.replayed?.hash).toBe(stateHash(w));
  });
});
