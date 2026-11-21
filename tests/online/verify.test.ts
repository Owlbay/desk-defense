/**
 * 第二阶段：服务端回放校验（src/shared/replay-verify.ts、functions/_lib/admin.ts、scripts/verify-runs.ts），
 * 以及兜底占比标记（docs/10 §18-6）与原生 App 壳的 CORS。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { handleAdminVerify } from '../../functions/_lib/admin';
import { type Deps, handleLeaderboard, handleSubmit } from '../../functions/_lib/handlers';
import { crossSiteRejection, withCors } from '../../functions/_lib/http';
import { rowsOf, verdictSql, verifyRows } from '../../scripts/verify-runs';
import { createWorld } from '../../src/core';
import type { RunOptions } from '../../src/core/types';
import { encodeLog } from '../../src/shared/codec';
import {
  type AgentMeta,
  type AiAssistMeta,
  boardForOpts,
  GAME_VERSION,
  type LeaderboardResponse,
  type SubmitBody,
  type SubmitResponse,
} from '../../src/shared/leaderboard';
import { verifyRun, verifyStoredRun } from '../../src/shared/replay-verify';
import { createFakeD1, type FakeD1 } from './fakeD1';
import { type PlayedRun, playRun } from './helpers';

const ORIGIN = 'https://desk-defense.pages.dev';
const NOW = Date.parse('2026-11-20T04:00:00Z');
const TOKEN = 'test-admin-token';
const SKILLS: RunOptions['skills'] = ['eraser_strike', 'bell', 'whiteout_zone'];
const dev = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const cache = new Map<string, PlayedRun>();
function played(seed: string): PlayedRun {
  if (!cache.has(seed))
    cache.set(seed, playRun({ mode: 'endless', map: 'ch2', difficulty: 'normal', seed, skills: SKILLS, autoWave: true }));
  return cache.get(seed)!;
}

const input = (r: PlayedRun) => ({ opts: r.opts, seed: r.opts.seed!, log: r.log, result: r.result });

/** 带造塔 / 升级 / 选增益的一局（手动开波，每个建造阶段花钱），直到失败或 maxTicks */
function playBuilt(seed: string, maxTicks = 60 * 60 * 12) {
  const opts: RunOptions = { mode: 'endless', map: 'ch1', difficulty: 'normal', seed, skills: SKILLS, autoWave: false };
  const w = createWorld(opts);
  const { cols, rows } = w.state.grid;
  const spend = () => {
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++) if (w.canPlace('pencil', x, y).ok) w.command({ type: 'place', tower: 'pencil', cx: x, cy: y });
    for (const t of w.state.towers.values()) w.command({ type: 'upgrade', uid: t.uid });
  };
  let n = 0;
  while (w.state.phase !== 'lost' && n < maxTicks) {
    if (w.state.phase === 'perk') {
      w.command({ type: 'choosePerk', id: w.state.perkChoices![0].id });
      continue;
    }
    if (w.state.phase === 'build') {
      spend();
      w.command({ type: 'startWave' });
    }
    w.step();
    if ((++n & 255) === 0) w.drainEvents();
  }
  const st = w.state;
  return {
    opts: { ...st.opts, seed: st.seed },
    seed: st.seed,
    log: w.log.map((e) => ({ tick: e.tick, cmd: e.cmd })),
    result: {
      wave: st.phase === 'lost' ? Math.max(0, st.wave - 1) : st.wave,
      score: Math.round(st.score),
      kills: st.stats.kills,
      lives: st.lives,
      gold: st.gold,
      won: false,
      ticks: st.tick,
    },
  };
}

