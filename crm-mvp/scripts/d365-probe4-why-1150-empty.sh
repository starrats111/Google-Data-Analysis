#!/bin/bash
# D-365 探查4：证据引擎为什么有 1150 条在投系列库里没后缀
# 只读。
Q() { sudo mysql google-data-analysis -t -e "$1"; }

echo "===== 1. 先复核这 1150 条的口径（已提交+在投+从未换链+库里无后缀） ====="
Q "SELECT COUNT(*) AS 条数, COUNT(DISTINCT user_id) AS 人数,
          MIN(created_at) AS 最早, MAX(created_at) AS 最晚
   FROM campaigns
   WHERE is_deleted = 0 AND google_campaign_id IS NOT NULL
     AND google_status = 'ENABLED' AND suffix_last_apply_at IS NULL
     AND (final_url_suffix IS NULL OR TRIM(final_url_suffix) = '');"

echo "===== 2. 按商家的巡航状态分类（这是最可能的成因） ====="
Q "SELECT IFNULL(m.tracking_status,'(NULL 未巡航)') AS tracking_status,
          COUNT(*) AS 条数,
          SUM(m.campaign_link IS NULL OR TRIM(m.campaign_link)='') AS 无campaign_link,
          SUM(m.tracking_link IS NULL OR TRIM(m.tracking_link)='') AS 无tracking_link,
          SUM(m.resolved_final_url IS NULL OR TRIM(m.resolved_final_url)='') AS 无巡航落地页
   FROM campaigns c
   LEFT JOIN user_merchants m ON m.id = c.user_merchant_id
   WHERE c.is_deleted = 0 AND c.google_campaign_id IS NOT NULL
     AND c.google_status = 'ENABLED' AND c.suffix_last_apply_at IS NULL
     AND (c.final_url_suffix IS NULL OR TRIM(c.final_url_suffix) = '')
   GROUP BY m.tracking_status ORDER BY 条数 DESC;"

echo "===== 3. 对照组：有后缀的在投系列，巡航状态分布（看差异在哪） ====="
Q "SELECT IFNULL(m.tracking_status,'(NULL 未巡航)') AS tracking_status, COUNT(*) AS 条数
   FROM campaigns c
   LEFT JOIN user_merchants m ON m.id = c.user_merchant_id
   WHERE c.is_deleted = 0 AND c.google_campaign_id IS NOT NULL
     AND c.google_status = 'ENABLED'
     AND c.final_url_suffix IS NOT NULL AND TRIM(c.final_url_suffix) <> ''
   GROUP BY m.tracking_status ORDER BY 条数 DESC;"

echo "===== 4. 商家压根没有联盟链接的占多少（没链接 ⇒ 本来就没后缀可抓） ====="
Q "SELECT
     CASE
       WHEN (m.connection_campaign_links IS NOT NULL AND m.connection_campaign_links <> 'null'
             AND JSON_LENGTH(m.connection_campaign_links) > 0) THEN '有账号级链接'
       WHEN (m.campaign_link IS NOT NULL AND TRIM(m.campaign_link) <> '') THEN '有campaign_link'
       WHEN (m.tracking_link IS NOT NULL AND TRIM(m.tracking_link) <> '') THEN '仅tracking_link'
       ELSE '完全没有联盟链接'
     END AS 链接情况,
     COUNT(*) AS 条数
   FROM campaigns c
   LEFT JOIN user_merchants m ON m.id = c.user_merchant_id
   WHERE c.is_deleted = 0 AND c.google_campaign_id IS NOT NULL
     AND c.google_status = 'ENABLED' AND c.suffix_last_apply_at IS NULL
     AND (c.final_url_suffix IS NULL OR TRIM(c.final_url_suffix) = '')
   GROUP BY 链接情况 ORDER BY 条数 DESC;"

echo "===== 5. 按建立时间分布（看是不是集中在某个时期 = 某次改动引入） ====="
Q "SELECT DATE_FORMAT(c.created_at,'%Y-%m') AS 月份, COUNT(*) AS 条数
   FROM campaigns c
   WHERE c.is_deleted = 0 AND c.google_campaign_id IS NOT NULL
     AND c.google_status = 'ENABLED' AND c.suffix_last_apply_at IS NULL
     AND (c.final_url_suffix IS NULL OR TRIM(c.final_url_suffix) = '')
   GROUP BY 月份 ORDER BY 月份;"

echo "===== 6. 按人分布（看是不是个别人的操作习惯） ====="
Q "SELECT u.username, COUNT(*) AS 无后缀条数
   FROM campaigns c JOIN users u ON u.id = c.user_id
   WHERE c.is_deleted = 0 AND c.google_campaign_id IS NOT NULL
     AND c.google_status = 'ENABLED' AND c.suffix_last_apply_at IS NULL
     AND (c.final_url_suffix IS NULL OR TRIM(c.final_url_suffix) = '')
   GROUP BY u.username ORDER BY 无后缀条数 DESC LIMIT 20;"

echo "===== 7. 后缀库存情况（换链脚本能不能救它们） ====="
Q "SELECT
     CASE WHEN p.cnt IS NULL THEN '后缀池里没有任何记录'
          WHEN p.available > 0 THEN '有可用库存'
          ELSE '有记录但零可用' END AS 库存情况,
     COUNT(*) AS 条数
   FROM campaigns c
   LEFT JOIN (
     SELECT campaign_id, COUNT(*) AS cnt, SUM(status='available') AS available
     FROM suffix_pool GROUP BY campaign_id
   ) p ON p.campaign_id = c.id
   WHERE c.is_deleted = 0 AND c.google_campaign_id IS NOT NULL
     AND c.google_status = 'ENABLED' AND c.suffix_last_apply_at IS NULL
     AND (c.final_url_suffix IS NULL OR TRIM(c.final_url_suffix) = '')
   GROUP BY 库存情况 ORDER BY 条数 DESC;"
