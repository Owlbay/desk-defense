import { beforeEach, describe, expect, it } from 'vitest';

import { checkFeedback, type FeedbackRow, handleFeedback, HOUR_MS } from '../../functions/_lib/feedback';
import { type Deps, hashDevice, hashIp } from '../../functions/_lib/handlers';
import { MemoryRateLimitStore } from '../../functions/_lib/ratelimit';
import {
  charCount,
  cleanFeedbackText,
  cleanLine,
  FEEDBACK_CONTACT_MAX,
  FEEDBACK_HOURLY_MAX,
  FEEDBACK_RATE_LIMIT,
  FEEDBACK_TEXT_MAX,
  type FeedbackBody,
  type FeedbackResponse,
} from '../../src/shared/feedback';
import type { ApiError } from '../../src/shared/leaderboard';
import { createFakeD1, type FakeD1 } from './fakeD1';

const ORIGIN = 'https://desk-defense.pages.dev';
const NOW = Date.parse('2026-11-20T04:00:00Z');
const dev = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const ctx = { version: '0.3.4', locale: 'zh-CN', screen: '390x844@3', route: 'game/endless/ch2/normal', ua: 'Mozilla/5.0 Test' };
const fb = (o: Partial<FeedbackBody> = {}): FeedbackBody => ({ kind: 'bug', text: '第 3 波卡住了', deviceId: dev(1), context: ctx, ...o });

function post(b: unknown, ip = '1.2.3.4', headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, Origin: ORIGIN, 'User-Agent': 'HeaderUA/1.0', ...headers },
    body: typeof b === 'string' ? b : JSON.stringify(b),
  });
}

let db: FakeD1;
let now = NOW;
let n = 0;
let deps: Deps;

beforeEach(async () => {
  db = await createFakeD1();
  now = NOW;
  n = 0;
  deps = { db, rate: new MemoryRateLimitStore(), now: () => now, salt: 'test-salt', newId: () => `fb${String(++n).padStart(10, '0')}` };
});

const rows = () =>
  db.sqlite.prepare('SELECT * FROM feedback ORDER BY created_at, id').all() as unknown as (FeedbackRow & { status: string })[];

