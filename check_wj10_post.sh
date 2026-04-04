#!/bin/bash
DB="mysql -u crm -pCrmPass2026! google-data-analysis -N"

echo "=== ZWJMCC12090 同步后逐日数据 ==="
$DB -e "
SELECT DATE(ads.date) AS dt,
  ROUND(SUM(ads.cost),2) AS cost,
  COUNT(DISTINCT c.id) AS campaigns
FROM campaigns c
JOIN ads_daily_stats ads ON ads.campaign_id=c.id AND ads.is_deleted=0
WHERE c.mcc_id=6 AND c.user_id=11 AND c.is_deleted=0
  AND ads.date >= '2026-02-28 16:00:00' AND ads.date < '2026-03-26 16:00:00'
GROUP BY DATE(ads.date) ORDER BY dt;
"

echo ""
echo "=== ZWJMCC12090 Sheet 数据条数（检查 sheet 覆盖范围）==="
$DB -e "
SELECT COUNT(*) AS total_rows,
  MIN(date) AS earliest,
  MAX(date) AS latest
FROM ads_daily_stats
WHERE campaign_id IN (SELECT id FROM campaigns WHERE mcc_id=6 AND user_id=11 AND is_deleted=0)
AND is_deleted=0;
"

echo ""
echo "=== 对比：总费用 ==="
echo "ZWJMCC12090:"
$DB -e "SELECT ROUND(SUM(cost),2) FROM ads_daily_stats WHERE campaign_id IN (SELECT id FROM campaigns WHERE mcc_id=6 AND user_id=11 AND is_deleted=0) AND is_deleted=0 AND date >= '2026-02-28 16:00:00' AND date < '2026-03-26 16:00:00';"
echo "ZWJMCC0203:"
$DB -e "SELECT ROUND(SUM(cost),2) FROM ads_daily_stats WHERE campaign_id IN (SELECT id FROM campaigns WHERE mcc_id=22 AND user_id=11 AND is_deleted=0) AND is_deleted=0 AND date >= '2026-02-28 16:00:00' AND date < '2026-03-26 16:00:00';"

echo ""
echo "=== ZWJMCC12090: 3月1日~10日详细（campaign数量少的天） ==="
$DB -e "
SELECT DATE(ads.date) AS dt,
  ROUND(SUM(ads.cost),2) AS cost,
  COUNT(DISTINCT c.id) AS campaigns,
  GROUP_CONCAT(DISTINCT c.customer_id ORDER BY c.customer_id SEPARATOR ',') AS customer_ids
FROM campaigns c
JOIN ads_daily_stats ads ON ads.campaign_id=c.id AND ads.is_deleted=0
WHERE c.mcc_id=6 AND c.user_id=11 AND c.is_deleted=0
  AND ads.date >= '2026-03-01' AND ads.date < '2026-03-11'
  AND ads.cost > 0
GROUP BY DATE(ads.date) ORDER BY dt;
"
