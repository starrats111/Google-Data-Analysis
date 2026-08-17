-- D-239 数据中心自定义列展示：表格列偏好表
-- 每用户 × 每表格一条，config 存可见列 key 的有序数组 { columns: string[] }

CREATE TABLE `user_table_preferences` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `table_key` VARCHAR(64) NOT NULL,
  `config` JSON NULL,
  `is_deleted` TINYINT NOT NULL DEFAULT 0,
  `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_user_table` (`user_id`, `table_key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
