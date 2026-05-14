-- 统一 user_atc_watchlist 的 advertiser_id / region collation 到 utf8mb4_unicode_ci，
-- 与 atc_advertiser_domain_snapshot 同列保持一致；否则跨两表 JOIN/NOT EXISTS 会
-- 触发 "Illegal mix of collations" 错误（C-094.6 修可关注列表剔除已关注时发现）。
ALTER TABLE `user_atc_watchlist`
  MODIFY COLUMN `advertiser_id` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  MODIFY COLUMN `region`        VARCHAR(8)  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'US';
