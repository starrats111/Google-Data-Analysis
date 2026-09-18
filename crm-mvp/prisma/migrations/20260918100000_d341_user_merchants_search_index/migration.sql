-- D-341：补建「选取商家」搜索索引 idx_um_avail_search（幂等）
--
-- 背景（2026-08-31，原 D-301）：
--   「我的商家 / 选取商家」搜索一个稀有词时优化器被 ORDER BY platform, merchant_name + LIMIT
--   骗去走 idx_merchant_name 做全索引扫描，扫穿 187 万行，实测 288s 未返回。
--   当时手工在生产上建了这条索引救急，查询恢复到秒级；但那次的代码与 schema.prisma 始终
--   没有并进 main，索引就此成了「生产上有、仓库里没有」的孤儿。
--   后果：任何一次 prisma db push 或新迁移都可能把它当多余索引删掉，故障复活。
--
-- 本迁移只做一件事：把这条索引正式落户到版本库。
--   - 生产上索引已存在 → information_schema 判定为已有，整条 DDL 退化成 DO 0，不动数据。
--   - 其他环境（本地 / 新库）没有 → 正常创建。
--   两边执行完的最终状态一致，且可重复执行。
--
-- 列序说明：user_id, status, is_deleted 三个等值条件在前，platform 供等值或排序，
-- 末位 merchant_name 直接提供 ORDER BY 需要的顺序，避免 filesort。

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
