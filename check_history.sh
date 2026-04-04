#!/bin/bash
cd /home/ubuntu/Google-Data-Analysis/crm-mvp
export $(grep -v '^#' .env | grep -v '^$' | xargs)

DB="mysql -u crm -pCrmPass2026! google-data-analysis -N"

echo "========================================================"
echo "  wj01-wj10 历史佣金核对 (2025-11 ~ 2026-02)"
echo "  时间：$(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================================"

echo ""
echo "=== 1. 各用户按月汇总 ==="
echo "user | month | txn_count | pending | rejected | total"
$DB -e "
SELECT u.username,
  DATE_FORMAT(at2.transaction_time, '%Y-%m') AS month,
  COUNT(*) AS txn_count,
  ROUND(SUM(CASE WHEN at2.status='pending' THEN at2.commission_amount ELSE 0 END),2) AS pending,
  ROUND(SUM(CASE WHEN at2.status='rejected' THEN at2.commission_amount ELSE 0 END),2) AS rejected,
  ROUND(SUM(at2.commission_amount),2) AS total
FROM users u
JOIN affiliate_transactions at2 ON at2.user_id = u.id AND at2.is_deleted = 0
  AND at2.transaction_time >= '2025-11-01'
  AND at2.transaction_time < '2026-03-01'
WHERE u.username LIKE 'wj%' AND u.username != 'wjzu'
GROUP BY u.username, DATE_FORMAT(at2.transaction_time, '%Y-%m')
ORDER BY u.id, month;
"

echo ""
echo "=== 2. 各用户按月按平台账号明细 ==="
echo "user | month | platform | account | txn_count | pending | rejected | total"
$DB -e "
SELECT u.username,
  DATE_FORMAT(at2.transaction_time, '%Y-%m') AS month,
  pc.platform,
  pc.account_name,
  COUNT(*) AS txn_count,
  ROUND(SUM(CASE WHEN at2.status='pending' THEN at2.commission_amount ELSE 0 END),2) AS pending,
  ROUND(SUM(CASE WHEN at2.status='rejected' THEN at2.commission_amount ELSE 0 END),2) AS rejected,
  ROUND(SUM(at2.commission_amount),2) AS total
FROM users u
JOIN platform_connections pc ON pc.user_id = u.id AND pc.is_deleted = 0
JOIN affiliate_transactions at2 ON at2.platform_connection_id = pc.id AND at2.is_deleted = 0
  AND at2.transaction_time >= '2025-11-01'
  AND at2.transaction_time < '2026-03-01'
WHERE u.username LIKE 'wj%' AND u.username != 'wjzu'
GROUP BY u.username, month, pc.platform, pc.account_name
ORDER BY u.id, month, pc.id;
"

echo ""
echo "=== 3. API 对比：逐用户逐月调佣金接口 ==="
for uid in 2 3 4 5 6 7 8 9 10 11; do
  TOKEN=$(node -e "
var jwt = require('jsonwebtoken');
var t = jwt.sign({userId:'$uid',username:'test',role:'user'}, process.env.JWT_SECRET, {expiresIn:'120s'});
console.log(t);
")

  for period in "2025-11-01,2025-11-30" "2025-12-01,2025-12-31" "2026-01-01,2026-01-31" "2026-02-01,2026-02-28"; do
    START=$(echo $period | cut -d, -f1)
    END=$(echo $period | cut -d, -f2)
    MONTH=$(echo $START | cut -c1-7)

    RESULT=$(curl -s "http://127.0.0.1:20050/api/user/data-center/commission-by-account?start_date=$START&end_date=$END" \
      -H "Cookie: user_token=$TOKEN" --max-time 15)

    echo "$RESULT" | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  if d.get('code')==0:
    by_acct=d['data'].get('byAccount',[])
    total=sum(a.get('total_commission',0) for a in by_acct)
    rej=sum(a.get('rejected_commission',0) for a in by_acct)
    pend=sum(a.get('pending_commission',0) for a in by_acct)
    accts=len(by_acct)
    print(f'uid=$uid | $MONTH | API_total=\${total:.2f} | pending=\${pend:.2f} | rejected=\${rej:.2f} | accounts={accts}')
  else:
    print(f'uid=$uid | $MONTH | error={d.get(\"message\",\"?\")}'  )
except Exception as e:
  print(f'uid=$uid | $MONTH | parse_error={e}')
" 2>/dev/null
  done
  echo "---"
done

echo ""
echo "=== 4. DB vs API 逐月汇总对比 ==="
for uid in 2 3 4 5 6 7 8 9 10 11; do
  TOKEN=$(node -e "
var jwt = require('jsonwebtoken');
var t = jwt.sign({userId:'$uid',username:'test',role:'user'}, process.env.JWT_SECRET, {expiresIn:'120s'});
console.log(t);
")

  for period in "2025-11-01,2025-11-30,2025-10-31 16:00:00,2025-11-30 16:00:00" "2025-12-01,2025-12-31,2025-11-30 16:00:00,2025-12-31 16:00:00" "2026-01-01,2026-01-31,2025-12-31 16:00:00,2026-01-31 16:00:00" "2026-02-01,2026-02-28,2026-01-31 16:00:00,2026-02-28 16:00:00"; do
    START=$(echo $period | cut -d, -f1)
    END=$(echo $period | cut -d, -f2)
    DB_START=$(echo $period | cut -d, -f3)
    DB_END=$(echo $period | cut -d, -f4)
    MONTH=$(echo $START | cut -c1-7)

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

    API_RESULT=$(curl -s "http://127.0.0.1:20050/api/user/data-center/commission-by-account?start_date=$START&end_date=$END" \
      -H "Cookie: user_token=$TOKEN" --max-time 15)

    echo "$API_RESULT" | python3 -c "
import sys,json
db_total=$DB_TOTAL
db_rej=$DB_REJ
d=json.load(sys.stdin)
if d.get('code')==0:
  by_acct=d['data'].get('byAccount',[])
  api_total=sum(a.get('total_commission',0) for a in by_acct)
  api_rej=sum(a.get('rejected_commission',0) for a in by_acct)
  diff_t=round(api_total-db_total,2)
  diff_r=round(api_rej-db_rej,2)
  mark='OK' if abs(diff_t)<0.02 else 'MISMATCH'
  if api_total==0 and db_total==0:
    pass
  else:
    print(f'uid=$uid | $MONTH | DB=\${db_total:.2f} | API=\${api_total:.2f} | diff=\${diff_t:+.2f} | rej_diff=\${diff_r:+.2f} | {mark}')
" 2>/dev/null
  done
done

echo ""
echo "=== 5. 数据完整性：各用户最早/最晚交易 ==="
$DB -e "
SELECT u.username,
  MIN(at2.transaction_time) AS earliest_txn,
  MAX(at2.transaction_time) AS latest_txn,
  COUNT(*) AS total_txns
FROM users u
JOIN affiliate_transactions at2 ON at2.user_id = u.id AND at2.is_deleted = 0
WHERE u.username LIKE 'wj%' AND u.username != 'wjzu'
GROUP BY u.username
ORDER BY u.id;
"

echo ""
echo "========================================================"
echo "  核对完成"
echo "========================================================"
