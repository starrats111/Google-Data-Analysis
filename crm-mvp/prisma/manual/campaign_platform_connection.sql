-- ============================================================================
-- campaigns.platform_connection_id 账号感知改造：加字段 + 回填存量
--
-- 背景：换链 / 刷点击 / 建广告选链接原本跟着「商家(user_merchants)的主连接」走，
--       而主连接会随商家重同步/加账号漂移，一个商家只有一行、只存一个主连接，
--       导致 CG1/CG2 两个联盟账号共用一行 → 换错号 / 刷到没出单的号（wj02 串号）。
-- 方案：给每条广告写死它归属的联盟账号 platform_connection_id，之后所有链接选择/
--       订单归属都以此为准（NULL=存量未回填，代码自动回退旧逻辑，无回归）。
--
-- ⚠️ 仅在生产库执行；执行前建议 mysqldump 备份 campaigns 表。
--    加可空列 + 索引为 InnoDB 在线 DDL，对 ~1.08 万行的 campaigns 表秒级完成。
-- ============================================================================

-- ── Step 1. 加字段 + 索引（幂等：若已存在会报错，忽略即可）──
ALTER TABLE `campaigns`
  ADD COLUMN `platform_connection_id` BIGINT UNSIGNED NULL AFTER `user_merchant_id`,
  ADD INDEX `idx_platform_connection` (`platform_connection_id`);

-- ── Step 2. 回填①：名字 CGx 位置命中(且该连接有链接/是主连接) 或 该用户此平台仅 1 个号 ──
-- 覆盖 ~9094 条（97%）。CGx 序号 = platform_connections 按 id 升序的位置（同 resolvePlatformLabel）。
UPDATE `campaigns` c
JOIN `user_merchants` m ON m.id = c.user_merchant_id AND m.is_deleted = 0
JOIN (
  SELECT user_id, platform, id AS conn_id,
         ROW_NUMBER() OVER (PARTITION BY user_id, platform ORDER BY id) AS pos,
         COUNT(*)     OVER (PARTITION BY user_id, platform)             AS conn_cnt
  FROM `platform_connections`
  WHERE is_deleted = 0
) cp ON cp.user_id = c.user_id AND cp.platform = m.platform
SET c.platform_connection_id = cp.conn_id
WHERE c.is_deleted = 0
  AND c.user_merchant_id > 0
  AND c.platform_connection_id IS NULL
  AND (
        cp.conn_cnt = 1  -- 唯一账号，无歧义
     OR (
          cp.pos = CAST(NULLIF(REGEXP_SUBSTR(SUBSTRING_INDEX(SUBSTRING_INDEX(c.campaign_name,'-',2),'-',-1), '[0-9]+$'), '') AS UNSIGNED)
          AND (
                cp.conn_id = m.platform_connection_id
             OR (m.connection_campaign_links IS NOT NULL
                 AND m.connection_campaign_links <> 'null'
                 AND JSON_EXISTS(m.connection_campaign_links, CONCAT('$."', cp.conn_id, '"')))
          )
        )
  );

-- ── Step 3. 回填②：仍为 NULL 的，用「近30天订单落在唯一连接」兜底 ──（覆盖 ~26 条）
UPDATE `campaigns` c
JOIN `user_merchants` m ON m.id = c.user_merchant_id AND m.is_deleted = 0
JOIN (
  SELECT user_id, platform, merchant_id,
         MAX(platform_connection_id) AS conn_id,
         COUNT(DISTINCT platform_connection_id) AS nconn
  FROM `affiliate_transactions`
  WHERE is_deleted = 0
    AND platform_connection_id IS NOT NULL
    AND transaction_time >= DATE_SUB(NOW(), INTERVAL 30 DAY)
  GROUP BY user_id, platform, merchant_id
  HAVING nconn = 1
) o ON o.user_id = c.user_id AND o.platform = m.platform AND o.merchant_id = m.merchant_id
SET c.platform_connection_id = o.conn_id
WHERE c.is_deleted = 0
  AND c.user_merchant_id > 0
  AND c.platform_connection_id IS NULL;

-- ── Step 4. 验证：回填覆盖率 + 剩余 NULL（这些自动回退旧逻辑，可后续人工确认）──
-- SELECT
--   COUNT(*) total,
--   SUM(platform_connection_id IS NOT NULL) filled,
--   SUM(platform_connection_id IS NULL)     still_null
-- FROM campaigns
-- WHERE is_deleted = 0 AND user_merchant_id > 0 AND suffix_exchange_enabled = 1;

-- ── Step 5. 人工确认清单：启用换链、仍为 NULL 的广告（附名字/商家/主连接/订单连接分布）──
-- SELECT c.id, c.campaign_name, m.platform, m.merchant_id,
--        m.platform_connection_id AS primary_conn,
--        (SELECT GROUP_CONCAT(DISTINCT t.platform_connection_id)
--           FROM affiliate_transactions t
--          WHERE t.user_id=c.user_id AND t.platform=m.platform AND t.merchant_id=m.merchant_id
--            AND t.is_deleted=0 AND t.platform_connection_id IS NOT NULL
--            AND t.transaction_time>=DATE_SUB(NOW(),INTERVAL 30 DAY)) AS order_conns
-- FROM campaigns c
-- JOIN user_merchants m ON m.id=c.user_merchant_id AND m.is_deleted=0
-- WHERE c.is_deleted=0 AND c.suffix_exchange_enabled=1 AND c.platform_connection_id IS NULL;
