-- articles: user_merchant_id 改为可选，添加迁移所需字段
ALTER TABLE `articles` MODIFY COLUMN `user_merchant_id` BIGINT UNSIGNED NULL;
ALTER TABLE `articles` ADD COLUMN `excerpt` TEXT NULL AFTER `content`;
ALTER TABLE `articles` ADD COLUMN `merchant_name` VARCHAR(255) NULL;
ALTER TABLE `articles` ADD COLUMN `tracking_link` VARCHAR(1024) NULL;
ALTER TABLE `articles` ADD COLUMN `meta_title` VARCHAR(512) NULL;
ALTER TABLE `articles` ADD COLUMN `meta_description` TEXT NULL;
