-- CreateTable: exchange_rate_snapshots
CREATE TABLE `exchange_rate_snapshots` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `currency` VARCHAR(8) NOT NULL,
    `date` DATE NOT NULL,
    `rate_to_usd` DECIMAL(14, 8) NOT NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `uk_currency_date`(`currency`, `date`),
    INDEX `idx_currency`(`currency`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Fix naming_prefix: remove 'wj' default, clear existing values
ALTER TABLE `ad_default_settings` ALTER COLUMN `naming_prefix` SET DEFAULT '';
UPDATE `ad_default_settings` SET `naming_prefix` = '' WHERE `naming_prefix` = 'wj';

-- Remove .html from article_html_pattern (static patterns only, not SPA ?-style)
UPDATE `publish_sites`
SET `article_html_pattern` = REPLACE(`article_html_pattern`, '.html', '')
WHERE `article_html_pattern` LIKE '%.html'
  AND `article_html_pattern` NOT LIKE '%?%';

-- Remove .html from already-published article URLs
UPDATE `articles`
SET `published_url` = REPLACE(`published_url`, '.html', '')
WHERE `published_url` LIKE '%.html'
  AND `published_url` NOT LIKE '%?%'
  AND `is_deleted` = 0;
