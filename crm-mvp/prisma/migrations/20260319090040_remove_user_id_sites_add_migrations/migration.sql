-- 1. platform_connections: 删除 api_secret 和 publisher_id，添加 publish_site_id
ALTER TABLE `platform_connections` DROP COLUMN `api_secret`;
ALTER TABLE `platform_connections` DROP COLUMN `publisher_id`;
ALTER TABLE `platform_connections` ADD COLUMN `publish_site_id` BIGINT UNSIGNED NULL;

-- 2. publish_sites: 删除 user_id，添加 domain 唯一约束
ALTER TABLE `publish_sites` DROP INDEX `idx_user`;
ALTER TABLE `publish_sites` DROP COLUMN `user_id`;
ALTER TABLE `publish_sites` ADD UNIQUE INDEX `publish_sites_domain_key` (`domain`);

-- 3. 创建站点迁移任务表
CREATE TABLE `site_migrations` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `site_id`       BIGINT UNSIGNED NULL,
  `domain`        VARCHAR(200) NOT NULL,
  `source_type`   VARCHAR(16) NOT NULL,
  `source_ref`    VARCHAR(512) NULL,
  `status`        VARCHAR(16) NOT NULL DEFAULT 'pending',
  `progress`      TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `step_detail`   TEXT NULL,
  `error_message` TEXT NULL,
  `started_at`    DATETIME NULL,
  `finished_at`   DATETIME NULL,
  `created_by`    BIGINT UNSIGNED NOT NULL,
  `is_deleted`    TINYINT NOT NULL DEFAULT 0,
  `created_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_migration_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
