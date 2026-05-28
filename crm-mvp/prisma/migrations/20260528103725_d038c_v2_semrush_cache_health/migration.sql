-- D-038c-v2 I6 + I1 — SemRush 关键词缓存兜底 + 健康检查日志
-- 详见：设计方案.md D-038c-v2 / C-102

-- I6：关键词缓存表（24h TTL，3UE 抽风时回退使用）
CREATE TABLE `semrush_keyword_cache` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `domain`     VARCHAR(255)    NOT NULL,
  `database`   VARCHAR(8)      NOT NULL,
  `payload`    LONGTEXT        NOT NULL,
  `raw_kw_cnt` INT UNSIGNED    NOT NULL DEFAULT 0,
  `cached_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expires_at` DATETIME        NOT NULL,
  `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_domain_db` (`domain`, `database`),
  KEY `idx_expires_at` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- I1：健康检查日志表（每整点 cron 写入，保留 7 天）
CREATE TABLE `semrush_health_logs` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `checked_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `overall`    VARCHAR(16)     NOT NULL,
  `error_type` VARCHAR(32)     DEFAULT NULL,
  `details`    LONGTEXT        DEFAULT NULL,
  `alerted`    TINYINT         NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_checked_at` (`checked_at`),
  KEY `idx_errtype_time` (`error_type`, `checked_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
