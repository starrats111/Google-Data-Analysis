-- R-01/02/03 月度收支报表重构：
--   payment_methods            组长维护的「收款人+卡号」清单
--   report_overrides           手填覆盖值（组员广告费 / 组员实收纠正 / 组长实际佣金CNY）
--   payment_binding_snapshots  收款方式绑定的历史月固化快照
--   platform_connections.payment_method_id 组员按联盟账号绑定收款方式（payee 文本字段弃用）

CREATE TABLE `payment_methods` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `team_id` BIGINT UNSIGNED NOT NULL,
  `payee_name` VARCHAR(64) NOT NULL,
  `card_no` VARCHAR(64) NOT NULL,
  `is_deleted` TINYINT NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_pm_team` (`team_id`, `is_deleted`)
) ENGINE = InnoDB;

CREATE TABLE `report_overrides` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `month` VARCHAR(7) NOT NULL,
  `scope_key` VARCHAR(64) NOT NULL,
  `value` DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
  `remark` VARCHAR(200) NULL,
  `updated_by` BIGINT UNSIGNED NULL,
  `is_deleted` TINYINT NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_ro_user_month_scope` (`user_id`, `month`, `scope_key`),
  KEY `idx_ro_month` (`month`)
) ENGINE = InnoDB;

CREATE TABLE `payment_binding_snapshots` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `month` VARCHAR(7) NOT NULL,
  `platform` VARCHAR(8) NOT NULL,
  `account_name` VARCHAR(32) NOT NULL,
  `payee_name` VARCHAR(64) NOT NULL DEFAULT '',
  `card_no` VARCHAR(64) NOT NULL DEFAULT '',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_pbs_user_month_acct` (`user_id`, `month`, `platform`, `account_name`)
) ENGINE = InnoDB;

ALTER TABLE `platform_connections`
  ADD COLUMN `payment_method_id` BIGINT UNSIGNED NULL AFTER `payee`;
