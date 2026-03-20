-- 部署前清理：删除已弃用的 prompt_preferences 表
-- 补齐 Schema 与迁移不一致的字段

-- 1. 删除 prompt_preferences 表
DROP TABLE IF EXISTS `prompt_preferences`;

-- 2. 补齐 users.plain_password（Schema 有、迁移缺失）
ALTER TABLE `users` ADD COLUMN IF NOT EXISTS `plain_password` VARCHAR(128) DEFAULT NULL COMMENT '明文密码（仅管理员可见）' AFTER `password_hash`;

-- 3. 补齐 platform_connections.account_name（Schema 有、迁移缺失）
ALTER TABLE `platform_connections` ADD COLUMN IF NOT EXISTS `account_name` VARCHAR(32) NOT NULL DEFAULT '' COMMENT '账号名称（如 RW1, RW2）' AFTER `platform`;
