-- 游戏内反馈（POST /api/feedback）：玩家在「设置 → 反馈」或主菜单底部提交的 bug / 建议。
-- 设计与读取方法见 docs/12-全服排行榜.md §9。不存 IP、不存原始设备 id，只存加盐哈希（与 runs 表同一套）。
CREATE TABLE IF NOT EXISTS feedback (
  id           TEXT    NOT NULL PRIMARY KEY,           -- 随机 14 位 [0-9a-z]
  created_at   INTEGER NOT NULL,                       -- 毫秒时间戳
  kind         TEXT    NOT NULL CHECK (kind IN ('bug', 'idea', 'other')),
  text         TEXT    NOT NULL,                       -- 正文（≤ 1000 字，已清洗控制字符）
  contact      TEXT,                                   -- 可选联系方式（≤ 100 字），没填为 NULL
  app_version  TEXT    NOT NULL DEFAULT '',            -- 客户端 APP_VERSION
  locale       TEXT    NOT NULL DEFAULT '',
  screen       TEXT    NOT NULL DEFAULT '',            -- 例如 390x844@3
  route        TEXT    NOT NULL DEFAULT '',            -- 当前页面；对局中为 game/<模式>/<地图>/<难度>
  user_agent   TEXT    NOT NULL DEFAULT '',
  device_hash  TEXT,                                   -- sha256(salt|dev|uuid) 前 32 位；没带设备 id 时为 NULL
  ip_hash      TEXT    NOT NULL,                       -- sha256(salt|ip|<ip>) 前 32 位
  status       TEXT    NOT NULL DEFAULT 'new'          -- 负责人处理进度：'new' / 'read' / 'done' / 'spam'（手动改）
);

CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback (created_at DESC);
-- 按 IP / 设备统计最近一小时的条数（限流）
CREATE INDEX IF NOT EXISTS idx_feedback_ip ON feedback (ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_device ON feedback (device_hash, created_at) WHERE device_hash IS NOT NULL;
