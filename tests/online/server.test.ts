import { beforeEach, describe, expect, it } from 'vitest';
import {
  handleDaily,
  handleGetRun,
  handleLeaderboard,
  handleStatus,
  handleSubmit,
  hashDevice,
  leaderboardCacheKey,
  type CacheLike,
  type Deps,
} from '../../functions/_lib/handlers';
import { crossSiteRejection } from '../../functions/_lib/http';
import { checkRateLimit, D1RateLimitStore, MemoryRateLimitStore, windowStartOf } from '../../functions/_lib/ratelimit';
import { decodeLogPayload, encodeLog } from '../../src/shared/codec';
import {
  GAME_VERSION,
  RATE_LIMIT,
  boardForOpts,
  dailyInfo,
  dailyRunOptions,
  type ApiError,
  type LeaderboardResponse,
  type RunDetail,
  type StatusResponse,
  type SubmitBody,
  type SubmitResponse,
} from '../../src/shared/leaderboard';
import type { RunOptions } from '../../src/core/types';
import { createFakeD1, type FakeD1 } from './fakeD1';
import { playRun, type PlayedRun } from './helpers';

const ORIGIN = 'https://desk-defense.pages.dev';
const NOW = Date.parse('2026-11-20T04:00:00Z');
const SKILLS: RunOptions['skills'] = ['eraser_strike', 'bell', 'whiteout_zone'];
const dev = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const runs = new Map<string, PlayedRun>();
function played(seed: string, extra: Partial<RunOptions> = {}): PlayedRun {
  const k = seed + JSON.stringify(extra);
  if (!runs.has(k)) runs.set(k, playRun({ mode: 'endless', map: 'ch2', difficulty: 'normal', seed, skills: SKILLS, autoWave: true, ...extra }));
  return runs.get(k)!;
}

async function body(run: PlayedRun, o: { device?: number; nickname?: string; board?: string; gz?: boolean } = {}): Promise<SubmitBody> {
  return {
    nickname: o.nickname ?? '测试玩家',
    deviceId: dev(o.device ?? 1),
    board: o.board ?? boardForOpts(run.opts),
    opts: run.opts,
    seed: run.opts.seed!,
    log: o.gz === false ? run.log : await encodeLog(run.log),
    result: run.result,
    gameVersion: GAME_VERSION,
  };
}

function post(b: unknown, ip = '1.2.3.4', headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, Origin: ORIGIN, ...headers },
    body: JSON.stringify(b),
  });
}

const get = (path: string) => new Request(`${ORIGIN}${path}`);

class MapCache implements CacheLike {
  m = new Map<string, Response>();
  async match(k: string) {
    return this.m.get(k)?.clone();
  }
  async put(k: string, r: Response) {
    this.m.set(k, r.clone());
  }
  async delete(k: string) {
    return this.m.delete(k);
  }
}

let db: FakeD1;
let deps: Deps;
let now = NOW;

beforeEach(async () => {
  db = await createFakeD1();
  now = NOW;
  deps = { db, now: () => now, salt: 'test-salt', cache: new MapCache() };
});

describe('限流', () => {
  it('内存实现：固定窗口，任一 key 超限即拒绝', async () => {
    const s = new MemoryRateLimitStore();
    const rule = { max: 3, windowSec: 60 };
    const t = 1_000_000_000_000;
    for (let i = 0; i < 3; i++) expect((await checkRateLimit(s, ['ip:a', 'dev:x'], t, rule)).ok).toBe(true);
    const r = await checkRateLimit(s, ['ip:a', 'dev:y'], t, rule);
    expect(r).toMatchObject({ ok: false, key: 'ip:a' });
    expect(r.retryAfter).toBeGreaterThan(0);
    expect(r.retryAfter).toBeLessThanOrEqual(60);
    // 换 IP 但同一设备
    expect((await checkRateLimit(s, ['ip:b', 'dev:x'], t, rule)).ok).toBe(false);
    // 下一个窗口恢复
    expect((await checkRateLimit(s, ['ip:a', 'dev:x'], t + 60_000, rule)).ok).toBe(true);
    await s.prune(windowStartOf(t + 120_000, 60));
    expect(s.rows.size).toBe(0);
  });

  it('D1 实现（真实 SQL）', async () => {
    const s = new D1RateLimitStore(db);
    expect(await s.hit('k', 600)).toBe(1);
    expect(await s.hit('k', 600)).toBe(2);
    expect(await s.hit('k', 1200)).toBe(1);
    await s.prune(1300);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM rate_limits').get()).toEqual(expect.objectContaining({ n: 0 }));
  });
});

