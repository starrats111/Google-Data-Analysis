-- D-046.A IntelliCenter 商家智能画像（详见设计方案"五、AI IntelliCenter MVP 详细方案"）
-- 由 D-046 / C-109 立项，07 拍板 Q1=B Q2=A Q3=A Q4=D Q5=B Q6=D Q7=C R1-R6 拍板。
-- 给 user_merchants 加 14 字段：12 画像 + 2 元数据(profile_updated_at + profile_source)

ALTER TABLE `user_merchants`
  ADD COLUMN `industry_category` VARCHAR(64) NULL DEFAULT NULL AFTER `atc_sync_status`,
  ADD COLUMN `industry_subcategory` VARCHAR(128) NULL DEFAULT NULL AFTER `industry_category`,
  ADD COLUMN `business_profile` JSON NULL DEFAULT NULL AFTER `industry_subcategory`,
  ADD COLUMN `audience_persona` JSON NULL DEFAULT NULL AFTER `business_profile`,
  ADD COLUMN `brand_assets` JSON NULL DEFAULT NULL AFTER `audience_persona`,
  ADD COLUMN `trademark_authorization_status` VARCHAR(16) NOT NULL DEFAULT 'unauthorized' AFTER `brand_assets`,
  ADD COLUMN `compliance_risk_level` VARCHAR(8) NOT NULL DEFAULT 'low' AFTER `trademark_authorization_status`,
  ADD COLUMN `requires_certification` JSON NULL DEFAULT NULL AFTER `compliance_risk_level`,
  ADD COLUMN `successful_template_ids` JSON NULL DEFAULT NULL AFTER `requires_certification`,
  ADD COLUMN `failed_template_ids` JSON NULL DEFAULT NULL AFTER `successful_template_ids`,
  ADD COLUMN `seasonal_pattern` JSON NULL DEFAULT NULL AFTER `failed_template_ids`,
  ADD COLUMN `competitor_brands` JSON NULL DEFAULT NULL AFTER `seasonal_pattern`,
  ADD COLUMN `profile_updated_at` DATETIME(0) NULL DEFAULT NULL AFTER `competitor_brands`,
  ADD COLUMN `profile_source` VARCHAR(16) NOT NULL DEFAULT 'none' AFTER `profile_updated_at`;

-- 索引：按行业大类 / 合规风险等级查询（admin 后台分组统计 + AI 自动分类查未分类商家）
ALTER TABLE `user_merchants`
  ADD INDEX `idx_industry_category` (`industry_category`),
  ADD INDEX `idx_compliance_risk` (`compliance_risk_level`);
