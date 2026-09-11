-- D-322：打款单按「物理联盟账户」去重，杜绝同一笔打款按连接重复入库
--
-- 病灶：联盟「支付/打款」接口是账户级返回（一把 key 拉回整个 publisher 账户的全部打款单，
-- 与该 key 挂在哪个 channel/子站无关）。affiliate_payments 唯一键含 platform_connection_id，
-- 同一 payment_no 落到两条连接就是两行，DB 层拦不住。
-- 既有两道防线都失守：
--   1) sync 按 (platform, api_key) 去重 —— 同一账户签发多把 key 时不命中；
--   2) resolveMainConnectionMap 按 account_name 归一 —— 账号名被改名/占位名换真名时不命中。
-- 2026-08-24 批量把占位名(PM1/PM2)改成真实账号名并新增连接，次日同步即全量重写一份。
--
-- 修法：给连接加稳定的物理账户标识 payment_account_key，打款去重与归一都以它为准，
-- 不再依赖易变的 api_key / account_name。NULL = 未标注，回退旧的 api_key/账号名口径。
ALTER TABLE `platform_connections`
  ADD COLUMN `payment_account_key` VARCHAR(64) NULL AFTER `account_index`;

-- 同一物理账户的连接共享同一个 key；跨成员误挂也能被识别（LH conn 243/323 即此例）
CREATE INDEX `idx_pc_payment_account_key`
  ON `platform_connections` (`platform`, `payment_account_key`);

-- 回填：先按 (platform, api_key) 相同者归为同一账户，key 取该组最小连接 id
UPDATE `platform_connections` c
JOIN (
  SELECT `platform`, `api_key`, MIN(`id`) AS anchor
  FROM `platform_connections`
  WHERE `api_key` IS NOT NULL AND CHAR_LENGTH(`api_key`) > 5
  GROUP BY `platform`, `api_key`
) g ON g.`platform` = c.`platform` AND g.`api_key` = c.`api_key`
SET c.`payment_account_key` = CONCAT('acct-', g.anchor);

-- 再按「已入库打款单号集合重合」合并：不同 api_key 但打款单号撞号 => 同一物理账户。
-- 账户级接口下单号在账户内唯一，跨账户撞号概率可忽略；取两侧最小 anchor 收敛。
UPDATE `platform_connections` c
JOIN (
  SELECT c2.`id`,
         MIN(CAST(SUBSTRING_INDEX(c1.`payment_account_key`, '-', -1) AS UNSIGNED)) AS anchor
  FROM `affiliate_payments` p1
  JOIN `affiliate_payments` p2
    ON p2.`platform` = p1.`platform` AND p2.`payment_no` = p1.`payment_no`
   AND p2.`platform_connection_id` <> p1.`platform_connection_id`
   AND p2.`is_deleted` = 0
  JOIN `platform_connections` c1 ON c1.`id` = p1.`platform_connection_id`
  JOIN `platform_connections` c2 ON c2.`id` = p2.`platform_connection_id`
  WHERE p1.`is_deleted` = 0
    AND c1.`payment_account_key` IS NOT NULL
    AND c2.`payment_account_key` IS NOT NULL
  GROUP BY c2.`id`
) m ON m.`id` = c.`id`
SET c.`payment_account_key` = CONCAT('acct-', m.anchor)
WHERE CAST(SUBSTRING_INDEX(c.`payment_account_key`, '-', -1) AS UNSIGNED) > m.anchor;
