-- kylink 关联：记录 API Key 对应的 kylink 账号标识（邮箱/姓名），便于辨认绑定的是谁
ALTER TABLE `users` ADD COLUMN `kylink_username` VARCHAR(255) NULL;
