-- C-029 R1.2: 为 platform_connections 增加 channel_id 字段（AD/AdsDoubler 平台必填）
-- 其他平台保持 NULL；无需 drop 回滚时直接保留也无害
ALTER TABLE `platform_connections`
  ADD COLUMN `channel_id` VARCHAR(64) NULL
             COMMENT 'C-029 AD 平台必填渠道 ID，其他平台为 NULL'
             AFTER `api_key`;
