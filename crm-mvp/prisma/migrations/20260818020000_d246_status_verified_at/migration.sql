-- D-246：暂停/启用后被过期 Sheet 快照翻回的修复
-- campaigns.status_verified_at = CRM 实时 mutate Google 成功的确认时间；
-- Sheet 快照类同步在信任窗口内（默认 90 分钟）不覆盖该系列状态
ALTER TABLE `campaigns` ADD COLUMN `status_verified_at` DATETIME(0) NULL;
