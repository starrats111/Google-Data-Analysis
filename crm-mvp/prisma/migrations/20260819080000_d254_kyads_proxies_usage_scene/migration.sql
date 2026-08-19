-- D-254 管理员代理管理列表改版：kyads_proxies 新增「应用场景」展示字段
ALTER TABLE `kyads_proxies` ADD COLUMN `usage_scene` VARCHAR(64) NULL AFTER `session_mode`;

-- 存量供应商回填：当前所有代理均服务换链接引擎（Suffix 补货 / 刷点击）
UPDATE `kyads_proxies` SET `usage_scene` = '换链接' WHERE `usage_scene` IS NULL AND `is_deleted` = 0;
