-- 修复花费数据精度问题
-- 将 ads_daily_stats 的 cost / budget / cpc 字段从 Decimal(12,2) 升级为 Decimal(16,6)
-- 原因：每条 campaign×day 记录若各自提前做 toFixed(2) 截断再汇总，会积累舍入误差，
--       导致系统合计与 Google Ads 官方数据存在几美元偏差。
--       6 位小数可完整表示 micros / 1_000_000 的精度（最小单位 $0.000001），
--       从根本上消除写入时的精度丢失。

ALTER TABLE `ads_daily_stats`
  MODIFY COLUMN `budget` DECIMAL(16,6) NULL,
  MODIFY COLUMN `cost`   DECIMAL(16,6) NOT NULL DEFAULT 0.000000,
  MODIFY COLUMN `cpc`    DECIMAL(16,6) NULL;
