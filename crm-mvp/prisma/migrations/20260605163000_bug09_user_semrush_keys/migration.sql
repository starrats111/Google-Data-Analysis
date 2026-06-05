-- 方案-09：员工自配 SemRush(3UE) 账号池。每员工各用各账号配额，根治共享账号批量设备超限。
-- 字段对标全局 system_configs.semrush_*（username/password/user_id/api_key/node/database）。密码明文（Q09-d）。
CREATE TABLE `user_semrush_keys` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_id`     BIGINT UNSIGNED NOT NULL,
  `key_name`    VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '用户自定义备注名',
  `username`    VARCHAR(128) NOT NULL COMMENT '3UE 登录用户名',
  `password`    VARCHAR(255) NOT NULL COMMENT '3UE 登录密码(明文)',
  `user_id_3ue` VARCHAR(64)  NOT NULL COMMENT '3UE userId',
  `api_key`     VARCHAR(128) NOT NULL COMMENT '3UE api_key',
  `node`        VARCHAR(8)   NOT NULL DEFAULT '3' COMMENT '节点',
  `database`    VARCHAR(8)   NOT NULL DEFAULT 'us' COMMENT '默认库(按投放国动态覆盖)',
  `is_active`   TINYINT DEFAULT 1,
  `is_deleted`  TINYINT DEFAULT 0,
  `created_at`  DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY `idx_user_active` (`user_id`, `is_active`)
);
