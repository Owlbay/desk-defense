/**
 * D1 访问层。只依赖一个最小的 D1 接口（D1Like），
 * 生产环境传 env.DB，测试里传基于 node:sqlite 的假 D1，跑的是同一份 SQL。
 *
 * 去重：UNIQUE(board, device_hash)。真人成绩的 device_hash = hash(设备)，AI 辅助成绩的 = hash(设备 + "ai")，
 * 所以每台设备在每个榜上「真人最佳」和「AI 辅助最佳」各保留一条——隐藏 AI 时自己的真人成绩不会被 AI 成绩顶掉。
 * 排序：评星（仅战役，其他榜为 0）↓ → 得分 ↓ → 波数 ↓ → 提交时间 ↑ → id ↑。
 */
import type { DifficultyId, MapId } from '../../src/core/types';
import { agentBadge, type LeaderRow, type RunStatus } from '../../src/shared/leaderboard';

export interface D1StmtLike {
  bind(...values: unknown[]): D1StmtLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface D1Like {
  prepare(sql: string): D1StmtLike;
}

/** runs 表的一行（列名与 migrations/0001..0003 一致） */
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
  // ── AI 参战（migrations/0002）；其他成绩全部为 NULL ──
  agent_provider?: string | null;
  agent_model?: string | null;
  agent_mode?: string | null;
  /** 兜底机器人决策占比 0..1 */
  agent_bot_share?: number | null;
  /** 完整的 AgentMeta JSON（决策数 / token / 费用） */
  agent_json?: string | null;
  // ── 精简榜单（migrations/0003） ──
  /** 1 = AI 辅助（AI 参战或「让 AI 替我玩」） */
  ai: number;
  /** AI 辅助时显示的模型名 */
  ai_model?: string | null;
  /** 战役评星（失败 0）；无尽 / 每日 0 */
  stars: number;
  /** 战役通关 1 */
  won: number;
}

export type BestRow = Pick<
  RunRow,
  | 'id'
  | 'nickname'
  | 'score'
  | 'wave'
  | 'kills'
  | 'lives'
  | 'map'
  | 'difficulty'
  | 'abyss'
  | 'stars'
  | 'won'
  | 'status'
  | 'created_at'
  | 'ai'
  | 'ai_model'
  | 'agent_provider'
  | 'agent_model'
  | 'agent_mode'
  | 'agent_bot_share'
>;

const RUN_COLUMNS: (keyof RunRow)[] = [
  'id',
  'board',
  'day',
  'nickname',
  'device_hash',
  'score',
  'wave',
  'kills',
  'lives',
  'seed',
  'map',
  'difficulty',
  'abyss',
  'pure',
  'auto_wave',
  'game_version',
  'opts_json',
  'result_json',
  'log_gz',
  'log_bytes',
  'status',
  'created_at',
  'ip_hash',
  'agent_provider',
  'agent_model',
  'agent_mode',
  'agent_bot_share',
  'agent_json',
  'ai',
  'ai_model',
  'stars',
  'won',
];
const BEST_COLS =
  'id, nickname, score, wave, kills, lives, map, difficulty, abyss, stars, won, status, created_at, ai, ai_model, ' +
  'agent_provider, agent_model, agent_mode, agent_bot_share';

export const RANK_ORDER = 'stars DESC, score DESC, wave DESC, created_at ASC, id ASC';

/** 「比 ?1..?5 那条更好」：stars=?6 score=?1 wave=?2 created_at=?3 id=?5 */
const BETTER_THAN =
  `(stars > ?6 OR (stars = ?6 AND (score > ?1 OR (score = ?1 AND wave > ?2) OR (score = ?1 AND wave = ?2 AND created_at < ?3) ` +
  `OR (score = ?1 AND wave = ?2 AND created_at = ?3 AND id < ?5))))`;

/** 是否包含 AI 辅助成绩的过滤条件（参数是 0/1；D1 不接受 boolean） */
const AI_FILTER = (n: number) => `(ai = 0 OR ?${n} = 1)`;

export type RankKey = Pick<BestRow, 'id' | 'score' | 'wave' | 'created_at' | 'stars'>;

/** a 是否排在 b 前面（与 RANK_ORDER 一致） */
export function ranksBefore(a: RankKey, b: RankKey): boolean {
  if (a.stars !== b.stars) return a.stars > b.stars;
  if (a.score !== b.score) return a.score > b.score;
  if (a.wave !== b.wave) return a.wave > b.wave;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at;
  return a.id < b.id;
}

