-- 扩展 merchant_recommendations 表，支持 Excel 批量导入推荐商家
ALTER TABLE `merchant_recommendations`
  ADD COLUMN `source`                VARCHAR(16)    NOT NULL DEFAULT 'sheets' COMMENT 'sheets / excel' AFTER `upload_batch`,
  ADD COLUMN `mcid`                  VARCHAR(64)    NULL COMMENT '平台内部商家代码' AFTER `source`,
  ADD COLUMN `mid`                   VARCHAR(64)    NULL COMMENT '数字型商家 ID' AFTER `mcid`,
  ADD COLUMN `affiliate`             VARCHAR(128)   NULL COMMENT '所属联盟平台（Impact/Rakuten/PHG 等）' AFTER `mid`,
  ADD COLUMN `website`               VARCHAR(512)   NULL COMMENT '商家官网' AFTER `affiliate`,
  ADD COLUMN `merchant_base`         VARCHAR(128)   NULL COMMENT '商家地区（如 US/GB/CA）' AFTER `website`,
  ADD COLUMN `epc`                   DECIMAL(12,4)  NULL COMMENT '每次点击收益' AFTER `merchant_base`,
  ADD COLUMN `commission_cap`        VARCHAR(256)   NULL COMMENT '预计最高AFF佣金上限' AFTER `epc`,
  ADD COLUMN `avg_commission_rate`   DECIMAL(12,6)  NULL COMMENT '平均佣金率（Payout，小数）' AFTER `commission_cap`,
  ADD COLUMN `avg_order_commission`  DECIMAL(12,4)  NULL COMMENT '平均带单佣金（Payout，美元）' AFTER `avg_commission_rate`,
  ADD INDEX `idx_rec_mid`    (`mid`),
  ADD INDEX `idx_rec_source` (`source`);
