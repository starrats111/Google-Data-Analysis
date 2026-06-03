-- D-090 广告生成后台任务表
-- 把广告生成从「长连接 SSE 请求」解耦为「后台任务 + 短轮询」：
-- 服务端 runner 跑完整条生成并把每阶段事件快照写入 result，前端轮询读取。
-- 连接断/刷新/部署重启都不丢结果；启动时把卡在 running 的任务重新入队恢复。

CREATE TABLE `ad_generation_jobs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `campaign_id` BIGINT UNSIGNED NOT NULL,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `types` JSON NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'queued',
  `stage` VARCHAR(32) NULL,
  `progress` TINYINT NOT NULL DEFAULT 0,
  `result` JSON NULL,
  `error` TEXT NULL,
  `attempt` TINYINT NOT NULL DEFAULT 0,
  `heartbeat_at` DATETIME NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_campaign_status` (`campaign_id`, `status`),
  KEY `idx_status` (`status`)
) ENGINE = InnoDB;