describe('verifyRun（纯函数）', () => {
  it('真实对局 → verified，回放结果与声明一致', () => {
    const r = played('verify-a');
    const v = verifyRun(input(r));
    expect(v.status).toBe('verified');
    expect(v.replayed).toMatchObject({ ticks: r.result.ticks, kills: r.result.kills, lives: r.result.lives, phase: 'lost' });
  });

  it('造塔 / 升级 / 选增益的较长对局 → verified；删掉一条造塔指令 → rejected', () => {
    const r = playBuilt('verify-built', 60 * 60 * 4);
    expect(r.log.filter((e) => e.cmd.type === 'place').length).toBeGreaterThan(3);
    expect(r.result.kills).toBeGreaterThan(0);
    expect(verifyRun(r).status).toBe('verified');
    const i = r.log.findIndex((e) => e.cmd.type === 'place');
    expect(verifyRun({ ...r, log: r.log.filter((_, j) => j !== i) }).status).toBe('rejected');
  });

  it('篡改结算 → rejected（mismatch）', () => {
    const r = played('verify-a');
    for (const patch of [
      { score: Math.round(r.result.score) + 50 },
      { kills: r.result.kills + 1 },
      { wave: r.result.wave + 1 },
      { gold: r.result.gold + 10 },
    ]) {
      const v = verifyRun({ ...input(r), result: { ...r.result, ...patch } });
      expect(v.status, JSON.stringify(patch)).toBe('rejected');
      if (v.status === 'rejected') expect(v.code).toBe('mismatch');
    }
  });

  it('篡改日志 → rejected', () => {
    const r = played('verify-a');
    // 结束帧之后的指令
    const late = verifyRun({ ...input(r), log: [...r.log, { tick: r.result.ticks + 5, cmd: { type: 'startWave' } }] });
    expect(late).toMatchObject({ status: 'rejected', code: 'log_after_end' });
    // 帧号倒退
    const back = verifyRun({
      ...input(r),
      log: [
        { tick: 10, cmd: { type: 'startWave' } },
        { tick: 5, cmd: { type: 'startWave' } },
      ],
    });
    expect(back).toMatchObject({ status: 'rejected', code: 'log_order' });
    // 回放时执行失败的指令（客户端日志里只有成功的指令）
    const bogus = verifyRun({ ...input(r), log: [{ tick: 0, cmd: { type: 'sell', uid: 99999 } }, ...r.log] });
    expect(bogus).toMatchObject({ status: 'rejected', code: 'command_failed' });
    // 换种子：同一份日志打不出同样的结果
    const seed = verifyRun({ ...input(r), seed: 'other-seed' });
    expect(seed.status).toBe('rejected');
  });

  it('verifyStoredRun 解开存储格式（gzip 日志 + JSON 列）', async () => {
    const r = played('verify-a');
    const log = await encodeLog(r.log);
    const row = {
      seed: r.opts.seed!,
      opts_json: JSON.stringify(r.opts),
      result_json: JSON.stringify(r.result),
      log_gz: (log as { gz: string }).gz,
    };
    expect((await verifyStoredRun(row)).status).toBe('verified');
    expect(await verifyStoredRun({ ...row, log_gz: 'not-base64!!' })).toMatchObject({ status: 'rejected', code: 'bad_input' });
  });
});

// ───────────── 服务端：POST /api/admin/verify ─────────────

let db: FakeD1;
let deps: Deps;
let ip = 0;

beforeEach(async () => {
  db = await createFakeD1();
  deps = { db, now: () => NOW, salt: 'test-salt', replayVerify: true, adminToken: TOKEN };
});

async function submitBody(
  r: PlayedRun,
  o: { device?: number; result?: Partial<PlayedRun['result']>; agent?: AgentMeta; aiAssist?: AiAssistMeta } = {},
): Promise<SubmitBody> {
  return {
    nickname: '测试玩家',
    deviceId: dev(o.device ?? 1),
    board: boardForOpts(r.opts),
    opts: r.opts,
    seed: r.opts.seed!,
    log: await encodeLog(r.log),
    result: { ...r.result, ...(o.result ?? {}) },
    gameVersion: GAME_VERSION,
    ...(o.agent ? { agent: o.agent } : {}),
    ...(o.aiAssist ? { aiAssist: o.aiAssist } : {}),
  };
}

