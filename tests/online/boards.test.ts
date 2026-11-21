/**
 * 精简排行榜（文档 12 §3–§5）：
 *  - 三类榜：endless / daily:<日期> / campaign:<章节>；旧榜键（含 ai:）归一；
 *  - AI 辅助（AI 参战 / 让 AI 替我玩）进同一张榜、带标记；hideAi=1 隐藏；
 *  - 每台设备每个榜「真人最佳」「AI 辅助最佳」各一条，隐藏 AI 时真人成绩不会被 AI 成绩顶掉；
 *  - 战役榜按 评星 → 得分 排；
 *  - migrations/0003 把旧数据归一（在假 D1 上真跑一遍）。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { type Deps, handleGetRun, handleLeaderboard, handleSubmit, hashAiDevice, hashDevice } from '../../functions/_lib/handlers';
import type { RunOptions } from '../../src/core/types';
import { _resetOnlineForTests, buildSubmitBody, configureOnline } from '../../src/meta/online';
import { memoryStorage } from '../../src/meta/storage';
import { encodeLog } from '../../src/shared/codec';
import {
  agentBadge,
  type AgentMeta,
  type AiAssistMeta,
  boardForOpts,
  type ClaimedResult,
  computeScore,
  GAME_VERSION,
  type LeaderboardResponse,
  type LogEntry,
  type RunDetail,
  sanitizeAgentMeta,
  scoreMul,
  type SubmitBody,
  type SubmitResponse,
} from '../../src/shared/leaderboard';
import { applyMigration3, createFakeD1, type FakeD1 } from './fakeD1';
import { type PlayedRun, playRun } from './helpers';

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
function played(seed: string, extra: Partial<RunOptions> = {}): PlayedRun {
  const k = seed + JSON.stringify(extra);
  if (!cache.has(k))
    cache.set(k, playRun({ mode: 'endless', map: 'ch1', difficulty: 'normal', seed, skills: SKILLS, autoWave: true, ...extra }));
  return cache.get(k)!;
}

interface Sub {
  opts: RunOptions;
  log: LogEntry[];
  result: ClaimedResult;
}

async function body(
  run: Sub,
  o: { device?: number; board?: string; agent?: AgentMeta; aiAssist?: AiAssistMeta; nickname?: string } = {},
): Promise<SubmitBody> {
  return {
    nickname: o.nickname ?? '玩家',
    deviceId: dev(o.device ?? 1),
    board: o.board ?? boardForOpts(run.opts),
    opts: run.opts,
    seed: run.opts.seed!,
    log: await encodeLog(run.log),
    result: run.result,
    gameVersion: GAME_VERSION,
    ...(o.agent ? { agent: o.agent } : {}),
    ...(o.aiAssist ? { aiAssist: o.aiAssist } : {}),
  };
}

let ipN = 0;
const post = (b: unknown) =>
  new Request(`${ORIGIN}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `9.9.${(ipN >> 8) & 255}.${ipN++ & 255}`, Origin: ORIGIN },
    body: JSON.stringify(b),
  });
const get = (path: string) => new Request(`${ORIGIN}${path}`);
const lb = async (q: string): Promise<LeaderboardResponse> =>
  (await (await handleLeaderboard(get(`/api/leaderboard?${q}`), deps)).json()) as LeaderboardResponse;
const submit = async (b: SubmitBody): Promise<{ status: number; data: SubmitResponse }> => {
  const res = await handleSubmit(post(b), deps);
  return { status: res.status, data: (await res.json()) as SubmitResponse };
};

/** 构造一局战役结算（轻量校验只看算式与范围；日志一条开波） */
function campaignRun(map: RunOptions['map'], difficulty: 'normal' | 'hard', lives: number, maxLives: number, gold = 300): Sub {
  const r = { wave: 20, kills: 800, lives, gold, won: true, ticks: 60 * 60 * 25, cleared: 20, bonus: 0, maxLives };
  return {
    opts: { mode: 'campaign', map, difficulty, seed: `c-${map}-${difficulty}-${lives}-${gold}`, skills: SKILLS },
    log: [{ tick: 0, cmd: { type: 'startWave' } }],
    result: { ...r, score: computeScore(r, scoreMul(difficulty)) },
  };
}

