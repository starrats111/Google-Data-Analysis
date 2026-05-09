-- 月度结算追踪表
-- 每用户每月一行，记录该月佣金状态分布与是否已结算
-- pending_count = 0 时自动 is_settled = 1，daily-sync 不再请求该月平台 API

CREATE TABLE `monthly_settlement_status` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `month` VARCHAR(7) NOT NULL,
  `total_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `total_amount` DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
  `pending_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `pending_amount` DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
  `approved_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `approved_amount` DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
  `paid_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `paid_amount` DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
  `rejected_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `rejected_amount` DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
  `is_settled` TINYINT NOT NULL DEFAULT 0,
  `settled_at` DATETIME NULL,
  `last_synced_at` DATETIME NULL,
  `is_deleted` TINYINT NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_month` (`user_id`, `month`),
  KEY `idx_settled_user` (`is_settled`, `user_id`)
) ENGINE = InnoDB;
