-- D-166：主营业务（category）人工修正标记。
-- 1=该商家主营业务被人工修改过（编辑时已按同域名/同MID全系统同步更正），
-- 之后的平台商家同步（用户同步 / 管理员同步）不再用 API 返回值覆盖 category，
-- 其余字段（佣金率/地区/链接等）照常更新。
ALTER TABLE `user_merchants` ADD COLUMN `category_manual` TINYINT NOT NULL DEFAULT 0;