describe('POST /api/runs', () => {
  it('正常提交：入库 pending、返回名次；不存原始设备 id / IP', async () => {
    const run = played('seed-a');
    const res = await handleSubmit(post(await body(run)), deps);
    expect(res.status).toBe(201);
    const data = (await res.json()) as SubmitResponse;
    expect(data).toMatchObject({ rank: 1, total: 1, improved: true, status: 'pending' });
    const row = db.sqlite.prepare('SELECT * FROM runs WHERE id = ?').get(data.id) as Record<string, unknown>;
    expect(row.status).toBe('pending');
    expect(row.device_hash).toBe(await hashDevice('test-salt', dev(1)));
    expect(JSON.stringify(row)).not.toContain(dev(1));
    expect(JSON.stringify(row)).not.toContain('1.2.3.4');
    expect(row.game_version).toBe(GAME_VERSION);
  });

  it('未压缩日志也能提交（服务端压缩保存）', async () => {
    const run = played('seed-plain');
    const res = await handleSubmit(post(await body(run, { gz: false })), deps);
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as SubmitResponse;
    const detail = (await (await handleGetRun(get(`/api/runs/${id}`), deps, id)).json()) as RunDetail;
    expect((await decodeLogPayload({ gz: detail.logGz })).log).toEqual(run.log);
  });

  it('每台设备每榜只保留最佳成绩', async () => {
    const weak = played('seed-weak', { difficulty: 'normal' });
    const strong = played('seed-strong', { map: 'ch3' });
    const [lo, hi] = weak.result.score <= strong.result.score ? [weak, strong] : [strong, weak];
    expect(lo.result.score).toBeLessThan(hi.result.score);

    const r1 = (await (await handleSubmit(post(await body(lo, { nickname: '旧名' })), deps)).json()) as SubmitResponse;
    const r2 = (await (await handleSubmit(post(await body(hi)), deps)).json()) as SubmitResponse;
    expect(r2.improved).toBe(true);
    expect(r2.id).not.toBe(r1.id);
    const r3res = await handleSubmit(post(await body(lo, { nickname: '新名' })), deps);
    expect(r3res.status).toBe(200);
    const r3 = (await r3res.json()) as SubmitResponse;
    expect(r3).toMatchObject({ improved: false, id: r2.id, rank: 1, total: 1 });
    const rows = db.sqlite.prepare('SELECT nickname, score FROM runs').all() as { nickname: string; score: number }[];
    expect(rows).toEqual([{ nickname: '新名', score: hi.result.score }]);
    // 旧 id 已被替换
    expect((await handleGetRun(get(`/api/runs/${r1.id}`), deps, r1.id)).status).toBe(404);
  });

  it('多人排名', async () => {
    const run = played('seed-a');
    for (let i = 1; i <= 3; i++) await handleSubmit(post(await body(run, { device: i }), `10.0.0.${i}`), deps);
    const better = played('seed-strong', { map: 'ch3' });
    const worse = played('seed-weak');
    const [b, w] = better.result.score >= worse.result.score ? [better, worse] : [worse, better];
    const rb = (await (await handleSubmit(post(await body(b, { device: 9 }), '10.0.1.1'), deps)).json()) as SubmitResponse;
    const rw = (await (await handleSubmit(post(await body(w, { device: 8 }), '10.0.1.2'), deps)).json()) as SubmitResponse;
    expect(rb.total).toBe(4);
    expect(rw.total).toBe(5);
    expect(rb.rank).toBeLessThanOrEqual(rw.rank);
  });

  it.each([
    ['坏 JSON', () => new Request(`${ORIGIN}/api/runs`, { method: 'POST', body: '{', headers: { 'CF-Connecting-IP': '9.9.9.9' } }), 400, 'bad_request'],
    ['版本过旧', async () => post({ ...(await body(played('seed-a'))), gameVersion: '0.0.1+c0' }), 409, 'version'],
    ['得分作假', async () => {
      const b = await body(played('seed-a'));
      return post({ ...b, result: { ...b.result, score: b.result.score + 10_000 } });
    }, 400, 'bad_request'],
    ['日志损坏', async () => post({ ...(await body(played('seed-a'))), log: { gz: 'AAAA' } }), 400, 'bad_request'],
    ['游戏结束后还有指令', async () => {
      const r = played('seed-a');
      return post({ ...(await body(r)), log: [...r.log, { tick: r.result.ticks + 100, cmd: { type: 'startWave' } }] });
    }, 400, 'bad_request'],
    ['请求过大', () => post({ junk: 'x'.repeat(400_000) }), 413, 'too_large'],
  ])('%s', async (_n, mk, status, code) => {
    const res = await handleSubmit(await mk(), deps);
    expect(res.status).toBe(status);
    const e = (await res.json()) as ApiError;
    expect(e.error).toBe(code);
    expect(e.message).toMatch(/[一-鿿]/);
  });

  it('限流：同一设备 10 分钟 10 次', async () => {
    const run = played('seed-a');
    const b = await body(run);
    for (let i = 0; i < RATE_LIMIT.max; i++) expect((await handleSubmit(post(b, `10.1.0.${i}`), deps)).status).toBeLessThan(300);
    const res = await handleSubmit(post(b, '10.1.1.1'), deps);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    now += RATE_LIMIT.windowSec * 1000;
    expect((await handleSubmit(post(b, '10.1.1.1'), deps)).status).toBeLessThan(300);
  });

  it('限流：同一 IP 不同设备', async () => {
    const run = played('seed-a');
    for (let i = 0; i < RATE_LIMIT.max; i++) await handleSubmit(post(await body(run, { device: 100 + i })), deps);
    expect((await handleSubmit(post(await body(run, { device: 200 })), deps)).status).toBe(429);
  });

  it('Turnstile：配置了 secret 才校验', async () => {
    const run = played('seed-a');
    let calls = 0;
    const d: Deps = {
      ...deps,
      turnstileSecret: 'sec',
      fetch: (async (_u: unknown, init?: RequestInit) => {
        calls++;
        const token = (init?.body as FormData).get('response');
        return new Response(JSON.stringify({ success: token === 'good' }), { headers: { 'Content-Type': 'application/json' } });
      }) as typeof fetch,
    };
    expect((await handleSubmit(post(await body(run)), d)).status).toBe(403);
    expect((await handleSubmit(post({ ...(await body(run)), turnstileToken: 'bad' }), d)).status).toBe(403);
    expect((await handleSubmit(post({ ...(await body(run)), turnstileToken: 'good' }), d)).status).toBe(201);
    expect(calls).toBe(2);
  });

  it('每日挑战', async () => {
    const info = dailyInfo('2026-11-20');
    const run = playRun(dailyRunOptions(info, SKILLS));
    const res = await handleSubmit(post(await body(run, { board: info.board })), deps);
    expect(res.status).toBe(201);
    const row = db.sqlite.prepare('SELECT day, board, pure, auto_wave FROM runs').get() as Record<string, unknown>;
    expect(row).toMatchObject({ day: '2026-11-20', board: 'daily:2026-11-20', pure: 1, auto_wave: 1 });
    // 用每日种子刷普通榜：拒绝
    const res2 = await handleSubmit(post(await body(run, { board: boardForOpts(run.opts) })), deps);
    expect(res2.status).toBe(400);
  });

  it('没有绑定 D1 时返回 not_configured', async () => {
    const res = await handleSubmit(post({}), { ...deps, db: null });
    expect(res.status).toBe(503);
    expect(((await res.json()) as ApiError).error).toBe('not_configured');
  });
});

