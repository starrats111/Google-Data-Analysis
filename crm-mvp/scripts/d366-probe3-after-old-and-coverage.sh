#!/bin/bash
# D-366 探查3：①after_old 那 16 行是什么 ②切完之后每一天是否都还有恰好一个人记着（不丢数）
Q() { sudo mysql google-data-analysis -t -e "$1"; }

DUPG="SELECT google_campaign_id FROM campaigns
      WHERE is_deleted=0 AND google_campaign_id IS NOT NULL
      GROUP BY google_campaign_id HAVING COUNT(DISTINCT user_id)>1"

CUT="SELECT c.google_campaign_id AS g,
            DATE(CONVERT_TZ(m.created_at,'+00:00','+08:00')) AS cutoff_cst
     FROM campaigns c
     JOIN google_mcc_accounts m ON m.id = c.mcc_id AND m.is_deleted = 0
     WHERE c.is_deleted = 0 AND c.google_campaign_id IN ($DUPG)
     GROUP BY c.google_campaign_id, m.created_at"

echo "===== 1. after_old 明细：旧主人名下、交接日之后还在记花费的 ====="
Q "SELECT u.username AS old_owner, m.mcc_id AS mcc_no, c.google_campaign_id AS gcid,
          s.date, ROUND(s.cost,2) AS cost, d.cutoff_cst,
          (SELECT GROUP_CONCAT(DISTINCT u2.username) FROM campaigns c2
             JOIN users u2 ON u2.id=c2.user_id
            WHERE c2.google_campaign_id=c.google_campaign_id AND c2.is_deleted=0
              AND c2.user_id<>c.user_id) AS other_owner,
          (SELECT ROUND(SUM(s2.cost),2) FROM campaigns c2
             JOIN ads_daily_stats s2 ON s2.campaign_id=c2.id AND s2.is_deleted=0
            WHERE c2.google_campaign_id=c.google_campaign_id AND c2.is_deleted=0
              AND c2.user_id<>c.user_id AND s2.date=s.date) AS same_day_other_side
   FROM campaigns c
   JOIN google_mcc_accounts m ON m.id = c.mcc_id AND m.is_deleted = 1
   JOIN ads_daily_stats s ON s.campaign_id = c.id AND s.is_deleted = 0
   JOIN ($CUT) d ON d.g = c.google_campaign_id
   LEFT JOIN users u ON u.id = c.user_id
   WHERE c.is_deleted = 0 AND s.date >= d.cutoff_cst
   ORDER BY s.date, c.google_campaign_id;"

echo "===== 2. 若只删 before_new：会不会把某(gcid,日)删成「没人记」=丢数 ====="
Q "SELECT coverage, COUNT(*) AS gcid_day_cells, ROUND(SUM(cost_kept),2) AS cost_kept
   FROM (
     SELECT c.google_campaign_id AS g, s.date,
            SUM(CASE WHEN NOT (m.is_deleted = 0 AND s.date < d.cutoff_cst) THEN 1 ELSE 0 END) AS kept_rows,
            SUM(CASE WHEN NOT (m.is_deleted = 0 AND s.date < d.cutoff_cst) THEN s.cost ELSE 0 END) AS cost_kept,
            CASE WHEN SUM(CASE WHEN NOT (m.is_deleted = 0 AND s.date < d.cutoff_cst) THEN 1 ELSE 0 END) = 0
                 THEN 'ZERO_left_DATA_LOSS'
                 WHEN SUM(CASE WHEN NOT (m.is_deleted = 0 AND s.date < d.cutoff_cst) THEN 1 ELSE 0 END) = 1
                 THEN 'exactly_one'
                 ELSE 'still_multiple' END AS coverage
     FROM campaigns c
     JOIN google_mcc_accounts m ON m.id = c.mcc_id
     JOIN ads_daily_stats s ON s.campaign_id = c.id AND s.is_deleted = 0
     JOIN ($CUT) d ON d.g = c.google_campaign_id
     WHERE c.is_deleted = 0
     GROUP BY c.google_campaign_id, s.date
   ) t GROUP BY coverage;"

echo "===== 3. 丢数的格子（若有）明细 ====="
Q "SELECT c.google_campaign_id AS gcid, s.date, d.cutoff_cst,
          GROUP_CONCAT(CONCAT(u.username,':',ROUND(s.cost,2),
                       CASE WHEN m.is_deleted=0 THEN '(new)' ELSE '(old)' END)) AS rows_detail
   FROM campaigns c
   JOIN google_mcc_accounts m ON m.id = c.mcc_id
   JOIN ads_daily_stats s ON s.campaign_id = c.id AND s.is_deleted = 0
   JOIN ($CUT) d ON d.g = c.google_campaign_id
   LEFT JOIN users u ON u.id = c.user_id
   WHERE c.is_deleted = 0
   GROUP BY c.google_campaign_id, s.date, d.cutoff_cst
   HAVING SUM(CASE WHEN NOT (m.is_deleted = 0 AND s.date < d.cutoff_cst) THEN 1 ELSE 0 END) = 0
   ORDER BY s.date LIMIT 40;"

echo "===== 4. 删除量复核（before_new = 待删） ====="
Q "SELECT COUNT(*) AS rows_to_delete, ROUND(SUM(s.cost),2) AS cost_to_remove,
          COUNT(DISTINCT c.user_id) AS affected_users,
          COUNT(DISTINCT c.google_campaign_id) AS affected_gcids
   FROM campaigns c
   JOIN google_mcc_accounts m ON m.id = c.mcc_id AND m.is_deleted = 0
   JOIN ads_daily_stats s ON s.campaign_id = c.id AND s.is_deleted = 0
   JOIN ($CUT) d ON d.g = c.google_campaign_id
   WHERE c.is_deleted = 0 AND s.date < d.cutoff_cst;"

echo "===== 5. 待删按人分布（谁的报表数字会变） ====="
Q "SELECT u.username, COUNT(*) AS rows_del, ROUND(SUM(s.cost),2) AS cost_del,
          MIN(s.date) AS d_min, MAX(s.date) AS d_max
   FROM campaigns c
   JOIN google_mcc_accounts m ON m.id = c.mcc_id AND m.is_deleted = 0
   JOIN ads_daily_stats s ON s.campaign_id = c.id AND s.is_deleted = 0
   JOIN ($CUT) d ON d.g = c.google_campaign_id
   LEFT JOIN users u ON u.id = c.user_id
   WHERE c.is_deleted = 0 AND s.date < d.cutoff_cst
   GROUP BY u.username ORDER BY cost_del DESC;"
