-- C-095 RC-1 治本：阻止同一真实 mcc_id 被多个 active user 同时绑定
-- 详见：设计方案.md C-095 章节
--
-- 思路：用 generated column + UNIQUE INDEX 模拟"部分唯一约束"
--   - is_deleted=0 时：mcc_id_active = mcc_id (必须全局唯一)
--   - is_deleted=1 时：mcc_id_active = NULL (允许多个 NULL，不受唯一约束限制)
--
-- 前置条件：Phase 1 已经清理掉所有 active 重复绑定（详见 设计方案.md §十一）

-- 1. 添加 VIRTUAL generated column（不占物理存储，每次读取时计算）
ALTER TABLE `google_mcc_accounts`
  ADD COLUMN `mcc_id_active` VARCHAR(32)
    GENERATED ALWAYS AS (CASE WHEN `is_deleted` = 0 THEN `mcc_id` ELSE NULL END) VIRTUAL;

-- 2. 在 generated column 上加 UNIQUE 索引
--    MariaDB UNIQUE 索引允许多个 NULL，所以 is_deleted=1 的行不受限制
CREATE UNIQUE INDEX `uniq_mcc_id_active` ON `google_mcc_accounts` (`mcc_id_active`);
