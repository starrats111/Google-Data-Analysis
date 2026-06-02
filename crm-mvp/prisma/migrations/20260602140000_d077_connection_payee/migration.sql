-- D-077: 平台连接新增收款人字段
ALTER TABLE `platform_connections` ADD COLUMN `payee` VARCHAR(64) NULL AFTER `channel_id`;
