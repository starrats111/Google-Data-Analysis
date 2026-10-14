#!/bin/bash
# D-366 探查：全库同 gcid 跨人双记——哪些是 MCC 交接造成的，交接日能不能定出来
Q() { sudo mysql google-data-analysis -t -e "$1"; }

echo "===== 1. 跨人双记规模（活行，按 gcid 分组） ====="
Q "SELECT COUNT(*) AS dup_groups, SUM(owners) AS rows_total
   FROM (SELECT google_campaign_id, COUNT(DISTINCT user_id) AS owners
         FROM campaigns WHERE is_deleted=0 AND google_campaign_id IS NOT NULL
         GROUP BY google_campaign_id HAVING COUNT(DISTINCT user_id)>1) t;"

echo "===== 2. 这些 gcid 分布在哪些 MCC 上，是不是都有「同 MCC 号多人登记」 ====="
Q "SELECT m.mcc_id AS mcc_no,
          COUNT(DISTINCT c.google_campaign_id) AS dup_gcids,
          COUNT(DISTINCT c.user_id) AS owners,
          GROUP_CONCAT(DISTINCT u.username ORDER BY u.username) AS users,
          (SELECT COUNT(DISTINCT user_id) FROM google_mcc_accounts
            WHERE mcc_id = m.mcc_id) AS mcc_reg_owners
   FROM campaigns c
   JOIN google_mcc_accounts m ON m.id = c.mcc_id
   LEFT JOIN users u ON u.id = c.user_id
   WHERE c.is_deleted=0 AND c.google_campaign_id IN (
     SELECT google_campaign_id FROM campaigns
     WHERE is_deleted=0 AND google_campaign_id IS NOT NULL
     GROUP BY google_campaign_id HAVING COUNT(DISTINCT user_id)>1)
   GROUP BY m.mcc_id
   ORDER BY dup_gcids DESC;"

echo "===== 3. 每组双记：两边花费是否完全镜像（镜像=纯重复，不镜像=各自有独立数据） ====="
Q "SELECT mirror, COUNT(*) AS gcid_groups, ROUND(SUM(dup_cost),2) AS dup_cost
   FROM (
     SELECT c.google_campaign_id AS g,
            CASE WHEN MIN(x.cost)=MAX(x.cost) THEN 'exact_mirror' ELSE 'differs' END AS mirror,
            SUM(x.cost)-MAX(x.cost) AS dup_cost
     FROM campaigns c
     JOIN (SELECT campaign_id, SUM(cost) AS cost FROM ads_daily_stats
           WHERE is_deleted=0 GROUP BY campaign_id) x ON x.campaign_id=c.id
     WHERE c.is_deleted=0 AND c.google_campaign_id IS NOT NULL
     GROUP BY c.google_campaign_id
     HAVING COUNT(DISTINCT c.user_id)>1 AND SUM(x.cost)>0
   ) t GROUP BY mirror;"

echo "===== 4. 能否为每组定出「交接日」= 新主人 MCC 登记行的 created_at ====="
Q "SELECT CASE WHEN handover_at IS NULL THEN 'no_cutoff' ELSE 'has_cutoff' END AS cutoff_state,
          COUNT(*) AS gcid_groups
   FROM (
     SELECT c.google_campaign_id AS g,
            MAX(m.created_at) AS handover_at
     FROM campaigns c
     LEFT JOIN google_mcc_accounts m ON m.id = c.mcc_id
     WHERE c.is_deleted=0 AND c.google_campaign_id IS NOT NULL
     GROUP BY c.google_campaign_id
     HAVING COUNT(DISTINCT c.user_id)>1
   ) t GROUP BY cutoff_state;"

echo "===== 5. 按交接日切：有多少组的花费【全部】落在交接日之前（=全归旧主人） ====="
Q "SELECT split_class, COUNT(*) AS gcid_groups, ROUND(SUM(cost_new_side),2) AS cost_on_new_side
   FROM (
     SELECT c.google_campaign_id AS g,
            m_new.created_at AS handover_at,
            SUM(CASE WHEN s.date >= DATE(CONVERT_TZ(m_new.created_at,'+00:00','+08:00'))
                     THEN s.cost ELSE 0 END) AS cost_after,
            SUM(CASE WHEN s.date <  DATE(CONVERT_TZ(m_new.created_at,'+00:00','+08:00'))
                     THEN s.cost ELSE 0 END) AS cost_before,
            SUM(s.cost) AS cost_new_side,
            CASE WHEN SUM(CASE WHEN s.date >= DATE(CONVERT_TZ(m_new.created_at,'+00:00','+08:00'))
                               THEN s.cost ELSE 0 END) = 0
                 THEN 'all_before_handover' ELSE 'has_after_handover' END AS split_class
     FROM campaigns c
     JOIN google_mcc_accounts m_new ON m_new.id = c.mcc_id AND m_new.is_deleted = 0
     JOIN ads_daily_stats s ON s.campaign_id = c.id AND s.is_deleted = 0
     WHERE c.is_deleted = 0 AND c.google_campaign_id IN (
       SELECT google_campaign_id FROM campaigns
       WHERE is_deleted=0 AND google_campaign_id IS NOT NULL
       GROUP BY google_campaign_id HAVING COUNT(DISTINCT user_id)>1)
     GROUP BY c.google_campaign_id, m_new.created_at
   ) t GROUP BY split_class;"
