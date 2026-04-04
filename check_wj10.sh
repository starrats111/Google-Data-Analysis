#!/bin/bash
cd /home/ubuntu/Google-Data-Analysis/crm-mvp
export $(grep -v '^#' .env | grep -v '^$' | xargs)

DB="mysql -u crm -pCrmPass2026! google-data-analysis -N"

WJ10_ID=$($DB -e "SELECT id FROM users WHERE username='wj10';")
echo "wj10 user_id = $WJ10_ID"

echo ""
echo "=== 1. wj10 的 MCC 配置 ==="
$DB -e "SELECT id, mcc_id, mcc_name, currency, sheet_url IS NOT NULL AS has_sheet, service_account_json IS NOT NULL AS has_sa FROM google_mcc_accounts WHERE user_id=$WJ10_ID AND is_deleted=0;"

echo ""
echo "=== 2. 各 MCC 本月费用 (ads_daily_stats) ==="
$DB -e "
SELECT g.id AS mcc_db_id, g.mcc_id, g.mcc_name, g.currency,
  ROUND(SUM(ads.cost),2) AS cost_usd,
  COUNT(*) AS stat_rows,
  COUNT(DISTINCT c.id) AS campaigns_with_data
FROM google_mcc_accounts g
JOIN campaigns c ON c.mcc_id = g.id AND c.is_deleted = 0
JOIN ads_daily_stats ads ON ads.campaign_id = c.id AND ads.is_deleted = 0
  AND ads.date >= '2026-02-28 16:00:00'
  AND ads.date < '2026-03-26 16:00:00'
WHERE g.user_id = $WJ10_ID AND g.is_deleted = 0
GROUP BY g.id, g.mcc_id, g.mcc_name, g.currency;
"

echo ""
echo "=== 3. campaigns API (网站显示) ==="
TOKEN=$(node -e "
var jwt = require('jsonwebtoken');
console.log(jwt.sign({userId:'$WJ10_ID',username:'wj10',role:'user'}, process.env.JWT_SECRET, {expiresIn:'120s'}));
")

curl -s "http://127.0.0.1:20050/api/user/data-center/campaigns?date_start=2026-03-01&date_end=2026-03-26&page=1&page_size=1" \
  -H "Cookie: user_token=$TOKEN" --max-time 15 | python3 -c "
import sys,json
d=json.load(sys.stdin)
if d.get('code')==0:
  s=d['data']['summary']
  print(f'  totalCost=\${s[\"totalCost\"]:.2f}  totalCommission=\${s[\"totalCommission\"]:.2f}')
  for mcc in d['data'].get('costByMcc',[]):
    orig = mcc.get('cost_original','N/A')
    print(f'  MCC {mcc[\"mcc_id\"]} ({mcc[\"mcc_name\"]}): cost_usd=\${mcc[\"cost_usd\"]:.2f}  currency={mcc[\"currency\"]}  cost_original={orig}')
else:
  print(f'  error: {d}')
"

echo ""
echo "=== 4. 各 MCC 按天费用明细 (最近7天) ==="
$DB -e "
SELECT g.mcc_id, g.currency, DATE(ads.date) AS dt,
  ROUND(SUM(ads.cost),4) AS cost_usd,
  COUNT(*) AS cnt
FROM google_mcc_accounts g
JOIN campaigns c ON c.mcc_id = g.id AND c.is_deleted = 0
JOIN ads_daily_stats ads ON ads.campaign_id = c.id AND ads.is_deleted = 0
  AND ads.date >= '2026-03-19'
  AND ads.date < '2026-03-27'
WHERE g.user_id = $WJ10_ID AND g.is_deleted = 0
GROUP BY g.mcc_id, g.currency, DATE(ads.date)
ORDER BY g.mcc_id, dt;
"

echo ""
echo "=== 5. 汇率检查 (本月) ==="
$DB -e "
SELECT date, currency, rate_to_usd
FROM exchange_rate_snapshots
WHERE currency IN (SELECT DISTINCT currency FROM google_mcc_accounts WHERE user_id=$WJ10_ID AND is_deleted=0)
AND date >= '2026-03-01'
ORDER BY currency, date DESC
LIMIT 30;
"

echo ""
echo "=== 6. 各 MCC campaign 总数和有数据的 campaign 数 ==="
$DB -e "
SELECT g.mcc_id,
  COUNT(DISTINCT c.id) AS total_campaigns,
  COUNT(DISTINCT CASE WHEN ads.id IS NOT NULL THEN c.id END) AS campaigns_with_stats
FROM google_mcc_accounts g
JOIN campaigns c ON c.mcc_id = g.id AND c.is_deleted = 0 AND c.google_campaign_id IS NOT NULL
LEFT JOIN ads_daily_stats ads ON ads.campaign_id = c.id AND ads.is_deleted = 0
  AND ads.date >= '2026-02-28 16:00:00' AND ads.date < '2026-03-26 16:00:00'
WHERE g.user_id = $WJ10_ID AND g.is_deleted = 0
GROUP BY g.mcc_id;
"
