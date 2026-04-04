#!/bin/bash
cd /home/ubuntu/Google-Data-Analysis/crm-mvp
export $(grep -v '^#' .env | grep -v '^$' | xargs)

TOKEN=$(node -e "
var jwt = require('jsonwebtoken');
console.log(jwt.sign({userId:'11',username:'wj10',role:'user'}, process.env.JWT_SECRET, {expiresIn:'120s'}));
")

echo "=== 部署后 API 查询 ==="
curl -s "http://127.0.0.1:20050/api/user/data-center/campaigns?date_start=2026-03-01&date_end=2026-03-26&page=1&page_size=1" \
  -H "Cookie: user_token=$TOKEN" --max-time 15 | python3 -c "
import sys,json
d=json.load(sys.stdin)
if d.get('code')==0:
  s=d['data']['summary']
  print(f'  totalCost=\${s[\"totalCost\"]:.2f}  campaignCount={s[\"campaignCount\"]}')
  print(f'  enabledCount={s[\"enabledCount\"]}  pausedCount={s[\"pausedCount\"]}')
  for mcc in d['data'].get('costByMcc',[]):
    print(f'  MCC {mcc[\"mcc_id\"]} ({mcc[\"mcc_name\"]}): cost_usd=\${mcc[\"cost_usd\"]:.2f}')
  rm=d['data'].get('rowMeta',{})
  print(f'  displayedRows={rm.get(\"displayedCount\",0)} totalRows={rm.get(\"totalCount\",0)}')
else:
  print(f'  error: {d}')
"

echo ""
echo "=== REMOVED campaigns 的费用 ==="
echo "(如果有值，说明 REMOVED campaigns 现在被计入总费用了)"
DB="mysql -u crm -pCrmPass2026! google-data-analysis -N"
$DB -e "
SELECT c.google_campaign_id, c.campaign_name, c.google_status,
  ROUND(SUM(ads.cost),2) AS cost
FROM campaigns c
JOIN ads_daily_stats ads ON ads.campaign_id=c.id AND ads.is_deleted=0
  AND ads.date >= '2026-02-28 16:00:00' AND ads.date < '2026-03-26 16:00:00'
WHERE c.user_id=11 AND c.is_deleted=0 AND c.google_status='REMOVED'
GROUP BY c.id HAVING cost > 0;
"

echo ""
echo "=== 完成 ==="
