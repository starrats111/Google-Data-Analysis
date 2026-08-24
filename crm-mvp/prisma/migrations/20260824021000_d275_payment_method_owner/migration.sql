-- D-275：payment_methods 增加归属人字段
-- NULL=组长维护的团队级收款方式（存量行全部保持 NULL，行为不变）
-- 非空=组员个人自填（yz 组模式：组长未维护清单时，组员在个人设置自填银行卡），仅本人可见可绑
ALTER TABLE `payment_methods` ADD COLUMN `owner_user_id` BIGINT UNSIGNED NULL AFTER `team_id`;
