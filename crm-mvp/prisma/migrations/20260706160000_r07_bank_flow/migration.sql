-- R-07 银行流水：平台总打款入账登记（组长核对每个收款方式的收款 + 手续费自动核算）

CREATE TABLE `bank_flow_entries` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `team_id` BIGINT UNSIGNED NOT NULL,
  `month` VARCHAR(7) NOT NULL,
  `payment_method_id` BIGINT UNSIGNED NOT NULL,
  `txn_at` DATETIME NOT NULL,
  `platform` VARCHAR(8) NOT NULL,
  `counterparty` VARCHAR(128) NOT NULL DEFAULT '',
  `summary` VARCHAR(128) NOT NULL DEFAULT '佣金结算',
  `amount` DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
  `currency` VARCHAR(8) NOT NULL DEFAULT 'CNY',
  `expected_amount` DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
  `fee` DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
  `breakdown` TEXT NULL,
  `remark` VARCHAR(255) NULL,
  `created_by` BIGINT UNSIGNED NULL,
  `is_deleted` TINYINT NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_bfe_team_month` (`team_id`, `month`, `is_deleted`),
  KEY `idx_bfe_method` (`payment_method_id`)
) ENGINE = InnoDB;
