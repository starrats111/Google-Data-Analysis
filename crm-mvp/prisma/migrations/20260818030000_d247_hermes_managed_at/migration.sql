-- D-247：Hermes 在管系列状态主权归 Hermes，CRM 只读不写状态
-- campaigns.hermes_managed_at = 首次被 Hermes push-crm-state 推送触达的时间（永久标记）。
-- 非空时：daily-sync D-034 不回停（跟随 Google），toggle / apply-actions 的 pause 拒绝执行。
-- 存量系列的回填由运维在生产按 Hermes ad_runs 的 gcid 清单一次性执行（Hermes 库在另一台服务器，
-- 迁移内无法跨库 JOIN），新系列靠 Hermes 每 10 分钟的推送自动打标。
ALTER TABLE `campaigns` ADD COLUMN `hermes_managed_at` DATETIME(0) NULL;
