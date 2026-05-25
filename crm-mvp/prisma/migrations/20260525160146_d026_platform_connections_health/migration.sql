-- D-026 API 连接健康监控字段
-- 背景：wj08 keymint(MUI) 卡了 7 天 Invalid token 完全静默，user 不知情
-- 详见：设计方案.md D-026 章节

-- AlterTable: platform_connections 新增 3 个健康监控字段
ALTER TABLE `platform_connections`
  ADD COLUMN `last_sync_attempt_at` DATETIME(0) NULL COMMENT 'D-026 上次尝试同步时间（成功失败都写）' AFTER `last_synced_at`,
  ADD COLUMN `last_error` VARCHAR(500) NULL COMMENT 'D-026 上次错误消息（成功后清空）' AFTER `last_sync_attempt_at`,
  ADD COLUMN `consecutive_failures` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'D-026 连续失败次数（成功后清零，>=1 切 error）' AFTER `last_error`;

-- CreateIndex: 健康巡检 cron 按 status + 上次尝试时间扫
CREATE INDEX `idx_status_attempt` ON `platform_connections`(`status`, `last_sync_attempt_at`);
