#!/bin/bash
cd /home/ubuntu/Google-Data-Analysis/crm-mvp
export $(grep -v '^#' .env | grep -v '^$' | xargs)

DB="mysql -u crm -pCrmPass2026! google-data-analysis -N"
WJ02_ID=$($DB -e "SELECT id FROM users WHERE username='wj02';")

# 找组长 (uid=3 的 team 里有组长权限的)
LEADER_ID=$($DB -e "SELECT u2.id FROM users u2 JOIN users u ON u2.team_id=u.team_id WHERE u.id=$WJ02_ID AND u2.role='leader' LIMIT 1;")
echo "wj02 ID=$WJ02_ID, Leader ID=$LEADER_ID"

LEADER_TOKEN=$(node -e "
var jwt = require('jsonwebtoken');
console.log(jwt.sign({userId:'$LEADER_ID',username:'leader',role:'leader'}, process.env.JWT_SECRET, {expiresIn:'120s'}));
")

WJ02_TOKEN=$(node -e "
var jwt = require('jsonwebtoken');
console.log(jwt.sign({userId:'$WJ02_ID',username:'wj02',role:'user'}, process.env.JWT_SECRET, {expiresIn:'120s'}));
")

echo ""
echo "=== 1. member-data (弹窗) ==="
curl -s "http://127.0.0.1:20050/api/user/team/member-data?userId=$WJ02_ID&start_date=2026-03-01&end_date=2026-03-26" \
  -H "Cookie: user_token=$LEADER_TOKEN" --max-time 15 | python3 -c "
import sys,json
d=json.load(sys.stdin)
if d.get('code')==0:
  s=d['data']['summary']
  print(f'  cost=\${s[\"total_cost\"]:.2f}  comm=\${s[\"total_commission\"]:.2f}  rej=\${s[\"rejected_commission\"]:.2f}  net=\${s[\"net_commission\"]:.2f}  roi={s[\"roi\"]}')
  print(f'  净佣金公式验证: {s[\"total_commission\"]:.2f} - {s[\"rejected_commission\"]:.2f} - {s[\"total_cost\"]:.2f} = {s[\"total_commission\"]-s[\"rejected_commission\"]-s[\"total_cost\"]:.2f}')
  print(f'  net_commission = {s[\"net_commission\"]:.2f}  (应该一致)')
else:
  print(f'  error: {d}')
"

echo ""
echo "=== 2. team/stats (组长列表) ==="
curl -s "http://127.0.0.1:20050/api/user/team/stats?start_date=2026-03-01&end_date=2026-03-26" \
  -H "Cookie: user_token=$LEADER_TOKEN" --max-time 15 | python3 -c "
import sys,json
d=json.load(sys.stdin)
if d.get('code')==0:
  for m in d['data'].get('member_ranking',[]):
    print(f'  {m[\"username\"]}: cost=\${m[\"cost\"]:.2f}  comm=\${m[\"commission\"]:.2f}  rej=\${m[\"rejected_commission\"]:.2f}  net=\${m[\"net_commission\"]:.2f}  roi={m[\"roi\"]}%')
    expected_net = m['commission'] - m['rejected_commission'] - m['cost']
    match = 'OK' if abs(m['net_commission'] - expected_net) < 0.02 else 'MISMATCH'
    print(f'    公式验证: {m[\"commission\"]:.2f} - {m[\"rejected_commission\"]:.2f} - {m[\"cost\"]:.2f} = {expected_net:.2f} [{match}]')
else:
  print(f'  error: {d}')
"

echo ""
echo "=== 3. campaigns (个人数据中心) ==="
curl -s "http://127.0.0.1:20050/api/user/data-center/campaigns?date_start=2026-03-01&date_end=2026-03-26&page=1&page_size=1" \
  -H "Cookie: user_token=$WJ02_TOKEN" --max-time 15 | python3 -c "
import sys,json
d=json.load(sys.stdin)
if d.get('code')==0:
  s=d['data']['summary']
  print(f'  cost=\${s[\"totalCost\"]:.2f}  comm=\${s[\"totalCommission\"]:.2f}  rej=\${s[\"totalRejectedCommission\"]:.2f}')
else:
  print(f'  error: {d}')
"

echo ""
echo "=== 4. 费用一致性对比 ==="
echo "  member-data cost 应该 ≈ campaigns cost ≈ team/stats cost"
