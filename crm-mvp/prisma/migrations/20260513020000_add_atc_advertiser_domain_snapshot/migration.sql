-- C-093 广告主域名分布快照（团队级共享，TTL 7 天）
-- 用于判定一个 advertiser 是「同行联盟客（多域名）」还是「品牌自投（单域名）」
-- 每次反查消耗 1 次 SerpApi，缓存后整个团队共享

CREATE TABLE `atc_advertiser_domain_snapshot` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `advertiser_id` VARCHAR(64) NOT NULL,
  `region` VARCHAR(8) NOT NULL DEFAULT 'US',
  `advertiser_name` VARCHAR(255) NULL,
  `unique_domain_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `ad_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `domains_json` JSON NULL,
  `fetched_at` DATETIME NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_advertiser_region` (`advertiser_id`, `region`),
  KEY `idx_fetched_at` (`fetched_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
