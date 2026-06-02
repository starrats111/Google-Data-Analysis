-- D-072 联盟平台「实付/打款」记录表
-- 各平台支付 API（RW/LH 提现、CG/PM/BSH/CF/MUI payment_summary、LB merchant_commission）
-- 拉取的「已支付」记录，平台/账户级。结算页「已支付总额 + 结算率 + 打款记录」的数据来源。
-- 注意：RW/LH 等提现级平台的金额无法拆分到具体商家/交易月，仅平台级统计。

CREATE TABLE `affiliate_payments` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `platform` VARCHAR(8) NOT NULL,
  `platform_connection_id` BIGINT UNSIGNED NULL,
  `payment_no` VARCHAR(128) NOT NULL,
  `source_kind` VARCHAR(20) NOT NULL DEFAULT 'payment_summary',
  `paid_date` DATETIME NULL,
  `request_date` DATETIME NULL,
  `amount` DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
  `gross_amount` DECIMAL(14, 2) NULL,
  `currency` VARCHAR(8) NOT NULL DEFAULT 'USD',
  `status` VARCHAR(24) NOT NULL DEFAULT 'paid',
  `raw_status` VARCHAR(64) NULL,
  `payment_type` VARCHAR(64) NULL,
  `raw_json` TEXT NULL,
  `is_deleted` TINYINT NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_platform_conn_payment` (`platform`, `platform_connection_id`, `payment_no`),
  KEY `idx_pay_user_status` (`user_id`, `status`),
  KEY `idx_pay_user_paid_date` (`user_id`, `paid_date`),
  KEY `idx_pay_platform_conn` (`platform_connection_id`)
) ENGINE = InnoDB;
