-- D-040 v2: campaigns 表新增 previous_gcids JSON 字段
-- 用途: 记录重发广告的历史 gcid 数组，让 status-sync / daily-sync 拉 GAds REMOVED 广告时
--      能按 previous_gcids JSON_CONTAINS 找回原 campaign，cost 合并不丢

ALTER TABLE `campaigns`
  ADD COLUMN `previous_gcids` JSON NOT NULL DEFAULT (JSON_ARRAY())
  AFTER `last_google_sync_at`;
