#!/bin/bash
cd /home/ubuntu/Google-Data-Analysis/crm-mvp
export $(grep -v '^#' .env | grep -v '^$' | xargs)

DB="mysql -u crm -pCrmPass2026! google-data-analysis -N"

echo "=== 同步前 ZWJMCC12090 费用 ==="
$DB -e "SELECT ROUND(SUM(ads.cost),2) FROM ads_daily_stats ads JOIN campaigns c ON c.id=ads.campaign_id AND c.is_deleted=0 WHERE c.mcc_id=6 AND c.user_id=11 AND ads.is_deleted=0 AND ads.date >= '2026-02-28 16:00:00' AND ads.date < '2026-03-26 16:00:00';"

TOKEN=$(node -e "
var jwt = require('jsonwebtoken');
console.log(jwt.sign({userId:'11',username:'wj10',role:'user'}, process.env.JWT_SECRET, {expiresIn:'600s'}));
")

echo ""
echo "=== 同步 ZWJMCC12090 (id=6) force_full_sync ==="
curl -s -X POST "http://127.0.0.1:20050/api/user/data-center/sync" \
  -H "Cookie: user_token=$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mcc_account_id":"6","force_full_sync":true}' \
  --max-time 300 | python3 -c "
import sys,json
d=json.load(sys.stdin)
if d.get('code')==0:
  ads=d['data'].get('ads',{})
  s=ads.get('sheet',{})
  a=ads.get('api',{})
  print(f'  Sheet: inserted={s.get(\"inserted\",0)} updated={s.get(\"updated\",0)}')
  print(f'  API: inserted={a.get(\"inserted\",0)} updated={a.get(\"updated\",0)} msg={a.get(\"message\",\"\")}')
else:
  print(f'  error: {d}')
"

echo ""
echo "=== 同步后 ZWJMCC12090 费用 ==="
$DB -e "SELECT ROUND(SUM(ads.cost),2) FROM ads_daily_stats ads JOIN campaigns c ON c.id=ads.campaign_id AND c.is_deleted=0 WHERE c.mcc_id=6 AND c.user_id=11 AND ads.is_deleted=0 AND ads.date >= '2026-02-28 16:00:00' AND ads.date < '2026-03-26 16:00:00';"

echo ""
echo "=== API 查询 ==="
TOKEN2=$(node -e "
var jwt = require('jsonwebtoken');
console.log(jwt.sign({userId:'11',username:'wj10',role:'user'}, process.env.JWT_SECRET, {expiresIn:'120s'}));
")
curl -s "http://127.0.0.1:20050/api/user/data-center/campaigns?date_start=2026-03-01&date_end=2026-03-26&page=1&page_size=1" \
  -H "Cookie: user_token=$TOKEN2" --max-time 15 | python3 -c "
import sys,json
d=json.load(sys.stdin)
if d.get('code')==0:
  for mcc in d['data'].get('costByMcc',[]):
    print(f'  {mcc[\"mcc_name\"]}: \${mcc[\"cost_usd\"]:.2f}')
"

echo ""
echo "=== ZWJMCC12090 有数据的 REMOVED campaigns 费用 ==="
$DB -e "
SELECT c.id, c.google_campaign_id, c.campaign_name,
  ROUND(SUM(ads.cost),2) AS cost
FROM campaigns c
JOIN ads_daily_stats ads ON ads.campaign_id=c.id AND ads.is_deleted=0
  AND ads.date >= '2026-02-28 16:00:00' AND ads.date < '2026-03-26 16:00:00'
WHERE c.mcc_id=6 AND c.user_id=11 AND c.is_deleted=0 AND c.google_status='REMOVED'
GROUP BY c.id HAVING cost > 0;
"

echo ""
echo "=== 完成 ==="
