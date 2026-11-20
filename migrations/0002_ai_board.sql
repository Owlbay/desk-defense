-- AI 榜（文档 10 §13 / §17.1）：AI 对局的成绩与真人成绩存在同一张 runs 表，
-- 用榜键前缀 `ai:` 隔离（'ai:normal:auto' …），并记录模型信息。真人成绩这些列全部为 NULL。
-- AI 榜的 device_hash = sha256(salt|dev|uuid|ai|provider|model)：同一设备的每个模型各保留一条最佳。
-- 应用：npx wrangler@4 d1 migrations apply desk-defense --local / --remote
ALTER TABLE runs ADD COLUMN agent_provider  TEXT;      -- claude-native / pi:ollama / bridge / scripted …
ALTER TABLE runs ADD COLUMN agent_model     TEXT;      -- claude-opus-5-5 / qwen3:8b …
ALTER TABLE runs ADD COLUMN agent_mode      TEXT;      -- 决策模式 pause / realtime
ALTER TABLE runs ADD COLUMN agent_bot_share REAL;      -- 兜底机器人决策占比 0..1（> 0.2 在榜上标注）
ALTER TABLE runs ADD COLUMN agent_json      TEXT;      -- 完整 AgentMeta JSON（决策数 / token / 费用估算）

-- 按模型统计 / 清理
CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs (agent_provider, agent_model) WHERE agent_provider IS NOT NULL;
