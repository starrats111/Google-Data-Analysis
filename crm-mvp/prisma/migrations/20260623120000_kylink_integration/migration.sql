-- kylink 集成：在 users 表新增 kylink 个人 API Key 与关联时间。
-- 用途：CRM 每小时把用户商家库的联盟链接自动喂给 kylink（换链接系统）未配置的广告系列。
-- Key 为明文存储，与 script_api_key 一致。
ALTER TABLE `users`
  ADD COLUMN `kylink_api_key` VARCHAR(64) NULL COMMENT 'kylink 个人 API Key（ky_live_xxx）',
  ADD COLUMN `kylink_linked_at` DATETIME NULL COMMENT '最近一次成功连接 kylink 的时间';
