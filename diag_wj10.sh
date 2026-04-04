#!/bin/bash
cd /home/ubuntu/Google-Data-Analysis/crm-mvp
export $(grep -v '^#' .env | grep -v '^$' | xargs)

DB="mysql -u crm -pCrmPass2026! google-data-analysis -N"

echo "=== 1. DB: 各 CID 本月费用 ==="
$DB -e "
SELECT c.customer_id,
  ROUND(SUM(ads.cost),2) AS db_cost,
  COUNT(DISTINCT c.id) AS campaigns,
  COUNT(DISTINCT DATE(ads.date)) AS days_with_data
FROM campaigns c
JOIN ads_daily_stats ads ON ads.campaign_id=c.id AND ads.is_deleted=0
  AND ads.date >= '2026-02-28 16:00:00' AND ads.date < '2026-03-26 16:00:00'
WHERE c.mcc_id=6 AND c.user_id=11 AND c.is_deleted=0
GROUP BY c.customer_id
ORDER BY db_cost DESC;
"

echo ""
echo "=== 2. Google Ads API: 各 CID 本月费用（按账户级别） ==="

# 获取 MCC 配置
MCC_ROW=$($DB -e "SELECT mcc_id, developer_token, service_account_json FROM google_mcc_accounts WHERE id=6 AND is_deleted=0;")
MCC_ID=$(echo "$MCC_ROW" | awk '{print $1}')
DEV_TOKEN=$(echo "$MCC_ROW" | awk '{print $2}')

node -e "
const { JWT } = require('google-auth-library');
const mysql = require('mysql2/promise');

async function main() {
  const conn = await mysql.createConnection({
    host: 'localhost', user: 'crm', password: 'CrmPass2026!', database: 'google-data-analysis'
  });

  const [rows] = await conn.execute('SELECT mcc_id, developer_token, service_account_json FROM google_mcc_accounts WHERE id=6 AND is_deleted=0');
  if (!rows.length) { console.log('No MCC found'); return; }
  const mcc = rows[0];

  const [cidRows] = await conn.execute('SELECT customer_id FROM mcc_cid_accounts WHERE mcc_account_id=6 AND is_deleted=0 AND status=\"active\"');

  const sa = JSON.parse(mcc.service_account_json);
  const jwt = new JWT({
    email: sa.client_email, key: sa.private_key,
    scopes: ['https://www.googleapis.com/auth/adwords'],
    subject: sa.subject || undefined,
  });
  const { token } = await jwt.getAccessToken();
  const devToken = (mcc.developer_token || process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '').trim();
  const mccId = mcc.mcc_id.replace(/-/g, '');

  let totalApi = 0;
  for (const cid of cidRows) {
    const cidClean = cid.customer_id.replace(/-/g, '');
    try {
      const resp = await fetch('https://googleads.googleapis.com/v23/customers/' + cidClean + '/googleAds:searchStream', {
        method: 'POST', headers: {
          'Authorization': 'Bearer ' + token, 'developer-token': devToken,
          'login-customer-id': mccId, 'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: \"SELECT metrics.cost_micros FROM customer WHERE segments.date BETWEEN '2026-03-01' AND '2026-03-26'\" }),
      });
      const data = await resp.json();
      let cost = 0;
      if (Array.isArray(data)) {
        for (const batch of data) {
          if (Array.isArray(batch.results)) {
            for (const r of batch.results) {
              cost += Number(r.metrics?.costMicros || 0);
            }
          }
        }
      }
      const costUsd = cost / 1000000;
      totalApi += costUsd;
      if (costUsd > 0.01) {
        console.log('  CID ' + cidClean + ': \$' + costUsd.toFixed(2));
      }
    } catch (e) {
      console.log('  CID ' + cidClean + ': ERROR - ' + e.message);
    }
  }
  console.log('  TOTAL API: \$' + totalApi.toFixed(2));
  await conn.end();
}
main().catch(e => console.error(e));
"

echo ""
echo "=== 完成 ==="
