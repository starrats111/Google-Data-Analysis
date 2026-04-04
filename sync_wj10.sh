#!/bin/bash
cd /home/ubuntu/Google-Data-Analysis/crm-mvp
export $(grep -v '^#' .env | grep -v '^$' | xargs)

TOKEN=$(node -e "
var jwt = require('jsonwebtoken');
console.log(jwt.sign({userId:'11',username:'wj10',role:'user'}, process.env.JWT_SECRET, {expiresIn:'600s'}));
")

echo "=== 同步 ZWJMCC12090 (id=6) ==="
curl -s -X POST "http://127.0.0.1:20050/api/user/data-center/sync" \
  -H "Cookie: user_token=$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mcc_account_id":"6","force_full_sync":true}' \
  --max-time 300
echo ""

echo "=== 同步 ZWJMCC0203 (id=22) ==="
curl -s -X POST "http://127.0.0.1:20050/api/user/data-center/sync" \
  -H "Cookie: user_token=$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mcc_account_id":"22","force_full_sync":true}' \
  --max-time 300
echo ""

echo "=== 同步后检查 ==="
DB="mysql -u crm -pCrmPass2026! google-data-analysis -N"
$DB -e "
SELECT g.mcc_id, g.mcc_name,
  ROUND(SUM(ads.cost),2) AS cost_usd,
  COUNT(DISTINCT c.id) AS campaigns
FROM google_mcc_accounts g
JOIN campaigns c ON c.mcc_id = g.id AND c.is_deleted = 0
JOIN ads_daily_stats ads ON ads.campaign_id = c.id AND ads.is_deleted = 0
  AND ads.date >= '2026-02-28 16:00:00' AND ads.date < '2026-03-26 16:00:00'
WHERE g.user_id = 11 AND g.is_deleted = 0
GROUP BY g.mcc_id, g.mcc_name;
"

TOKEN2=$(node -e "
var jwt = require('jsonwebtoken');
console.log(jwt.sign({userId:'11',username:'wj10',role:'user'}, process.env.JWT_SECRET, {expiresIn:'120s'}));
")
echo ""
echo "API costByMcc:"
curl -s "http://127.0.0.1:20050/api/user/data-center/campaigns?date_start=2026-03-01&date_end=2026-03-26&page=1&page_size=1" \
  -H "Cookie: user_token=$TOKEN2" --max-time 15 | python3 -c "
import sys,json
d=json.load(sys.stdin)
if d.get('code')==0:
  for mcc in d['data'].get('costByMcc',[]):
    print(f'  {mcc[\"mcc_name\"]}: \${mcc[\"cost_usd\"]:.2f}')
"
echo ""
echo "=== 完成 ==="
