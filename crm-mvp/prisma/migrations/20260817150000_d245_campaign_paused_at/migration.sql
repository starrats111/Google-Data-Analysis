-- D-245 复盘分析：campaigns 增加暂停时间与暂停来源
-- paused_at：系列被置为 PAUSED 的时间；重新启用（→ENABLED）时清空；REMOVED 保留
-- pause_source：manual(手动) / spend_guard(花费哨兵) / ai_apply(AI建议执行) / sync(同步发现) / backfill(存量近似回填)
ALTER TABLE `campaigns`
  ADD COLUMN `paused_at` DATETIME NULL DEFAULT NULL AFTER `last_google_sync_at`,
  ADD COLUMN `pause_source` VARCHAR(20) NULL DEFAULT NULL AFTER `paused_at`;

-- 存量一次性回填：当前已是 PAUSED 的系列用 last_google_sync_at 近似暂停时间（UI 会标注为近似值）。
-- 存量 REMOVED 无法可靠判断"移除前是否暂停过"，不回填（不进复盘列表）。
UPDATE `campaigns`
SET `paused_at` = COALESCE(`last_google_sync_at`, `updated_at`),
    `pause_source` = 'backfill'
WHERE `is_deleted` = 0
  AND `google_status` = 'PAUSED'
  AND `paused_at` IS NULL;