describe('POST /api/feedback', () => {
  it('stores a cleaned row and returns { ok, id }', async () => {
    const res = await handleFeedback(post(fb({ contact: '  qq 12345 \n', text: '  卡住了\r\n\r\n\r\n\r\n\r\n第二行\u200b  ' })), deps);
    expect(res.status).toBe(201);
    const data = (await res.json()) as FeedbackResponse;
    expect(data).toEqual({ ok: true, id: 'fb0000000001' });
    const [r] = rows();
    expect(r.kind).toBe('bug');
    expect(r.text).toBe('卡住了\n\n\n第二行');
    expect(r.contact).toBe('qq 12345');
    expect(r.app_version).toBe('0.3.4');
    expect(r.locale).toBe('zh-CN');
    expect(r.screen).toBe('390x844@3');
    expect(r.route).toBe('game/endless/ch2/normal');
    expect(r.user_agent).toBe('Mozilla/5.0 Test');
    expect(r.created_at).toBe(NOW);
    // 不存原始 IP / 设备 id，只存加盐哈希
    expect(r.ip_hash).toBe(await hashIp('test-salt', '1.2.3.4'));
    expect(r.device_hash).toBe(await hashDevice('test-salt', dev(1)));
    expect(JSON.stringify(r)).not.toContain('1.2.3.4');
    expect(JSON.stringify(r)).not.toContain(dev(1));
    expect(r.status).toBe('new');
  });

  it('optional fields: no contact → NULL, no device → NULL, UA falls back to the request header', async () => {
    const res = await handleFeedback(post({ kind: 'idea', text: '加个暂停快捷键', context: { ...ctx, ua: '' } }), deps);
    expect(res.status).toBe(201);
    const [r] = rows();
    expect(r.contact).toBeNull();
    expect(r.device_hash).toBeNull();
    expect(r.user_agent).toBe('HeaderUA/1.0');
    // context 缺失也能存（全部空串）
    const res2 = await handleFeedback(post({ kind: 'other', text: 'hi' }, '5.6.7.8', { 'User-Agent': '' }), deps);
    expect(res2.status).toBe(201);
    expect(rows()[1]).toMatchObject({ app_version: '', locale: '', screen: '', route: '', user_agent: '' });
  });

  it('clamps over-long fields', async () => {
    const long = '字'.repeat(FEEDBACK_TEXT_MAX + 50);
    const res = await handleFeedback(
      post(fb({ text: long, contact: 'x'.repeat(500), context: { ...ctx, ua: 'u'.repeat(2000), route: 'r'.repeat(500) } })),
      deps,
    );
    expect(res.status).toBe(201);
    const [r] = rows();
    expect(charCount(r.text)).toBe(FEEDBACK_TEXT_MAX);
    expect(r.contact).toHaveLength(FEEDBACK_CONTACT_MAX);
    expect(r.user_agent.length).toBeLessThanOrEqual(300);
    expect(r.route.length).toBeLessThanOrEqual(80);
  });

  it('rejects bad input', async () => {
    const bad = async (b: unknown) => {
      const res = await handleFeedback(post(b, `9.9.9.${++n}`), deps);
      expect(res.status, JSON.stringify(b)).toBe(400);
      return ((await res.json()) as ApiError).error;
    };
    expect(await bad('not json')).toBe('bad_request');
    expect(await bad([1, 2])).toBe('bad_request');
    expect(await bad(fb({ kind: 'spam' as 'bug' }))).toBe('bad_request');
    expect(await bad(fb({ text: '   \n\t ' }))).toBe('bad_request');
    expect(await bad(fb({ text: 123 as unknown as string }))).toBe('bad_request');
    expect(rows()).toHaveLength(0);
  });

  it('rejects oversized bodies, wrong method, missing DB', async () => {
    const big = await handleFeedback(post({ ...fb(), pad: 'x'.repeat(10_000) }), deps);
    expect(big.status).toBe(413);
    const get = await handleFeedback(new Request(`${ORIGIN}/api/feedback`), deps);
    expect(get.status).toBe(405);
    const none = await handleFeedback(post(fb()), { ...deps, db: null });
    expect(none.status).toBe(503);
  });

  it('rate-limits per IP and per device (fixed window, junk requests count too)', async () => {
    for (let i = 0; i < FEEDBACK_RATE_LIMIT.max; i++) expect((await handleFeedback(post(fb()), deps)).status).toBe(201);
    const res = await handleFeedback(post(fb()), deps);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    // 换 IP 但同一设备：仍然被限
    expect((await handleFeedback(post(fb(), '2.2.2.2'), deps)).status).toBe(429);
    // 同一 IP 换设备：IP 也已超限
    expect((await handleFeedback(post(fb({ deviceId: dev(2) })), deps)).status).toBe(429);
    // 别的 IP + 别的设备不受影响
    expect((await handleFeedback(post(fb({ deviceId: dev(3) }), '3.3.3.3'), deps)).status).toBe(201);
    // 垃圾请求也计数
    for (let i = 0; i < FEEDBACK_RATE_LIMIT.max; i++) await handleFeedback(post('garbage', '4.4.4.4'), deps);
    expect((await handleFeedback(post(fb({ deviceId: dev(4) }), '4.4.4.4'), deps)).status).toBe(429);
    // 下一个窗口恢复
    now += FEEDBACK_RATE_LIMIT.windowSec * 1000;
    expect((await handleFeedback(post(fb()), deps)).status).toBe(201);
  });

  it('caps stored feedback per hour (sliding window over the feedback table)', async () => {
    let sent = 0;
    while (sent < FEEDBACK_HOURLY_MAX) {
      expect((await handleFeedback(post(fb()), deps)).status).toBe(201);
      sent++;
      now += 4 * 60_000; // 每 10 分钟不超过 3 条：固定窗口不触发，只剩小时上限在起作用
    }
    const res = await handleFeedback(post(fb()), deps);
    expect(res.status).toBe(429);
    expect(((await res.json()) as ApiError).error).toBe('rate_limited');
    expect(rows()).toHaveLength(FEEDBACK_HOURLY_MAX);
    // 同一设备换 IP 也算
    expect((await handleFeedback(post(fb(), '8.8.8.8'), deps)).status).toBe(429);
    // 一小时后最早的那条滑出窗口
    now = NOW + HOUR_MS + 1;
    expect((await handleFeedback(post(fb()), deps)).status).toBe(201);
  });

  it('requires a Turnstile token when configured', async () => {
    const d: Deps = {
      ...deps,
      turnstileSecret: 'secret',
      fetch: (async (_u: unknown, init?: RequestInit) => {
        const token = (init?.body as FormData).get('response');
        return new Response(JSON.stringify({ success: token === 'good' }));
      }) as typeof fetch,
    };
    expect((await handleFeedback(post(fb()), d)).status).toBe(403);
    expect((await handleFeedback(post(fb({ turnstileToken: 'bad' }), '2.2.2.2'), d)).status).toBe(403);
    expect((await handleFeedback(post(fb({ turnstileToken: 'good', deviceId: dev(5) }), '3.3.3.3'), d)).status).toBe(201);
  });
});

describe('feedback validation helpers', () => {
  it('checkFeedback cleans every field', () => {
    const r = checkFeedback({ kind: 'other', text: 'a\u0000b', contact: 'me\n@x', deviceId: 'nope', context: { locale: 'en\tUS' } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.text).toBe('ab');
    expect(r.value.contact).toBe('me @x');
    expect(r.value.deviceId).toBeNull();
    expect(r.value.locale).toBe('en US');
    expect(checkFeedback(null).ok).toBe(false);
  });

  it('clamping keeps surrogate pairs intact', () => {
    expect(cleanFeedbackText('😀'.repeat(5), 3)).toBe('😀😀😀');
    expect(cleanLine('  a   b  ', 10)).toBe('a b');
    expect(charCount('😀a')).toBe(2);
  });
});
