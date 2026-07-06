-- Token 池升级：token 与 Service Account JSON 配对存储 + 每日配额 + 每日用量表
ALTER TABLE `team_developer_tokens`
  ADD COLUMN `service_account_json` TEXT NULL AFTER `token`,
  ADD COLUMN `daily_quota` INT UNSIGNED NOT NULL DEFAULT 15000 AFTER `service_account_json`;

CREATE TABLE `token_usage_daily` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `token` VARCHAR(64) NOT NULL,
  `date` DATE NOT NULL,
  `requests` INT UNSIGNED NOT NULL DEFAULT 0,
  `mcc_ids` TEXT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_tud_token_date` (`token`, `date`)
) ENGINE = InnoDB;
