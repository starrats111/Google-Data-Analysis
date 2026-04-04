#!/bin/bash
mysql -u crm -pCrmPass2026! google-data-analysis -e "
SELECT u.username,
  DATE_FORMAT(ads.date,'%Y-%m') AS month_str,
  ROUND(SUM(ads.cost),2) AS total_cost,
  COUNT(*) AS cnt
FROM ads_daily_stats ads
JOIN campaigns c ON ads.campaign_id=c.id
JOIN google_mcc_accounts g ON c.mcc_id=g.id
JOIN users u ON g.user_id=u.id
WHERE ads.date >= '2025-10-31 16:00:00'
AND ads.date < '2026-02-28 16:00:00'
GROUP BY u.username, DATE_FORMAT(ads.date,'%Y-%m')
ORDER BY u.id, month_str;
"
