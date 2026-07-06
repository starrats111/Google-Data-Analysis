-- Token 池自动体检：系统自行标记 token 可用性、按 MCC 记录权限、触顶反推真实额度
ALTER TABLE `team_developer_tokens`
  ADD COLUMN `health_status` VARCHAR(16) NULL DEFAULT 'unknown',
  ADD COLUMN `health_note` VARCHAR(255) NULL,
  ADD COLUMN `last_ok_at` DATETIME(0) NULL,
  ADD COLUMN `last_error_at` DATETIME(0) NULL,
  ADD COLUMN `detected_quota` INT UNSIGNED NULL,
  ADD COLUMN `quota_detected_at` DATETIME(0) NULL,
  ADD COLUMN `mcc_access` TEXT NULL;
