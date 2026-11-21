/**
 * D1 访问层。只依赖一个最小的 D1 接口（D1Like），
 * 生产环境传 env.DB，测试里传基于 node:sqlite 的假 D1，跑的是同一份 SQL。
 *
 * 去重：UNIQUE(board, device_hash)。真人成绩的 device_hash = hash(设备)，AI 辅助成绩的 = hash(设备 + "ai")，
 * 所以每台设备在每个榜上「真人最佳」和「AI 辅助最佳」各保留一条——隐藏 AI 时自己的真人成绩不会被 AI 成绩顶掉。
 * 排序：评星（仅战役，其他榜为 0）↓ → 得分 ↓ → 波数 ↓ → 提交时间 ↑ → id ↑。
 */
import type { DifficultyId, MapId } from '../../src/core/types';
import {
  agentBadge,
  type DuelRow,
  type DuelSideBadge,
  duelSideBadge,
  isAiEffort,
  isBotHeavy,
  type LeaderRow,
  publicModelName,
  type RunStatus,
} from '../../src/shared/leaderboard';

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
  /** 兜底机器人决策占比 0..1（AI 参战；以及中途接管的 AI 辅助局，此时 agent_provider 为 NULL） */
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
  // ── 思考档位（migrations/0004）；旧成绩为 NULL ──
  /** AI 辅助 / AI 参战时的思考档位 */
  ai_effort?: string | null;
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
  | 'ai_effort'
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
  'ai_effort',
];
const BEST_COLS =
  'id, nickname, score, wave, kills, lives, map, difficulty, abyss, stars, won, status, created_at, ai, ai_model, ' +
  'agent_provider, agent_model, agent_mode, agent_bot_share, ai_effort';

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

  // ── 第二阶段：回放校验队列（idx_runs_status） ──

  /** 最早提交的若干条 pending 成绩（只取当前版本：回放用的是服务器上的当前代码） */
  async pendingRuns(gameVersion: string, limit: number): Promise<PendingRun[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, board, seed, opts_json, result_json, log_gz, game_version FROM runs ` +
          `WHERE status = 'pending' AND game_version = ?1 ORDER BY created_at ASC, id ASC LIMIT ?2`,
      )
      .bind(gameVersion, limit)
      .all<PendingRun>();
    return results;
  }

  async pendingCount(gameVersion: string): Promise<number> {
    const r = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM runs WHERE status = 'pending' AND game_version = ?`)
      .bind(gameVersion)
      .first<{ n: number }>();
    return Number(r?.n ?? 0);
  }

  /**
   * 写入校验结论。只改仍是 pending 的同一条（id 不变）：校验期间同一设备刷新了纪录，
   * UPSERT 会换成新 id，这里就不会误伤新成绩。返回是否真的写入。
   */
  async setVerdict(id: string, status: 'verified' | 'rejected', reason: string | null, now: number): Promise<boolean> {
    const r = await this.db
      .prepare(`UPDATE runs SET status = ?1, reject_reason = ?2, verified_at = ?3 WHERE id = ?4 AND status = 'pending' RETURNING id`)
      .bind(status, reason, now, id)
      .first<{ id: string }>();
    return !!r;
  }
}

/** 校验队列取出的一行 */
export type PendingRun = Pick<RunRow, 'id' | 'board' | 'seed' | 'opts_json' | 'result_json' | 'log_gz' | 'game_version'>;

const num = (x: unknown): number => Number(x ?? 0);

/** 榜上的 AI 参战标记：只有模型名 + 思考档位（agent_provider 只用来判断是不是内置机器人，不对外返回） */
export function agentOfRow(
  r: Pick<RunRow, 'agent_provider' | 'agent_model' | 'agent_mode' | 'agent_bot_share' | 'ai_effort'>,
): LeaderRow['agent'] | undefined {
  if (!r.agent_provider || !r.agent_model) return undefined;
  return agentBadge({
    provider: r.agent_provider,
    model: r.agent_model,
    ...(isAiEffort(r.ai_effort) ? { effort: r.ai_effort } : {}),
    mode: r.agent_mode === 'realtime' ? 'realtime' : 'pause',
    botShare: num(r.agent_bot_share),
  });
}

