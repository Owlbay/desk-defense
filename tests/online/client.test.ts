import { beforeEach, describe, expect, it } from 'vitest';

import { type Deps, handleDaily, handleGetRun, handleLeaderboard, handleStatus, handleSubmit } from '../../functions/_lib/handlers';
import { apiError } from '../../functions/_lib/http';
import { createWorld } from '../../src/core';
import { replaySync } from '../../src/meta/midrun';
import {
  _resetOnlineForTests,
  configureOnline,
  DEVICE_KEY,
  fetchDaily,
  fetchLeaderboard,
  fetchRun,
  flushQueue,
  getDeviceId,
  getNickname,
  getOnlineState,
  initOnline,
  QUEUE_KEY,
  runToMidRun,
  setNickname,
  submitRun,
  submitWorldRun,
  subscribeOnline,
} from '../../src/meta/online';
import { type KV, memoryStorage } from '../../src/meta/storage';
import { boardForOpts, dailyInfo, isDeviceId } from '../../src/shared/leaderboard';
import { createFakeD1 } from './fakeD1';
import { playRun } from './helpers';

const ORIGIN = 'http://localhost:8788';
const NOW = Date.parse('2026-11-20T04:00:00Z');
const SKILLS = ['eraser_strike', 'bell', 'whiteout_zone'] as const;

let kv: KV;
let deps: Deps;
let mode: 'api' | 'down' | 'vite' = 'api';
let calls: string[] = [];

/** 把 fetch 直接路由到 handlers（相当于 wrangler pages dev，但不需要起进程） */
const routedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), ORIGIN);
  calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
  if (mode === 'down') throw new TypeError('Failed to fetch');
  if (mode === 'vite') return new Response('<!doctype html><title>dev</title>', { status: 200, headers: { 'Content-Type': 'text/html' } });
  const req = new Request(url, { ...init, headers: { ...(init?.headers as Record<string, string>), 'CF-Connecting-IP': '127.0.0.1' } });
  const p = url.pathname;
  if (p === '/api/runs') return handleSubmit(req, deps);
  if (p.startsWith('/api/runs/')) return handleGetRun(req, deps, p.slice('/api/runs/'.length));
  if (p === '/api/leaderboard') return handleLeaderboard(req, deps);
  if (p === '/api/daily') return handleDaily(req, deps);
  if (p === '/api/status') return handleStatus(req, deps);
  return apiError('not_found', '接口不存在');
}) as typeof fetch;

beforeEach(async () => {
  _resetOnlineForTests();
  kv = memoryStorage();
  mode = 'api';
  calls = [];
  deps = { db: await createFakeD1(), now: () => NOW, salt: 's' };
  configureOnline({ fetch: routedFetch, storage: kv, now: () => NOW });
});

const run = playRun({ mode: 'endless', map: 'ch1', difficulty: 'hard', seed: 'client-1', skills: [...SKILLS], autoWave: true });

describe('设备 id / 昵称', () => {
  it('设备 id 持久化，坏数据会重建', () => {
    const id = getDeviceId();
    expect(isDeviceId(id)).toBe(true);
    expect(getDeviceId()).toBe(id);
    kv.set(DEVICE_KEY, 'garbage');
    expect(getDeviceId()).not.toBe('garbage');
  });

  it('昵称校验后保存', () => {
    expect(getNickname()).toBe('');
    expect(setNickname('  橡皮擦 ').ok).toBe(true);
    expect(getNickname()).toBe('橡皮擦');
    expect(setNickname('管理员').ok).toBe(false);
    expect(getNickname()).toBe('橡皮擦');
  });
});

describe('在线状态', () => {
  it('API 正常：online，并拿到今日挑战', async () => {
    const seen: string[] = [];
    subscribeOnline((s) => seen.push(s.status));
    const s = await initOnline();
    expect(s.status).toBe('online');
    expect(s.daily).toEqual(dailyInfo('2026-11-20'));
    expect(seen).toContain('online');
  });

  it('vite dev（返回 HTML）：unavailable，不抛异常', async () => {
    mode = 'vite';
    const s = await initOnline();
    expect(s.status).toBe('unavailable');
    expect(s.message).toBe('在线功能不可用');
    const lb = await fetchLeaderboard('normal');
    expect(lb.ok).toBe(false);
    // 每日挑战可本地推算
    const d = await fetchDaily();
    expect(d).toMatchObject({ ok: true, source: 'local', data: dailyInfo('2026-11-20') });
  });

  it('数据库未绑定：unavailable', async () => {
    deps.db = null;
    expect((await initOnline()).status).toBe('unavailable');
  });

  it('断网：offline', async () => {
    mode = 'down';
    expect((await initOnline()).status).toBe('offline');
  });
});

describe('提交与离线队列', () => {
  it('在线提交 → 排行榜可见 → 回放与原局一致', async () => {
    setNickname('小明');
    const out = await submitRun({ opts: run.opts, log: run.log, result: run.result });
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.res).toMatchObject({ rank: 1, total: 1, improved: true });

    const lb = await fetchLeaderboard(boardForOpts(run.opts), { around: true });
    expect(lb.ok && lb.data.rows[0].nickname).toBe('小明');
    expect(lb.ok && lb.data.me?.rank).toBe(1);

    const r = await fetchRun(out.res.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = runToMidRun(r.data);
    const w = createWorld(m.opts);
    replaySync(w, m);
    expect(w.state.phase).toBe('lost');
    expect(w.state.score).toBe(run.result.score);
    expect(w.state.tick).toBe(run.result.ticks);
  });

  it('submitWorldRun 从 world 取结果', async () => {
    setNickname('小红');
    const out = await submitWorldRun(run.world, { wavesSurvived: run.result.wave });
    expect(out.kind).toBe('ok');
  });

  it('断网时进入队列，恢复后上传', async () => {
    setNickname('小明');
    mode = 'down';
    const out = await submitRun({ opts: run.opts, log: run.log, result: run.result });
    expect(out.kind).toBe('queued');
    expect(getOnlineState().pending).toBe(1);
    expect(JSON.parse(kv.get(QUEUE_KEY)!)).toHaveLength(1);

    mode = 'api';
    await initOnline(); // 下次启动
    expect(getOnlineState().pending).toBe(0);
    expect(kv.get(QUEUE_KEY)).toBeNull();
    const lb = await fetchLeaderboard(boardForOpts(run.opts));
    expect(lb.ok && lb.data.total).toBe(1);
  });

  it('服务端拒收的成绩不进队列', async () => {
    setNickname('小明');
    const out = await submitRun({ opts: run.opts, log: run.log, result: { ...run.result, score: run.result.score + 99999 } });
    expect(out).toMatchObject({ kind: 'rejected' });
    expect(getOnlineState().pending).toBe(0);
  });

  it('没有昵称时直接拒绝（不发请求）', async () => {
    const out = await submitRun({ opts: run.opts, log: run.log, result: run.result });
    expect(out).toEqual({ kind: 'rejected', message: '请填写昵称' });
    expect(calls).toEqual([]);
  });

  it('队列里坏掉的条目被丢弃，flush 不抛异常', async () => {
    kv.set(QUEUE_KEY, '{not json');
    expect(await flushQueue()).toBe(0);
  });
});
