#!/bin/bash
cd /home/ubuntu/Google-Data-Analysis/crm-mvp
export $(grep -v '^#' .env | grep -v '^$' | xargs)

echo "=== 对比 team/stats vs team/member-data vs campaigns 三个接口的费用 ==="

# wj02 = uid 3, 查 March 数据
TOKEN=$(node -e "
var jwt = require('jsonwebtoken');
var t = jwt.sign({userId:'3',username:'test',role:'user'}, process.env.JWT_SECRET, {expiresIn:'120s'});
console.log(t);
")

echo ""
echo "--- 1. team/stats (组长接口) ---"
STATS=$(curl -s "http://127.0.0.1:20050/api/user/team/stats?start_date=2026-03-01&end_date=2026-03-26" \
  -H "Cookie: user_token=$TOKEN" --max-time 15)
echo "$STATS" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if d.get('code')==0:
  ts=d['data'].get('team_stats',{})
  print(f'  team_stats: cost=\${ts.get(\"total_cost\",0):.2f}, comm=\${ts.get(\"total_commission\",0):.2f}, rej=\${ts.get(\"rejected_commission\",0):.2f}, net=\${ts.get(\"net_commission\",0):.2f}, profit=\${ts.get(\"total_profit\",0):.2f}')
  for m in d['data'].get('member_ranking',[]):
    print(f'  member: {m[\"username\"]} cost=\${m[\"cost\"]:.2f} comm=\${m[\"commission\"]:.2f} rej=\${m[\"rejected_commission\"]:.2f} net=\${m[\"net_commission\"]:.2f} profit=\${m.get(\"profit\",0):.2f} roi={m[\"roi\"]}')
else:
  print(f'  error: {d}')
"

echo ""
echo "--- 2. team/member-data (组长查看成员详情) for wj02 ---"
# 需要先找到 wj02 的 user_id
DB='mysql -u crm -pCrmPass2026! google-data-analysis -N'
WJ02_ID=$($DB -e "SELECT id FROM users WHERE username='wj02';")
echo "  wj02 user_id = $WJ02_ID"

MEMBER=$(curl -s "http://127.0.0.1:20050/api/user/team/member-data?userId=$WJ02_ID&start_date=2026-03-01&end_date=2026-03-26" \
  -H "Cookie: user_token=$TOKEN" --max-time 15)
echo "$MEMBER" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if d.get('code')==0:
  s=d['data'].get('summary',{})
  print(f'  summary: cost=\${s.get(\"total_cost\",0):.2f}, comm=\${s.get(\"total_commission\",0):.2f}, rej=\${s.get(\"rejected_commission\",0):.2f}, net=\${s.get(\"net_commission\",0):.2f}, roi={s.get(\"roi\",0)}')
  camps=d['data'].get('campaigns',[])
  cost_camps=[c for c in camps if c.get('cost',0)>0]
  print(f'  campaigns: total={len(camps)}, with_cost={len(cost_camps)}')
  for c in cost_camps[:10]:
    print(f'    {c[\"campaign_name\"]}: cost=\${c[\"cost\"]:.2f}')
else:
  print(f'  error: {d}')
"

echo ""
echo "--- 3. data-center/campaigns (个人数据中心) for wj02 ---"
WJ02_TOKEN=$(node -e "
var jwt = require('jsonwebtoken');
var t = jwt.sign({userId:'$WJ02_ID',username:'wj02',role:'user'}, process.env.JWT_SECRET, {expiresIn:'120s'});
console.log(t);
")
CAMPS=$(curl -s "http://127.0.0.1:20050/api/user/data-center/campaigns?date_start=2026-03-01&date_end=2026-03-26&page=1&page_size=5" \
  -H "Cookie: user_token=$WJ02_TOKEN" --max-time 15)
echo "$CAMPS" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if d.get('code')==0:
  s=d['data'].get('summary',{})
  print(f'  summary: cost=\${s.get(\"totalCost\",0):.2f}, comm=\${s.get(\"totalCommission\",0):.2f}, rej=\${s.get(\"totalRejectedCommission\",0):.2f}')
  print(f'  campaignCount={s.get(\"campaignCount\",0)}, totalClicks={s.get(\"totalClicks\",0)}')
else:
  print(f'  error: {d}')
"

echo ""
echo "--- 4. DB 直查 wj02 campaign 数量和费用 ---"
echo "  总campaign数:"
$DB -e "SELECT COUNT(*) FROM campaigns WHERE user_id=$WJ02_ID AND is_deleted=0 AND google_campaign_id IS NOT NULL;"
echo "  March ads_daily_stats 总费用:"
$DB -e "SELECT ROUND(SUM(ads.cost),2) FROM ads_daily_stats ads JOIN campaigns c ON ads.campaign_id=c.id WHERE c.user_id=$WJ02_ID AND c.is_deleted=0 AND ads.date >= '2026-02-28 16:00:00' AND ads.date < '2026-03-26 16:00:00' AND ads.is_deleted=0;"
echo "  费用非零的campaign_id:"
$DB -e "SELECT ads.campaign_id, c.campaign_name, ROUND(SUM(ads.cost),2) AS total_cost FROM ads_daily_stats ads JOIN campaigns c ON ads.campaign_id=c.id WHERE c.user_id=$WJ02_ID AND c.is_deleted=0 AND ads.date >= '2026-02-28 16:00:00' AND ads.date < '2026-03-26 16:00:00' AND ads.is_deleted=0 AND ads.cost > 0 GROUP BY ads.campaign_id, c.campaign_name ORDER BY total_cost DESC;"
