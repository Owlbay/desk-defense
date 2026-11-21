-- 精简排行榜（docs/12 §3）：只剩三类榜，AI 辅助的成绩进同一张榜、带标记。
--   endless               所有无尽成绩一张榜（得分已含难度倍率）
--   daily:<YYYY-MM-DD>    每日挑战，每天一张
--   campaign:<ch1|ch2|ch3> 战役，每章一张（评星 → 得分 → 波数）
-- 去重仍是 UNIQUE(board, device_hash)：AI 辅助成绩的 device_hash = sha256(salt|dev|uuid|ai)，
-- 所以每台设备在每个榜上「真人最佳」和「AI 辅助最佳」各一条。
-- 应用：npx wrangler@4 d1 migrations apply desk-defense --local / --remote

ALTER TABLE runs ADD COLUMN ai       INTEGER NOT NULL DEFAULT 0;  -- 1 = AI 辅助（AI 参战 / 让 AI 替我玩）
ALTER TABLE runs ADD COLUMN ai_model TEXT;                        -- AI 辅助时显示的模型名
ALTER TABLE runs ADD COLUMN stars    INTEGER NOT NULL DEFAULT 0;  -- 战役评星（失败 0）；无尽 / 每日 0
ALTER TABLE runs ADD COLUMN won      INTEGER NOT NULL DEFAULT 0;  -- 战役通关 1

-- 旧 AI 榜（'ai:normal:auto' …）的成绩：标记为 AI 辅助，模型名沿用 agent_model
UPDATE runs SET ai = 1, ai_model = agent_model WHERE board LIKE 'ai:%' OR agent_provider IS NOT NULL;

-- 旧无尽榜键（'normal' / 'hard:pure' / 'abyss3:pure:auto' / 'ai:…'）全部并入 'endless'。
-- 同一 device_hash 在多张旧榜上都有成绩时只保留最好的一条（未被判作弊的优先，再按 得分 → 波数 → 先提交 → id），
-- 否则改榜键时会撞上 UNIQUE(board, device_hash)。
DELETE FROM runs
WHERE board NOT LIKE 'daily:%' AND board NOT LIKE 'campaign:%' AND board <> 'endless'
  AND EXISTS (
    SELECT 1 FROM runs AS b
    WHERE b.device_hash = runs.device_hash AND b.id <> runs.id
      AND b.board NOT LIKE 'daily:%' AND b.board NOT LIKE 'campaign:%'
      AND (
        (b.status <> 'rejected' AND runs.status = 'rejected')
        OR ((b.status = 'rejected') = (runs.status = 'rejected') AND (
          b.score > runs.score
          OR (b.score = runs.score AND b.wave > runs.wave)
          OR (b.score = runs.score AND b.wave = runs.wave AND b.created_at < runs.created_at)
          OR (b.score = runs.score AND b.wave = runs.wave AND b.created_at = runs.created_at AND b.id < runs.id)
        ))
      )
  );
UPDATE runs SET board = 'endless' WHERE board NOT LIKE 'daily:%' AND board NOT LIKE 'campaign:%' AND board <> 'endless';

-- 新的排名索引：评星 → 得分 → 波数 → 先提交 → id
DROP INDEX IF EXISTS idx_runs_board_rank;
CREATE INDEX IF NOT EXISTS idx_runs_board_rank2 ON runs (board, stars DESC, score DESC, wave DESC, created_at ASC, id ASC);
-- 隐藏 AI 辅助成绩时的查询
CREATE INDEX IF NOT EXISTS idx_runs_board_human ON runs (board, ai, stars DESC, score DESC, wave DESC, created_at ASC, id ASC);
