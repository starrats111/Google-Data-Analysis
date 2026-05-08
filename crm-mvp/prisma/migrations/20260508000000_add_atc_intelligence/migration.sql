-- ATC 广告情报系统并入迁移
-- 新增字段：users.serpapi_key
ALTER TABLE `users`
  ADD COLUMN `serpapi_key` VARCHAR(128) NULL COMMENT '个人 SerpApi API Key（广告情报功能）';

-- 新增字段：user_merchants ATC 相关
ALTER TABLE `user_merchants`
  ADD COLUMN `atc_advertiser_count` INT UNSIGNED NULL          COMMENT 'ATC 真实广告主数（已过滤商家自身和代理商）',
  ADD COLUMN `atc_last_synced_at`   DATETIME NULL              COMMENT '最后 ATC 同步时间',
  ADD COLUMN `atc_sync_status`      VARCHAR(16) DEFAULT 'idle' COMMENT 'idle / syncing / done / error';

-- 新建表：ATC 团队共享缓存
CREATE TABLE `merchant_atc_snapshots` (
  `id`                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `domain`                VARCHAR(255) NOT NULL,
  `region`                VARCHAR(8)   NOT NULL DEFAULT 'US',
  `raw_advertiser_count`  INT UNSIGNED DEFAULT 0,
  `real_advertiser_count` INT UNSIGNED DEFAULT 0,
  `top_advertisers_json`  JSON NULL,
  `sample_ads_json`       JSON NULL,
  `fetched_at`            DATETIME NOT NULL,
  `created_at`            DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at`            DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_domain_region` (`domain`, `region`)
);

-- 新建表：监控告警规则（Phase 2 预建）
CREATE TABLE `merchant_monitor_rules` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_id`          BIGINT UNSIGNED NOT NULL,
  `user_merchant_id` BIGINT UNSIGNED NOT NULL,
  `rule_type`        VARCHAR(32) NOT NULL,
  `threshold_pct`    TINYINT UNSIGNED DEFAULT 20,
  `is_active`        TINYINT DEFAULT 1,
  `is_deleted`       TINYINT DEFAULT 0,
  `created_at`       DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY `idx_user` (`user_id`)
);
