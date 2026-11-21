-- 1) AI 辅助 / AI 参战成绩记下思考档位（off / low / medium / high / xhigh / max）；旧成绩为 NULL（榜上不显示档位）。
--    对外只返回模型名 + 档位；agent_provider 仍只做内部判断（是不是内置机器人），不再出现在接口返回里。
-- 2) AI 对战榜（进攻方模型 vs 防守方模型）：独立的 duel_runs 表，不混进 runs 的三类榜。
--    device_hash = sha256(salt|dev|uuid|duel|进攻模型|档位|防守模型|档位) 前 32 位：同一设备的每个对阵组合保留最好的一条。
--    排序：通关（战役）↓ → 撑过的波数 ↓ → 得分 ↓ → 先提交 → id。
-- 应用：npx wrangler@4 d1 migrations apply desk-defense --local / --remote

ALTER TABLE runs ADD COLUMN ai_effort TEXT;

CREATE TABLE IF NOT EXISTS duel_runs (
  id           TEXT    NOT NULL PRIMARY KEY,           -- 随机 14 位 [0-9a-z]
  nickname     TEXT    NOT NULL,
  device_hash  TEXT    NOT NULL UNIQUE,                -- 见上（含对阵组合）
  owner_hash   TEXT    NOT NULL,                       -- sha256(salt|dev|uuid|duel) 前 32 位：查「我的最佳」
  mode         TEXT    NOT NULL,                       -- endless / campaign
  map          TEXT    NOT NULL,
  difficulty   TEXT    NOT NULL,
  abyss        INTEGER NOT NULL DEFAULT 0,
  wave         INTEGER NOT NULL,                       -- 防守方撑过的波数
  score        INTEGER NOT NULL,
  kills        INTEGER NOT NULL,
  lives        INTEGER NOT NULL,
  won          INTEGER NOT NULL DEFAULT 0,             -- 战役通关（防守方赢）
  stars        INTEGER NOT NULL DEFAULT 0,
  plans        INTEGER NOT NULL DEFAULT 0,             -- 进攻方改写了几波
  seed         TEXT    NOT NULL,
  game_version TEXT    NOT NULL,
  opts_json    TEXT    NOT NULL,
  result_json  TEXT    NOT NULL,
  log_gz       TEXT    NOT NULL,                       -- 含 overrideWave 的指令日志（gzip + base64）
  log_bytes    INTEGER NOT NULL DEFAULT 0,
  atk_model    TEXT    NOT NULL,
  atk_effort   TEXT,
  atk_scripted INTEGER NOT NULL DEFAULT 0,
  atk_bot_share REAL,
  def_model    TEXT    NOT NULL,
  def_effort   TEXT,
  def_scripted INTEGER NOT NULL DEFAULT 0,
  def_bot_share REAL,
  duel_json    TEXT    NOT NULL,                       -- 完整 DuelMeta（双方决策数 / token / 费用 / 错误数；不含渠道）
  created_at   INTEGER NOT NULL,
  ip_hash      TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_duel_owner ON duel_runs (owner_hash);
CREATE INDEX IF NOT EXISTS idx_duel_rank ON duel_runs (won DESC, wave DESC, score DESC, created_at ASC, id ASC);
