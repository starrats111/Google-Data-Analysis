#!/bin/bash
cd /home/ubuntu/Google-Data-Analysis/crm-mvp
export $(grep -v '^#' .env | grep -v '^$' | xargs)

DB="mysql -u crm -pCrmPass2026! google-data-analysis -N"

echo "========================================================"
echo "  DB vs API 精确对比（CST时区对齐）"
echo "  时间：$(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================================"

# parseCSTDateStart('2025-11-01') = 2025-10-31 16:00:00 UTC
# parseCSTDateEndExclusive('2025-11-30') = 2025-11-30 16:00:00 UTC (非今天时+1天0点CST)
# parseCSTDateEndExclusive的逻辑：endDate + 1天的CST 0点 = end_date天+1天 - 8小时

# 映射：
# API: date_start=2025-11-01, date_end=2025-11-30
#   -> startDate = 2025-10-31 16:00:00 UTC
#   -> endDate = parseCSTDateEndExclusive('2025-11-30') = 2025-11-30 16:00:00 UTC
# API: date_start=2025-12-01, date_end=2025-12-31
#   -> 2025-11-30 16:00:00 to 2025-12-31 16:00:00
# API: date_start=2026-01-01, date_end=2026-01-31
#   -> 2025-12-31 16:00:00 to 2026-01-31 16:00:00
# API: date_start=2026-02-01, date_end=2026-02-28
#   -> 2026-01-31 16:00:00 to 2026-02-28 16:00:00

echo ""
echo "user | month | DB_total | API_total | total_diff | DB_rej | API_rej | rej_diff | result"

for uid in 2 3 4 5 6 7 8 9 10 11; do
  UNAME=$($DB -e "SELECT username FROM users WHERE id=$uid;")
  TOKEN=$(node -e "
var jwt = require('jsonwebtoken');
var t = jwt.sign({userId:'$uid',username:'test',role:'user'}, process.env.JWT_SECRET, {expiresIn:'120s'});
console.log(t);
")

  for period in \
    "2025-11-01,2025-11-30,2025-10-31 16:00:00,2025-11-30 16:00:00" \
    "2025-12-01,2025-12-31,2025-11-30 16:00:00,2025-12-31 16:00:00" \
    "2026-01-01,2026-01-31,2025-12-31 16:00:00,2026-01-31 16:00:00" \
    "2026-02-01,2026-02-28,2026-01-31 16:00:00,2026-02-28 16:00:00"; do

    API_START=$(echo $period | cut -d, -f1)
    API_END=$(echo $period | cut -d, -f2)
    DB_START=$(echo $period | cut -d, -f3)
    DB_END=$(echo $period | cut -d, -f4)
    MONTH=$(echo $API_START | cut -c1-7)

    DB_TOTAL=$($DB -e "
SELECT ROUND(COALESCE(SUM(commission_amount),0),2)
FROM affiliate_transactions
WHERE user_id=$uid AND is_deleted=0
AND transaction_time >= '$DB_START'
AND transaction_time < '$DB_END';
")

    DB_REJ=$($DB -e "
SELECT ROUND(COALESCE(SUM(CASE WHEN status='rejected' THEN commission_amount ELSE 0 END),0),2)
FROM affiliate_transactions
WHERE user_id=$uid AND is_deleted=0
AND transaction_time >= '$DB_START'
AND transaction_time < '$DB_END';
")

    API_RESULT=$(curl -s "http://127.0.0.1:20050/api/user/data-center/commission-by-account?date_start=$API_START&date_end=$API_END" \
      -H "Cookie: user_token=$TOKEN" --max-time 15)

    echo "$API_RESULT" | python3 -c "
import sys,json
db_total=float('$DB_TOTAL'.strip() or 0)
db_rej=float('$DB_REJ'.strip() or 0)
try:
  d=json.load(sys.stdin)
  if d.get('code')==0:
    by_acct=d['data'].get('byAccount',[])
    api_total=round(sum(a.get('total_commission',0) for a in by_acct),2)
    api_rej=round(sum(a.get('rejected_commission',0) for a in by_acct),2)
    diff_t=round(api_total-db_total,2)
    diff_r=round(api_rej-db_rej,2)
    mark='OK' if abs(diff_t)<0.02 and abs(diff_r)<0.02 else 'MISMATCH'
    print(f'$UNAME | $MONTH | DB=\${db_total:.2f} | API=\${api_total:.2f} | diff=\${diff_t:+.2f} | DB_rej=\${db_rej:.2f} | API_rej=\${api_rej:.2f} | rej_diff=\${diff_r:+.2f} | {mark}')
except:
  print(f'$UNAME | $MONTH | DB=\${db_total:.2f} | API=error')
" 2>/dev/null
  done
done

echo ""
echo "=== MCC费用 DB vs API 对比 ==="
echo "user | month | DB_cost | API_cost | diff | result"

for uid in 2 3 4 5 6 7 8 9 10 11; do
  UNAME=$($DB -e "SELECT username FROM users WHERE id=$uid;")
  TOKEN=$(node -e "
var jwt = require('jsonwebtoken');
var t = jwt.sign({userId:'$uid',username:'test',role:'user'}, process.env.JWT_SECRET, {expiresIn:'120s'});
console.log(t);
")

  for period in \
    "2025-11-01,2025-11-30,2025-10-31 16:00:00,2025-11-30 16:00:00" \
    "2025-12-01,2025-12-31,2025-11-30 16:00:00,2025-12-31 16:00:00" \
    "2026-01-01,2026-01-31,2025-12-31 16:00:00,2026-01-31 16:00:00" \
    "2026-02-01,2026-02-28,2026-01-31 16:00:00,2026-02-28 16:00:00"; do

    API_START=$(echo $period | cut -d, -f1)
    API_END=$(echo $period | cut -d, -f2)
    DB_START=$(echo $period | cut -d, -f3)
    DB_END=$(echo $period | cut -d, -f4)
    MONTH=$(echo $API_START | cut -c1-7)

    DB_COST=$($DB -e "
SELECT ROUND(COALESCE(SUM(ads.cost_usd),0),2)
FROM ads_daily_stats ads
JOIN campaigns c ON ads.campaign_id = c.id
JOIN google_mcc_accounts g ON c.mcc_id = g.id
WHERE g.user_id = $uid
AND ads.date >= '$DB_START'
AND ads.date < '$DB_END';
")

    RESULT=$(curl -s "http://127.0.0.1:20050/api/user/data-center/campaigns?date_start=$API_START&date_end=$API_END&page=1&page_size=1" \
      -H "Cookie: user_token=$TOKEN" --max-time 15)

    echo "$RESULT" | python3 -c "
import sys,json
db_cost=float('$DB_COST'.strip() or 0)
try:
  d=json.load(sys.stdin)
  if d.get('code')==0:
    api_cost=d['data'].get('summary',{}).get('totalCost',0)
    diff=round(api_cost-db_cost,2)
    mark='OK' if abs(diff)<0.02 else 'MISMATCH'
    if api_cost==0 and db_cost==0:
      print(f'$UNAME | $MONTH | DB=\$0.00 | API=\$0.00 | diff=\$0.00 | NO_DATA')
    else:
      print(f'$UNAME | $MONTH | DB=\${db_cost:.2f} | API=\${api_cost:.2f} | diff=\${diff:+.2f} | {mark}')
except:
  print(f'$UNAME | $MONTH | DB=\${db_cost:.2f} | API=error')
" 2>/dev/null
  done
done

echo ""
echo "========================================================"
echo "  核对完成"
echo "========================================================"
