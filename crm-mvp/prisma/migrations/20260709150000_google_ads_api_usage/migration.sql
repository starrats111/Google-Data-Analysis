-- 批次5：Google Ads API 配额审计账本（日+token+MCC+CID+操作类型 聚合）
CREATE TABLE `google_ads_api_usage` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `date` DATE NOT NULL,
  `token` VARCHAR(64) NOT NULL,
  `mcc_id` VARCHAR(32) NOT NULL,
  `customer_id` VARCHAR(32) NOT NULL DEFAULT '',
  `kind` VARCHAR(16) NOT NULL DEFAULT 'query',
  `requests` INT UNSIGNED NOT NULL DEFAULT 0,
  `rate_limited` INT UNSIGNED NOT NULL DEFAULT 0,
  `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  UNIQUE INDEX `uk_gaau_key`(`date`, `token`, `mcc_id`, `customer_id`, `kind`),
  INDEX `idx_gaau_date_mcc`(`date`, `mcc_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
