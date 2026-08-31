-- D-301：「选取商家」搜索一搜就转圈——ORDER BY 让优化器改走 idx_merchant_name 扫穿全表
--
-- 现场（2026-08-31 09:08，生产 43.156.142.141）：
--   yz08(user_id=30) 在「选取商家」搜 MID 156132，同一条语句在 processlist 里堆了 3 份，
--   最久一条 Sending data 288s 未返回；机器 2 核，load average 7.26，其余接口一起挨饿。
--
-- 语句（Prisma 生成）：
--   SELECT ... FROM user_merchants
--   WHERE user_id=30 AND is_deleted=0 AND status='available' AND platform IN ('RW')
--     AND (merchant_name LIKE '%156132%' OR merchant_id LIKE '%156132%' OR merchant_url LIKE '%156132%')
--   ORDER BY platform ASC, merchant_name ASC LIMIT 50 OFFSET 0
--
-- 同一 WHERE 的三种执行计划实测：
--   带 ORDER BY（真实）          → key=idx_merchant_name，type=index，全索引扫 187 万行 → 288s+ 未结束
--   去掉 ORDER BY                → key=idx_user_source，扫 18926 行            → 0.44s
--   FORCE INDEX(idx_user_status) → key=idx_user_status + filesort，扫 22032 行 → 0.10s
--
-- 成因：优化器看到 ORDER BY + LIMIT 50，赌「顺 merchant_name 索引扫能很快凑够 50 行、省掉排序」。
-- 但搜索词越精确命中越少（156132 在该用户 10247 条 RW 商家里只中 1 条），这个赌必输——
-- 要扫穿整张 187 万行的表才知道只有一条。idx_merchant_name 本身是 D-218 为 admin 推荐商家同步加的，
-- 那条路径受益，这条路径反被它坑。搜索词越稀有越慢，属于全员可复现，不是单个用户的问题。
--
-- 修法：给「选取商家」这条热路径配一条前缀完全匹配的组合索引。
--   user_id / status / is_deleted 是等值条件 → 放前缀；
--   platform 等值或单值 IN → 紧随其后；
--   merchant_name 收尾，正好提供 ORDER BY platform, merchant_name 需要的顺序，连 filesort 一起省掉。
-- 有了它，优化器再没有理由去碰 idx_merchant_name。
--
-- InnoDB ONLINE DDL（INPLACE + 允许并发 DML），不锁写；但 187 万行 / 2 核机器，
-- 建索引期间 IO 吃紧，参照 D-218 的经验盯 free -m / df -h。
--
-- 幂等写法：本次为止血已在生产手工执行过同一条 CREATE INDEX，
-- 后续 migrate deploy 跑到这里必须安静跳过，否则「索引已存在」会把整条部署流水线卡死。

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'user_merchants'
    AND index_name = 'idx_um_avail_search'
);

SET @ddl := IF(@idx_exists = 0,
  'CREATE INDEX `idx_um_avail_search` ON `user_merchants` (`user_id`, `status`, `is_deleted`, `platform`, `merchant_name`)',
  'DO 0'
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
