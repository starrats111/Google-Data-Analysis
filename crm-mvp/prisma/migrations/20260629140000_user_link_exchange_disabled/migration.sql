-- 用户级「只同步数据、不参与换链接」标记（jy 交垟队等）。
-- 1=不参与换链：从 Google 回填的新广告不自动开换链，UI 也禁止开启。
ALTER TABLE `users` ADD COLUMN `link_exchange_disabled` TINYINT NOT NULL DEFAULT 0;
