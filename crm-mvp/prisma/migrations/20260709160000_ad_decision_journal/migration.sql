-- 批次6：广告决策日志（建议 → 结果 → 准确率 闭环）
CREATE TABLE `ad_decision_journal` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `decision_id` VARCHAR(64) NOT NULL,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `campaign_id` BIGINT UNSIGNED NOT NULL,
  `campaign_name` VARCHAR(255) NOT NULL,
  `snapshot_json` JSON NOT NULL,
  `action_type` VARCHAR(20) NOT NULL,
  `magnitude` VARCHAR(32) NULL,
  `reasoning` TEXT NULL,
  `outcome_3d` JSON NULL,
  `outcome_7d` JSON NULL,
  `verdict` VARCHAR(20) NULL,
  `is_deleted` TINYINT NOT NULL DEFAULT 0,
  `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  UNIQUE INDEX `uk_adj_decision_id`(`decision_id`),
  INDEX `idx_adj_user_created`(`user_id`, `created_at`),
  INDEX `idx_adj_campaign_created`(`campaign_id`, `created_at`),
  INDEX `idx_adj_verdict`(`verdict`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
