#!/bin/bash
cd /home/ubuntu/Google-Data-Analysis/crm-mvp
export $(grep -v '^#' .env | grep -v '^$' | xargs)

DB="mysql -u crm -pCrmPass2026! google-data-analysis -N"
WJ10_ID=11

echo "=== wj10 两个 MCC 费用差异分析 ==="
echo ""
echo "真实值（Google Ads）: ZWJMCC12090=\$1,375.34  ZWJMCC0203=\$1,704.22"

echo ""
echo "=== 1. 按 customer_id 聚合费用（检查是否有客户账号遗漏） ==="
echo "--- ZWJMCC12090 (mcc_db_id=6) ---"
$DB -e "
SELECT c.customer_id,
  ROUND(SUM(ads.cost),2) AS cost,
  COUNT(DISTINCT c.id) AS campaigns,
  COUNT(*) AS stat_rows
FROM campaigns c
JOIN ads_daily_stats ads ON ads.campaign_id = c.id AND ads.is_deleted = 0
  AND ads.date >= '2026-02-28 16:00:00' AND ads.date < '2026-03-26 16:00:00'
WHERE c.mcc_id = 6 AND c.user_id = $WJ10_ID AND c.is_deleted = 0
GROUP BY c.customer_id
ORDER BY cost DESC;
"

echo ""
echo "--- ZWJMCC0203 (mcc_db_id=22) ---"
$DB -e "
SELECT c.customer_id,
  ROUND(SUM(ads.cost),2) AS cost,
  COUNT(DISTINCT c.id) AS campaigns,
  COUNT(*) AS stat_rows
FROM campaigns c
JOIN ads_daily_stats ads ON ads.campaign_id = c.id AND ads.is_deleted = 0
  AND ads.date >= '2026-02-28 16:00:00' AND ads.date < '2026-03-26 16:00:00'
WHERE c.mcc_id = 22 AND c.user_id = $WJ10_ID AND c.is_deleted = 0
GROUP BY c.customer_id
ORDER BY cost DESC;
"

echo ""
echo "=== 2. 按天聚合全月费用（检查哪些天数据可能缺失） ==="
echo "--- ZWJMCC12090 ---"
$DB -e "
SELECT DATE(ads.date) AS dt,
  ROUND(SUM(ads.cost),2) AS cost,
  COUNT(DISTINCT c.id) AS campaigns
FROM campaigns c
JOIN ads_daily_stats ads ON ads.campaign_id = c.id AND ads.is_deleted = 0
WHERE c.mcc_id = 6 AND c.user_id = $WJ10_ID AND c.is_deleted = 0
  AND ads.date >= '2026-02-28 16:00:00' AND ads.date < '2026-03-26 16:00:00'
GROUP BY DATE(ads.date)
ORDER BY dt;
"

echo ""
echo "--- ZWJMCC0203 ---"
$DB -e "
SELECT DATE(ads.date) AS dt,
  ROUND(SUM(ads.cost),2) AS cost,
  COUNT(DISTINCT c.id) AS campaigns
FROM campaigns c
JOIN ads_daily_stats ads ON ads.campaign_id = c.id AND ads.is_deleted = 0
WHERE c.mcc_id = 22 AND c.user_id = $WJ10_ID AND c.is_deleted = 0
  AND ads.date >= '2026-02-28 16:00:00' AND ads.date < '2026-03-26 16:00:00'
GROUP BY DATE(ads.date)
ORDER BY dt;
"

echo ""
echo "=== 3. 没有 stats 数据的 campaign（可能有费用但未同步） ==="
echo "--- ZWJMCC12090 ---"
$DB -e "
SELECT c.id, c.google_campaign_id, c.campaign_name, c.google_status
FROM campaigns c
WHERE c.mcc_id = 6 AND c.user_id = $WJ10_ID AND c.is_deleted = 0
  AND c.google_campaign_id IS NOT NULL
  AND c.id NOT IN (
    SELECT DISTINCT campaign_id FROM ads_daily_stats
    WHERE date >= '2026-02-28 16:00:00' AND date < '2026-03-26 16:00:00' AND is_deleted = 0
  )
LIMIT 20;
"

echo ""
echo "--- ZWJMCC0203 ---"
$DB -e "
SELECT c.id, c.google_campaign_id, c.campaign_name, c.google_status
FROM campaigns c
WHERE c.mcc_id = 22 AND c.user_id = $WJ10_ID AND c.is_deleted = 0
  AND c.google_campaign_id IS NOT NULL
  AND c.id NOT IN (
    SELECT DISTINCT campaign_id FROM ads_daily_stats
    WHERE date >= '2026-02-28 16:00:00' AND date < '2026-03-26 16:00:00' AND is_deleted = 0
  )
LIMIT 20;
"

echo ""
echo "=== 4. 触发 wj10 手动同步 ==="
TOKEN=$(node -e "
var jwt = require('jsonwebtoken');
console.log(jwt.sign({userId:'$WJ10_ID',username:'wj10',role:'user'}, process.env.JWT_SECRET, {expiresIn:'300s'}));
")

echo "同步 ZWJMCC12090 (id=6)..."
curl -s -X POST "http://127.0.0.1:20050/api/user/data-center/sync" \
  -H "Cookie: user_token=$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mcc_account_id":"6","force_full_sync":true}' \
  --max-time 120 | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(f'  result: {d}')
"

echo ""
echo "同步 ZWJMCC0203 (id=22)..."
curl -s -X POST "http://127.0.0.1:20050/api/user/data-center/sync" \
  -H "Cookie: user_token=$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mcc_account_id":"22","force_full_sync":true}' \
  --max-time 120 | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(f'  result: {d}')
"

echo ""
echo "=== 5. 同步后重新检查费用 ==="
sleep 2
$DB -e "
SELECT g.mcc_id, g.mcc_name,
  ROUND(SUM(ads.cost),2) AS cost_usd,
  COUNT(DISTINCT c.id) AS campaigns_with_data
FROM google_mcc_accounts g
JOIN campaigns c ON c.mcc_id = g.id AND c.is_deleted = 0
JOIN ads_daily_stats ads ON ads.campaign_id = c.id AND ads.is_deleted = 0
  AND ads.date >= '2026-02-28 16:00:00' AND ads.date < '2026-03-26 16:00:00'
WHERE g.user_id = $WJ10_ID AND g.is_deleted = 0
GROUP BY g.mcc_id, g.mcc_name;
"

echo ""
echo "API 重新查询..."
TOKEN2=$(node -e "
var jwt = require('jsonwebtoken');
console.log(jwt.sign({userId:'$WJ10_ID',username:'wj10',role:'user'}, process.env.JWT_SECRET, {expiresIn:'120s'}));
")
curl -s "http://127.0.0.1:20050/api/user/data-center/campaigns?date_start=2026-03-01&date_end=2026-03-26&page=1&page_size=1" \
  -H "Cookie: user_token=$TOKEN2" --max-time 15 | python3 -c "
import sys,json
d=json.load(sys.stdin)
if d.get('code')==0:
  for mcc in d['data'].get('costByMcc',[]):
    print(f'  MCC {mcc[\"mcc_id\"]} ({mcc[\"mcc_name\"]}): cost_usd=\${mcc[\"cost_usd\"]:.2f}')
"
