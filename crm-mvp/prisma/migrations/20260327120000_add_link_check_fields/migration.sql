-- AlterTable: 给 user_merchants 增加链接可达性检测字段
ALTER TABLE `user_merchants`
  ADD COLUMN `link_status` VARCHAR(16) NOT NULL DEFAULT 'unchecked',
  ADD COLUMN `link_checked_at` DATETIME(0) NULL,
  ADD COLUMN `link_check_reason` VARCHAR(255) NULL;
