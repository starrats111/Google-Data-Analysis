#!/bin/bash
# D-365 探查5：1152 条里 1132 条是 jy*（已停工作室），确认之；再单看非 jy 的 20 条
# 只读。
Q() { sudo mysql google-data-analysis -t -e "$1"; }

echo "===== 1. jy* 账号现状（是否已停用） ====="
Q "SELECT u.username, u.is_active, u.is_deleted, u.team_id, t.team_name,
          u.created_at, u.updated_at
   FROM users u LEFT JOIN teams t ON t.id = u.team_id
   WHERE u.username LIKE 'jy%'
   ORDER BY u.username;"

echo "===== 2. jy* 这批无后缀系列，Google 侧状态是否也还在投 ====="
Q "SELECT c.google_status, COUNT(*) AS 条数,
          MAX(c.last_google_sync_at) AS 最近同步,
          MAX(c.created_at) AS 最近建立
   FROM campaigns c JOIN users u ON u.id = c.user_id
   WHERE c.is_deleted = 0 AND c.google_campaign_id IS NOT NULL
     AND u.username LIKE 'jy%'
   GROUP BY c.google_status ORDER BY 条数 DESC;"

echo "===== 3. jy* 这批还在花钱吗（近 30 天花费） ====="
Q "SELECT COUNT(DISTINCT s.campaign_id) AS 有花费的系列数,
          ROUND(SUM(s.cost),2) AS 近30天花费USD,
          MAX(s.date) AS 最近有数据日期
   FROM ads_daily_stats s JOIN users u ON u.id = s.user_id
   WHERE s.is_deleted = 0 AND u.username LIKE 'jy%'
     AND s.date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY);"

echo "===== 4. jy* 全历史最后一次有花费是什么时候 ====="
Q "SELECT MAX(s.date) AS 最后有花费日期, ROUND(SUM(s.cost),2) AS 全历史花费USD
   FROM ads_daily_stats s JOIN users u ON u.id = s.user_id
   WHERE s.is_deleted = 0 AND u.username LIKE 'jy%' AND s.cost > 0;"

echo "===== 5. 排除 jy 后，真正需要关注的无后缀在投系列（逐条） ====="
Q "SELECT c.id, u.username, c.google_campaign_id, c.customer_id,
          LEFT(c.campaign_name,40) AS campaign_name,
          c.created_at,
          IFNULL(m.tracking_status,'(NULL)') AS tracking_status,
          CASE
            WHEN (m.connection_campaign_links IS NOT NULL AND m.connection_campaign_links <> 'null'
                  AND JSON_LENGTH(m.connection_campaign_links) > 0) THEN '有账号级链接'
            WHEN (m.campaign_link IS NOT NULL AND TRIM(m.campaign_link) <> '') THEN '有campaign_link'
            WHEN (m.tracking_link IS NOT NULL AND TRIM(m.tracking_link) <> '') THEN '仅tracking_link'
            ELSE '没有联盟链接'
          END AS 链接情况
   FROM campaigns c
   JOIN users u ON u.id = c.user_id
   LEFT JOIN user_merchants m ON m.id = c.user_merchant_id
   WHERE c.is_deleted = 0 AND c.google_campaign_id IS NOT NULL
     AND c.google_status = 'ENABLED' AND c.suffix_last_apply_at IS NULL
     AND (c.final_url_suffix IS NULL OR TRIM(c.final_url_suffix) = '')
     AND u.username NOT LIKE 'jy%'
   ORDER BY u.username, c.id;"

echo "===== 6. 那 453 条「完全没有联盟链接」里，jy 占多少 ====="
Q "SELECT CASE WHEN u.username LIKE 'jy%' THEN 'jy（已停）' ELSE '在职' END AS 归属,
          COUNT(*) AS 条数
   FROM campaigns c
   JOIN users u ON u.id = c.user_id
   LEFT JOIN user_merchants m ON m.id = c.user_merchant_id
   WHERE c.is_deleted = 0 AND c.google_campaign_id IS NOT NULL
     AND c.google_status = 'ENABLED' AND c.suffix_last_apply_at IS NULL
     AND (c.final_url_suffix IS NULL OR TRIM(c.final_url_suffix) = '')
     AND (m.connection_campaign_links IS NULL OR m.connection_campaign_links = 'null'
          OR JSON_LENGTH(m.connection_campaign_links) = 0)
     AND (m.campaign_link IS NULL OR TRIM(m.campaign_link) = '')
     AND (m.tracking_link IS NULL OR TRIM(m.tracking_link) = '')
   GROUP BY 归属;"