describe('GET /api/leaderboard', () => {
  it('前 N 名 + around + 缓存', async () => {
    const a = played('seed-a');
    for (let i = 1; i <= 5; i++) {
      now += 1000;
      await handleSubmit(post(await body(a, { device: i, nickname: `玩家${i}` }), `10.2.0.${i}`), deps);
    }
    const board = boardForOpts(a.opts);
    const res = await handleLeaderboard(get(`/api/leaderboard?board=${board}&limit=3`), deps);
    expect(res.headers.get('Cache-Control')).toContain('max-age=30');
    const lb = (await res.json()) as LeaderboardResponse;
    expect(lb.rows.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(lb.rows[0].nickname).toBe('玩家1'); // 同分同波先提交者在前
    expect(lb.total).toBe(5);
    expect(lb.me).toBeUndefined();
    expect(JSON.stringify(lb)).not.toContain('device');

    const res2 = await handleLeaderboard(get(`/api/leaderboard?board=${board}&limit=3&around=${dev(5)}`), deps);
    const lb2 = (await res2.json()) as LeaderboardResponse;
    expect(lb2.me).toMatchObject({ rank: 5, nickname: '玩家5' });
    expect(res2.headers.get('Cache-Control')).toContain('private');
    const none = (await (await handleLeaderboard(get(`/api/leaderboard?board=${board}&around=${dev(77)}`), deps)).json()) as LeaderboardResponse;
    expect(none.me).toBeNull();

    // 命中缓存时不查库
    const before = db.queries.length;
    await handleLeaderboard(get(`/api/leaderboard?board=${board}&limit=3`), deps);
    expect(db.queries.length).toBe(before);
    expect((deps.cache as MapCache).m.has(leaderboardCacheKey(ORIGIN, board, 10))).toBe(true);
  });

  it('提交新纪录后清掉该榜常用缓存', async () => {
    const a = played('seed-a');
    const board = boardForOpts(a.opts);
    await handleLeaderboard(get(`/api/leaderboard?board=${board}&limit=5`), deps);
    expect((deps.cache as MapCache).m.has(leaderboardCacheKey(ORIGIN, board, 10))).toBe(true);
    await handleSubmit(post(await body(a)), deps);
    expect((deps.cache as MapCache).m.has(leaderboardCacheKey(ORIGIN, board, 10))).toBe(false);
    const lb = (await (await handleLeaderboard(get(`/api/leaderboard?board=${board}&limit=5`), deps)).json()) as LeaderboardResponse;
    expect(lb.total).toBe(1);
  });

  it('参数错误', async () => {
    expect((await handleLeaderboard(get('/api/leaderboard?board=custom'), deps)).status).toBe(400);
    expect((await handleLeaderboard(get('/api/leaderboard?board=normal&around=xx'), deps)).status).toBe(400);
    const lb = (await (await handleLeaderboard(get('/api/leaderboard?board=normal&limit=9999'), deps)).json()) as LeaderboardResponse;
    expect(lb.rows).toEqual([]);
  });
});

describe('其它接口', () => {
  it('GET /api/runs/:id 返回可回放的数据', async () => {
    const run = played('seed-a');
    const { id } = (await (await handleSubmit(post(await body(run)), deps)).json()) as SubmitResponse;
    const d = (await (await handleGetRun(get(`/api/runs/${id}`), deps, id)).json()) as RunDetail;
    expect(d.opts).toEqual(run.opts);
    expect(d.seed).toBe(run.opts.seed);
    expect(d.result).toEqual(run.result);
    expect((await decodeLogPayload({ gz: d.logGz })).log).toEqual(run.log);
    expect((await handleGetRun(get('/api/runs/nope!'), deps, 'nope!')).status).toBe(404);
  });

  it('GET /api/daily 与 /api/status', async () => {
    const d = await handleDaily(get('/api/daily'), deps).json();
    expect(d).toEqual(dailyInfo('2026-11-20'));
    const s = (await handleStatus(get('/api/status'), deps).json()) as StatusResponse;
    expect(s).toMatchObject({ ok: true, gameVersion: GAME_VERSION, turnstileSiteKey: null });
  });

  it('同源限制', () => {
    expect(crossSiteRejection(post({}, '1.1.1.1', { Origin: 'https://evil.example' }))?.status).toBe(403);
    expect(crossSiteRejection(new Request(`${ORIGIN}/api/runs`, { method: 'OPTIONS' }))?.status).toBe(403);
    expect(crossSiteRejection(post({}))).toBeNull();
    expect(crossSiteRejection(get('/api/daily'))).toBeNull();
  });
});
