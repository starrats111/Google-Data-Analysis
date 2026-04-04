#!/bin/bash
cd /home/ubuntu/Google-Data-Analysis/crm-mvp
export $(grep -v '^#' .env | grep -v '^$' | xargs)

TOKEN=$(node -e "
var jwt = require('jsonwebtoken');
console.log(jwt.sign({userId:'11',username:'wj10',role:'user'}, process.env.JWT_SECRET, {expiresIn:'600s'}));
")

echo "=== 同步前费用 ==="
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

echo ""
echo "=== 同步 ZWJMCC12090 (id=6) ==="
RESULT1=$(curl -s -X POST "http://127.0.0.1:20050/api/user/data-center/sync" \
  -H "Cookie: user_token=$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mcc_account_id":"6","force_full_sync":true}' \
  --max-time 300)
echo "$RESULT1" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if d.get('code')==0:
  ads=d['data'].get('ads',{})
  s=ads.get('sheet',{})
  a=ads.get('api',{})
  print(f'  Sheet: inserted={s.get(\"inserted\",0)} updated={s.get(\"updated\",0)} msg={s.get(\"message\",\"\")}')
  print(f'  API: inserted={a.get(\"inserted\",0)} updated={a.get(\"updated\",0)} msg={a.get(\"message\",\"\")}')
else:
  print(f'  error: {d}')
"

echo ""
echo "=== 同步 ZWJMCC0203 (id=22) ==="
TOKEN2=$(node -e "
var jwt = require('jsonwebtoken');
console.log(jwt.sign({userId:'11',username:'wj10',role:'user'}, process.env.JWT_SECRET, {expiresIn:'600s'}));
")
RESULT2=$(curl -s -X POST "http://127.0.0.1:20050/api/user/data-center/sync" \
  -H "Cookie: user_token=$TOKEN2" \
  -H "Content-Type: application/json" \
  -d '{"mcc_account_id":"22","force_full_sync":true}' \
  --max-time 300)
echo "$RESULT2" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if d.get('code')==0:
  ads=d['data'].get('ads',{})
  s=ads.get('sheet',{})
  a=ads.get('api',{})
  print(f'  Sheet: inserted={s.get(\"inserted\",0)} updated={s.get(\"updated\",0)} msg={s.get(\"message\",\"\")}')
  print(f'  API: inserted={a.get(\"inserted\",0)} updated={a.get(\"updated\",0)} msg={a.get(\"message\",\"\")}')
else:
  print(f'  error: {d}')
"

echo ""
echo "=== 同步后费用 ==="
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

echo ""
echo "=== API 查询结果 ==="
TOKEN3=$(node -e "
var jwt = require('jsonwebtoken');
console.log(jwt.sign({userId:'11',username:'wj10',role:'user'}, process.env.JWT_SECRET, {expiresIn:'120s'}));
")
curl -s "http://127.0.0.1:20050/api/user/data-center/campaigns?date_start=2026-03-01&date_end=2026-03-26&page=1&page_size=1" \
  -H "Cookie: user_token=$TOKEN3" --max-time 15 | python3 -c "
import sys,json
d=json.load(sys.stdin)
if d.get('code')==0:
  s=d['data']['summary']
  print(f'  totalCost=\${s[\"totalCost\"]:.2f}')
  for mcc in d['data'].get('costByMcc',[]):
    print(f'  MCC {mcc[\"mcc_id\"]} ({mcc[\"mcc_name\"]}): cost_usd=\${mcc[\"cost_usd\"]:.2f}')
"

echo ""
echo "=== 逐日数据 ZWJMCC12090 ==="
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
echo "=== 完成 ==="
