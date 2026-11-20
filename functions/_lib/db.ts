/**
 * D1 访问层。只依赖一个最小的 D1 接口（D1Like），
 * 生产环境传 env.DB，测试里传基于 node:sqlite 的假 D1，跑的是同一份 SQL。
 */
import type { LeaderRow, RunStatus } from '../../src/shared/leaderboard';

export interface D1StmtLike {
  bind(...values: unknown[]): D1StmtLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface D1Like {
  prepare(sql: string): D1StmtLike;
}

/** runs 表的一行（列名与 migrations/0001_init.sql 一致） */
export interface RunRow {
  id: string;
  board: string;
  day: string | null;
  nickname: string;
  device_hash: string;
  score: number;
  wave: number;
  kills: number;
  lives: number;
  seed: string;
  map: string;
  difficulty: string;
  abyss: number;
  pure: number;
  auto_wave: number;
  game_version: string;
  opts_json: string;
  result_json: string;
  log_gz: string;
  log_bytes: number;
  status: RunStatus;
  created_at: number;
  ip_hash: string;
}

export type BestRow = Pick<RunRow, 'id' | 'nickname' | 'score' | 'wave' | 'kills' | 'lives' | 'map' | 'status' | 'created_at'>;

const RUN_COLUMNS: (keyof RunRow)[] = [
  'id', 'board', 'day', 'nickname', 'device_hash', 'score', 'wave', 'kills', 'lives', 'seed', 'map',
  'difficulty', 'abyss', 'pure', 'auto_wave', 'game_version', 'opts_json', 'result_json', 'log_gz',
  'log_bytes', 'status', 'created_at', 'ip_hash',
];
const BEST_COLS = 'id, nickname, score, wave, kills, lives, map, status, created_at';

/** 「更好」的定义：分高者优先，同分波数高者优先，再同则先提交者优先（最后按 id 保证全序） */
const BETTER_THAN =
  `(score > ?1 OR (score = ?1 AND wave > ?2) OR (score = ?1 AND wave = ?2 AND created_at < ?3) ` +
  `OR (score = ?1 AND wave = ?2 AND created_at = ?3 AND id < ?5))`;

export class RunStore {
  constructor(private readonly db: D1Like) {}

  /**
   * 每台设备在每个榜只保留最佳一条（UNIQUE(board, device_hash) + 条件 UPSERT）：
   * 新成绩更好（或旧成绩已被判定作弊）才覆盖整行，否则只更新昵称。
   */
  async upsertBest(row: RunRow): Promise<{ improved: boolean }> {
    const cols = RUN_COLUMNS.join(', ');
    const qs = RUN_COLUMNS.map(() => '?').join(', ');
    const sets = RUN_COLUMNS.filter((c) => c !== 'board' && c !== 'device_hash').map((c) => `${c} = excluded.${c}`).join(', ');
    const sql =
      `INSERT INTO runs (${cols}) VALUES (${qs}) ` +
      `ON CONFLICT(board, device_hash) DO UPDATE SET ${sets} ` +
      `WHERE excluded.score > runs.score OR (excluded.score = runs.score AND excluded.wave > runs.wave) OR runs.status = 'rejected' ` +
      `RETURNING id`;
    const res = await this.db.prepare(sql).bind(...RUN_COLUMNS.map((c) => row[c])).first<{ id: string }>();
    if (res) return { improved: true };
    await this.db
      .prepare('UPDATE runs SET nickname = ? WHERE board = ? AND device_hash = ? AND nickname <> ?')
      .bind(row.nickname, row.board, row.device_hash, row.nickname)
      .run();
    return { improved: false };
  }

  bestOf(board: string, deviceHash: string): Promise<BestRow | null> {
    return this.db
      .prepare(`SELECT ${BEST_COLS} FROM runs WHERE board = ? AND device_hash = ? AND status <> 'rejected'`)
      .bind(board, deviceHash)
      .first<BestRow>();
  }

  /** 名次（1 起）与榜上总人数，一条查询 */
  async rankOf(board: string, best: Pick<BestRow, 'id' | 'score' | 'wave' | 'created_at'>): Promise<{ rank: number; total: number }> {
    const r = await this.db
      .prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN ${BETTER_THAN} THEN 1 ELSE 0 END), 0) AS better ` +
          `FROM runs WHERE board = ?4 AND status <> 'rejected'`,
      )
      .bind(best.score, best.wave, best.created_at, board, best.id)
      .first<{ total: number; better: number }>();
    return { rank: Number(r?.better ?? 0) + 1, total: Number(r?.total ?? 0) };
  }

  async total(board: string): Promise<number> {
    const r = await this.db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE board = ? AND status <> 'rejected'`).bind(board).first<{ n: number }>();
    return Number(r?.n ?? 0);
  }

  async top(board: string, limit: number): Promise<LeaderRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${BEST_COLS} FROM runs WHERE board = ? AND status <> 'rejected' ` +
          `ORDER BY score DESC, wave DESC, created_at ASC, id ASC LIMIT ?`,
      )
      .bind(board, limit)
      .all<BestRow>();
    return results.map((r, i) => toLeaderRow(r, i + 1));
  }

  getRun(id: string): Promise<RunRow | null> {
    return this.db.prepare(`SELECT * FROM runs WHERE id = ?`).bind(id).first<RunRow>();
  }
}

export function toLeaderRow(r: BestRow, rank: number): LeaderRow {
  return {
    rank,
    id: r.id,
    nickname: r.nickname,
    score: Number(r.score),
    wave: Number(r.wave),
    kills: Number(r.kills),
    lives: Number(r.lives),
    map: r.map as LeaderRow['map'],
    status: r.status,
    createdAt: Number(r.created_at),
  };
}
