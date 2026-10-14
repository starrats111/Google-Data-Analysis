#!/bin/bash
# D-365 探查：确定「后缀需要补推 Google」的范围
# 只读，不改任何数据。
#
# 目标集合（01 拍板口径）：从未换过链（suffix_last_apply_at IS NULL）
#   —— 换过链的系列 Google 上生效的是 suffix_last_content，由换链脚本负责，不碰。
Q() { sudo mysql google-data-analysis -t -e "$1"; }

echo "===== 0. 在投系列总览（分母） ====="
Q "SELECT
     COUNT(*) AS 全部未删系列,
     SUM(google_campaign_id IS NOT NULL) AS 已提交到google,
     SUM(google_campaign_id IS NOT NULL AND google_status='ENABLED') AS 其中在投,
     SUM(suffix_last_apply_at IS NULL) AS 从未换过链,
     SUM(suffix_last_apply_at IS NOT NULL) AS 换过链
   FROM campaigns WHERE is_deleted = 0;"

echo "===== 1. 核心：从未换过链 且 库里有后缀（这批 Google 上可能是空的） ====="
Q "SELECT
     google_status,
     COUNT(*) AS 条数,
     COUNT(DISTINCT user_id) AS 涉及人数,
     MIN(created_at) AS 最早,
     MAX(created_at) AS 最晚
   FROM campaigns
   WHERE is_deleted = 0
     AND google_campaign_id IS NOT NULL
     AND suffix_last_apply_at IS NULL
     AND final_url_suffix IS NOT NULL AND TRIM(final_url_suffix) <> ''
   GROUP BY google_status ORDER BY 条数 DESC;"

echo "===== 2. 反向：从未换过链 且 库里也没后缀（这批是真空，补不了，只能等巡航） ====="
Q "SELECT
     google_status, COUNT(*) AS 条数, COUNT(DISTINCT user_id) AS 涉及人数
   FROM campaigns
   WHERE is_deleted = 0
     AND google_campaign_id IS NOT NULL
     AND suffix_last_apply_at IS NULL
     AND (final_url_suffix IS NULL OR TRIM(final_url_suffix) = '')
   GROUP BY google_status ORDER BY 条数 DESC;"

echo "===== 3. 竞品情报引擎的系列有多少（keywords.source='rival_intel' 是唯一出处标记） ====="
Q "SELECT
     c.google_status,
     COUNT(DISTINCT c.id) AS 竞品引擎系列数,
     SUM(c.final_url_suffix IS NULL OR TRIM(c.final_url_suffix)='') AS 其中库里无后缀,
     SUM(c.suffix_last_apply_at IS NULL) AS 其中从未换链
   FROM campaigns c
   WHERE c.is_deleted = 0
     AND c.google_campaign_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM ad_groups g
       JOIN keywords k ON k.ad_group_id = g.id AND k.source = 'rival_intel'
       WHERE g.campaign_id = c.id
     )
   GROUP BY c.google_status ORDER BY 竞品引擎系列数 DESC;"

echo "===== 4. 待补清单（第 1 组里在投的，按人分组）====="
Q "SELECT
     u.username,
     COUNT(*) AS 待补条数,
     GROUP_CONCAT(c.id ORDER BY c.id SEPARATOR ',') AS crm_campaign_ids
   FROM campaigns c
   JOIN users u ON u.id = c.user_id
   WHERE c.is_deleted = 0
     AND c.google_campaign_id IS NOT NULL
     AND c.google_status = 'ENABLED'
     AND c.suffix_last_apply_at IS NULL
     AND c.final_url_suffix IS NOT NULL AND TRIM(c.final_url_suffix) <> ''
   GROUP BY u.username
   ORDER BY 待补条数 DESC;"

echo "===== 5. 01 报案那条（HYTEST US）现状 ====="
Q "SELECT c.id, c.google_campaign_id, LEFT(c.name,46) AS name, c.google_status,
          c.customer_id, c.suffix_last_apply_at,
          LEFT(c.final_url_suffix,70) AS suffix_db,
          LEFT(c.suffix_last_content,40) AS suffix_applied
   FROM campaigns c
   JOIN user_merchants m ON m.id = c.user_merchant_id
   WHERE c.is_deleted = 0 AND m.merchant_name LIKE '%HYTEST%'
   ORDER BY c.created_at DESC LIMIT 10;"

echo "===== 6. 抽样看待补的后缀长什么样（确认不是脏值）====="
Q "SELECT c.id, c.google_status, LEFT(c.final_url_suffix,100) AS suffix_db
   FROM campaigns c
   WHERE c.is_deleted = 0
     AND c.google_campaign_id IS NOT NULL
     AND c.google_status = 'ENABLED'
     AND c.suffix_last_apply_at IS NULL
     AND c.final_url_suffix IS NOT NULL AND TRIM(c.final_url_suffix) <> ''
   ORDER BY c.id DESC LIMIT 15;"
