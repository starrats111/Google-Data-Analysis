-- D-218 补两个热路径缺失索引（07 于 2026-08-05 生产体检后选定）
--
-- 证据：/var/log/mysql/slow.log（覆盖 7/24 至今）经 mysqldumpslow -s t 排序。
--
-- 一、user_merchants.merchant_name
-- admin/merchant-sheet 同步推荐商家时，对每个新推荐商家执行
--   SELECT id FROM user_merchants WHERE is_deleted=? AND merchant_name=? AND recommendation_status<>?
-- 该表 163 万行 / 1.9GB，现有 7 个索引全部以 user_id 或 merchant_id 打头，
-- 这句只能全表扫描：单次 29.05s，56 次累计 1626s。
--
-- 二、suffix_pool.expires_at
-- suffix-replenish 每 5 分钟一轮的过期回收
--   UPDATE suffix_pool SET status='expired' WHERE status=? AND is_deleted=? AND expires_at < ?
-- 只有 (campaign_id,status) 和 (user_id,status) 可用，按 status 前缀取出后逐行比时间：
-- 每轮扫 27 万行 / 3.68s，837 次累计 3082s。
--
-- 两条都是 InnoDB ONLINE DDL（INPLACE + 允许并发 DML），不锁写。
-- 但 user_merchants 体积大、生产机只有 2 核，建索引期间 IO 会吃紧，
-- 部署走 GitHub Actions 的 prisma migrate deploy，注意盯 free -m / df -h。

CREATE INDEX `idx_merchant_name` ON `user_merchants` (`merchant_name`);

CREATE INDEX `idx_expires_at` ON `suffix_pool` (`expires_at`);
