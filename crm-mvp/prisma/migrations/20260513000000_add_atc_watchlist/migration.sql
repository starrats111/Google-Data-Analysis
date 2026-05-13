-- C-089 ATC 广告情报二次升级：watchlist + 每日扫描推送
-- 设计文档：设计方案.md C-089 章节

-- 用户关注的广告主（watchlist）
CREATE TABLE `user_atc_watchlist` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`         BIGINT UNSIGNED NOT NULL,
  `advertiser_id`   VARCHAR(64)     NOT NULL COMMENT 'AR... 格式',
  `advertiser_name` VARCHAR(255)    NULL     COMMENT '关注时的名称快照',
  `region`          VARCHAR(8)      NOT NULL DEFAULT 'US',
  `min_days`        INT             NOT NULL DEFAULT 15 COMMENT '触发阈值，加关注时可配',
  `is_deleted`      TINYINT         NOT NULL DEFAULT 0,
  `created_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_adv_region` (`user_id`, `advertiser_id`, `region`),
  KEY `idx_user_deleted` (`user_id`, `is_deleted`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='C-089: 广告情报 watchlist';

-- 防止同一 creative 反复推送的去重日志
CREATE TABLE `user_atc_alert_log` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`       BIGINT UNSIGNED NOT NULL,
  `watchlist_id`  BIGINT UNSIGNED NOT NULL,
  `advertiser_id` VARCHAR(64)     NOT NULL,
  `creative_id`   VARCHAR(64)     NOT NULL,
  `days`          INT             NOT NULL COMMENT '推送当时计算的累计天数',
  `alerted_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_creative` (`user_id`, `creative_id`),
  KEY `idx_watchlist` (`watchlist_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='C-089: 广告情报推送防重日志';
