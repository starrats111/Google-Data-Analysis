-- D-177（采纳 kyads 验证链接思路）：失败冷却落库，治「进程内冷却被 pm2 重启清零 → 死链系列死循环重烧代理流量」。
-- suffix_fail_count：连续「疑似死链」硬失败（no_tracking 且落地域名与商家域名不匹配 / resolve_failed）计数，
--                    成功或「域名匹配的活链」判定时清零；达阈值(3)才升级 invalid_link 告警 + 长冷却(8h)。
-- suffix_cooldown_until：补货冷却截止时间，此前该系列不被 cron 补货选中（proxy_unavailable 10min / 活链 30min / 疑似死链 8h）。
ALTER TABLE `campaigns`
  ADD COLUMN `suffix_fail_count` INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN `suffix_cooldown_until` DATETIME NULL;
