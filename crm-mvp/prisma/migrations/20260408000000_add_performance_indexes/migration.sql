-- Performance optimization: add missing indexes

-- campaigns: replace idx_user with composite covering is_deleted
DROP INDEX `idx_user` ON `campaigns`;
CREATE INDEX `idx_user` ON `campaigns`(`user_id`, `is_deleted`);
CREATE INDEX `idx_user_status_del` ON `campaigns`(`user_id`, `status`, `is_deleted`);
CREATE INDEX `idx_user_mcc` ON `campaigns`(`user_id`, `mcc_id`);

-- user_merchants: add composite index for merchant lookup and violation status
CREATE INDEX `idx_user_plat_mid` ON `user_merchants`(`user_id`, `platform`, `merchant_id`);
CREATE INDEX `idx_violation_status` ON `user_merchants`(`violation_status`);

-- articles: add indexes for site and merchant+status queries
CREATE INDEX `idx_merchant_status` ON `articles`(`user_merchant_id`, `status`);
CREATE INDEX `idx_site_del` ON `articles`(`publish_site_id`, `is_deleted`);

-- kyads_click_tasks: add campaign_id index
CREATE INDEX `idx_campaign` ON `kyads_click_tasks`(`campaign_id`);

-- exchange_rate_snapshots: remove redundant index (covered by uk_currency_date)
DROP INDEX `idx_currency` ON `exchange_rate_snapshots`;
