-- D-333：剖分产出的行级 sign_id 持久化。
--
-- 背景：RW/LH/LB 的交易API 不返回打款状态，paid 桶只能靠支付明细API 逐打款单展开出
-- sign_id 后剖分回填。这批 sign_id 是整条链路上唯一昂贵的产出（逐单外部请求），
-- 原先用完即丢 —— 于是 txn-quick-sync（每 30 分钟、14 天窗口）把 paid 行打回
-- approved/pending 之后，除了等下一次全量剖分别无恢复手段。落库之后
-- restorePaidAfterSync() 能用一条 set-based UPDATE 零外部请求地自愈。
--
-- sign_id 对应 affiliate_transactions.transaction_id（平台内唯一）。
-- 只存「有已付打款单佐证」的 id，是个只增不减的白名单：打款一旦发生就不会撤销，
-- 所以不需要清理逻辑；重复剖分靠 INSERT IGNORE 幂等。
CREATE TABLE IF NOT EXISTS `affiliate_paid_signids` (
  `platform` VARCHAR(8) NOT NULL,
  `sign_id` VARCHAR(128) NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`platform`, `sign_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
