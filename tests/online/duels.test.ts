/**
 * AI 对战榜 + 模型 / 思考档位标记（不外泄渠道）：
 *  - publicModelName / 校验函数的接受与拒绝；
 *  - AI 辅助 / AI 参战上传带思考档位，接口只返回模型名 + 档位，不返回渠道；旧数据没有档位就不显示；
 *  - AI 对战：真跑一局（进攻方出题 + 防守方），客户端 submitDuel → /api/duels 入独立的对战榜，不混进三类榜；
 *    同样的日志走 /api/runs 会被拒（overrideWave）；对战详情可回放；
 *  - 本地对战记录：完整数据（双方模型 / 档位 / 用量 / 错误 / 出题 / 回放）存取。
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  type Deps,
  handleDuelBoard,
  handleDuelSubmit,
  handleGetDuel,
  handleLeaderboard,
  handleStatus,
  handleSubmit,
} from '../../functions/_lib/handlers';
import { apiError } from '../../functions/_lib/http';
import { agentTag, resolveConfig, runAgentGame, ScriptedAttackerProvider, ScriptedProvider, THINKING_LEVELS } from '../../src/agent';
import { createWorld, type IWorld, type RunOptions, stateHash } from '../../src/core';
import { markAssist } from '../../src/meta/aiAssist';
import { duelPlansOf, duelRecordOf, DUELS_KEY, getDuel, noteDuelUpload, readDuels, recordDuel } from '../../src/meta/duels';
import { historyEntryOf, readHistory, recordHistory } from '../../src/meta/history';
import { replaySync } from '../../src/meta/midrun';
import {
  _resetOnlineForTests,
  configureOnline,
  fetchDuel,
  fetchDuelBoard,
  resultFromWorld,
  submitDuel,
  submitWorldRun,
} from '../../src/meta/online';
import { type KV, memoryStorage } from '../../src/meta/storage';
import { encodeLog } from '../../src/shared/codec';
import {
  AI_EFFORTS,
  checkDuelSubmission,
  checkLog,
  type DuelBoardResponse,
  type DuelMeta,
  type DuelSubmitBody,
  GAME_VERSION,
  type LeaderboardResponse,
  modelTagText,
  publicModelName,
  sanitizeAgentMeta,
  sanitizeAiAssist,
  sanitizeDuelMeta,
} from '../../src/shared/leaderboard';
import { agentMetaOf, duelMetaOf } from '../../src/ui/ai/meta';
import { createFakeD1, type FakeD1 } from './fakeD1';
import { playRun } from './helpers';

const ORIGIN = 'http://localhost:8788';
const NOW = Date.parse('2026-11-20T04:00:00Z');
const OPTS: RunOptions = {
  mode: 'endless',
  map: 'ch1',
  difficulty: 'normal',
  seed: 'duel-board',
  skills: ['eraser_strike', 'bell', 'whiteout_zone'],
  pure: true,
  autoWave: true,
};
const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 300, requests: 9 };

let kv: KV;
let db: FakeD1;
let deps: Deps;

const routedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), ORIGIN);
  const req = new Request(url, { ...init, headers: { ...(init?.headers as Record<string, string>), 'CF-Connecting-IP': '127.0.0.1' } });
  const p = url.pathname;
  if (p === '/api/runs') return handleSubmit(req, deps);
  if (p === '/api/leaderboard') return handleLeaderboard(req, deps);
  if (p === '/api/status') return handleStatus(req, deps);
  if (p === '/api/duels') return req.method === 'POST' ? handleDuelSubmit(req, deps) : handleDuelBoard(req, deps);
  if (p.startsWith('/api/duels/')) return handleGetDuel(req, deps, p.slice('/api/duels/'.length));
  return apiError('not_found', '接口不存在');
}) as typeof fetch;

beforeEach(async () => {
  _resetOnlineForTests();
  kv = memoryStorage();
  db = await createFakeD1();
  deps = { db, now: () => NOW, salt: 's' };
  configureOnline({ fetch: routedFetch, storage: kv, now: () => NOW });
});

// ───────────── 一局真实的 AI 对战（无头，内置进攻方 + 内置防守方） ─────────────

let duelWorld: IWorld;
let duelSurvived = 0;
beforeAll(async () => {
  const r = await runAgentGame(OPTS, {
    config: { provider: 'scripted', role: 'player' },
    provider: new ScriptedProvider(),
    attacker: { config: { provider: 'scripted' }, provider: new ScriptedAttackerProvider() },
    maxWaves: 4,
  });
  duelWorld = createWorld(r.replay.opts);
  replaySync(duelWorld, r.replay);
  duelSurvived = duelWorld.state.phase === 'lost' ? Math.max(0, duelWorld.state.wave - 1) : duelWorld.state.wave;
}, 30_000);

const side = (provider: string, model: string, effort?: string) => ({
  provider,
  model,
  ...(effort ? { effort } : {}),
  decisions: 10,
  fallback: 1,
  usage,
  costUsd: 0.0123,
  errors: ['[攻] timeout'],
});

const DUEL: DuelMeta = {
  attacker: { model: 'deepseek-flash', effort: 'high', decisions: 5, botShare: 0, tokens: 1000, costUsd: 0.01, errors: 0 },
  defender: { model: 'claude-sonnet-5-5', effort: 'low', decisions: 20, botShare: 0.1, tokens: 9000, costUsd: 0.2, errors: 1 },
  plans: 4,
};

async function duelBody(o: Partial<DuelSubmitBody> = {}, device = 1): Promise<DuelSubmitBody> {
  const st = duelWorld.state;
  return {
    nickname: '对战',
    deviceId: `00000000-0000-4000-8000-${String(device).padStart(12, '0')}`,
    opts: { ...st.opts, seed: st.seed },
    seed: st.seed,
    log: await encodeLog(duelWorld.log.map((e) => ({ tick: e.tick, cmd: e.cmd }))),
    result: resultFromWorld(st, duelSurvived),
    gameVersion: GAME_VERSION,
    duel: DUEL,
    ...o,
  };
}

let ip = 0;
const post = (path: string, b: unknown) =>
  new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `7.7.7.${ip++ & 255}` },
    body: JSON.stringify(b),
  });

describe('模型名 / 思考档位：校验与清洗', () => {
  it('publicModelName 去掉渠道 / 中转前缀 / 地址，只留模型', () => {
    expect(publicModelName('claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
    expect(publicModelName('Claude · claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
    expect(publicModelName('中转服务 · deepseek-flash')).toBe('deepseek-flash');
    expect(publicModelName('https://relay.example.com/v1/deepseek-flash?key=abc')).toBe('deepseek-flash');
    expect(publicModelName('https://user:pw@relay.example.com/')).toBe('');
    expect(publicModelName('relay.example.com:8080')).toBe('');
    expect(publicModelName('anthropic/claude-sonnet-4')).toBe('claude-sonnet-4');
    expect(publicModelName('Qwen/Qwen3-8B')).toBe('Qwen3-8B');
    expect(publicModelName('qwen3:8b')).toBe('qwen3:8b');
    expect(publicModelName('gpt-4.1')).toBe('gpt-4.1');
    expect(publicModelName('离线演示')).toBe('离线演示');
    expect(publicModelName('离线演示', true)).toBe('____');
    expect(publicModelName(42)).toBe('');
    expect(modelTagText('deepseek-flash', 'high')).toBe('deepseek-flash · high');
    expect(modelTagText('deepseek-flash', undefined)).toBe('deepseek-flash');
  });

  it('思考档位白名单与 Agent 配置一致；agentTag 带档位（内置机器人没有）', () => {
    expect([...AI_EFFORTS]).toEqual(THINKING_LEVELS);
    expect(agentTag(resolveConfig({ provider: 'claude-native', model: 'claude-opus-5-5', thinking: 'xhigh' })).effort).toBe('xhigh');
    expect(agentTag(resolveConfig({ provider: 'pi', preset: 'ollama' }))).toMatchObject({ effort: 'off' });
    expect(agentTag(resolveConfig({ provider: 'scripted' }))).toEqual({ provider: 'scripted', model: 'scripted-v1' });
  });

  it('sanitizeAgentMeta：接受合法档位、拒绝非法档位；模型名清洗；内置机器人不带档位', () => {
    const base = { provider: 'llm', model: 'deepseek-flash', mode: 'pause', botShare: 0, decisions: 3 };
    expect(sanitizeAgentMeta({ ...base, effort: 'high' })).toEqual({ ok: true, value: { ...base, effort: 'high' } });
    expect(sanitizeAgentMeta({ ...base, effort: 'turbo' }).ok).toBe(false);
    expect(sanitizeAgentMeta({ ...base, effort: 7 }).ok).toBe(false);
    const url = sanitizeAgentMeta({ ...base, model: 'https://relay.example.com/v1/deepseek-flash' });
    expect(url.ok && url.value.model).toBe('deepseek-flash');
    expect(sanitizeAgentMeta({ ...base, model: 'https://relay.example.com/' }).ok).toBe(false);
    const s = sanitizeAgentMeta({ ...base, provider: 'scripted', model: 'scripted-v1', effort: 'high' });
    expect(s.ok && s.value.effort).toBeUndefined();
  });

  it('sanitizeAiAssist：档位可选且走白名单', () => {
    expect(sanitizeAiAssist({ model: 'deepseek-flash', effort: 'medium' })).toEqual({
      ok: true,
      value: { model: 'deepseek-flash', effort: 'medium' },
    });
    expect(sanitizeAiAssist({ model: 'x', effort: 'ultra' }).ok).toBe(false);
    expect(sanitizeAiAssist({ effort: 'low' })).toEqual({ ok: true, value: { effort: 'low' } });
  });

  it('客户端上传标记不带渠道：provider 只有 llm / scripted', () => {
    const meta = agentMetaOf({
      agent: { provider: 'pi:relay', model: 'https://my-relay.example.com/v1/deepseek-flash', role: 'player', effort: 'high' },
      mode: 'pause',
      botShare: 0,
      decisions: 3,
      usage,
      costUsd: 0.1,
    });
    expect(meta).toMatchObject({ provider: 'llm', model: 'deepseek-flash', effort: 'high' });
    expect(JSON.stringify(meta)).not.toMatch(/relay|pi:/);
    const bot = agentMetaOf({
      agent: { provider: 'scripted', model: 'scripted-v1', role: 'player', effort: 'low' },
      mode: 'pause',
      botShare: 1,
      decisions: 3,
      usage,
      costUsd: 0,
    });
    expect(bot).toMatchObject({ provider: 'scripted' });
    expect(bot.effort).toBeUndefined();
  });

  it('AI 辅助标记：markAssist 只记模型名 + 档位', () => {
    const a = markAssist({ player: false, advisor: false }, 'player', 'Claude · claude-sonnet-5-5', 'high');
    expect(a).toEqual({ player: true, advisor: false, model: 'claude-sonnet-5-5', effort: 'high' });
    markAssist(a, 'player', 'scripted-v1');
    expect(a.effort).toBeUndefined();
  });
});

describe('AI 辅助 / AI 参战上传：模型 + 档位，不外泄渠道', () => {
  const run = playRun({ ...OPTS, seed: 'effort-1', pure: false });

  it('让 AI 替我玩：档位入库、榜上显示；旧标签里的渠道被去掉', async () => {
    const r = await submitWorldRun(run.world, {
      wavesSurvived: run.result.wave,
      aiAssist: { player: true, advisor: false, model: '中转服务 · deepseek-flash', effort: 'high' },
    });
    expect(r.kind).toBe('ok');
    const row = db.sqlite.prepare('SELECT ai_model, ai_effort FROM runs').get() as Record<string, unknown>;
    expect(row).toEqual({ ai_model: 'deepseek-flash', ai_effort: 'high' });
    const lb = (await (
      await handleLeaderboard(new Request(`${ORIGIN}/api/leaderboard?board=endless`), deps)
    ).json()) as LeaderboardResponse;
    expect(lb.rows[0]).toMatchObject({ ai: true, aiModel: 'deepseek-flash', aiEffort: 'high' });
    expect(JSON.stringify(lb)).not.toContain('中转');
  });

  it('AI 参战：agent.effort 入库；接口不返回 provider；旧客户端的渠道只存库', async () => {
    const body = {
      nickname: '机器',
      deviceId: '00000000-0000-4000-8000-000000000009',
      board: 'endless',
      opts: run.opts,
      seed: run.opts.seed,
      log: await encodeLog(run.log),
      result: run.result,
      gameVersion: GAME_VERSION,
      agent: { provider: 'pi:relay', model: 'deepseek-flash', effort: 'medium', mode: 'pause', botShare: 0, decisions: 5 },
    };
    expect((await handleSubmit(post('/api/runs', body), deps)).status).toBe(201);
    const stored = db.sqlite.prepare('SELECT agent_provider, ai_effort FROM runs').get() as Record<string, unknown>;
    expect(stored).toEqual({ agent_provider: 'pi:relay', ai_effort: 'medium' });
    const lb = (await (
      await handleLeaderboard(new Request(`${ORIGIN}/api/leaderboard?board=endless`), deps)
    ).json()) as LeaderboardResponse;
    expect(lb.rows[0].agent).toEqual({ model: 'deepseek-flash', effort: 'medium', mode: 'pause', botShare: 0, botAssisted: false });
    expect(JSON.stringify(lb)).not.toContain('pi:relay');
  });

  it('旧数据（没有档位、模型名是界面标签）：不显示档位，模型名照样清洗', async () => {
    db.sqlite
      .prepare(
        `INSERT INTO runs (id, board, nickname, device_hash, score, wave, kills, lives, seed, map, difficulty, game_version,
          opts_json, result_json, log_gz, status, created_at, ip_hash, ai, ai_model)
         VALUES ('old1', 'endless', 'n', 'h', 10, 1, 0, 0, 's', 'ch1', 'normal', 'v', '{}', '{}', 'x', 'pending', 1, 'ip', 1, 'Claude · claude-sonnet-5-5')`,
      )
      .run();
    const lb = (await (
      await handleLeaderboard(new Request(`${ORIGIN}/api/leaderboard?board=endless`), deps)
    ).json()) as LeaderboardResponse;
    expect(lb.rows[0]).toMatchObject({ ai: true, aiModel: 'claude-sonnet-5-5' });
    expect(lb.rows[0]).not.toHaveProperty('aiEffort');
  });
});

describe('AI 对战榜', () => {
  it('对战日志里有出题；同样的日志走 /api/runs 被拒，走 /api/duels 被接受', async () => {
    expect(duelWorld.log.some((e) => e.cmd.type === 'overrideWave')).toBe(true);
    const b = await duelBody();
    const asRun = await handleSubmit(post('/api/runs', { ...b, board: 'endless', duel: undefined }), deps);
    expect(asRun.status).toBe(400);
    expect(((await asRun.json()) as { message: string }).message).toContain('未知指令');
    const res = await handleDuelSubmit(post('/api/duels', b), deps);
    expect(res.status).toBe(201);
    // 不混进三类榜
    const lb = (await (
      await handleLeaderboard(new Request(`${ORIGIN}/api/leaderboard?board=endless`), deps)
    ).json()) as LeaderboardResponse;
    expect(lb.total).toBe(0);
  });

  it('客户端 submitDuel → 对战榜显示双方模型 + 档位 + 波数；详情可回放、结果一致；不含渠道', async () => {
    const meta = duelMetaOf(
      {
        attack: side('pi:relay', 'https://relay.example.com/v1/deepseek-flash', 'high'),
        defend: side('claude-native', 'claude-sonnet-5-5', 'low'),
      },
      { plans: duelPlansOf(duelWorld.log).length },
    );
    expect(JSON.stringify(meta)).not.toMatch(/relay|claude-native|pi:/);
    const out = await submitDuel(duelWorld, { wavesSurvived: duelSurvived, duel: meta });
    expect(out.kind).toBe('ok');
    expect(out.kind === 'ok' && out.res).toMatchObject({ rank: 1, total: 1, improved: true });
    const board = await fetchDuelBoard({ around: true });
    expect(board.ok).toBe(true);
    const data = (board as { ok: true; data: DuelBoardResponse }).data;
    expect(data.rows[0]).toMatchObject({
      rank: 1,
      nickname: expect.any(String),
      attacker: { model: 'deepseek-flash', effort: 'high' },
      defender: { model: 'claude-sonnet-5-5', effort: 'low' },
      mode: 'endless',
      wave: duelSurvived,
      plans: duelWorld.log.filter((e) => e.cmd.type === 'overrideWave').length,
    });
    expect(data.me?.id).toBe(data.rows[0].id);
    expect(JSON.stringify(data)).not.toMatch(/relay|claude-native|pi:/);
    const stored = db.sqlite.prepare('SELECT duel_json FROM duel_runs').get() as { duel_json: string };
    expect(stored.duel_json).not.toMatch(/relay|claude-native|pi:/);
    // 详情 → 回放：同样的日志复现同样的结局
    const d = await fetchDuel(data.rows[0].id);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const w = createWorld({ ...d.data.opts, seed: d.data.seed });
    replaySync(w, { v: 1, opts: d.data.opts, tick: d.data.result.ticks, log: d.data.log, wave: d.data.result.wave, savedAt: 0 });
    expect(stateHash(w)).toBe(stateHash(duelWorld));
  });

  it('同一设备同一对阵组合只留最好的一条；换组合另算；排序按波数', async () => {
    expect((await handleDuelSubmit(post('/api/duels', await duelBody()), deps)).status).toBe(201);
    // 同组合再交一次（不更好）：不覆盖
    expect((await handleDuelSubmit(post('/api/duels', await duelBody()), deps)).status).toBe(200);
    // 换防守方档位：另一个组合
    const other = { ...DUEL, defender: { ...DUEL.defender, effort: 'high' as const } };
    expect((await handleDuelSubmit(post('/api/duels', await duelBody({ duel: other })), deps)).status).toBe(201);
    const res = (await (await handleDuelBoard(new Request(`${ORIGIN}/api/duels?limit=10`), deps)).json()) as DuelBoardResponse;
    expect(res.total).toBe(2);
    expect(res.rows.map((r) => r.defender.effort).sort()).toEqual(['high', 'low']);
  });

  it('拒绝：对战数据缺失 / 档位非法 / 模型只是地址 / 版本不符 / 出题过多', async () => {
    const bad = async (b: unknown) => (await handleDuelSubmit(post('/api/duels', b), deps)).status;
    const b = await duelBody();
    expect(await bad({ ...b, duel: undefined })).toBe(400);
    expect(await bad({ ...b, duel: { ...DUEL, attacker: { ...DUEL.attacker, effort: 'turbo' } } })).toBe(400);
    expect(await bad({ ...b, duel: { ...DUEL, defender: { ...DUEL.defender, model: 'https://relay.example.com/' } } })).toBe(400);
    expect(await bad({ ...b, gameVersion: '0.0.0+c0' })).toBe(409);
    expect(sanitizeDuelMeta({ attacker: DUEL.attacker }).ok).toBe(false);
    expect(sanitizeDuelMeta({ ...DUEL, plans: -1 }).ok).toBe(false);
    // 多余字段（例如渠道）直接丢掉
    const extra = sanitizeDuelMeta({ ...DUEL, attacker: { ...DUEL.attacker, provider: 'pi:relay', baseUrl: 'https://x' } });
    expect(extra.ok && JSON.stringify(extra.value)).not.toMatch(/relay|https/);
    // checkDuelSubmission 复用普通成绩的开局参数 / 得分校验
    expect(checkDuelSubmission({ ...b, opts: { ...b.opts, mode: 'custom' } }, { now: NOW }).ok).toBe(false);
    // checkLog：不允许出题时拒绝；出题次数超过波数 + 2 时拒绝
    const log = duelWorld.log.map((e) => ({ tick: e.tick, cmd: e.cmd }));
    const result = resultFromWorld(duelWorld.state, duelSurvived);
    expect(checkLog(log, result, b.opts).ok).toBe(false);
    expect(checkLog(log, result, b.opts, { allowOverride: true }).ok).toBe(true);
    const spam = Array.from({ length: result.wave + 3 }, () => ({ tick: 0, cmd: { type: 'overrideWave', wave: 1, plan: { groups: [] } } }));
    expect(checkLog([...spam, ...log], result, b.opts, { allowOverride: true }).ok).toBe(false);
  });
});

describe('AI 对战本地记录', () => {
  const rec = () =>
    duelRecordOf(
      {
        opts: duelWorld.state.opts,
        seed: duelWorld.state.seed,
        result: {
          wave: duelWorld.state.wave,
          wavesSurvived: duelSurvived,
          score: Math.round(duelWorld.state.score),
          kills: duelWorld.state.stats.kills,
          lives: duelWorld.state.lives,
          maxLives: duelWorld.state.maxLives,
          won: false,
          stars: 0,
          ticks: duelWorld.state.tick,
        },
        seconds: 42,
        attack: side('pi:relay', 'https://relay.example.com/v1/deepseek-flash', 'high'),
        defend: side('scripted', 'scripted-v1', 'low'),
        log: duelWorld.log,
      },
      NOW,
      'dtest',
    );

  it('完整数据存本地：双方模型 / 档位 / 用量 / 花费 / 错误 / 出题 / 回放；不含渠道', () => {
    const r = rec();
    expect(r.attacker).toMatchObject({
      model: 'deepseek-flash',
      effort: 'high',
      decisions: 10,
      fallback: 1,
      costUsd: 0.0123,
      errorCount: 1,
    });
    expect(r.defender).toMatchObject({ model: 'scripted-v1', scripted: true });
    expect(r.defender.effort).toBeUndefined();
    expect(r.plans.length).toBe(duelWorld.log.filter((e) => e.cmd.type === 'overrideWave').length);
    expect(r.plans[0].groups.length).toBeGreaterThan(0);
    expect(r.replay?.log.length).toBe(duelWorld.log.length);
    recordDuel(r, kv);
    expect(JSON.stringify(readDuels(kv))).not.toMatch(/relay|pi:/);
    const back = getDuel('dtest', kv);
    expect(back).toMatchObject({ id: 'dtest', seconds: 42, result: { wavesSurvived: duelSurvived } });
    // 本地回放与原局一致
    const w = createWorld({ ...back!.opts });
    replaySync(w, { v: 1, opts: back!.opts, tick: back!.replay!.tick, log: back!.replay!.log, wave: back!.result.wave, savedAt: 0 });
    expect(stateHash(w)).toBe(stateHash(duelWorld));
    noteDuelUpload('dtest', { rank: 3, total: 9 }, kv);
    expect(getDuel('dtest', kv)?.upload).toEqual({ rank: 3, total: 9 });
  });

  it('「我的记录」里的对战条目带双方模型 + 档位，指向完整记录', () => {
    const e = historyEntryOf(
      OPTS,
      {
        wave: 3,
        score: 100,
        won: false,
        ai: false,
        ranked: true,
        duel: { id: 'dtest', attacker: 'deepseek-flash', defender: 'claude-sonnet-5-5', atkEffort: 'high' },
      },
      NOW,
    );
    recordHistory(e, null, kv);
    expect(readHistory(null, kv)[0].duel).toEqual({
      id: 'dtest',
      attacker: 'deepseek-flash',
      defender: 'claude-sonnet-5-5',
      atkEffort: 'high',
    });
  });

  it('存储满时先丢旧记录的回放，再丢整条', () => {
    const limited: KV = {
      ...memoryStorage(),
      persistent: false,
    };
    const inner = memoryStorage();
    let cap = Infinity;
    limited.get = (k) => inner.get(k);
    limited.set = (k, v) => (v.length > cap ? false : inner.set(k, v));
    limited.remove = (k) => inner.remove(k);
    recordDuel({ ...rec(), id: 'a' }, limited);
    const one = (inner.get(DUELS_KEY) ?? '').length;
    cap = Math.floor(one * 1.5);
    recordDuel({ ...rec(), id: 'b' }, limited);
    const list = readDuels(limited);
    expect(list.map((d) => d.id)).toEqual(['b', 'a']);
    expect(list[0].replay).toBeDefined();
    expect(list[1].replay).toBeUndefined();
  });
});
