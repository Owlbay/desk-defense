/**
 * 书桌防线 · 排行榜第二阶段：离线回放校验（docs/12 §5.2）
 *
 * 不需要付费计划：把 D1 里的 pending 成绩导出成 JSON，在本机用与 POST /api/admin/verify 相同的
 * src/shared/replay-verify 重放，输出结论和一份 SQL（再由你决定是否执行）。
 *
 * 用法：
 *   # 1. 导出（本地 D1；线上把 --local 换成 --remote，由负责人执行）
 *   npx wrangler@4 d1 execute desk-defense --local --json \
 *     --command "SELECT id, board, seed, opts_json, result_json, log_gz, game_version FROM runs WHERE status = 'pending'" > pending.json
 *   # 2. 校验，生成 SQL
 *   npx vite-node scripts/verify-runs.ts -- pending.json --sql verdicts.sql [--limit 100] [--any-version] [--quiet]
 *   # 3. 应用
 *   npx wrangler@4 d1 execute desk-defense --local --file verdicts.sql
 *
 * 输入：wrangler `--json` 的输出（[{ results: [...] }]）或者直接是行数组。
 * 缺省只校验 game_version 与当前 GAME_VERSION 一致的行（回放用的是当前代码），其他行跳过、保持 pending。
 * 退出码：0 = 全部通过；2 = 有 rejected；1 = 用法 / 输入错误。
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { GAME_VERSION } from '../src/shared/leaderboard';
import { rejectReasonText, type StoredRun, verifyStoredRun } from '../src/shared/replay-verify';

export interface ExportRow extends StoredRun {
  id: string;
  board?: string;
  game_version?: string;
}

export interface Verdict {
  id: string;
  board: string;
  status: 'verified' | 'rejected' | 'skipped';
  reason?: string;
  ms: number;
}

/** wrangler d1 execute --json 的输出或行数组 → 行 */
export function rowsOf(data: unknown): ExportRow[] {
  const arr = Array.isArray(data) ? data : [data];
  const rows: unknown[] = arr.flatMap((x) =>
    x && typeof x === 'object' && Array.isArray((x as { results?: unknown }).results) ? (x as { results: unknown[] }).results : [x],
  );
  return rows.filter(
    (r): r is ExportRow =>
      !!r &&
      typeof r === 'object' &&
      typeof (r as ExportRow).id === 'string' &&
      typeof (r as ExportRow).log_gz === 'string' &&
      typeof (r as ExportRow).opts_json === 'string',
  );
}

export async function verifyRows(rows: ExportRow[], o: { anyVersion?: boolean; limit?: number } = {}): Promise<Verdict[]> {
  const out: Verdict[] = [];
  for (const r of rows.slice(0, o.limit ?? rows.length)) {
    const board = r.board ?? '?';
    if (!o.anyVersion && r.game_version !== undefined && r.game_version !== GAME_VERSION) {
      out.push({ id: r.id, board, status: 'skipped', reason: `version ${r.game_version}`, ms: 0 });
      continue;
    }
    const t0 = performance.now();
    const v = await verifyStoredRun(r);
    const ms = Math.round(performance.now() - t0);
    out.push(
      v.status === 'verified'
        ? { id: r.id, board, status: 'verified', ms }
        : { id: r.id, board, status: 'rejected', reason: rejectReasonText(v), ms },
    );
  }
  return out;
}

const sqlStr = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** 只改仍是 pending 的同一条（与 RunStore.setVerdict 相同语义） */
export function verdictSql(vs: readonly Verdict[], now: number): string {
  return vs
    .filter((v) => v.status !== 'skipped')
    .map(
      (v) =>
        `UPDATE runs SET status = ${sqlStr(v.status)}, reject_reason = ${v.reason ? sqlStr(v.reason) : 'NULL'}, verified_at = ${now} ` +
        `WHERE id = ${sqlStr(v.id)} AND status = 'pending';`,
    )
    .join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const flag = (name: string) => args.includes(name);
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const valued = new Set(['--sql', '--limit']);
  const input = args.find((a, i) => !a.startsWith('--') && !valued.has(args[i - 1] ?? ''));
  if (!input) {
    process.stdout.write(
      'usage: vite-node scripts/verify-runs.ts -- <pending.json> [--sql out.sql] [--limit N] [--any-version] [--quiet]\n',
    );
    process.exit(1);
  }
  const rows = rowsOf(JSON.parse(readFileSync(input, 'utf8')));
  const limitRaw = Number(opt('--limit'));
  const verdicts = await verifyRows(rows, {
    anyVersion: flag('--any-version'),
    ...(Number.isFinite(limitRaw) && limitRaw > 0 ? { limit: Math.floor(limitRaw) } : {}),
  });
  if (!flag('--quiet')) {
    for (const v of verdicts)
      process.stdout.write(`${v.status.padEnd(8)} ${v.id} ${v.board} ${v.ms}ms${v.reason ? `  ${v.reason}` : ''}\n`);
  }
  const n = (s: Verdict['status']) => verdicts.filter((v) => v.status === s).length;
  process.stdout.write(
    `\n${rows.length} rows · verified ${n('verified')} · rejected ${n('rejected')} · skipped ${n('skipped')} (server GAME_VERSION ${GAME_VERSION})\n`,
  );
  const sqlPath = opt('--sql');
  if (sqlPath) {
    writeFileSync(sqlPath, verdictSql(verdicts, Date.now()) + '\n');
    process.stdout.write(`SQL → ${sqlPath}\n`);
  }
  process.exit(n('rejected') > 0 ? 2 : 0);
}

// 被测试 import 时不执行（vite-node 下 argv[1] 是 vite-node 本身，所以按 VITEST 环境变量判断）
if (!process.env.VITEST) void main();
