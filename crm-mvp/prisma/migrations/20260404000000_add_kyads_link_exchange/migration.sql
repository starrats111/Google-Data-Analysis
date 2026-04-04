-- 换链接功能相关数据库变更
-- 1. users 表新增字段
ALTER TABLE `users`
  ADD COLUMN `script_api_key` VARCHAR(64) NULL COMMENT 'Google Ads Script 鉴权 Key，格式 ky_live_xxx',
  ADD COLUMN `link_exchange_click_count` INT UNSIGNED NOT NULL DEFAULT 10 COMMENT '换链工作台：上次设置的每广告刷点击数';

CREATE UNIQUE INDEX `uk_script_api_key` ON `users`(`script_api_key`);

-- 2. user_merchants 表新增字段
ALTER TABLE `user_merchants`
  ADD COLUMN `kyads_referer_url` VARCHAR(1024) NULL COMMENT '手动覆盖来路URL（为空则自动取最新已发布文章URL）';

-- 3. campaigns 表新增字段
ALTER TABLE `campaigns`
  ADD COLUMN `suffix_exchange_enabled` TINYINT NOT NULL DEFAULT 1 COMMENT '是否参与换链（可单独关闭）',
  ADD COLUMN `suffix_last_content` TEXT NULL COMMENT '最近一次写入的 Suffix 内容（展示用）',
  ADD COLUMN `suffix_last_apply_at` DATETIME(0) NULL COMMENT '最近换链时间',
  ADD COLUMN `suffix_click_baseline` INT NOT NULL DEFAULT 0 COMMENT '脚本退出前记录的点击数基线',
  ADD COLUMN `suffix_click_checkpoint_at` DATETIME(0) NULL COMMENT '基线记录时间';

-- 4. 代理池表
CREATE TABLE `kyads_proxies` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`       VARCHAR(64) NOT NULL COMMENT '代理名称',
  `priority`   TINYINT NOT NULL DEFAULT 5 COMMENT '优先级，数字越小越优先',
  `host`       VARCHAR(255) NOT NULL COMMENT '代理服务器地址',
  `port`       INT UNSIGNED NOT NULL COMMENT '端口',
  `proxy_type` VARCHAR(8) NOT NULL DEFAULT 'http' COMMENT 'http / socks5',
  `status`     VARCHAR(16) NOT NULL DEFAULT 'active' COMMENT 'active / disabled / testing',
  `is_deleted` TINYINT NOT NULL DEFAULT 0,
  `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_proxy_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 5. 代理与员工分配关系表
CREATE TABLE `kyads_proxy_users` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `proxy_id`   BIGINT UNSIGNED NOT NULL,
  `user_id`    BIGINT UNSIGNED NOT NULL,
  `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_proxy_user` (`proxy_id`, `user_id`),
  INDEX `idx_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 6. Suffix 库存池
CREATE TABLE `suffix_pool` (
  `id`                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`              BIGINT UNSIGNED NOT NULL,
  `campaign_id`          BIGINT UNSIGNED NOT NULL,
  `suffix_content`       TEXT NOT NULL COMMENT 'finalUrlSuffix 字符串',
  `status`               VARCHAR(16) NOT NULL DEFAULT 'available' COMMENT 'available / leased / expired',
  `leased_assignment_id` VARCHAR(64) NULL COMMENT '当前占用的 assignment_id',
  `expires_at`           DATETIME(0) NULL,
  `is_deleted`           TINYINT NOT NULL DEFAULT 0,
  `created_at`           DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_campaign_status` (`campaign_id`, `status`),
  INDEX `idx_user_status` (`user_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 7. Suffix 分配记录
CREATE TABLE `suffix_assignments` (
  `id`                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`              BIGINT UNSIGNED NOT NULL,
  `campaign_id`          BIGINT UNSIGNED NOT NULL,
  `suffix_pool_id`       BIGINT UNSIGNED NULL,
  `assignment_id`        VARCHAR(64) NOT NULL COMMENT 'UUID，返回给 Script',
  `idempotency_key`      VARCHAR(255) NOT NULL COMMENT 'campaignId:clicks:windowStart',
  `clicks_at_assignment` INT UNSIGNED NOT NULL DEFAULT 0,
  `window_start_epoch`   BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `script_instance_id`   VARCHAR(64) NULL,
  `write_success`        TINYINT NULL,
  `write_error_message`  TEXT NULL,
  `reported_at`          DATETIME(0) NULL,
  `meta`                 JSON NULL,
  `is_deleted`           TINYINT NOT NULL DEFAULT 0,
  `created_at`           DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`           DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_assignment_id` (`assignment_id`),
  INDEX `idx_user_created` (`user_id`, `created_at`),
  INDEX `idx_campaign_created` (`campaign_id`, `created_at`),
  INDEX `idx_idempotency_key` (`idempotency_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 8. 点击任务队列
CREATE TABLE `kyads_click_tasks` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`       BIGINT UNSIGNED NOT NULL,
  `campaign_id`   BIGINT UNSIGNED NOT NULL,
  `proxy_id`      BIGINT UNSIGNED NULL,
  `affiliate_url` VARCHAR(1024) NOT NULL,
  `referer_url`   VARCHAR(1024) NOT NULL,
  `target_count`  INT UNSIGNED NOT NULL DEFAULT 10,
  `done_count`    INT UNSIGNED NOT NULL DEFAULT 0,
  `status`        VARCHAR(16) NOT NULL DEFAULT 'pending' COMMENT 'pending / running / done / failed',
  `error_message` TEXT NULL,
  `started_at`    DATETIME(0) NULL,
  `finished_at`   DATETIME(0) NULL,
  `is_deleted`    TINYINT NOT NULL DEFAULT 0,
  `created_at`    DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_user_status` (`user_id`, `status`),
  INDEX `idx_status_created` (`status`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