let db: FakeD1;
let deps: Deps;

beforeEach(async () => {
  db = await createFakeD1();
  deps = { db, now: () => NOW, salt: 'test-salt' };
});

describe('AI 标记', () => {
  it('AgentMeta 校验与规范化', () => {
    expect(sanitizeAgentMeta(AGENT)).toEqual({ ok: true, value: AGENT });
    expect(sanitizeAgentMeta({ ...AGENT, provider: 'pi:ollama', model: 'qwen3:8b' }).ok).toBe(true);
    expect(sanitizeAgentMeta({ ...AGENT, provider: 'Bad Provider' }).ok).toBe(false);
    expect(sanitizeAgentMeta({ ...AGENT, model: 'a\nb' }).ok).toBe(false);
    expect(sanitizeAgentMeta({ ...AGENT, mode: 'turbo' }).ok).toBe(false);
    expect(sanitizeAgentMeta({ ...AGENT, botShare: 1.5 }).ok).toBe(false);
    expect(sanitizeAgentMeta({ ...AGENT, role: 'advisor' }).ok).toBe(false);
    const s = sanitizeAgentMeta({ ...AGENT, provider: 'scripted', model: 'scripted-v1', botShare: 0 });
    expect(s.ok && s.value.botShare).toBe(1);
    expect(agentBadge({ ...AGENT, botShare: 0.21 }).botAssisted).toBe(true);
  });
});

describe('POST /api/runs：AI 辅助进同一张榜', () => {
  it('AI 参战：入 endless 榜，带 AI 辅助 + 模型；回放详情也带', async () => {
    const run = played('ai-a');
    const { status, data } = await submit(await body(run, { agent: AGENT }));
    expect(status).toBe(201);
    const row = db.sqlite.prepare('SELECT * FROM runs WHERE id = ?').get(data.id) as Record<string, unknown>;
    expect(row).toMatchObject({
      board: 'endless',
      ai: 1,
      ai_model: 'claude-sonnet-5-5',
      agent_provider: 'claude-native',
      stars: 0,
      won: 0,
    });
    expect(row.device_hash).toBe(await hashAiDevice('test-salt', dev(1)));
    const all = await lb('board=endless');
    expect(all.rows[0]).toMatchObject({
      ai: true,
      aiModel: 'claude-sonnet-5-5',
      difficulty: 'normal',
      agent: { provider: 'claude-native' },
    });
    expect((await lb('board=endless&hideAi=1')).rows).toHaveLength(0);
    const d = (await (await handleGetRun(get(`/api/runs/${data.id}`), deps, data.id)).json()) as RunDetail;
    expect(d).toMatchObject({ board: 'endless', ai: true, aiModel: 'claude-sonnet-5-5' });
  });

  it('让 AI 替我玩：带标记（模型名可选）；旧客户端的 ai: 榜键也收', async () => {
    const run = played('ai-a');
    expect((await submit(await body(run, { aiAssist: { model: '离线演示' }, board: 'ai:normal:auto' }))).status).toBe(201);
    const r = (await lb('board=endless')).rows[0];
    expect(r).toMatchObject({ ai: true, aiModel: '离线演示' });
    expect(r.agent).toBeUndefined();
  });

  it('每台设备每榜：真人最佳与 AI 辅助最佳各一条；隐藏 AI 时真人成绩还在', async () => {
    const weak = played('w-1');
    const strong = played('s-1', { map: 'ch3', difficulty: 'hard' });
    const [lo, hi] = weak.result.score < strong.result.score ? [weak, strong] : [strong, weak];
    expect(lo.result.score).toBeLessThan(hi.result.score);
    await submit(await body(lo, { nickname: '真人' }));
    await submit(await body(hi, { aiAssist: {} }));
    // 再交一次更差的 AI 成绩：不覆盖
    expect((await submit(await body(lo, { aiAssist: {} }))).data.improved).toBe(false);
    const rows = db.sqlite.prepare('SELECT ai, score FROM runs ORDER BY ai').all() as { ai: number; score: number }[];
    expect(rows).toEqual([
      { ai: 0, score: lo.result.score },
      { ai: 1, score: hi.result.score },
    ]);
    const all = await lb(`board=endless&around=${dev(1)}`);
    expect(all.total).toBe(2);
    expect(all.me).toMatchObject({ ai: true, rank: 1, score: hi.result.score });
    const human = await lb(`board=endless&around=${dev(1)}&hideAi=1`);
    expect(human).toMatchObject({ total: 1, hideAi: true, me: { ai: false, rank: 1, score: lo.result.score } });
    expect(await hashDevice('test-salt', dev(1))).not.toBe(await hashAiDevice('test-salt', dev(1)));
  });

  it('无尽榜不分难度：困难 / 噩梦 / 魔境的成绩在同一张榜，按得分排，行上带难度', async () => {
    const a = played('mix-a', { difficulty: 'hard' });
    const b = played('mix-b', { difficulty: 'abyss', abyssLevel: 2, pure: true });
    const c = played('mix-c', { difficulty: 'easy', autoWave: false });
    await submit(await body(a, { device: 1 }));
    await submit(await body(b, { device: 2 }));
    await submit(await body(c, { device: 3 }));
    const r = await lb('board=endless');
    expect(r.total).toBe(3);
    expect(r.rows.map((x) => x.score)).toEqual([a, b, c].map((x) => x.result.score).sort((p, q) => q - p));
    expect(r.rows.find((x) => x.difficulty === 'abyss')).toMatchObject({ abyssLevel: 2 });
    // 旧链接的榜键归到同一张榜
    expect((await lb('board=hard:pure:auto')).total).toBe(3);
  });

  it('缓存按是否隐藏 AI 分开，新纪录时两份都清掉', async () => {
    const cacheMap = new Map<string, Response>();
    deps.cache = {
      match: async (k) => cacheMap.get(k)?.clone(),
      put: async (k, r) => void cacheMap.set(k, r.clone()),
      delete: async (k) => cacheMap.delete(k),
    };
    await lb('board=endless');
    await lb('board=endless&hideAi=1');
    expect(cacheMap.size).toBe(2);
    await submit(await body(played('ai-a'), { aiAssist: {} }));
    expect(cacheMap.size).toBe(0);
    expect((await lb('board=endless')).total).toBe(1);
    expect((await lb('board=endless&hideAi=1')).total).toBe(0);
  });
});