async function submit(b: SubmitBody): Promise<SubmitResponse> {
  const res = await handleSubmit(
    new Request(`${ORIGIN}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `10.0.0.${++ip % 250}`, Origin: ORIGIN },
      body: JSON.stringify(b),
    }),
    deps,
  );
  expect(res.status, await res.clone().text()).toBeLessThan(300);
  return (await res.json()) as SubmitResponse;
}

const adminReq = (o: { token?: string; limit?: number; method?: string } = {}) =>
  new Request(`${ORIGIN}/api/admin/verify${o.limit ? `?limit=${o.limit}` : ''}`, {
    method: o.method ?? 'POST',
    headers: o.token === undefined ? { 'X-Admin-Token': TOKEN } : o.token ? { 'X-Admin-Token': o.token } : {},
  });

const statusOf = (id: string) =>
  db.sqlite.prepare('SELECT status, reject_reason, verified_at FROM runs WHERE id = ?').get(id) as Record<string, unknown>;

async function board(b: string): Promise<LeaderboardResponse> {
  return (await (
    await handleLeaderboard(new Request(`${ORIGIN}/api/leaderboard?board=${b}&limit=10`), deps)
  ).json()) as LeaderboardResponse;
}

describe('POST /api/admin/verify', () => {
  it('缺省关闭（REPLAY_VERIFY ≠ 1 或没设 ADMIN_TOKEN）→ 404；口令错误 → 403', async () => {
    expect((await handleAdminVerify(adminReq(), { ...deps, replayVerify: false })).status).toBe(404);
    expect((await handleAdminVerify(adminReq(), { ...deps, adminToken: undefined })).status).toBe(404);
    expect((await handleAdminVerify(adminReq({ token: '' }), deps)).status).toBe(403);
    expect((await handleAdminVerify(adminReq({ token: 'wrong' }), deps)).status).toBe(403);
    expect((await handleAdminVerify(adminReq({ method: 'GET' }), deps)).status).toBe(405);
  });

  it('pending → verified / rejected；rejected 的成绩从榜上消失', async () => {
    const good = played('verify-a');
    const okRun = await submit(await submitBody(good, { device: 1 }));
    // 自洽地多报 1 次击杀（得分也跟着改，轻量校验挡不住），回放能识破
    const fake = await submit(
      await submitBody(good, { device: 2, result: { kills: good.result.kills + 1, score: Math.round(good.result.score) + 1 } }),
    );
    expect((await board('endless')).total).toBe(2);

    const res = await handleAdminVerify(adminReq({ limit: 10 }), deps);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      processed: number;
      verified: number;
      rejected: number;
      remaining: number;
      items: { id: string; status: string }[];
    };
    expect(data).toMatchObject({ processed: 2, verified: 1, rejected: 1, remaining: 0 });
    expect(statusOf(okRun.id)).toMatchObject({ status: 'verified', verified_at: NOW });
    expect(statusOf(fake.id).status).toBe('rejected');
    expect(String(statusOf(fake.id).reject_reason)).toMatch(/^mismatch: .*kills/);

    const lb = await board('endless');
    expect(lb.total).toBe(1);
    expect(lb.rows.map((r) => [r.id, r.status])).toEqual([[okRun.id, 'verified']]);

    // 再跑一次：没有 pending 了
    const again = (await (await handleAdminVerify(adminReq(), deps)).json()) as { processed: number };
    expect(again.processed).toBe(0);
  });

  it('limit 控制每次处理条数；其他版本的 pending 不处理', async () => {
    const r = played('verify-a');
    for (let d = 1; d <= 3; d++) await submit(await submitBody(r, { device: d }));
    db.sqlite.prepare(`UPDATE runs SET game_version = 'old' WHERE device_hash = (SELECT device_hash FROM runs ORDER BY id LIMIT 1)`).run();
    const a = (await (await handleAdminVerify(adminReq({ limit: 1 }), deps)).json()) as { processed: number; remaining: number };
    expect(a).toMatchObject({ processed: 1, remaining: 1 });
    const b = (await (await handleAdminVerify(adminReq({ limit: 50 }), deps)).json()) as { processed: number; remaining: number };
    expect(b).toMatchObject({ processed: 1, remaining: 0 });
    expect(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM runs WHERE status = 'pending'`).get()).toMatchObject({ n: 1 });
  });
});

