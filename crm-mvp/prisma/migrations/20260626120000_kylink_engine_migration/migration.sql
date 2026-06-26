-- kylink 换链接引擎并入 CRM：代理凭据、出口IP去重、告警中心、库存池补充字段
-- 注意：本迁移由 CI prisma migrate deploy 应用，禁止本地对生产库执行。

-- 1. kyads_proxies 增加 kylink ProxyProvider 凭据字段（补货引擎生成 SOCKS5 用户名/密码）
ALTER TABLE `kyads_proxies`
  ADD COLUMN `username_template` VARCHAR(255) NULL COMMENT '代理用户名模板，支持 {COUNTRY} {session:N} 占位',
  ADD COLUMN `password` VARCHAR(255) NULL COMMENT '代理密码（加密存储）',
  ADD COLUMN `country_code_map` JSON NULL COMMENT '国家代码映射，用户名模板替换用',
  ADD COLUMN `session_mode` VARCHAR(16) NULL COMMENT 'sticky / rotating 会话粘性策略';

-- 2. suffix_pool 增加出口 IP 与来源商家
ALTER TABLE `suffix_pool`
  ADD COLUMN `exit_ip` VARCHAR(64) NULL COMMENT '生成该后缀时代理的出口 IP',
  ADD COLUMN `source_merchant_id` BIGINT UNSIGNED NULL COMMENT '来源商家 user_merchants.id';

-- 3. 代理出口 IP 使用记录（24h 去重）
CREATE TABLE `proxy_exit_ip_usage` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`     BIGINT UNSIGNED NOT NULL,
  `campaign_id` BIGINT UNSIGNED NOT NULL,
  `exit_ip`     VARCHAR(64) NOT NULL,
  `used_at`     DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expires_at`  DATETIME(0) NOT NULL COMMENT '过期时间（默认 used_at + 24h）',
  PRIMARY KEY (`id`),
  INDEX `idx_user_campaign_ip` (`user_id`, `campaign_id`, `exit_ip`),
  INDEX `idx_expires` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4. 换链接告警中心
CREATE TABLE `suffix_alerts` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`      BIGINT UNSIGNED NOT NULL,
  `campaign_id`  BIGINT UNSIGNED NULL,
  `type`         VARCHAR(32) NOT NULL COMMENT 'invalid_link / merchant_not_found / low_stock / replenish_failed',
  `level`        VARCHAR(16) NOT NULL DEFAULT 'warning' COMMENT 'info / warning / error',
  `message`      VARCHAR(500) NOT NULL,
  `context`      JSON NULL,
  `status`       VARCHAR(16) NOT NULL DEFAULT 'open' COMMENT 'open / resolved',
  `occur_count`  INT UNSIGNED NOT NULL DEFAULT 1,
  `last_seen_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `resolved_at`  DATETIME(0) NULL,
  `is_deleted`   TINYINT NOT NULL DEFAULT 0,
  `created_at`   DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`   DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_user_status_type` (`user_id`, `status`, `type`),
  INDEX `idx_campaign_type_status` (`campaign_id`, `type`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
