-- D-374 商家结算率表（丰度/邮政群里定期分享的结算率统计表导入中控）
CREATE TABLE `merchant_settlement_rates` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `platform` VARCHAR(8) NOT NULL,
  `merchant_name` VARCHAR(255) NOT NULL,
  `mid` VARCHAR(64) NULL,
  `order_count` INT UNSIGNED NULL,
  `total_commission` DECIMAL(14, 2) NULL,
  `settlement_rate` DECIMAL(8, 6) NULL,
  `chargeback_rate` DECIMAL(8, 6) NULL,
  `chargeback_amount` DECIMAL(14, 2) NULL,
  `confirmed_amount` DECIMAL(14, 2) NULL,
  `paid_amount` DECIMAL(14, 2) NULL,
  `pending_amount` DECIMAL(14, 2) NULL,
  `order_amount` DECIMAL(14, 2) NULL,
  `remark` VARCHAR(512) NULL,
  `upload_batch` VARCHAR(64) NOT NULL,
  `is_deleted` TINYINT NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_settle_name` (`merchant_name`),
  KEY `idx_settle_platform` (`platform`),
  KEY `idx_settle_rate` (`settlement_rate`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
