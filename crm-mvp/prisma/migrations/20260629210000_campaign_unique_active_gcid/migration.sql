-- 根治重复广告系列：对「活跃行」按 (user_id, google_campaign_id) 加唯一约束（DB 级兜底）。
-- 背景：客户在 MCC 间迁移后 gcid 不变，旧同步按 user+mcc+gcid 查重在新 MCC 下查不到旧行就新建，
--       且 campaigns 无唯一约束、P2002 兜底失效 → 同 gcid 多副本。代码已改为按 user+gcid 防重，
--       此处再加 DB 唯一约束作最终防线。
-- 难点：MariaDB 不支持部分唯一索引，而软删的历史重复行仍与保留行同 gcid，朴素 unique(user_id,gcid) 会冲突。
-- 方案：生成列 active_gcid = (is_deleted=0 时取 google_campaign_id，否则 NULL)。NULL 在唯一索引中互不冲突，
--       因此唯一约束仅作用于活跃行；软删行 active_gcid=NULL 不参与去重。
-- 前置：执行前所有用户的活跃重复已清理为 0（备份见服务器 ~/.crm-backups/dedup_yz04_* 与 dedup_rest_*）。
ALTER TABLE `campaigns`
  ADD COLUMN IF NOT EXISTS `active_gcid` VARCHAR(64)
    GENERATED ALWAYS AS (IF(`is_deleted` = 0, `google_campaign_id`, NULL)) VIRTUAL;

ALTER TABLE `campaigns`
  ADD UNIQUE INDEX IF NOT EXISTS `uk_user_active_gcid` (`user_id`, `active_gcid`);
