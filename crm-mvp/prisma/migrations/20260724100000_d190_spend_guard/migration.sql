-- D-190 花费哨兵：零出单超线测试系列自动暂停的动作记录。
-- campaign_id 唯一 => 每个系列哨兵只出手一次，用户手动重启后不会被反复重暂停；
-- status='pause_failed' 且 attempts<3 的会在后续轮次重试。
CREATE TABLE `spend_guard_actions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `campaign_id` BIGINT UNSIGNED NOT NULL,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'paused',
  `attempts` INT UNSIGNED NOT NULL DEFAULT 1,
  `cost_usd` DECIMAL(12,2) NULL,
  `cap_usd` DECIMAL(12,2) NULL,
  `last_error` VARCHAR(500) NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_campaign` (`campaign_id`),
  KEY `idx_user` (`user_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