/** 对外的模型名：旧数据里可能是「服务商 · 模型」的界面标签，这里统一清洗 */
export const publicAiModel = (m: string | null | undefined): string | undefined => (m ? publicModelName(m) || undefined : undefined);

export function toLeaderRow(r: BestRow, rank: number): LeaderRow {
  const agent = agentOfRow(r);
  const ai = num(r.ai) === 1 || !!agent;
  const aiModel = publicAiModel(r.ai_model) ?? agent?.model;
  const aiEffort = isAiEffort(r.ai_effort) ? r.ai_effort : undefined;
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
    ...(ai && aiEffort ? { aiEffort } : {}),
    ...(agent ? { agent } : {}),
    ...(ai && isBotHeavy(r.agent_bot_share, r.agent_provider) ? { botHeavy: true } : {}),
  };
}

// ───────────────────────── AI 对战榜（duel_runs，migrations/0004） ─────────────────────────

/** duel_runs 表的一行 */
export interface DuelRunRow {
  id: string;
  nickname: string;
  /** 设备 + 对阵组合（去重键） */
  device_hash: string;
  /** 只按设备（查「我的最佳」） */
  owner_hash: string;
  mode: string;
  map: string;
  difficulty: string;
  abyss: number;
  wave: number;
  score: number;
  kills: number;
  lives: number;
  won: number;
  stars: number;
  plans: number;
  seed: string;
  game_version: string;
  opts_json: string;
  result_json: string;
  log_gz: string;
  log_bytes: number;
  atk_model: string;
  atk_effort: string | null;
  atk_scripted: number;
  atk_bot_share: number | null;
  def_model: string;
  def_effort: string | null;
  def_scripted: number;
  def_bot_share: number | null;
  duel_json: string;
  created_at: number;
  ip_hash: string;
}

const DUEL_COLUMNS: (keyof DuelRunRow)[] = [
  'id',
  'nickname',
  'device_hash',
  'owner_hash',
  'mode',
  'map',
  'difficulty',
  'abyss',
  'wave',
  'score',
  'kills',
  'lives',
  'won',
  'stars',
  'plans',
  'seed',
  'game_version',
  'opts_json',
  'result_json',
  'log_gz',
  'log_bytes',
  'atk_model',
  'atk_effort',
  'atk_scripted',
  'atk_bot_share',
  'def_model',
  'def_effort',
  'def_scripted',
  'def_bot_share',
  'duel_json',
  'created_at',
  'ip_hash',
];

export type DuelBestRow = Omit<
  DuelRunRow,
  'device_hash' | 'owner_hash' | 'seed' | 'game_version' | 'opts_json' | 'result_json' | 'log_gz' | 'log_bytes' | 'duel_json' | 'ip_hash'
>;

const DUEL_BEST_COLS =
  'id, nickname, mode, map, difficulty, abyss, wave, score, kills, lives, won, stars, plans, ' +
  'atk_model, atk_effort, atk_scripted, atk_bot_share, def_model, def_effort, def_scripted, def_bot_share, created_at';

export const DUEL_RANK_ORDER = 'won DESC, wave DESC, score DESC, created_at ASC, id ASC';

/** 「比那条更好」：won=?1 wave=?2 score=?3 created_at=?4 id=?5 */
const DUEL_BETTER_THAN =
  '(won > ?1 OR (won = ?1 AND (wave > ?2 OR (wave = ?2 AND score > ?3) OR (wave = ?2 AND score = ?3 AND created_at < ?4) ' +
  'OR (wave = ?2 AND score = ?3 AND created_at = ?4 AND id < ?5))))';

export class DuelStore {
  constructor(private readonly db: D1Like) {}