describe('战役榜', () => {
  it('按评星 → 得分排；普通 / 困难合并；失败也上榜（0 星）', async () => {
    const hard3 = campaignRun('ch1', 'hard', 19, 20);
    const normal3 = campaignRun('ch1', 'normal', 20, 20, 900);
    const hard1 = campaignRun('ch1', 'hard', 5, 20, 99_000); // 得分高但只有 1 星
    expect(hard1.result.score).toBeGreaterThan(hard3.result.score);
    await submit(await body(hard1, { device: 1, nickname: '一星' }));
    await submit(await body(normal3, { device: 2, nickname: '普通三星' }));
    await submit(await body(hard3, { device: 3, nickname: '困难三星' }));
    const lost = playRun({ mode: 'campaign', map: 'ch1', difficulty: 'normal', seed: 'camp-lost', skills: SKILLS });
    expect((await submit(await body(lost, { device: 4, nickname: '失败' }))).status).toBe(201);
    const r = await lb('board=campaign:ch1');
    expect(r.rows.map((x) => x.nickname)).toEqual(
      hard3.result.score > normal3.result.score ? ['困难三星', '普通三星', '一星', '失败'] : ['普通三星', '困难三星', '一星', '失败'],
    );
    expect(r.rows[0]).toMatchObject({ stars: 3, won: true });
    expect(r.rows[3]).toMatchObject({ stars: 0, won: false });
    expect((await lb('board=campaign:ch2')).total).toBe(0);
  });

  it('同一设备：更多星才覆盖（即使得分更低）', async () => {
    await submit(await body(campaignRun('ch2', 'hard', 5, 20, 99_000)));
    const better = await submit(await body(campaignRun('ch2', 'normal', 20, 20)));
    expect(better.data.improved).toBe(true);
    const worse = await submit(await body(campaignRun('ch2', 'hard', 6, 20, 99_000)));
    expect(worse.data.improved).toBe(false);
    expect((await lb('board=campaign:ch2')).rows).toMatchObject([{ stars: 3 }]);
  });
});

