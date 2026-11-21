/**
 * 第二阶段：服务端回放校验（docs/12 §5.2）。
 *
 *   POST /api/admin/verify?limit=5     头：X-Admin-Token: <ADMIN_TOKEN>（或 Authorization: Bearer <ADMIN_TOKEN>）
 *
 * 每次取最早的 limit 条（1..50，缺省 5）当前版本的 pending 成绩，用 src/shared/replay-verify 重放整局，
 * 写回 verified / rejected（+ reject_reason, verified_at），被判 rejected 的榜清边缘缓存（排行查询本来就排除 rejected）。
 *
 * 默认关闭：只有 env.REPLAY_VERIFY === '1' 才处理，否则 404。原因：免费计划每次请求约 10 ms CPU，
 * 一局几万帧的回放要几百 ms～几秒，只有 Workers 付费计划（单请求 CPU 30 s，可调到 5 min）跑得动。
 * 没设 ADMIN_TOKEN 时同样不可用。
 *
 * 回放模块（整个 core）用 dynamic import 惰性加载：即使它在运行时出问题，也不影响其他 /api 接口；
 * 关闭时完全不会执行 core 的代码。
 */
import { GAME_VERSION } from '../../src/shared/leaderboard';
import type { StoredRun, VerifyOptions, VerifyOutcome } from '../../src/shared/replay-verify';
// 与 replay-verify 的 rejectReasonText 相同；从那里静态 import 值会把整个 core 打进 Functions 包的启动路径，所以这里复写一份
const rejectReasonText = (v: Extract<VerifyOutcome, { status: 'rejected' }>): string => `${v.code}: ${v.reason}`.slice(0, 300);
import { RunStore } from './db';
import { type Deps, purgeBoardCache, sha256Hex } from './handlers';
import { apiError, json } from './http';

export const ADMIN_VERIFY_DEFAULT = 5;
export const ADMIN_VERIFY_MAX = 50;
/** 单次请求的墙钟预算：超过就不再取下一条（剩下的下次请求再处理） */
export const ADMIN_VERIFY_BUDGET_MS = 20_000;

export interface VerifyItem {
  id: string;
  board: string;
  status: 'verified' | 'rejected' | 'skipped';
  reason?: string;
  ms: number;
}

export interface AdminVerifyResponse {
  gameVersion: string;
  processed: number;
  verified: number;
  rejected: number;
  /** 还在排队的当前版本 pending 条数 */
  remaining: number;
  items: VerifyItem[];
}

export interface AdminDeps extends Deps {
  /** 测试注入；缺省 dynamic import src/shared/replay-verify */
  verifier?: (row: StoredRun, o?: VerifyOptions) => Promise<VerifyOutcome>;
}

/** 常数时间比较（先各自哈希，避免长度 / 前缀泄露） */
async function tokenMatches(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256Hex(`admin|${given}`), sha256Hex(`admin|${expected}`)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function tokenOf(req: Request): string {
  const h = req.headers.get('X-Admin-Token');
  if (h) return h.trim();
  const auth = req.headers.get('Authorization') ?? '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

async function loadVerifier(deps: AdminDeps): Promise<NonNullable<AdminDeps['verifier']>> {
  if (deps.verifier) return deps.verifier;
  const m = await import('../../src/shared/replay-verify');
  return m.verifyStoredRun;
}

export async function handleAdminVerify(req: Request, deps: AdminDeps): Promise<Response> {
  // 关闭时（缺省）与不存在的接口一样返回 404，不暴露管理接口
  if (!deps.replayVerify || !deps.adminToken) return apiError('not_found', '接口不存在');
  if (req.method !== 'POST') return apiError('method', '请求方式不支持');
  const given = tokenOf(req);
  if (!given || !(await tokenMatches(given, deps.adminToken))) return apiError('forbidden', '口令错误');
  if (!deps.db) return apiError('not_configured', '在线功能暂未开放（服务器未配置数据库）');

  const url = new URL(req.url);
  const raw = Number(url.searchParams.get('limit') ?? ADMIN_VERIFY_DEFAULT);
  const limit = Number.isFinite(raw) ? Math.max(1, Math.min(ADMIN_VERIFY_MAX, Math.floor(raw))) : ADMIN_VERIFY_DEFAULT;
  const gameVersion = (deps.acceptVersions ?? [GAME_VERSION])[0];

  const store = new RunStore(deps.db);
  const verify = await loadVerifier(deps);
  const rows = await store.pendingRuns(gameVersion, limit);
  const started = deps.now();
  const items: VerifyItem[] = [];
  const rejectedBoards = new Set<string>();
  for (const row of rows) {
    if (items.length > 0 && deps.now() - started > ADMIN_VERIFY_BUDGET_MS) break;
    const t0 = deps.now();
    const v = await verify(row);
    const reason = v.status === 'rejected' ? rejectReasonText(v) : null;
    const wrote = await store.setVerdict(row.id, v.status, reason, deps.now());
    const ms = deps.now() - t0;
    if (!wrote) {
      // 校验期间这条被同一设备的新纪录替换了
      items.push({ id: row.id, board: row.board, status: 'skipped', reason: 'replaced', ms });
      continue;
    }
    if (v.status === 'rejected') rejectedBoards.add(row.board);
    items.push({ id: row.id, board: row.board, status: v.status, ...(reason ? { reason } : {}), ms });
  }
  const origin = url.origin;
  await Promise.all([...rejectedBoards].map((b) => purgeBoardCache(deps, origin, b)));
  const body: AdminVerifyResponse = {
    gameVersion,
    processed: items.length,
    verified: items.filter((i) => i.status === 'verified').length,
    rejected: items.filter((i) => i.status === 'rejected').length,
    remaining: await store.pendingCount(gameVersion),
    items,
  };
  return json(body);
}
