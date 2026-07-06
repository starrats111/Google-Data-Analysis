-- 团队 Developer Token 池：组长配置，Google Ads API 429 时轮询换 token
CREATE TABLE `team_developer_tokens` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `team_id` BIGINT UNSIGNED NOT NULL,
  `token` VARCHAR(64) NOT NULL,
  `label` VARCHAR(64) NULL,
  `is_active` TINYINT NOT NULL DEFAULT 1,
  `created_by` BIGINT UNSIGNED NULL,
  `is_deleted` TINYINT NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_tdt_team` (`team_id`, `is_deleted`)
) ENGINE = InnoDB;
