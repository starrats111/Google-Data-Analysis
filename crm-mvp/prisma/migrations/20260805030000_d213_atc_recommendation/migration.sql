-- D-213 打通「ATC 追踪广告主」→「推荐商家」，让推荐列表每天自动更新。
--
-- 背景：徐克要求「推荐列表除官方给的，每天要定时获取别人已经在跑 2 周以上的商家」。
-- 每日 cron atc-watchlist-scan 其实一直在产出这批数据（8-05 当天仍写入 234 条），
-- 但落库时把域名丢了——user_atc_alert_log 只存 creative_id 和 days，
-- 唯一带 domain 的地方是 notifications.metadata 那段 JSON：
--   {"source":"atc_watchlist","days":147,"domain":"vennskincare.com","domain_source":"meta",...}
-- 通知表是给人看的、会被清理，不能当数据源用，故把 domain 提到 alert_log 本表。
--
-- merchant_recommendations 侧新增三列区分「系统发现」与官方录入：
--   atc_domain    重算时按域名去重（比 merchant_name 稳，不受重名和大小写影响）
--   atc_days      同行已投放天数，前端这一档按它降序（官方那档没有 EPC 以外的排序依据）
--   atc_last_seen 最后一次确认还在投，配合每日重算把停投的商家软删下架
-- source 沿用既有字段，取值 'atc'，与 sheets / excel 互不干扰，重算只动自己这批。

ALTER TABLE `user_atc_alert_log`
  ADD COLUMN `domain` VARCHAR(255) NULL AFTER `days`,
  ADD INDEX `idx_domain_date` (`domain`, `alerted_date`);

ALTER TABLE `merchant_recommendations`
  ADD COLUMN `atc_domain` VARCHAR(255) NULL AFTER `avg_order_commission`,
  ADD COLUMN `atc_days` INT UNSIGNED NULL AFTER `atc_domain`,
  ADD COLUMN `atc_last_seen` DATE NULL AFTER `atc_days`,
  ADD INDEX `idx_rec_atc_domain` (`atc_domain`);
