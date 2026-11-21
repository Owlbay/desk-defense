/// <reference types="@cloudflare/workers-types" />
/**
 * Pages Functions 的环境绑定（只被路由文件引用；测试直接构造 Deps）。
 * - DB：D1 绑定（wrangler.toml [[d1_databases]] 或 Pages 控制台 → 设置 → 绑定）
 * - HASH_SALT：哈希 IP / 设备 id 的盐（secret）。未设置时用开发用默认值——生产环境务必设置。
 * - TURNSTILE_SECRET / TURNSTILE_SITE_KEY：可选，设置后提交成绩必须带 Turnstile token。
 * - ACCEPT_GAME_VERSIONS：可选，逗号分隔，在 src/shared 的 GAME_VERSION 之外临时额外接受的客户端版本。
 * - REPLAY_VERIFY：'1' 时启用第二阶段服务端回放校验接口 POST /api/admin/verify（缺省关闭：需要 Workers 付费计划的 CPU 时间）。
 * - ADMIN_TOKEN：管理接口口令（secret，`wrangler pages secret put ADMIN_TOKEN`）；未设置时管理接口不可用。
 */
import { GAME_VERSION } from '../../src/shared/leaderboard';
import type { Deps } from './handlers';

export interface Env {
  DB?: D1Database;
  HASH_SALT?: string;
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  ACCEPT_GAME_VERSIONS?: string;
  REPLAY_VERIFY?: string;
  ADMIN_TOKEN?: string;
}

export const DEV_SALT = 'desk-defense-dev-salt';

export function depsFromEnv(env: Env): Deps {
  const versions = env.ACCEPT_GAME_VERSIONS?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    db: env.DB ?? null,
    now: () => Date.now(),
    salt: env.HASH_SALT || DEV_SALT,
    turnstileSecret: env.TURNSTILE_SECRET || undefined,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || undefined,
    acceptVersions: [GAME_VERSION, ...(versions ?? []).filter((v) => v !== GAME_VERSION)],
    fetch: (input, init) => fetch(input, init),
    replayVerify: env.REPLAY_VERIFY === '1',
    adminToken: env.ADMIN_TOKEN || undefined,
    cache: typeof caches !== 'undefined' ? (caches as unknown as { default: Cache }).default : null,
  };
}
