-- D-321：广告被 Google 拒登后，员工在 CRM 点「拒登」即把本地状态标为已移除（Google 侧由成员自己移除）。
-- remove_source 非空 = 本地人工移除的终态，所有同步入口不得再把状态冲回 ENABLED/PAUSED。
ALTER TABLE `campaigns` ADD COLUMN `removed_at` DATETIME NULL AFTER `pause_source`;
ALTER TABLE `campaigns` ADD COLUMN `remove_source` VARCHAR(20) NULL AFTER `removed_at`;
