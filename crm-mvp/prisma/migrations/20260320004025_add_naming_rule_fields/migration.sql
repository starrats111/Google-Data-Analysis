-- AlterTable
ALTER TABLE `ad_default_settings` ADD COLUMN `naming_prefix` VARCHAR(10) NOT NULL DEFAULT 'wj',
    ADD COLUMN `naming_rule` VARCHAR(20) NOT NULL DEFAULT 'global';
