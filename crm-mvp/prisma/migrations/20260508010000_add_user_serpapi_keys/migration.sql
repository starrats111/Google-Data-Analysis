-- 新建表：用户 SerpApi Key 多账号池
-- 支持每人配置多个 Key，系统随机选取使用，叠加免费额度
CREATE TABLE `user_serpapi_keys` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_id`    BIGINT UNSIGNED NOT NULL,
  `key_name`   VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '用户自定义备注名',
  `api_key`    VARCHAR(128) NOT NULL,
  `is_active`  TINYINT DEFAULT 1,
  `is_deleted` TINYINT DEFAULT 0,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY `idx_user_active` (`user_id`, `is_active`)
);

-- 将旧的 users.serpapi_key 数据迁移到新表（有值的行）
INSERT INTO `user_serpapi_keys` (`user_id`, `key_name`, `api_key`)
SELECT `id`, 'Key 1', `serpapi_key`
FROM `users`
WHERE `serpapi_key` IS NOT NULL AND `serpapi_key` != '';
