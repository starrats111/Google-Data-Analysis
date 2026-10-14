#!/bin/bash
# D-366 探查2：双记在「日」这一粒度上的重叠结构，决定能不能按交接日逐行切
Q() { sudo mysql google-data-analysis -t -e "$1"; }

# 双记 gcid + 其当前活跃 MCC 登记行的交接日（CST 日期）
DUP="SELECT c.google_campaign_id AS g,
            DATE(CONVERT_TZ(m.created_at,'+00:00','+08:00')) AS cutoff_cst
     FROM campaigns c
     JOIN google_mcc_accounts m ON m.id = c.mcc_id AND m.is_deleted = 0
     WHERE c.is_deleted = 0 AND c.google_campaign_id IN (
       SELECT google_campaign_id FROM campaigns
       WHERE is_deleted=0 AND google_campaign_id IS NOT NULL
       GROUP BY google_campaign_id HAVING COUNT(DISTINCT user_id)>1)
     GROUP BY c.google_campaign_id, m.created_at"

echo "===== 1. 逐(gcid,日)看：同一天有几个人记了花费 ====="
Q "SELECT owners_that_day, COUNT(*) AS gcid_day_cells, ROUND(SUM(cost_sum),2) AS cost_sum,
          ROUND(SUM(cost_dup),2) AS cost_dup
   FROM (
     SELECT c.google_campaign_id AS g, s.date,
            COUNT(DISTINCT c.user_id) AS owners_that_day,
            SUM(s.cost) AS cost_sum,
            SUM(s.cost) - MAX(s.cost) AS cost_dup
     FROM campaigns c
     JOIN ads_daily_stats s ON s.campaign_id = c.id AND s.is_deleted = 0
     WHERE c.is_deleted = 0 AND c.google_campaign_id IN (SELECT g FROM ($DUP) dd)
     GROUP BY c.google_campaign_id, s.date
   ) t GROUP BY owners_that_day ORDER BY owners_that_day;"

echo "===== 2. 同一(gcid,日)被两人记时，金额是否一样（一样=纯复制，不一样=各自抓的） ====="
Q "SELECT same_amount, COUNT(*) AS cells, ROUND(SUM(cost_dup),2) AS cost_dup
   FROM (
     SELECT c.google_campaign_id AS g, s.date,
            CASE WHEN MIN(s.cost)=MAX(s.cost) THEN 'identical' ELSE 'different' END AS same_amount,
            SUM(s.cost) - MAX(s.cost) AS cost_dup
     FROM campaigns c
     JOIN ads_daily_stats s ON s.campaign_id = c.id AND s.is_deleted = 0
     WHERE c.is_deleted = 0 AND c.google_campaign_id IN (SELECT g FROM ($DUP) dd)
     GROUP BY c.google_campaign_id, s.date
     HAVING COUNT(DISTINCT c.user_id) > 1
   ) t GROUP BY same_amount;"

echo "===== 3. 按交接日切后，每侧该保留多少（这是修复目标口径） ====="
Q "SELECT side, COUNT(*) AS stat_rows, ROUND(SUM(cost),2) AS cost
   FROM (
     SELECT s.id, s.cost,
            CASE WHEN s.date < d.cutoff_cst THEN 'before_cutoff' ELSE 'on_or_after_cutoff' END AS period,
            CASE WHEN m.is_deleted = 0 THEN 'new_owner' ELSE 'old_owner' END AS owner_kind,
            CONCAT(CASE WHEN s.date < d.cutoff_cst THEN 'before' ELSE 'after' END, '_',
                   CASE WHEN m.is_deleted = 0 THEN 'new' ELSE 'old' END) AS side
     FROM campaigns c
     JOIN google_mcc_accounts m ON m.id = c.mcc_id
     JOIN ads_daily_stats s ON s.campaign_id = c.id AND s.is_deleted = 0
     JOIN ($DUP) d ON d.g = c.google_campaign_id
     WHERE c.is_deleted = 0
   ) t GROUP BY side ORDER BY side;"

echo "===== 4. 旧主人那侧：MCC 登记行是否都已软删（决定今后花费会不会继续往旧侧写） ====="
Q "SELECT CASE WHEN m.is_deleted=0 THEN 'alive' ELSE 'soft_deleted' END AS mcc_state,
          m.is_active, COUNT(DISTINCT c.id) AS camp_rows, COUNT(DISTINCT c.user_id) AS users
   FROM campaigns c
   JOIN google_mcc_accounts m ON m.id = c.mcc_id
   WHERE c.is_deleted = 0 AND c.google_campaign_id IN (SELECT g FROM ($DUP) dd)
   GROUP BY mcc_state, m.is_active;"
