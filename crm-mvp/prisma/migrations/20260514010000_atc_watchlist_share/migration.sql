-- C-094.6 给 user_atc_watchlist 增加 is_shared 字段 + 索引
-- 员工可把自己关注的广告主切换为「分享」状态, 让团队其他人在「推荐广告主」tab 看到

ALTER TABLE `user_atc_watchlist`
  ADD COLUMN `is_shared` TINYINT NOT NULL DEFAULT 0 AFTER `min_days`;

CREATE INDEX `idx_shared_deleted` ON `user_atc_watchlist` (`is_shared`, `is_deleted`);
