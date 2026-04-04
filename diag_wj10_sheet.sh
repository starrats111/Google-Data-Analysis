#!/bin/bash
DB="mysql -u crm -pCrmPass2026! google-data-analysis -N"

echo "=== 检查 campaigns 表中是否有已取消 CID 的 campaign ==="
echo "已取消的 CID 列表: 1106109892,1178439891,1244649329,1293376554,1834137554,2161221311,2850965137,3375123429,4355402521,4623981466,5013415258,5595477842,6033344741,6447607903,7360895466,7954864415,8021120195,8381106768,8760531268,8827103858,8881107135,9283500809,9658203425"
echo ""

$DB -e "
SELECT c.customer_id, COUNT(*) AS campaigns,
  ROUND(SUM(IFNULL(ads_cost,0)),2) AS march_cost
FROM campaigns c
LEFT JOIN (
  SELECT campaign_id, SUM(cost) AS ads_cost
  FROM ads_daily_stats
  WHERE date >= '2026-02-28 16:00:00' AND date < '2026-03-26 16:00:00' AND is_deleted=0
  GROUP BY campaign_id
) a ON a.campaign_id = c.id
WHERE c.mcc_id = 6 AND c.user_id = 11 AND c.is_deleted = 0
  AND c.customer_id IN ('1106109892','1178439891','1244649329','1293376554','1834137554','2161221311','2850965137','3375123429','4355402521','4623981466','5013415258','5595477842','6033344741','6447607903','7360895466','7954864415','8021120195','8381106768','8760531268','8827103858','8881107135','9283500809','9658203425')
GROUP BY c.customer_id;
"

echo ""
echo "=== 检查 Sheet 原始数据中是否有这些 CID ==="
echo "（查看 campaigns 表中这些 CID 的记录来源）"
$DB -e "
SELECT c.customer_id, c.campaign_name, c.google_status,
  (SELECT COUNT(*) FROM ads_daily_stats WHERE campaign_id=c.id AND is_deleted=0 AND date >= '2026-03-01') AS stats_rows,
  (SELECT ROUND(SUM(cost),2) FROM ads_daily_stats WHERE campaign_id=c.id AND is_deleted=0 AND date >= '2026-02-28 16:00:00' AND date < '2026-03-26 16:00:00') AS march_cost
FROM campaigns c
WHERE c.mcc_id = 6 AND c.user_id = 11 AND c.is_deleted = 0
  AND c.customer_id IN ('1106109892','1178439891','1244649329','1293376554','1834137554','2161221311','2850965137','3375123429','4355402521','4623981466','5013415258','5595477842','6033344741','6447607903','7360895466','7954864415','8021120195','8381106768','8760531268','8827103858','8881107135','9283500809','9658203425')
ORDER BY c.customer_id
LIMIT 30;
"

echo ""
echo "=== 所有 CID 的 campaign 数量 ==="
$DB -e "
SELECT customer_id, COUNT(*) AS cnt
FROM campaigns
WHERE mcc_id=6 AND user_id=11 AND is_deleted=0
GROUP BY customer_id
ORDER BY cnt DESC;
"
