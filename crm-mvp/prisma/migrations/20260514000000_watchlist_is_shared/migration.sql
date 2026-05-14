-- C-094.6 user_atc_watchlist 加 is_shared 字段：
-- is_shared=1 时该广告主出现在「推荐广告主」列表给其他同事关注
-- idx_shared 加速推荐广告主页的跨用户聚合查询

ALTER TABLE `user_atc_watchlist`
  ADD COLUMN `is_shared` TINYINT NOT NULL DEFAULT 0 AFTER `min_days`,
  ADD INDEX `idx_shared` (`is_shared`, `is_deleted`);
