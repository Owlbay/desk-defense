/**
 * 固定窗口限流：key（如 ip:<hash> / dev:<hash>）在 windowSec 秒的窗口内最多 max 次。
 * 存储抽象成 RateLimitStore，生产用 D1（rate_limits 表），测试可用内存实现。
 */
import type { D1Like } from './db';

export interface RateLimitStore {
  /** 计数 +1 并返回本窗口内的累计次数 */
  hit(key: string, windowStart: number): Promise<number>;
  /** 清理早于 before 的窗口（可选） */
  prune?(before: number): Promise<void>;
}

export interface RateLimitRule {
  max: number;
  windowSec: number;
}

export interface RateLimitResult {
  ok: boolean;
  /** 被限流时，距离窗口结束的秒数 */
  retryAfter: number;
  /** 触发限流的 key */
  key?: string;
}

export const windowStartOf = (nowMs: number, windowSec: number): number => Math.floor(nowMs / 1000 / windowSec) * windowSec;

/** 每个 key 都计数（不短路，避免换 key 绕过），任一超限即拒绝 */
export async function checkRateLimit(store: RateLimitStore, keys: string[], nowMs: number, rule: RateLimitRule): Promise<RateLimitResult> {
  const ws = windowStartOf(nowMs, rule.windowSec);
  let blocked: string | undefined;
  for (const k of keys) {
    const n = await store.hit(k, ws);
    if (n > rule.max && !blocked) blocked = k;
  }
  if (store.prune && hash01(nowMs) < 0.02) await store.prune(ws - rule.windowSec).catch(() => undefined);
  if (!blocked) return { ok: true, retryAfter: 0 };
  return { ok: false, retryAfter: Math.max(1, ws + rule.windowSec - Math.floor(nowMs / 1000)), key: blocked };
}

/** 低成本的伪随机（按时间），只用于决定是否顺手清理旧窗口 */
function hash01(n: number): number {
  const x = Math.sin(n % 100_000) * 10000;
  return x - Math.floor(x);
}

export class D1RateLimitStore implements RateLimitStore {
  constructor(private readonly db: D1Like) {}

  async hit(key: string, windowStart: number): Promise<number> {
    const r = await this.db
      .prepare(
        `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1) ` +
          `ON CONFLICT(key) DO UPDATE SET ` +
          `count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END, ` +
          `window_start = excluded.window_start ` +
          `RETURNING count`,
      )
      .bind(key, windowStart)
      .first<{ count: number }>();
    return Number(r?.count ?? 1);
  }

  async prune(before: number): Promise<void> {
    await this.db.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(before).run();
  }
}

export class MemoryRateLimitStore implements RateLimitStore {
  readonly rows = new Map<string, { windowStart: number; count: number }>();

  async hit(key: string, windowStart: number): Promise<number> {
    const r = this.rows.get(key);
    if (!r || r.windowStart !== windowStart) {
      this.rows.set(key, { windowStart, count: 1 });
      return 1;
    }
    r.count++;
    return r.count;
  }

  async prune(before: number): Promise<void> {
    for (const [k, v] of this.rows) if (v.windowStart < before) this.rows.delete(k);
  }
}
