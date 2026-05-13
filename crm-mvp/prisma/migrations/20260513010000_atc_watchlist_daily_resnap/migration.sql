-- C-089 v2：watchlist 推送规则收紧（07 二次反馈）
-- 1. min_days 默认值 15 → 30（明确要求）
-- 2. 防重逻辑从"全局只推一次"改成"每天可重推一次"，配合「last_shown 是 CST 昨天」过滤实现日报语义
--    旧：uk_user_creative (user_id, creative_id)
--    新：uk_user_creative_date (user_id, creative_id, alerted_date)

-- 调 default 30
ALTER TABLE `user_atc_watchlist`
  MODIFY COLUMN `min_days` INT NOT NULL DEFAULT 30 COMMENT '推送累计天数阈值（v2：默认 30）';

-- 加 alerted_date 列（先允许 NULL，避免与历史空表/已有行冲突；之后改 NOT NULL）
ALTER TABLE `user_atc_alert_log`
  ADD COLUMN `alerted_date` DATE NULL AFTER `days`;

-- 已有行（若有）填上 alerted_at 的日期作为 alerted_date
UPDATE `user_atc_alert_log` SET `alerted_date` = DATE(`alerted_at`) WHERE `alerted_date` IS NULL;

-- 改为 NOT NULL
ALTER TABLE `user_atc_alert_log`
  MODIFY COLUMN `alerted_date` DATE NOT NULL COMMENT 'CST 推送日期（v2 日报语义）';

-- 删旧唯一索引、加新组合唯一索引
ALTER TABLE `user_atc_alert_log` DROP INDEX `uk_user_creative`;
ALTER TABLE `user_atc_alert_log`
  ADD UNIQUE KEY `uk_user_creative_date` (`user_id`, `creative_id`, `alerted_date`);
