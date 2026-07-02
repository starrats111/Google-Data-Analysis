-- 广告提交后台任务表
-- 把 /api/user/ad-creation/submit 从「长连接同步请求」解耦为「后台任务 + 短轮询」：
-- 核心逻辑（AI 合规返工 + 图片处理 + Google Ads mutate）单次可耗时 >2min，超过 Cloudflare
-- ~100s 边缘超时会返回 HTML 524，前端按 JSON 解析报 Unexpected token '<'。改为后台跑完落库、
-- 前端轮询 /submit-status 读取结果，彻底绕开边缘超时。

CREATE TABLE `ad_submit_jobs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `campaign_id` BIGINT UNSIGNED NOT NULL,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `payload` JSON NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'queued',
  `http_status` SMALLINT NOT NULL DEFAULT 0,
  `result` JSON NULL,
  `error` TEXT NULL,
  `attempt` TINYINT NOT NULL DEFAULT 0,
  `heartbeat_at` DATETIME NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_submit_campaign_status` (`campaign_id`, `status`),
  KEY `idx_submit_status` (`status`)
) ENGINE = InnoDB;