describe('兜底占比标记（docs/10 §18-6）', () => {
  const agent = (provider: string, botShare: number): AgentMeta => ({ provider, model: 'm-1', mode: 'pause', botShare, decisions: 40 });

  it('> 20% 照常上榜但带 botHeavy；scripted / ≤ 20% / 真人不标', async () => {
    const r = played('verify-a');
    await submit(await submitBody(r, { device: 1, agent: agent('claude-native', 0.35) }));
    await submit(await submitBody(r, { device: 2, agent: agent('claude-native', 0.2) }));
    await submit(await submitBody(r, { device: 3, agent: agent('scripted', 0) }));
    await submit(await submitBody(r, { device: 4, aiAssist: { model: 'x', botShare: 0.5 } }));
    await submit(await submitBody(r, { device: 5, aiAssist: { model: 'x' } }));
    await submit(await submitBody(r, { device: 6 }));
    const lb = await board('endless');
    expect(lb.total).toBe(6);
    const heavy = lb.rows.filter((x) => x.botHeavy).map((x) => x.agent?.botShare ?? 'assist');
    expect(heavy.sort()).toEqual([0.35, 'assist']);
    const row = db.sqlite
      .prepare(`SELECT agent_bot_share, agent_provider FROM runs WHERE ai = 1 AND agent_provider IS NULL AND agent_bot_share IS NOT NULL`)
      .get();
    expect(row).toMatchObject({ agent_bot_share: 0.5, agent_provider: null });
  });

  it('aiAssist.botShare 越界 → 400', async () => {
    const r = played('verify-a');
    const res = await handleSubmit(
      new Request(`${ORIGIN}/api/runs`, {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '9.9.9.9' },
        body: JSON.stringify(await submitBody(r, { aiAssist: { botShare: 1.5 } })),
      }),
      deps,
    );
    expect(res.status).toBe(400);
  });
});

describe('scripts/verify-runs', () => {
  it('读取 wrangler --json 导出，生成只改 pending 的 SQL', async () => {
    const r = played('verify-a');
    const gz = ((await encodeLog(r.log)) as { gz: string }).gz;
    const base = { seed: r.opts.seed!, opts_json: JSON.stringify(r.opts), log_gz: gz, board: 'endless' };
    const exported = [
      {
        results: [
          { ...base, id: 'aaaaaaaa', result_json: JSON.stringify(r.result), game_version: GAME_VERSION },
          { ...base, id: 'bbbbbbbb', result_json: JSON.stringify({ ...r.result, lives: r.result.lives + 3 }), game_version: GAME_VERSION },
          { ...base, id: 'cccccccc', result_json: JSON.stringify(r.result), game_version: 'old' },
        ],
        success: true,
      },
    ];
    const rows = rowsOf(exported);
    expect(rows).toHaveLength(3);
    const vs = await verifyRows(rows);
    expect(vs.map((v) => v.status)).toEqual(['verified', 'rejected', 'skipped']);
    const sql = verdictSql(vs, 123);
    expect(sql.split('\n')).toHaveLength(2);
    expect(sql).toContain(`SET status = 'verified', reject_reason = NULL, verified_at = 123 WHERE id = 'aaaaaaaa' AND status = 'pending';`);
    expect(sql).toMatch(/status = 'rejected', reject_reason = 'mismatch: lives claimed \d+ replayed \d+', .*WHERE id = 'bbbbbbbb'/);
  });
});

describe('原生 App 壳 CORS', () => {
  it('允许的 App origin：预检 204 + CORS 头；普通请求放行并补头；其他跨站照旧 403', async () => {
    const pre = crossSiteRejection(new Request(`${ORIGIN}/api/runs`, { method: 'OPTIONS', headers: { Origin: 'capacitor://localhost' } }));
    expect(pre?.status).toBe(204);
    expect(pre?.headers.get('Access-Control-Allow-Origin')).toBe('capacitor://localhost');
    expect(pre?.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST');
    expect(pre?.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, Accept');
    for (const o of ['https://localhost', 'tauri://localhost', 'http://tauri.localhost']) {
      const req = new Request(`${ORIGIN}/api/daily`, { headers: { Origin: o, 'Sec-Fetch-Site': 'cross-site' } });
      expect(crossSiteRejection(req)).toBeNull();
      const res = withCors(req, new Response('{}'));
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe(o);
      expect(res.headers.get('Vary')).toBe('Origin');
    }
    const evil = new Request(`${ORIGIN}/api/daily`, { headers: { Origin: 'https://evil.example' } });
    expect(crossSiteRejection(evil)?.status).toBe(403);
    expect(withCors(evil, new Response('{}')).headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(
      crossSiteRejection(new Request(`${ORIGIN}/api/runs`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }))?.status,
    ).toBe(403);
  });
});