export class RunStore {
  constructor(private readonly db: D1Like) {}

  /**
   * 每台设备在每个榜（真人 / AI 辅助分开）只保留最佳一条（UNIQUE(board, device_hash) + 条件 UPSERT）：
   * 新成绩更好（或旧成绩已被判定作弊）才覆盖整行，否则只更新昵称。
   */
  async upsertBest(row: RunRow): Promise<{ improved: boolean }> {
    const cols = RUN_COLUMNS.join(', ');
    const qs = RUN_COLUMNS.map(() => '?').join(', ');
    const sets = RUN_COLUMNS.filter((c) => c !== 'board' && c !== 'device_hash')
      .map((c) => `${c} = excluded.${c}`)
      .join(', ');
    const sql =
      `INSERT INTO runs (${cols}) VALUES (${qs}) ` +
      `ON CONFLICT(board, device_hash) DO UPDATE SET ${sets} ` +
      `WHERE excluded.stars > runs.stars ` +
      `OR (excluded.stars = runs.stars AND (excluded.score > runs.score OR (excluded.score = runs.score AND excluded.wave > runs.wave))) ` +
      `OR runs.status = 'rejected' ` +
      `RETURNING id`;
    const res = await this.db
      .prepare(sql)
      .bind(...RUN_COLUMNS.map((c) => row[c] ?? null))
      .first<{ id: string }>();
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

  /** 名次（1 起）与榜上总条数，一条查询；includeAi=false 时只在真人成绩里排 */
  async rankOf(board: string, best: RankKey, includeAi = true): Promise<{ rank: number; total: number }> {
    const r = await this.db
      .prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN ${BETTER_THAN} THEN 1 ELSE 0 END), 0) AS better ` +
          `FROM runs WHERE board = ?4 AND status <> 'rejected' AND ${AI_FILTER(7)}`,
      )
      .bind(Number(best.score), Number(best.wave), Number(best.created_at), board, best.id, Number(best.stars), includeAi ? 1 : 0)
      .first<{ total: number; better: number }>();
    return { rank: Number(r?.better ?? 0) + 1, total: Number(r?.total ?? 0) };
  }

  async total(board: string, includeAi = true): Promise<number> {
    const r = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM runs WHERE board = ?1 AND status <> 'rejected' AND ${AI_FILTER(2)}`)
      .bind(board, includeAi ? 1 : 0)
      .first<{ n: number }>();
    return Number(r?.n ?? 0);
  }

  async top(board: string, limit: number, includeAi = true): Promise<LeaderRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${BEST_COLS} FROM runs WHERE board = ?1 AND status <> 'rejected' AND ${AI_FILTER(2)} ` + `ORDER BY ${RANK_ORDER} LIMIT ?3`,
      )
      .bind(board, includeAi ? 1 : 0, limit)
      .all<BestRow>();
    return results.map((r, i) => toLeaderRow(r, i + 1));
  }

  getRun(id: string): Promise<RunRow | null> {
    return this.db.prepare(`SELECT * FROM runs WHERE id = ?`).bind(id).first<RunRow>();
  }
}

const num = (x: unknown): number => Number(x ?? 0);

export function agentOfRow(
  r: Pick<RunRow, 'agent_provider' | 'agent_model' | 'agent_mode' | 'agent_bot_share'>,
): LeaderRow['agent'] | undefined {
  if (!r.agent_provider || !r.agent_model) return undefined;
  return agentBadge({
    provider: r.agent_provider,
    model: r.agent_model,
    mode: r.agent_mode === 'realtime' ? 'realtime' : 'pause',
    botShare: num(r.agent_bot_share),
  });
}

export function toLeaderRow(r: BestRow, rank: number): LeaderRow {
  const agent = agentOfRow(r);
  const ai = num(r.ai) === 1 || !!agent;
  const aiModel = r.ai_model || agent?.model || undefined;
  const abyss = num(r.abyss);
  return {
    rank,
    id: r.id,
    nickname: r.nickname,
    score: num(r.score),
    wave: num(r.wave),
    kills: num(r.kills),
    lives: num(r.lives),
    map: r.map as MapId,
    difficulty: r.difficulty as DifficultyId,
    ...(r.difficulty === 'abyss' && abyss > 0 ? { abyssLevel: abyss } : {}),
    stars: num(r.stars),
    won: num(r.won) === 1,
    status: r.status,
    createdAt: num(r.created_at),
    ai,
    ...(ai && aiModel ? { aiModel } : {}),
    ...(agent ? { agent } : {}),
  };
}