describe('客户端 buildSubmitBody', () => {
  it('榜键不再带 ai: 前缀；AI 参战带 agent、替我玩带 aiAssist', async () => {
    _resetOnlineForTests();
    configureOnline({ storage: memoryStorage(), now: () => NOW });
    const run = played('ai-a');
    const ai = await buildSubmitBody({ opts: run.opts, log: run.log, result: run.result, agent: AGENT });
    expect(ai.ok && ai.value).toMatchObject({ board: 'endless', agent: AGENT });
    const assist = await buildSubmitBody({ opts: run.opts, log: run.log, result: run.result, aiAssist: { model: 'x' } });
    expect(assist.ok && assist.value).toMatchObject({ board: 'endless', aiAssist: { model: 'x' } });
    const human = await buildSubmitBody({ opts: run.opts, log: run.log, result: run.result });
    expect(human.ok && 'agent' in human.value).toBe(false);
    expect(human.ok && 'aiAssist' in human.value).toBe(false);
    expect(human.ok && human.value.nickname).toMatch(/^玩家[0-9A-F]{4}$/);
    _resetOnlineForTests();
  });
});

describe('migrations/0003：旧数据归一', () => {
  it('旧无尽榜 / ai: 榜并入 endless，每个 device_hash 只留最好的一条；每日榜不动', async () => {
    const old = await createFakeD1({ upTo: 2 });
    const ins = old.sqlite.prepare(
      `INSERT INTO runs (id, board, day, nickname, device_hash, score, wave, kills, lives, seed, map, difficulty, game_version,
        opts_json, result_json, log_gz, status, created_at, ip_hash, agent_provider, agent_model)
       VALUES (?, ?, ?, 'n', ?, ?, 10, 0, 0, 's', 'ch1', 'normal', 'v', '{}', '{}', 'x', ?, ?, 'ip', ?, ?)`,
    );
    const add = (
      id: string,
      board: string,
      dev: string,
      score: number,
      o: { status?: string; at?: number; agent?: boolean; day?: string } = {},
    ) =>
      ins.run(
        id,
        board,
        o.day ?? null,
        dev,
        score,
        o.status ?? 'pending',
        o.at ?? 1,
        o.agent ? 'claude-native' : null,
        o.agent ? 'm1' : null,
      );
    add('a1', 'normal', 'devA', 100);
    add('a2', 'hard:pure:auto', 'devA', 300);
    add('a3', 'abyss3:auto', 'devA', 999, { status: 'rejected' });
    add('b1', 'normal:auto', 'devB', 50);
    add('b2', 'easy', 'devB', 50, { at: 0 }); // 同分同波，先提交者留下
    add('c1', 'ai:normal:auto', 'devAI', 500, { agent: true });
    add('c2', 'ai:hard', 'devAI', 400, { agent: true });
    add('d1', 'daily:2026-11-19', 'devA', 70, { day: '2026-11-19' });
    applyMigration3(old);
    const rows = old.sqlite.prepare('SELECT id, board, ai, ai_model, stars FROM runs ORDER BY id').all();
    expect(rows).toEqual([
      { id: 'a2', board: 'endless', ai: 0, ai_model: null, stars: 0 },
      { id: 'b2', board: 'endless', ai: 0, ai_model: null, stars: 0 },
      { id: 'c1', board: 'endless', ai: 1, ai_model: 'm1', stars: 0 },
      { id: 'd1', board: 'daily:2026-11-19', ai: 0, ai_model: null, stars: 0 },
    ]);
    // 迁移后的库照常可查（新索引 / 新列）
    const d: Deps = { db: old, now: () => NOW, salt: 's' };
    const res = (await (await handleLeaderboard(get('/api/leaderboard?board=endless'), d)).json()) as LeaderboardResponse;
    expect(res.rows.map((r) => r.id)).toEqual(['c1', 'a2', 'b2']);
    expect(res.rows[0]).toMatchObject({ ai: true, aiModel: 'm1', agent: { model: 'm1' } });
    const human = (await (await handleLeaderboard(get('/api/leaderboard?board=endless&hideAi=1'), d)).json()) as LeaderboardResponse;
    expect(human.rows.map((r) => r.id)).toEqual(['a2', 'b2']);
  });
});
