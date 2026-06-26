-- 换链接「刷点击」改为 kylink 式真人自然点击：按目标国作息曲线把 N 次点击排程到当天，
-- 由 cron 到期执行。新增子项表 kyads_click_task_items 持久化每次点击的计划时间与执行结果。
-- 注意：本迁移由 CI prisma migrate deploy 应用，禁止本地对生产库执行。

CREATE TABLE `kyads_click_task_items` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `task_id`      BIGINT UNSIGNED NOT NULL COMMENT '关联 kyads_click_tasks.id',
  `scheduled_at` DATETIME(0) NOT NULL COMMENT '计划执行时间（按目标国作息曲线分布到当天）',
  `status`       VARCHAR(16) NOT NULL DEFAULT 'pending' COMMENT 'pending / executing / success / failed',
  `exit_ip`      VARCHAR(64) NULL,
  `error`        VARCHAR(500) NULL,
  `executed_at`  DATETIME(0) NULL,
  `duration_ms`  INT UNSIGNED NULL,
  `is_deleted`   TINYINT NOT NULL DEFAULT 0,
  `created_at`   DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`   DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_status_scheduled` (`status`, `scheduled_at`),
  INDEX `idx_task_status` (`task_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
