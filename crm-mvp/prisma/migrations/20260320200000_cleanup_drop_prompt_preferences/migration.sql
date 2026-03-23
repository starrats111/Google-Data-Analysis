-- 部署前清理：删除已弃用的 prompt_preferences 表
-- 补齐 Schema 与迁移不一致的字段

-- 1. 删除 prompt_preferences 表
DROP TABLE IF EXISTS `prompt_preferences`;

-- 2. 补齐 users.plain_password（Schema 有、迁移缺失）
ALTER TABLE `users` ADD COLUMN `plain_password` VARCHAR(128) DEFAULT NULL;

-- 3. 补齐 platform_connections.account_name（Schema 有、迁移缺失）
ALTER TABLE `platform_connections` ADD COLUMN `account_name` VARCHAR(32) NOT NULL DEFAULT '';
