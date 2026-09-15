-- D-336：为「商家×平台」维度的佣金聚合补索引。
--
-- 背景：我的商家 / 选取商家两个 tab 新增「待审核佣金」列（只做 LB），按
-- (platform, merchant_id) 聚合 affiliate_transactions。原有索引都以 user_id 或
-- platform_connection_id 开头，唯一以 platform 开头的 uk_platform_txn 第二列是
-- transaction_id，接不上 merchant_id —— 于是该聚合走全表扫描：
--   EXPLAIN → type: ALL, key: NULL, rows: 742383（实测 170ms 冷热一致）
-- 为聚合 58,894 行 LB 数据扫 742,383 行全表，且这条查询在商家页热路径上，
-- 每个员工每次翻页都会走一次。生产机 3.66GB 常年 swap，不能放全表扫描进去。
--
-- 为什么不用 FORCE INDEX (uk_platform_txn) 绕过：实测 1118ms，比全表扫描还慢 6 倍。
-- 该索引能按 platform 定位，但第二列不是 merchant_id，命中 133,902 行后要逐行回表
-- 随机 IO —— 在 swap 的机器上代价远高于顺序全扫。优化器不选它是对的。
--
-- 本索引 (platform, merchant_id) 让同一聚合走 range 扫描。预估体积 15–20MB
-- （该表现有索引合计 187MB，数据 123MB）。
--
-- ALGORITHM=INPLACE, LOCK=NONE：online DDL，不阻塞读写。这两个子句是显式声明而非
-- 优化建议 —— 若 MariaDB 无法以该方式执行会直接报错，而不是悄悄降级成锁表重建，
-- 这正是我们想要的（宁可失败也不要在生产上静默锁表）。
--
-- 注意写法：MariaDB 10.11 的 `CREATE INDEX` **不接受** ALGORITHM 前的逗号
-- （`CREATE INDEX ... (cols), ALGORITHM=INPLACE` 报 ERROR 1064），带逗号是
-- ALTER TABLE 的语法。这里用 ALTER TABLE 形式，已在克隆表上验证通过。
ALTER TABLE `affiliate_transactions`
  ADD INDEX `idx_platform_merchant` (`platform`, `merchant_id`),
  ALGORITHM=INPLACE, LOCK=NONE;
