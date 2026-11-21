/**
 * AI 榜（文档 10 §13）：带 AI 标记的成绩只进 `ai:` 榜；真人榜拒收；榜上带模型 / 决策模式 / 兜底占比。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { handleGetRun, handleLeaderboard, handleSubmit, hashDevice, type Deps } from '../../functions/_lib/handlers';
import { encodeLog } from '../../src/shared/codec';
import {
  AI_BOARD_PREFIX,
  GAME_VERSION,
  agentBadge,
  aiEndlessBoardKey,
  boardForOpts,
  boardLabel,
  checkSubmission,
  dailyInfo,
  dailyRunOptions,
  dayOf,
  parseAiBoard,
  parseBoard,
  sanitizeAgentMeta,
  type AgentMeta,
  type ApiError,
  type LeaderboardResponse,
  type RunDetail,
  type SubmitBody,
  type SubmitResponse,
} from '../../src/shared/leaderboard';
import { buildSubmitBody, configureOnline, _resetOnlineForTests } from '../../src/meta/online';
import { aiBoardKey } from '../../src/agent/runner';
import type { RunOptions } from '../../src/core/types';
import { createFakeD1, type FakeD1 } from './fakeD1';
import { playRun, type PlayedRun } from './helpers';

const ORIGIN = 'https://desk-defense.pages.dev';
const NOW = Date.parse('2026-11-20T04:00:00Z');
const SKILLS: RunOptions['skills'] = ['eraser_strike', 'bell', 'whiteout_zone'];
const dev = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AGENT: AgentMeta = {
  provider: 'claude-native',
  model: 'claude-sonnet-5-5',
  mode: 'pause',
  botShare: 0.05,
  decisions: 40,
  tokens: 123456,
  costUsd: 0.42,
};

const cache = new Map<string, PlayedRun>();
function played(seed: string): PlayedRun {
  if (!cache.has(seed))
    cache.set(seed, playRun({ mode: 'endless', map: 'ch1', difficulty: 'normal', seed, skills: SKILLS, autoWave: true }));
  return cache.get(seed)!;
}

async function body(run: PlayedRun, o: { device?: number; board?: string; agent?: unknown; nickname?: string } = {}): Promise<SubmitBody> {
  return {
    nickname: o.nickname ?? '模型主人',
    deviceId: dev(o.device ?? 1),
    board: o.board ?? AI_BOARD_PREFIX + boardForOpts(run.opts),
    opts: run.opts,
    seed: run.opts.seed!,
    log: await encodeLog(run.log),
    result: run.result,
    gameVersion: GAME_VERSION,
    ...('agent' in o ? (o.agent === undefined ? {} : { agent: o.agent as AgentMeta }) : { agent: AGENT }),
  };
}

const post = (b: unknown, ip = '9.9.9.9') =>
  new Request(`${ORIGIN}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, Origin: ORIGIN },
    body: JSON.stringify(b),
  });
const get = (path: string) => new Request(`${ORIGIN}${path}`);

let db: FakeD1;
let deps: Deps;

beforeEach(async () => {
  db = await createFakeD1();
  deps = { db, now: () => NOW, salt: 'test-salt' };
});

describe('AI 榜键', () => {
  it('ai: 前缀只对无尽榜有效，真人 parseBoard 不认', () => {
    expect(parseBoard('ai:normal:auto')).toBeNull();
    expect(parseAiBoard('ai:normal:auto')).toEqual({ kind: 'endless', difficulty: 'normal', pure: false, auto: true });
    expect(parseAiBoard('ai:abyss10:pure:auto')).toMatchObject({ difficulty: 'abyss', abyssLevel: 10, pure: true });
    expect(parseAiBoard('normal:auto')).toBeNull();
    expect(parseAiBoard('ai:daily:2026-11-20')).toBeNull();
    expect(parseAiBoard('ai:ai:normal')).toBeNull();
    expect(aiEndlessBoardKey('hard', undefined, true, false)).toBe('ai:hard:pure');
    expect(boardLabel('ai:normal:auto')).toBe('AI 榜 · 普通 · 自动开波');
  });

  it('与 agent 模块的 aiBoardKey 一致', () => {
    const opts: RunOptions = { mode: 'endless', map: 'ch1', difficulty: 'nightmare', skills: [], pure: true, autoWave: false, seed: 'x' };
    expect(aiBoardKey(opts)).toBe(AI_BOARD_PREFIX + boardForOpts(opts));
    expect(parseAiBoard(aiBoardKey(opts))).not.toBeNull();
  });

  it('AI 标记校验与规范化', () => {
    expect(sanitizeAgentMeta(AGENT)).toEqual({ ok: true, value: AGENT });
    expect(sanitizeAgentMeta({ ...AGENT, provider: 'pi:ollama', model: 'qwen3:8b' }).ok).toBe(true);
    expect(sanitizeAgentMeta({ ...AGENT, provider: 'Bad Provider' }).ok).toBe(false);
    expect(sanitizeAgentMeta({ ...AGENT, model: 'a\nb' }).ok).toBe(false);
    expect(sanitizeAgentMeta({ ...AGENT, model: 'x'.repeat(81) }).ok).toBe(false);
    expect(sanitizeAgentMeta({ ...AGENT, mode: 'turbo' }).ok).toBe(false);
    expect(sanitizeAgentMeta({ ...AGENT, botShare: 1.5 }).ok).toBe(false);
    expect(sanitizeAgentMeta({ ...AGENT, decisions: -1 }).ok).toBe(false);
    expect(sanitizeAgentMeta({ ...AGENT, role: 'advisor' }).ok).toBe(false);
    expect(sanitizeAgentMeta(null).ok).toBe(false);
    // 内置策略本身就是机器人
    const s = sanitizeAgentMeta({ ...AGENT, provider: 'scripted', model: 'scripted-v1', botShare: 0 });
    expect(s.ok && s.value.botShare).toBe(1);
    expect(agentBadge({ ...AGENT, botShare: 0.2 }).botAssisted).toBe(false);
    expect(agentBadge({ ...AGENT, botShare: 0.21 }).botAssisted).toBe(true);
  });
});

describe('checkSubmission：AI 与真人隔离', () => {
  it('带 AI 标记的成绩不能进真人榜；没有标记的不能进 AI 榜', async () => {
    const run = played('ai-iso');
    const human = boardForOpts(run.opts);
    const r1 = checkSubmission(await body(run, { board: human }), { now: NOW });
    expect(r1).toEqual({ ok: false, message: 'AI 对局的成绩只能提交到 AI 榜' });
    const r2 = checkSubmission(await body(run, { agent: undefined }), { now: NOW });
    expect(r2).toEqual({ ok: false, message: 'AI 榜只接受带 AI 标记的成绩' });
    const r3 = checkSubmission(await body(run), { now: NOW });
    expect(r3.ok && r3.value.agent).toEqual(AGENT);
    expect(r3.ok && r3.value.parsedBoard).toMatchObject({ kind: 'endless', difficulty: 'normal', auto: true });
    // 真人提交不受影响，agent 为 null
    const r4 = checkSubmission(await body(run, { board: human, agent: undefined }), { now: NOW });
    expect(r4.ok && r4.value.agent).toBeNull();
  });

  it('AI 榜键必须与开局参数一致；每日挑战没有 AI 榜', async () => {
    const run = played('ai-iso');
    expect(checkSubmission(await body(run, { board: 'ai:hard:auto' }), { now: NOW })).toMatchObject({
      ok: false,
      message: '排行榜与开局参数不一致',
    });
    expect(checkSubmission(await body(run, { board: 'ai:nope' }), { now: NOW })).toMatchObject({ ok: false, message: '排行榜不存在' });
    const info = dailyInfo(dayOf(NOW));
    const daily = playRun(dailyRunOptions(info, SKILLS), 60 * 60 * 3);
    expect(checkSubmission(await body(daily, { board: info.board }), { now: NOW })).toMatchObject({
      ok: false,
      message: 'AI 对局的成绩只能提交到 AI 榜',
    });
    expect(checkSubmission(await body(daily, { board: `ai:${info.board}` }), { now: NOW })).toMatchObject({
      ok: false,
      message: '排行榜不存在',
    });
    expect(checkSubmission(await body(run, { agent: { ...AGENT, mode: 'x' } }), { now: NOW }).ok).toBe(false);
  });
});

describe('POST /api/runs → AI 榜', () => {
  it('入库带模型信息；真人榜看不到；AI 榜带徽章', async () => {
    const run = played('ai-a');
    const res = await handleSubmit(post(await body(run)), deps);
    expect(res.status).toBe(201);
    const data = (await res.json()) as SubmitResponse;
    expect(data).toMatchObject({ rank: 1, total: 1, improved: true });
    const row = db.sqlite.prepare('SELECT * FROM runs WHERE id = ?').get(data.id) as Record<string, unknown>;
    expect(row).toMatchObject({
      board: 'ai:normal:auto',
      agent_provider: 'claude-native',
      agent_model: 'claude-sonnet-5-5',
      agent_mode: 'pause',
      agent_bot_share: 0.05,
    });
    expect(JSON.parse(row.agent_json as string)).toEqual(AGENT);
    // 去重键不是真人榜用的设备哈希
    expect(row.device_hash).not.toBe(await hashDevice('test-salt', dev(1)));

    const human = (await (await handleLeaderboard(get('/api/leaderboard?board=normal:auto'), deps)).json()) as LeaderboardResponse;
    expect(human.rows).toHaveLength(0);
    const ai = (await (await handleLeaderboard(get('/api/leaderboard?board=ai:normal:auto'), deps)).json()) as LeaderboardResponse;
    expect(ai.rows).toHaveLength(1);
    expect(ai.rows[0].agent).toEqual({
      provider: 'claude-native',
      model: 'claude-sonnet-5-5',
      mode: 'pause',
      botShare: 0.05,
      botAssisted: false,
    });

    const d = (await (await handleGetRun(get(`/api/runs/${data.id}`), deps, data.id)).json()) as RunDetail;
    expect(d.board).toBe('ai:normal:auto');
    expect(d.agent?.model).toBe('claude-sonnet-5-5');
  });

  it('真人成绩不带徽章，也不会出现在 AI 榜', async () => {
    const run = played('ai-a');
    const res = await handleSubmit(post(await body(run, { board: boardForOpts(run.opts), agent: undefined })), deps);
    expect(res.status).toBe(201);
    const human = (await (await handleLeaderboard(get('/api/leaderboard?board=normal:auto'), deps)).json()) as LeaderboardResponse;
    expect(human.rows).toHaveLength(1);
    expect(human.rows[0].agent).toBeUndefined();
    const ai = (await (await handleLeaderboard(get('/api/leaderboard?board=ai:normal:auto'), deps)).json()) as LeaderboardResponse;
    expect(ai.rows).toHaveLength(0);
  });

  it('真人榜拒收带 AI 标记的成绩（HTTP 层）', async () => {
    const run = played('ai-a');
    const res = await handleSubmit(post(await body(run, { board: boardForOpts(run.opts) })), deps);
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiError).message).toBe('AI 对局的成绩只能提交到 AI 榜');
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM runs').get()).toMatchObject({ n: 0 });
  });

  it('同一设备：每个模型各保留一条；同模型只留最佳', async () => {
    const a = played('ai-a');
    const b = played('ai-b');
    await handleSubmit(post(await body(a)), deps);
    await handleSubmit(post(await body(b)), deps);
    await handleSubmit(post(await body(a, { agent: { ...AGENT, provider: 'pi:ollama', model: 'qwen3:8b', botShare: 0.5 } })), deps);
    const ai = (await (
      await handleLeaderboard(get(`/api/leaderboard?board=ai:normal:auto&around=${dev(1)}`), deps)
    ).json()) as LeaderboardResponse;
    expect(ai.total).toBe(2);
    expect(ai.me).toBeNull();
    const models = ai.rows.map((r) => r.agent?.model).sort();
    expect(models).toEqual(['claude-sonnet-5-5', 'qwen3:8b']);
    const local = ai.rows.find((r) => r.agent?.model === 'qwen3:8b')!;
    expect(local.agent).toMatchObject({ provider: 'pi:ollama', botShare: 0.5, botAssisted: true });
  });

  it('内置策略（scripted）标注为机器人代打', async () => {
    const run = played('ai-a');
    await handleSubmit(
      post(await body(run, { agent: { provider: 'scripted', model: 'scripted-v1', mode: 'pause', botShare: 0, decisions: 12 } })),
      deps,
    );
    const ai = (await (await handleLeaderboard(get('/api/leaderboard?board=ai:normal:auto'), deps)).json()) as LeaderboardResponse;
    expect(ai.rows[0].agent).toMatchObject({ provider: 'scripted', botShare: 1, botAssisted: true });
  });

  it('不存在的 AI 榜', async () => {
    expect((await handleLeaderboard(get('/api/leaderboard?board=ai:nope'), deps)).status).toBe(400);
    expect((await handleLeaderboard(get('/api/leaderboard?board=ai:daily:2026-11-20'), deps)).status).toBe(400);
  });
});

describe('客户端 buildSubmitBody', () => {
  it('带 agent 时榜键加 ai: 前缀并附带标记；不带时不变', async () => {
    _resetOnlineForTests();
    const mem = new Map<string, string>();
    configureOnline({
      storage: {
        get: (k: string) => mem.get(k) ?? null,
        set: (k: string, v: string) => (mem.set(k, v), true),
        remove: (k: string) => void mem.delete(k),
        persistent: true,
      },
      now: () => NOW,
    });
    const run = played('ai-a');
    const ai = await buildSubmitBody({ opts: run.opts, log: run.log, result: run.result, nickname: '主人', agent: AGENT });
    expect(ai.ok && ai.value.board).toBe('ai:normal:auto');
    expect(ai.ok && ai.value.agent).toEqual(AGENT);
    expect(ai.ok && checkSubmission(ai.value, { now: NOW }).ok).toBe(true);
    const human = await buildSubmitBody({ opts: run.opts, log: run.log, result: run.result, nickname: '主人' });
    expect(human.ok && human.value.board).toBe('normal:auto');
    expect(human.ok && 'agent' in human.value).toBe(false);
    _resetOnlineForTests();
  });
});
