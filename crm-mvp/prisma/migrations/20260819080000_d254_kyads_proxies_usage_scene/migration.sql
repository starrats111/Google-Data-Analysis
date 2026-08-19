-- D-254 admin proxies list revamp: add usage_scene display field to kyads_proxies
ALTER TABLE `kyads_proxies` ADD COLUMN `usage_scene` VARCHAR(64) NULL AFTER `session_mode`;

-- Backfill existing providers: all current proxies serve the link-exchange engine
UPDATE `kyads_proxies` SET `usage_scene` = '换链接' WHERE `usage_scene` IS NULL AND `is_deleted` = 0;
