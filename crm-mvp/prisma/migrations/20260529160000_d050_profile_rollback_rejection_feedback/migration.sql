-- D-050 — 详见设计方案.md D-050 / C-122
-- 第1块：回滚 D-046.A IntelliCenter 商家画像 14 字段 + 2 索引（07 拍板：画像改内存临时生成、不存库）
-- 第3块：新建广告拒登反馈表（事后学习负样本，员工在数据中心手动录入，零 API）

-- ===== 第1块：回滚画像字段（先删索引，再删列）=====
ALTER TABLE `user_merchants` DROP INDEX `idx_industry_category`;
ALTER TABLE `user_merchants` DROP INDEX `idx_compliance_risk`;

ALTER TABLE `user_merchants`
  DROP COLUMN `industry_category`,
  DROP COLUMN `industry_subcategory`,
  DROP COLUMN `business_profile`,
  DROP COLUMN `audience_persona`,
  DROP COLUMN `brand_assets`,
  DROP COLUMN `trademark_authorization_status`,
  DROP COLUMN `compliance_risk_level`,
  DROP COLUMN `requires_certification`,
  DROP COLUMN `successful_template_ids`,
  DROP COLUMN `failed_template_ids`,
  DROP COLUMN `seasonal_pattern`,
  DROP COLUMN `competitor_brands`,
  DROP COLUMN `profile_updated_at`,
  DROP COLUMN `profile_source`;

-- ===== 第3块：广告拒登反馈表 =====
CREATE TABLE `ad_rejection_feedback` (
  `id`                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`               BIGINT UNSIGNED NOT NULL,
  `campaign_id`           BIGINT UNSIGNED DEFAULT NULL,
  `google_campaign_id`    VARCHAR(32)     DEFAULT NULL,
  `campaign_name`         VARCHAR(255)    DEFAULT NULL,
  `user_merchant_id`      BIGINT UNSIGNED DEFAULT NULL,
  `merchant_name`         VARCHAR(255)    DEFAULT NULL,
  `merchant_url`          VARCHAR(512)    DEFAULT NULL,
  `industry_category`     VARCHAR(64)     DEFAULT NULL,
  `policy_category`       VARCHAR(64)     NOT NULL,
  `reason_text`           TEXT            NOT NULL,
  `rejected_headlines`    JSON            DEFAULT NULL,
  `rejected_descriptions` JSON            DEFAULT NULL,
  `created_by`            BIGINT UNSIGNED DEFAULT NULL,
  `is_deleted`            TINYINT         NOT NULL DEFAULT 0,
  `created_at`            DATETIME(0)     NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  `updated_at`            DATETIME(0)     NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  PRIMARY KEY (`id`),
  KEY `idx_arf_merchant` (`user_merchant_id`),
  KEY `idx_arf_industry` (`industry_category`),
  KEY `idx_arf_campaign` (`campaign_id`),
  KEY `idx_arf_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
