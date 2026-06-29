-- 需求2：转化率(订单/点击)控制区间，员工可在换链接页配置。默认 5%~10%（= 每订单 10~20 次点击）。
ALTER TABLE `users`
  ADD COLUMN `click_control_ratio_min_pct` TINYINT NOT NULL DEFAULT 5 AFTER `click_control_enabled`,
  ADD COLUMN `click_control_ratio_max_pct` TINYINT NOT NULL DEFAULT 10 AFTER `click_control_ratio_min_pct`;
