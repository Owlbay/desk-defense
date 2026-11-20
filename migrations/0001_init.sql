-- 书桌防线 全服排行榜（D1 / SQLite）
-- 设计说明见 docs/12-全服排行榜.md
-- 应用：npx wrangler@4 d1 migrations apply desk-defense --local   （本地）
--       npx wrangler@4 d1 migrations apply desk-defense --remote  （线上）

-- 成绩：每台设备在每个榜只保留最佳一条（UNIQUE(board, device_hash)，提交时条件 UPSERT）。
-- 保存种子 / 开局参数 / 指令日志 / 版本 / 声明结果，供第二阶段服务端回放校验。
CREATE TABLE IF NOT EXISTS runs (
  id           TEXT    NOT NULL PRIMARY KEY,           -- 随机 14 位 [0-9a-z]
  board        TEXT    NOT NULL,                       -- 'normal' / 'abyss3:pure:auto' / 'daily:2026-11-20'
  day          TEXT,                                   -- 每日挑战日期（UTC+8），无尽榜为 NULL
  nickname     TEXT    NOT NULL,
  device_hash  TEXT    NOT NULL,                       -- sha256(salt|dev|uuid) 前 32 位，不存原始设备 id
  score        INTEGER NOT NULL,
  wave         INTEGER NOT NULL,                       -- 撑过的波数
  kills        INTEGER NOT NULL,
  lives        INTEGER NOT NULL,
  seed         TEXT    NOT NULL,
  map          TEXT    NOT NULL,
  difficulty   TEXT    NOT NULL,
  abyss        INTEGER NOT NULL DEFAULT 0,             -- 魔境等级，非魔境为 0
  pure         INTEGER NOT NULL DEFAULT 0,
  auto_wave    INTEGER NOT NULL DEFAULT 0,
  game_version TEXT    NOT NULL,                       -- src/shared/leaderboard.ts GAME_VERSION
  opts_json    TEXT    NOT NULL,                       -- RunOptions（含 seed）
  result_json  TEXT    NOT NULL,                       -- 客户端声明的结算（wave/score/kills/lives/gold/ticks/...）
  log_gz       TEXT    NOT NULL,                       -- 指令日志 JSON → gzip → base64（原文 ≤ 200 KB）
  log_bytes    INTEGER NOT NULL DEFAULT 0,             -- 日志 JSON 原文字节数
  status       TEXT    NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'verified', 'rejected')),
  reject_reason TEXT,                                  -- 第二阶段：回放不一致的原因
  verified_at  INTEGER,                                -- 第二阶段：校验时间（毫秒）
  created_at   INTEGER NOT NULL,                       -- 毫秒时间戳
  ip_hash      TEXT    NOT NULL,                       -- sha256(salt|ip|<ip>) 前 32 位
  UNIQUE (board, device_hash)
);

-- 每榜前 N：ORDER BY score DESC, wave DESC, created_at ASC, id ASC
CREATE INDEX IF NOT EXISTS idx_runs_board_rank ON runs (board, score DESC, wave DESC, created_at ASC, id ASC);
-- 第二阶段校验队列
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs (status, created_at);
-- 按日期清理旧的每日挑战
CREATE INDEX IF NOT EXISTS idx_runs_day ON runs (day) WHERE day IS NOT NULL;

-- 固定窗口限流计数：key = 'ip:<hash>' / 'dev:<hash>'
CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT    NOT NULL PRIMARY KEY,
  window_start INTEGER NOT NULL,                       -- 窗口起点（秒，对齐到窗口长度）
  count        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits (window_start);
