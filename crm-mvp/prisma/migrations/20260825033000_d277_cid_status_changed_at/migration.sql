-- D-277：账户状态总览——记录 CID 状态最近一次变化时间（UTC），总览页展示「何时被停」
ALTER TABLE `mcc_cid_accounts` ADD COLUMN `status_changed_at` DATETIME NULL;
