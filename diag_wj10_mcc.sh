#!/bin/bash
cd /home/ubuntu/Google-Data-Analysis/crm-mvp
export $(grep -v '^#' .env | grep -v '^$' | xargs)

node -e "
const { JWT } = require('google-auth-library');
const mysql = require('mysql2/promise');

async function main() {
  const conn = await mysql.createConnection({
    host: 'localhost', user: 'crm', password: 'CrmPass2026!', database: 'google-data-analysis'
  });

  const [rows] = await conn.execute('SELECT mcc_id, developer_token, service_account_json FROM google_mcc_accounts WHERE id=6 AND is_deleted=0');
  const mcc = rows[0];
  
  const [cidRows] = await conn.execute('SELECT customer_id FROM mcc_cid_accounts WHERE mcc_account_id=6 AND is_deleted=0');
  const registeredCids = new Set(cidRows.map(c => c.customer_id.replace(/-/g, '')));

  const sa = JSON.parse(mcc.service_account_json);
  const jwt = new JWT({
    email: sa.client_email, key: sa.private_key,
    scopes: ['https://www.googleapis.com/auth/adwords'],
    subject: sa.subject || undefined,
  });
  const { token } = await jwt.getAccessToken();
  const devToken = (mcc.developer_token || process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '').trim();
  const mccId = mcc.mcc_id.replace(/-/g, '');

  // 查询 MCC 下所有子账户
  console.log('=== MCC 子账户列表 vs 已注册 CID ===');
  const resp = await fetch('https://googleads.googleapis.com/v23/customers/' + mccId + '/googleAds:searchStream', {
    method: 'POST', headers: {
      'Authorization': 'Bearer ' + token, 'developer-token': devToken,
      'login-customer-id': mccId, 'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: 'SELECT customer_client.id, customer_client.descriptive_name, customer_client.status, customer_client.manager FROM customer_client WHERE customer_client.manager = false' }),
  });
  const data = await resp.json();
  
  let allChildren = [];
  let missing = [];
  if (Array.isArray(data)) {
    for (const batch of data) {
      if (Array.isArray(batch.results)) {
        for (const r of batch.results) {
          const cc = r.customerClient || {};
          const cid = String(cc.id || '');
          const name = cc.descriptiveName || '';
          const status = cc.status || '';
          allChildren.push({ cid, name, status });
          const isRegistered = registeredCids.has(cid);
          if (!isRegistered) {
            missing.push({ cid, name, status });
          }
        }
      }
    }
  }
  
  console.log('MCC 下总子账户数: ' + allChildren.length);
  console.log('已注册 CID 数: ' + registeredCids.size);
  console.log('未注册 CID 数: ' + missing.length);
  
  if (missing.length > 0) {
    console.log('');
    console.log('=== 未注册的 CID ===');
    for (const m of missing) {
      console.log('  CID ' + m.cid + ' (' + m.name + ') status=' + m.status);
    }
    
    // 查询未注册 CID 的费用
    console.log('');
    console.log('=== 未注册 CID 的本月费用 ===');
    let totalMissing = 0;
    for (const m of missing) {
      if (m.status !== 'ENABLED') continue;
      try {
        const r2 = await fetch('https://googleads.googleapis.com/v23/customers/' + m.cid + '/googleAds:searchStream', {
          method: 'POST', headers: {
            'Authorization': 'Bearer ' + token, 'developer-token': devToken,
            'login-customer-id': mccId, 'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query: \"SELECT metrics.cost_micros FROM customer WHERE segments.date BETWEEN '2026-03-01' AND '2026-03-26'\" }),
        });
        const d2 = await r2.json();
        let cost = 0;
        if (Array.isArray(d2)) {
          for (const b of d2) {
            if (Array.isArray(b.results)) {
              for (const r of b.results) {
                cost += Number(r.metrics?.costMicros || 0);
              }
            }
          }
        }
        const costUsd = cost / 1000000;
        totalMissing += costUsd;
        if (costUsd > 0) {
          console.log('  CID ' + m.cid + ' (' + m.name + '): \\$' + costUsd.toFixed(2));
        }
      } catch (e) {
        console.log('  CID ' + m.cid + ': ERROR - ' + e.message);
      }
    }
    console.log('  未注册 CID 总费用: \\$' + totalMissing.toFixed(2));
  }
  
  await conn.end();
}
main().catch(e => console.error(e));
"