  /** 每台设备每个对阵组合只保留最好的一条：通关 → 波数 → 得分 更好才覆盖，否则只更新昵称 */
  async upsertBest(row: DuelRunRow): Promise<{ improved: boolean }> {
    const cols = DUEL_COLUMNS.join(', ');
    const qs = DUEL_COLUMNS.map(() => '?').join(', ');
    const sets = DUEL_COLUMNS.filter((c) => c !== 'device_hash' && c !== 'owner_hash')
      .map((c) => `${c} = excluded.${c}`)
      .join(', ');
    const sql =
      `INSERT INTO duel_runs (${cols}) VALUES (${qs}) ` +
      `ON CONFLICT(device_hash) DO UPDATE SET ${sets} ` +
      `WHERE excluded.won > duel_runs.won ` +
      `OR (excluded.won = duel_runs.won AND (excluded.wave > duel_runs.wave ` +
      `OR (excluded.wave = duel_runs.wave AND excluded.score > duel_runs.score))) ` +
      `RETURNING id`;
    const res = await this.db
      .prepare(sql)
      .bind(...DUEL_COLUMNS.map((c) => row[c] ?? null))
      .first<{ id: string }>();
    if (res) return { improved: true };
    await this.db
      .prepare('UPDATE duel_runs SET nickname = ? WHERE device_hash = ? AND nickname <> ?')
      .bind(row.nickname, row.device_hash, row.nickname)
      .run();
    return { improved: false };
  }

  bestOf(deviceHash: string): Promise<DuelBestRow | null> {
    return this.db.prepare(`SELECT ${DUEL_BEST_COLS} FROM duel_runs WHERE device_hash = ?`).bind(deviceHash).first<DuelBestRow>();
  }

  /** 本设备（所有对阵组合里）最好的一条 */
  bestOfOwner(ownerHash: string): Promise<DuelBestRow | null> {
    return this.db
      .prepare(`SELECT ${DUEL_BEST_COLS} FROM duel_runs WHERE owner_hash = ?1 ORDER BY ${DUEL_RANK_ORDER} LIMIT 1`)
      .bind(ownerHash)
      .first<DuelBestRow>();
  }

  async rankOf(r: Pick<DuelBestRow, 'id' | 'won' | 'wave' | 'score' | 'created_at'>): Promise<{ rank: number; total: number }> {
    const x = await this.db
      .prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN ${DUEL_BETTER_THAN} THEN 1 ELSE 0 END), 0) AS better FROM duel_runs`)
      .bind(Number(r.won), Number(r.wave), Number(r.score), Number(r.created_at), r.id)
      .first<{ total: number; better: number }>();
    return { rank: Number(x?.better ?? 0) + 1, total: Number(x?.total ?? 0) };
  }

  async total(): Promise<number> {
    const r = await this.db.prepare('SELECT COUNT(*) AS n FROM duel_runs').first<{ n: number }>();
    return Number(r?.n ?? 0);
  }

  async top(limit: number): Promise<DuelRow[]> {
    const { results } = await this.db
      .prepare(`SELECT ${DUEL_BEST_COLS} FROM duel_runs ORDER BY ${DUEL_RANK_ORDER} LIMIT ?1`)
      .bind(limit)
      .all<DuelBestRow>();
    return results.map((r, i) => toDuelRow(r, i + 1));
  }

  getRun(id: string): Promise<DuelRunRow | null> {
    return this.db.prepare('SELECT * FROM duel_runs WHERE id = ?').bind(id).first<DuelRunRow>();
  }
}

export function duelSideOfRow(model: string, effort: string | null | undefined, scripted: unknown, botShare: unknown): DuelSideBadge {
  return duelSideBadge({
    model,
    ...(isAiEffort(effort) ? { effort } : {}),
    ...(num(scripted) === 1 ? { scripted: true } : {}),
    botShare: num(botShare),
  });
}

export function toDuelRow(r: DuelBestRow, rank: number): DuelRow {
  const abyss = num(r.abyss);
  return {
    rank,
    id: r.id,
    nickname: r.nickname,
    attacker: duelSideOfRow(r.atk_model, r.atk_effort, r.atk_scripted, r.atk_bot_share),
    defender: duelSideOfRow(r.def_model, r.def_effort, r.def_scripted, r.def_bot_share),
    mode: r.mode === 'campaign' ? 'campaign' : 'endless',
    map: r.map as MapId,
    difficulty: r.difficulty as DifficultyId,
    ...(r.difficulty === 'abyss' && abyss > 0 ? { abyssLevel: abyss } : {}),
    wave: num(r.wave),
    score: num(r.score),
    kills: num(r.kills),
    lives: num(r.lives),
    won: num(r.won) === 1,
    stars: num(r.stars),
    plans: num(r.plans),
    createdAt: num(r.created_at),
  };
}
