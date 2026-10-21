#!/bin/bash
# D-366 探查6：988-504-7597 这类「活登记行反而更早」的反例，在规则下会删到谁
Q() { sudo mysql google-data-analysis -t -e "$1"; }

DUPG="SELECT google_campaign_id FROM campaigns
      WHERE is_deleted=0 AND google_campaign_id IS NOT NULL
      GROUP BY google_campaign_id HAVING COUNT(DISTINCT user_id)>1"

echo "===== 1. 每个涉事 MCC：活登记行是不是【最晚】那一手 ====="
Q "SELECT mcc_id AS mcc_no,
          MAX(CASE WHEN is_deleted=0 THEN created_at END) AS alive_reg_at,
          MAX(created_at) AS latest_reg_at,
          CASE WHEN MAX(CASE WHEN is_deleted=0 THEN created_at END) = MAX(created_at)
               THEN 'alive_is_latest' ELSE 'INVERTED' END AS verdict
   FROM google_mcc_accounts
   WHERE mcc_id IN ('821-194-2717','988-504-7597','308-527-6642','418-778-6456',
                    '984-715-0598','736-710-9619','152-782-6127','658-633-7448','482-938-3854')
   GROUP BY mcc_id ORDER BY verdict, mcc_no;"

echo "===== 2. 反例 MCC 上的双记组：按【活行=新主人】切会删掉谁多少钱 ====="
Q "SELECT m_mcc AS mcc_no, del_user, COUNT(*) AS rows_del, ROUND(SUM(cost),2) AS cost_del,
          MIN(dt) AS d_min, MAX(dt) AS d_max
   FROM (
     SELECT m.mcc_id AS m_mcc, u.username AS del_user, s.cost, s.date AS dt
     FROM campaigns c
     JOIN google_mcc_accounts m ON m.id = c.mcc_id AND m.is_deleted = 0
     JOIN ads_daily_stats s ON s.campaign_id = c.id AND s.is_deleted = 0
     LEFT JOIN users u ON u.id = c.user_id
     JOIN (SELECT mcc_id FROM google_mcc_accounts
           GROUP BY mcc_id
           HAVING MAX(CASE WHEN is_deleted=0 THEN created_at END) <> MAX(created_at)) inv
       ON inv.mcc_id = m.mcc_id
     WHERE c.is_deleted = 0
       AND c.google_campaign_id IN ($DUPG)
       AND s.date < DATE(CONVERT_TZ(m.created_at,'+00:00','+08:00'))
   ) t GROUP BY m_mcc, del_user;"

echo "===== 3. 正常 MCC（活行=最晚手）上的待删量，与反例分开统计 ====="
Q "SELECT verdict, COUNT(*) AS rows_del, ROUND(SUM(cost),2) AS cost_del
   FROM (
     SELECT CASE WHEN inv.mcc_id IS NULL THEN 'alive_is_latest' ELSE 'INVERTED' END AS verdict,
            s.cost
     FROM campaigns c
     JOIN google_mcc_accounts m ON m.id = c.mcc_id AND m.is_deleted = 0
     JOIN ads_daily_stats s ON s.campaign_id = c.id AND s.is_deleted = 0
     LEFT JOIN (SELECT mcc_id FROM google_mcc_accounts
                GROUP BY mcc_id
                HAVING MAX(CASE WHEN is_deleted=0 THEN created_at END) <> MAX(created_at)) inv
       ON inv.mcc_id = m.mcc_id
     WHERE c.is_deleted = 0
       AND c.google_campaign_id IN ($DUPG)
       AND s.date < DATE(CONVERT_TZ(m.created_at,'+00:00','+08:00'))
   ) t GROUP BY verdict;"

echo "===== 4. 988-504-7597：两侧 campaigns 的 created_at 范围（看谁的行更新） ====="
Q "SELECT u.username, m.is_deleted AS mcc_del,
          MIN(c.created_at) AS camp_first, MAX(c.created_at) AS camp_last,
          COUNT(*) AS camps
   FROM campaigns c
   JOIN google_mcc_accounts m ON m.id = c.mcc_id
   LEFT JOIN users u ON u.id = c.user_id
   WHERE c.is_deleted = 0 AND m.mcc_id = '988-504-7597'
   GROUP BY u.username, m.is_deleted;"
