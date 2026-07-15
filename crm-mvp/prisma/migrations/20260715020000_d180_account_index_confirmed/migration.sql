-- D-180：联盟序号（account_index）用户确认机制。
-- 新增确认时间列：NULL=未确认（含存量自动分配、多连接未核对）；有值=用户已确认或单连接平台系统自动确认。
-- 存量一律视为未确认（不回填），多连接用户上线后首次登录强制确认一次。
ALTER TABLE `platform_connections` ADD COLUMN `account_index_confirmed_at` DATETIME NULL;
