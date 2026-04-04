#!/bin/bash
DB="mysql -u crm -pCrmPass2026! google-data-analysis -N"

echo "=== DB MCC费用 按用户按月 (2025-11 ~ 2026-02) ==="
echo "user | month | DB_cost | rows"
$DB -e "
SELECT u.username,
  DATE_FORMAT(ads.date,'%Y-%m') AS m,
  ROUND(SUM(ads.cost),2) AS total_cost,
  COUNT(*) AS rows
FROM ads_daily_stats ads
JOIN campaigns c ON ads.campaign_id=c.id
JOIN google_mcc_accounts g ON c.mcc_id=g.id
JOIN users u ON g.user_id=u.id
WHERE ads.date >= '2025-10-31 16:00:00'
AND ads.date < '2026-02-28 16:00:00'
GROUP BY u.username, DATE_FORMAT(ads.date,'%Y-%m')
ORDER BY u.id, m;
"

echo ""
echo "=== 最早最晚 ads_daily_stats 记录 ==="
$DB -e "
SELECT u.username,
  MIN(ads.date) AS earliest,
  MAX(ads.date) AS latest,
  COUNT(*) AS total_rows
FROM ads_daily_stats ads
JOIN campaigns c ON ads.campaign_id=c.id
JOIN google_mcc_accounts g ON c.mcc_id=g.id
JOIN users u ON g.user_id=u.id
WHERE u.username LIKE 'wj%' AND u.username != 'wjzu'
GROUP BY u.username
ORDER BY u.id;
"
