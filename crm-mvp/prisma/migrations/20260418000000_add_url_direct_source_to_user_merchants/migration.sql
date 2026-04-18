-- C-020 R1.1：user_merchants 新增 URL 直投来源标记字段
-- 设计方案 §20.5.2 / §20.5.7 B-6（维持 VarChar(16)，QX2 决议）

ALTER TABLE `user_merchants`
  ADD COLUMN `source`         VARCHAR(16) NOT NULL DEFAULT 'platform'
             COMMENT 'platform / url_direct，来源渠道' AFTER `campaign_link`,
  ADD COLUMN `listing_status` VARCHAR(16) NOT NULL DEFAULT 'active'
             COMMENT 'active / offline / url_only，平台上架态' AFTER `source`,
  ADD INDEX  `idx_user_source` (`user_id`, `source`);
