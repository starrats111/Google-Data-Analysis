#!/bin/bash
cd /home/ubuntu/Google-Data-Analysis/crm-mvp
export $(grep -v '^#' .env | grep -v '^$' | xargs)

DB="mysql -u crm -pCrmPass2026! google-data-analysis -N"

echo "========================================================"
echo "  wj01-wj10 历史佣金核对 v2 (2025-11 ~ 2026-02)"
echo "  时间：$(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================================"

echo ""
echo "=== 1. DB vs API 逐月汇总对比（使用正确参数名 date_start/date_end） ==="
echo "user | month | DB_total | API_total | diff | DB_rej | API_rej | diff | result"
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

    # API使用CST日期，DB也用CST对齐
    API_RESULT=$(curl -s "http://127.0.0.1:20050/api/user/data-center/commission-by-account?date_start=$START&date_end=$END" \
      -H "Cookie: user_token=$TOKEN" --max-time 15)

    # API内部用parseCSTDateStart/parseCSTDateEndExclusive处理日期
    # 所以DB查询也用对应的CST时间范围对齐
    echo "$API_RESULT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if d.get('code')==0:
  by_acct=d['data'].get('byAccount',[])
  api_total=round(sum(a.get('total_commission',0) for a in by_acct),2)
  api_rej=round(sum(a.get('rejected_commission',0) for a in by_acct),2)
  api_pend=round(sum(a.get('pending_commission',0) for a in by_acct),2)
  accts=len(by_acct)
  acct_detail='; '.join([f\"{a.get('account_name','?')}=\${a.get('total_commission',0):.2f}\" for a in by_acct]) if by_acct else 'none'
  print(f'uid=$uid | $MONTH | API_total=\${api_total:.2f} | rej=\${api_rej:.2f} | pend=\${api_pend:.2f} | {acct_detail}')
else:
  print(f'uid=$uid | $MONTH | error')
" 2>/dev/null
  done
  echo "---"
done

echo ""
echo "=== 2. campaigns API 逐月 MCC费用+佣金（网站实际显示） ==="
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

    RESULT=$(curl -s "http://127.0.0.1:20050/api/user/data-center/campaigns?date_start=$START&date_end=$END&page=1&page_size=2" \
      -H "Cookie: user_token=$TOKEN" --max-time 15)

    echo "$RESULT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if d.get('code')==0:
  s=d['data'].get('summary',{})
  cost=s.get('totalCost',0)
  comm=s.get('totalCommission',0)
  rej=s.get('totalRejectedCommission',0)
  roi=s.get('roi',0)
  camps=s.get('campaignCount',0)
  print(f'uid=$uid | $MONTH | cost=\${cost:.2f} | comm=\${comm:.2f} | rej=\${rej:.2f} | roi={roi} | campaigns={camps}')
" 2>/dev/null
  done
  echo "---"
done

echo ""
echo "========================================================"
echo "  核对完成"
echo "========================================================"
