/**
 * 基于 node:sqlite 的假 D1：实现 functions/_lib/db.ts 用到的 D1Like 子集，
 * 并执行真实的 migrations/*.sql，所以测试覆盖的是线上同一份 SQL。
 */
import migration from '../../migrations/0001_init.sql?raw';
import migrationAi from '../../migrations/0002_ai_board.sql?raw';
import type { D1Like, D1StmtLike } from '../../functions/_lib/db';

interface SqliteStmt {
  get(...a: unknown[]): unknown;
  all(...a: unknown[]): unknown[];
  run(...a: unknown[]): unknown;
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStmt;
}

export interface FakeD1 extends D1Like {
  sqlite: SqliteDb;
  queries: string[];
}

const plain = <T>(row: unknown): T => ({ ...(row as object) }) as T;

export async function createFakeD1(): Promise<FakeD1> {
  const name = 'node:sqlite';
  const mod = (await import(/* @vite-ignore */ name)) as { DatabaseSync: new (path: string) => SqliteDb };
  const sqlite = new mod.DatabaseSync(':memory:');
  sqlite.exec(migration);
  sqlite.exec(migrationAi);
  const queries: string[] = [];
  const stmt = (sql: string, args: unknown[]): D1StmtLike => ({
    bind: (...values: unknown[]) => {
      for (const v of values) if (v === undefined || typeof v === 'boolean') throw new Error(`D1 不接受 ${typeof v} 参数`);
      return stmt(sql, values);
    },
    first: async <T>() => {
      queries.push(sql);
      const r = sqlite.prepare(sql).get(...args);
      return r === undefined ? null : plain<T>(r);
    },
    all: async <T>() => {
      queries.push(sql);
      return { results: sqlite.prepare(sql).all(...args).map((r) => plain<T>(r)) };
    },
    run: async () => {
      queries.push(sql);
      return sqlite.prepare(sql).run(...args);
    },
  });
  return { sqlite, queries, prepare: (sql: string) => stmt(sql, []) };
}
