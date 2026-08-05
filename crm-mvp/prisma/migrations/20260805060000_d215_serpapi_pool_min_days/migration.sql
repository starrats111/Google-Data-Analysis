-- D-215 SerpApi 共享 key 池 + 关注阈值统一为 15 天（07 于 2026-08-05 拍板）
--
-- 一、共享 key 池
-- 原先每处都按 user_id 取自己的 key（user_serpapi_keys.user_id），
-- 某个用户额度用完，他关注的广告主就全废，别人富余的额度也调不动。
-- 实测：36 个关注的广告主近 7 天只有 8 个扫出数据，9 个 key 分属 7 个用户。
-- 改成全局取池后加两列，用来把「这个 key 这个月已经打满了」这件事记下来，
-- 免得每轮扫描都拿同一个废 key 反复撞墙（SerpApi 额度按月重置，但也可能是每小时限流，
-- 故用冷却窗口而非直接封到月底，可自愈）。
--
-- 二、min_days 统一 15
-- D-213 推荐列表按「同行投够 15 天」收录，而关注列表的推送阈值还是 30（73 条）和 7（6 条），
-- 两套口径并存会让人看不懂「为什么推荐里有的商家从没推送过」。统一成 15。
-- 存量数据一并改，默认值同时下调，避免以后新增关注又回到 30。

ALTER TABLE `user_serpapi_keys`
  ADD COLUMN `exhausted_at` DATETIME NULL AFTER `is_deleted`,
  ADD COLUMN `exhausted_msg` VARCHAR(255) NULL AFTER `exhausted_at`,
  ADD INDEX `idx_pool_pick` (`is_active`, `is_deleted`, `exhausted_at`);

ALTER TABLE `user_atc_watchlist`
  ALTER COLUMN `min_days` SET DEFAULT 15;

ALTER TABLE `users`
  ALTER COLUMN `atc_default_min_days` SET DEFAULT 15;

UPDATE `user_atc_watchlist` SET `min_days` = 15 WHERE `is_deleted` = 0 AND `min_days` <> 15;

UPDATE `users` SET `atc_default_min_days` = 15 WHERE `is_deleted` = 0 AND `atc_default_min_days` <> 15;
