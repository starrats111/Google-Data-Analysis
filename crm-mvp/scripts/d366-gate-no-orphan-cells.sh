#!/bin/bash
# D-366 安全闸（独立跑，别名不与修复脚本冲突）：
# 按修复规则软删后，是否存在某(gcid,日)变成「没人记」而原本有钱 → 必须为 0
Q() { sudo mysql google-data-analysis -t -e "$1"; }

# 待删行 id 清单（与 d366-fix-handover-dup-cost.sh 的 TARGET 必须完全一致）
TARGETIDS="SELECT ss.id
  FROM ads_daily_stats ss
  JOIN campaigns cc ON cc.id = ss.campaign_id AND cc.is_deleted = 0
  JOIN google_mcc_accounts mm ON mm.id = cc.mcc_id AND mm.is_deleted = 0
  WHERE ss.is_deleted = 0
    AND cc.google_campaign_id IN (
      SELECT google_campaign_id FROM campaigns
      WHERE is_deleted = 0 AND google_campaign_id IS NOT NULL
      GROUP BY google_campaign_id HAVING COUNT(DISTINCT user_id) > 1)
    AND ss.date < DATE(CONVERT_TZ(mm.created_at,'+00:00','+08:00'))
    AND mm.mcc_id IN (
      SELECT mcc_id FROM google_mcc_accounts
      GROUP BY mcc_id
      HAVING MAX(CASE WHEN is_deleted = 0 THEN created_at END) = MAX(created_at))
    AND EXISTS (
      SELECT 1 FROM campaigns c2
      JOIN google_mcc_accounts m2 ON m2.id = c2.mcc_id AND m2.is_deleted = 1
      JOIN ads_daily_stats s2 ON s2.campaign_id = c2.id AND s2.is_deleted = 0
      WHERE c2.google_campaign_id = cc.google_campaign_id
        AND c2.is_deleted = 0 AND c2.user_id <> cc.user_id
        AND s2.date = ss.date)"

DUPG="SELECT google_campaign_id FROM campaigns
      WHERE is_deleted = 0 AND google_campaign_id IS NOT NULL
      GROUP BY google_campaign_id HAVING COUNT(DISTINCT user_id) > 1"

echo "===== 闸1. 待删 id 数（应与修复脚本第1段一致） ====="
Q "SELECT COUNT(*) AS target_rows FROM ($TARGETIDS) t;"

echo "===== 闸2. 删完后变成「没人记」的格子，按原有金额分桶 ====="
Q "CREATE TEMPORARY TABLE tgt (id BIGINT PRIMARY KEY);
   INSERT INTO tgt (id) $TARGETIDS;
   SELECT CASE WHEN cost_before = 0 THEN 'zero_cost_shell' ELSE 'HAS_MONEY_STOP' END AS bucket,
          COUNT(*) AS cells, ROUND(SUM(cost_before),2) AS cost_before_total
   FROM (
     SELECT c3.google_campaign_id AS g, s3.date,
            SUM(s3.cost) AS cost_before,
            SUM(CASE WHEN s3.id IN (SELECT id FROM tgt) THEN 0 ELSE 1 END) AS kept
     FROM campaigns c3
     JOIN ads_daily_stats s3 ON s3.campaign_id = c3.id AND s3.is_deleted = 0
     WHERE c3.is_deleted = 0 AND c3.google_campaign_id IN ($DUPG)
     GROUP BY c3.google_campaign_id, s3.date
   ) z WHERE kept = 0
   GROUP BY bucket;"
echo "（HAS_MONEY_STOP 必须不出现。出现即说明保险①漏了，立刻停手。）"

echo "===== 闸3. 删完后每格剩几行（应全为 1；>1 说明还有残留双记） ====="
Q "CREATE TEMPORARY TABLE tgt2 (id BIGINT PRIMARY KEY);
   INSERT INTO tgt2 (id) $TARGETIDS;
   SELECT kept_rows, COUNT(*) AS cells, ROUND(SUM(cost_kept),2) AS cost_kept
   FROM (
     SELECT c4.google_campaign_id AS g, s4.date,
            SUM(CASE WHEN s4.id IN (SELECT id FROM tgt2) THEN 0 ELSE 1 END) AS kept_rows,
            SUM(CASE WHEN s4.id IN (SELECT id FROM tgt2) THEN 0 ELSE s4.cost END) AS cost_kept
     FROM campaigns c4
     JOIN ads_daily_stats s4 ON s4.campaign_id = c4.id AND s4.is_deleted = 0
     WHERE c4.is_deleted = 0 AND c4.google_campaign_id IN ($DUPG)
     GROUP BY c4.google_campaign_id, s4.date
   ) z GROUP BY kept_rows ORDER BY kept_rows;"

echo "===== 闸4. 总额守恒 ====="
Q "CREATE TEMPORARY TABLE tgt3 (id BIGINT PRIMARY KEY);
   INSERT INTO tgt3 (id) $TARGETIDS;
   SELECT ROUND(SUM(s5.cost),2) AS cost_before_fix,
          ROUND(SUM(CASE WHEN s5.id IN (SELECT id FROM tgt3) THEN 0 ELSE s5.cost END),2) AS cost_after_fix,
          ROUND(SUM(CASE WHEN s5.id IN (SELECT id FROM tgt3) THEN s5.cost ELSE 0 END),2) AS cost_removed
   FROM campaigns c5
   JOIN ads_daily_stats s5 ON s5.campaign_id = c5.id AND s5.is_deleted = 0
   WHERE c5.is_deleted = 0 AND c5.google_campaign_id IN ($DUPG);"

echo "===== 闸5. 按人：谁的数字会变（带用户名） ====="
Q "CREATE TEMPORARY TABLE tgt4 (id BIGINT PRIMARY KEY);
   INSERT INTO tgt4 (id) $TARGETIDS;
   SELECT u.username, u.display_name, COUNT(*) AS rows_del, ROUND(SUM(s6.cost),2) AS cost_del,
          MIN(s6.date) AS d_min, MAX(s6.date) AS d_max
   FROM ads_daily_stats s6
   JOIN campaigns c6 ON c6.id = s6.campaign_id
   LEFT JOIN users u ON u.id = c6.user_id
   WHERE s6.id IN (SELECT id FROM tgt4)
   GROUP BY u.username, u.display_name ORDER BY cost_del DESC;"
