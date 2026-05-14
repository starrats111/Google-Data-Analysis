-- 我的广告主-全局阈值：每个用户只有一个 default，新增关注 / 统一设置时使用
ALTER TABLE `users`
  ADD COLUMN `atc_default_min_days` INT UNSIGNED NOT NULL DEFAULT 30
  AFTER `serpapi_key`;
