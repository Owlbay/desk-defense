import { beforeEach, describe, expect, it } from 'vitest';

import { type Deps, handleDaily, handleGetRun, handleLeaderboard, handleStatus, handleSubmit } from '../../functions/_lib/handlers';
import { apiError } from '../../functions/_lib/http';
import { createWorld } from '../../src/core';
import { setLocale } from '../../src/i18n';
import { replaySync } from '../../src/meta/midrun';
import {
  _resetOnlineForTests,
  configureOnline,
  defaultNickname,
  DEVICE_KEY,
  fetchDaily,
  fetchLeaderboard,
  fetchRun,
  flushQueue,
  getAutoUpload,
  getCustomNickname,
  getDeviceId,
  getNickname,
  getOnlineState,
  initOnline,
  isDefaultNickname,
  QUEUE_KEY,
  runToMidRun,
  setAutoUpload,
  setNickname,
  submitRun,
  submitWorldRun,
  subscribeOnline,
} from '../../src/meta/online';
import { type KV, memoryStorage } from '../../src/meta/storage';
import { boardForOpts, dailyInfo, isDeviceId, sanitizeNickname } from '../../src/shared/leaderboard';
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

  it('没设过昵称时用默认昵称（本地化前缀 + 设备 id 前 4 位）', async () => {
    kv.set(DEVICE_KEY, '3f9a0000-1111-4222-8333-444455556666');
    expect(getCustomNickname()).toBe('');
    expect(isDefaultNickname()).toBe(true);
    expect(getNickname()).toBe('玩家3F9A');
    await setLocale('en');
    expect(getNickname()).toBe('Player3F9A');
    await setLocale('ja');
    expect(getNickname()).toBe('プレイヤー3F9A');
    await setLocale('zh-CN');
    // 任何设备 id 生成的默认昵称都能通过服务端校验
    for (const id of ['ffffffff-0000-4000-8000-000000000000', '5b000000-0000-4000-8000-000000000000', getDeviceId()])
      for (const prefix of ['玩家', 'Player', 'プレイヤー']) expect(sanitizeNickname(defaultNickname(id, prefix)).ok).toBe(true);
  });

  it('昵称校验后保存', () => {
    expect(setNickname('  橡皮擦 ').ok).toBe(true);
    expect(getNickname()).toBe('橡皮擦');
    expect(isDefaultNickname()).toBe(false);
    expect(setNickname('管理员').ok).toBe(false);
    expect(getNickname()).toBe('橡皮擦');
  });

  it('自动上传成绩：缺省开启，可以关掉', () => {
    expect(getAutoUpload()).toBe(true);
    setAutoUpload(false);
    expect(getAutoUpload()).toBe(false);
    setAutoUpload(true);
    expect(getAutoUpload()).toBe(true);
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

  it('没设昵称也能直接上传（默认昵称），不弹框', async () => {
    const out = await submitRun({ opts: run.opts, log: run.log, result: run.result });
    expect(out.kind).toBe('ok');
    const lb = await fetchLeaderboard('endless');
    expect(lb.ok && lb.data.rows[0].nickname).toBe(getNickname());
    expect(lb.ok && lb.data.rows[0].nickname).toMatch(/^玩家[0-9A-F]{4}$/);
  });

  it('昵称不合法时拒绝（不发请求）', async () => {
    const out = await submitRun({ opts: run.opts, log: run.log, result: run.result, nickname: '管理员' });
    expect(out).toMatchObject({ kind: 'rejected' });
    expect(calls).toEqual([]);
  });

  it('AI 辅助（替我玩）的对局照常上传、带标记；只用军师不带标记', async () => {
    const ai = await submitWorldRun(run.world, {
      wavesSurvived: run.result.wave,
      aiAssist: { player: true, advisor: false, model: '离线演示' },
    });
    expect(ai.kind).toBe('ok');
    const adv = await submitWorldRun(run.world, { wavesSurvived: run.result.wave, aiAssist: { player: false, advisor: true } });
    expect(adv.kind).toBe('ok');
    const all = await fetchLeaderboard('endless', { around: true });
    expect(all.ok && all.data.total).toBe(2);
    expect(all.ok && all.data.rows.map((r) => r.ai).sort()).toEqual([false, true]);
    expect(all.ok && all.data.rows.find((r) => r.ai)?.aiModel).toBe('离线演示');
    const human = await fetchLeaderboard('endless', { around: true, hideAi: true });
    expect(human.ok && human.data).toMatchObject({ total: 1, hideAi: true, me: { ai: false, rank: 1 } });
  });

  it('队列里坏掉的条目被丢弃，flush 不抛异常', async () => {
    kv.set(QUEUE_KEY, '{not json');
    expect(await flushQueue()).toBe(0);
  });
});
