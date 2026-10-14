#!/bin/bash
# D-366 探查5：多手交接（MCC 登记 >2 次）会不会让「活着那行=新主人」这个口径失真
Q() { sudo mysql google-data-analysis -t -e "$1"; }

echo "===== 1. 涉事 MCC 的完整交接链 ====="
Q "SELECT m.mcc_id AS mcc_no, m.id AS reg_id, u.username, m.is_deleted, m.is_active,
          DATE(CONVERT_TZ(m.created_at,'+00:00','+08:00')) AS reg_cst
   FROM google_mcc_accounts m
   LEFT JOIN users u ON u.id = m.user_id
   WHERE m.mcc_id IN ('821-194-2717','988-504-7597','308-527-6642','418-778-6456',
                      '984-715-0598','736-710-9619','152-782-6127','658-633-7448','482-938-3854')
   ORDER BY m.mcc_id, m.created_at;"

echo "===== 2. 每个 MCC 有几个【活】登记行（>1 则「新主人」不唯一，口径会崩） ====="
Q "SELECT m.mcc_id AS mcc_no, SUM(m.is_deleted=0) AS alive_regs,
          COUNT(*) AS total_regs,
          GROUP_CONCAT(CASE WHEN m.is_deleted=0 THEN u.username END) AS alive_owners
   FROM google_mcc_accounts m
   LEFT JOIN users u ON u.id = m.user_id
   WHERE m.mcc_id IN ('821-194-2717','988-504-7597','308-527-6642','418-778-6456',
                      '984-715-0598','736-710-9619','152-782-6127','658-633-7448','482-938-3854')
   GROUP BY m.mcc_id ORDER BY alive_regs DESC;"

echo "===== 3. 双记 gcid 里，有几组的两侧【都是活 MCC】（无法用 is_deleted 分新旧） ====="
Q "SELECT both_alive, COUNT(*) AS gcid_groups
   FROM (
     SELECT c.google_campaign_id AS g,
            CASE WHEN MIN(m.is_deleted) = 0 AND MAX(m.is_deleted) = 0 THEN 'both_alive'
                 WHEN MIN(m.is_deleted) = 0 AND MAX(m.is_deleted) = 1 THEN 'one_alive_one_deleted'
                 ELSE 'both_deleted' END AS both_alive
     FROM campaigns c
     JOIN google_mcc_accounts m ON m.id = c.mcc_id
     WHERE c.is_deleted = 0 AND c.google_campaign_id IN (
       SELECT google_campaign_id FROM campaigns
       WHERE is_deleted=0 AND google_campaign_id IS NOT NULL
       GROUP BY google_campaign_id HAVING COUNT(DISTINCT user_id)>1)
     GROUP BY c.google_campaign_id
   ) t GROUP BY both_alive;"

echo "===== 4. 两侧都活的那些组：明细（这些不能自动切，要人工定） ====="
Q "SELECT c.google_campaign_id AS gcid,
          GROUP_CONCAT(CONCAT(u.username,'/mcc',m.mcc_id,'/del',m.is_deleted)
                       ORDER BY m.created_at) AS sides,
          ROUND(SUM(x.cost),2) AS cost_total
   FROM campaigns c
   JOIN google_mcc_accounts m ON m.id = c.mcc_id
   LEFT JOIN users u ON u.id = c.user_id
   LEFT JOIN (SELECT campaign_id, SUM(cost) AS cost FROM ads_daily_stats
              WHERE is_deleted=0 GROUP BY campaign_id) x ON x.campaign_id = c.id
   WHERE c.is_deleted = 0 AND c.google_campaign_id IN (
     SELECT google_campaign_id FROM campaigns
     WHERE is_deleted=0 AND google_campaign_id IS NOT NULL
     GROUP BY google_campaign_id HAVING COUNT(DISTINCT user_id)>1)
   GROUP BY c.google_campaign_id
   HAVING MIN(m.is_deleted) = 0 AND MAX(m.is_deleted) = 0
   ORDER BY cost_total DESC LIMIT 30;"
