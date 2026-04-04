#!/bin/bash
cd /home/ubuntu/Google-Data-Analysis/crm-mvp
export $(grep -v '^#' .env | grep -v '^$' | xargs)

DB="mysql -u crm -pCrmPass2026! google-data-analysis -N"

# 找 wj02 和所属组长
WJ02_ID=$($DB -e "SELECT id FROM users WHERE username='wj02';")
LEADER_INFO=$($DB -e "SELECT u.id, u.username, u.team_id FROM users u WHERE u.role='leader' AND u.team_id=(SELECT team_id FROM users WHERE id=$WJ02_ID) LIMIT 1;")
LEADER_ID=$(echo "$LEADER_INFO" | awk '{print $1}')
LEADER_NAME=$(echo "$LEADER_INFO" | awk '{print $2}')
TEAM_ID=$(echo "$LEADER_INFO" | awk '{print $3}')
echo "wj02 ID=$WJ02_ID, Leader=$LEADER_NAME(ID=$LEADER_ID), Team=$TEAM_ID"

LEADER_TOKEN=$(node -e "
var jwt = require('jsonwebtoken');
console.log(jwt.sign({userId:'$LEADER_ID',username:'$LEADER_NAME',role:'leader',teamId:'$TEAM_ID'}, process.env.JWT_SECRET, {expiresIn:'120s'}));
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
  expected = round(s['total_commission'] - s['rejected_commission'] - s['total_cost'], 2)
  match = 'OK' if abs(s['net_commission'] - expected) < 0.02 else 'MISMATCH'
  print(f'  公式验证: {s[\"total_commission\"]:.2f} - {s[\"rejected_commission\"]:.2f} - {s[\"total_cost\"]:.2f} = {expected:.2f} [{match}]')
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
  ts=d['data']['team_stats']
  print(f'  team: cost=\${ts[\"total_cost\"]:.2f}  comm=\${ts[\"total_commission\"]:.2f}  rej=\${ts[\"rejected_commission\"]:.2f}  net=\${ts[\"net_commission\"]:.2f}')
  has_profit = 'total_profit' in ts
  print(f'  total_profit字段已移除: {\"NO - 还在!\" if has_profit else \"YES\"}')
  for m in d['data'].get('member_ranking',[]):
    expected_net = round(m['commission'] - m['rejected_commission'] - m['cost'], 2)
    match = 'OK' if abs(m['net_commission'] - expected_net) < 0.02 else 'MISMATCH'
    print(f'  {m[\"username\"]}: cost=\${m[\"cost\"]:.2f}  comm=\${m[\"commission\"]:.2f}  rej=\${m[\"rejected_commission\"]:.2f}  net=\${m[\"net_commission\"]:.2f}  roi={m[\"roi\"]}%  [{match}]')
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
