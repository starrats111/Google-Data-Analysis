#!/bin/bash
# D-366 探查4：删 before_new 时，那 1254 个「删完没人记」的格子里到底有多少钱
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

echo "===== 1. 丢数格子的真实金额分布（关键：里面有钱吗） ====="
Q "SELECT CASE WHEN cost_in_cell = 0 THEN 'zero_cost_shell' ELSE 'HAS_MONEY' END AS cell_kind,
          COUNT(*) AS cells, ROUND(SUM(cost_in_cell),2) AS cost_total,
          ROUND(MAX(cost_in_cell),2) AS max_cell
   FROM (
     SELECT c.google_campaign_id AS g, s.date, SUM(s.cost) AS cost_in_cell
     FROM campaigns c
     JOIN google_mcc_accounts m ON m.id = c.mcc_id
     JOIN ads_daily_stats s ON s.campaign_id = c.id AND s.is_deleted = 0
     JOIN ($CUT) d ON d.g = c.google_campaign_id
     WHERE c.is_deleted = 0
     GROUP BY c.google_campaign_id, s.date
     HAVING SUM(CASE WHEN NOT (m.is_deleted = 0 AND s.date < d.cutoff_cst) THEN 1 ELSE 0 END) = 0
   ) t GROUP BY cell_kind;"

echo "===== 2. 若把「删完没人记且有钱」的格子保留下来，最终待删量 ====="
Q "SELECT COUNT(*) AS rows_to_delete, ROUND(SUM(s.cost),2) AS cost_removed
   FROM campaigns c
   JOIN google_mcc_accounts m ON m.id = c.mcc_id AND m.is_deleted = 0
   JOIN ads_daily_stats s ON s.campaign_id = c.id AND s.is_deleted = 0
   JOIN ($CUT) d ON d.g = c.google_campaign_id
   WHERE c.is_deleted = 0 AND s.date < d.cutoff_cst
     AND EXISTS (
       SELECT 1 FROM campaigns c3
       JOIN google_mcc_accounts m3 ON m3.id = c3.mcc_id AND m3.is_deleted = 1
       JOIN ads_daily_stats s3 ON s3.campaign_id = c3.id AND s3.is_deleted = 0
       WHERE c3.google_campaign_id = c.google_campaign_id AND c3.is_deleted = 0
         AND s3.date = s.date);"

echo "===== 3. 同口径下按人分布（谁的数字会变、变多少） ====="
Q "SELECT u.username, COUNT(*) AS rows_del, ROUND(SUM(s.cost),2) AS cost_del,
          MIN(s.date) AS d_min, MAX(s.date) AS d_max
   FROM campaigns c
   JOIN google_mcc_accounts m ON m.id = c.mcc_id AND m.is_deleted = 0
   JOIN ads_daily_stats s ON s.campaign_id = c.id AND s.is_deleted = 0
   JOIN ($CUT) d ON d.g = c.google_campaign_id
   LEFT JOIN users u ON u.id = c.user_id
   WHERE c.is_deleted = 0 AND s.date < d.cutoff_cst
     AND EXISTS (
       SELECT 1 FROM campaigns c3
       JOIN google_mcc_accounts m3 ON m3.id = c3.mcc_id AND m3.is_deleted = 1
       JOIN ads_daily_stats s3 ON s3.campaign_id = c3.id AND s3.is_deleted = 0
       WHERE c3.google_campaign_id = c.google_campaign_id AND c3.is_deleted = 0
         AND s3.date = s.date)
   GROUP BY u.username ORDER BY cost_del DESC;"

echo "===== 4. 旧主人侧同口径该补删吗：交接日之后、旧主人名下有钱的行 ====="
Q "SELECT u.username AS old_owner, COUNT(*) AS rows_cnt, ROUND(SUM(s.cost),2) AS cost
   FROM campaigns c
   JOIN google_mcc_accounts m ON m.id = c.mcc_id AND m.is_deleted = 1
   JOIN ads_daily_stats s ON s.campaign_id = c.id AND s.is_deleted = 0
   JOIN ($CUT) d ON d.g = c.google_campaign_id
   LEFT JOIN users u ON u.id = c.user_id
   WHERE c.is_deleted = 0 AND s.date >= d.cutoff_cst AND s.cost > 0
   GROUP BY u.username;"

echo "===== 5. wj11 / wj111 / wj02 到底是几个人 ====="
Q "SELECT id, username, display_name, team_id, status, is_deleted
   FROM users WHERE username IN ('wj02','wj11','wj111','wj06','wj04','wj08') ORDER BY username;"
