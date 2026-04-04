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
  const sa = JSON.parse(mcc.service_account_json);
  const jwt = new JWT({
    email: sa.client_email, key: sa.private_key,
    scopes: ['https://www.googleapis.com/auth/adwords'],
    subject: sa.subject || undefined,
  });
  const { token } = await jwt.getAccessToken();
  const devToken = (mcc.developer_token || process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '').trim();
  const mccId = mcc.mcc_id.replace(/-/g, '');

  // 获取所有已注册的 CID
  const [cidRows] = await conn.execute('SELECT customer_id FROM mcc_cid_accounts WHERE mcc_account_id=6 AND is_deleted=0');
  const registeredCids = new Set(cidRows.map(c => c.customer_id.replace(/-/g, '')));

  // 获取所有子账户
  const resp = await fetch('https://googleads.googleapis.com/v23/customers/' + mccId + '/googleAds:searchStream', {
    method: 'POST', headers: {
      'Authorization': 'Bearer ' + token, 'developer-token': devToken,
      'login-customer-id': mccId, 'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: 'SELECT customer_client.id, customer_client.status, customer_client.manager FROM customer_client WHERE customer_client.manager = false' }),
  });
  const data = await resp.json();
  const canceledCids = [];
  if (Array.isArray(data)) {
    for (const batch of data) {
      if (Array.isArray(batch.results)) {
        for (const r of batch.results) {
          const cc = r.customerClient || {};
          const cid = String(cc.id || '');
          const status = cc.status || '';
          if (status === 'CANCELED') canceledCids.push(cid);
        }
      }
    }
  }

  console.log('CANCELED CIDs 数量: ' + canceledCids.length);
  console.log('');
  console.log('=== 查询所有 CANCELED CID 的 3月费用 ===');
  let totalCanceled = 0;
  for (const cid of canceledCids) {
    try {
      const r2 = await fetch('https://googleads.googleapis.com/v23/customers/' + cid + '/googleAds:searchStream', {
        method: 'POST', headers: {
          'Authorization': 'Bearer ' + token, 'developer-token': devToken,
          'login-customer-id': mccId, 'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: \"SELECT metrics.cost_micros FROM customer WHERE segments.date BETWEEN '2026-03-01' AND '2026-03-26'\" }),
      });
      if (!r2.ok) {
        const errText = await r2.text();
        if (errText.includes('CUSTOMER_NOT_ENABLED')) {
          // 账户已取消，尝试查询 campaign 级别
          const r3 = await fetch('https://googleads.googleapis.com/v23/customers/' + cid + '/googleAds:searchStream', {
            method: 'POST', headers: {
              'Authorization': 'Bearer ' + token, 'developer-token': devToken,
              'login-customer-id': mccId, 'Content-Type': 'application/json',
            },
            body: JSON.stringify({ query: \"SELECT campaign.id, metrics.cost_micros FROM campaign WHERE segments.date BETWEEN '2026-03-01' AND '2026-03-26'\" }),
          });
          if (!r3.ok) {
            console.log('  CID ' + cid + ': 无法访问 (CUSTOMER_NOT_ENABLED)');
            continue;
          }
        } else {
          console.log('  CID ' + cid + ': 查询失败');
          continue;
        }
      }
      const d2 = await r2.json();
      let cost = 0;
      if (Array.isArray(d2)) {
        for (const b of d2) {
          if (Array.isArray(b.results)) {
            for (const r of b.results) cost += Number(r.metrics?.costMicros || 0);
          }
        }
      }
      const costUsd = cost / 1000000;
      totalCanceled += costUsd;
      if (costUsd > 0) console.log('  CID ' + cid + ': \\$' + costUsd.toFixed(2));
      else if (costUsd === 0) { /* skip silent */ }
    } catch (e) {
      console.log('  CID ' + cid + ': ERROR - ' + e.message?.slice(0,80));
    }
  }
  console.log('');
  console.log('CANCELED CID 总费用: \\$' + totalCanceled.toFixed(2));

  // 对比: 注册的 CID 中有哪个不是 ENABLED
  console.log('');
  console.log('=== 注册但不是 ENABLED 的 CID ===');
  const resp2 = await fetch('https://googleads.googleapis.com/v23/customers/' + mccId + '/googleAds:searchStream', {
    method: 'POST', headers: {
      'Authorization': 'Bearer ' + token, 'developer-token': devToken,
      'login-customer-id': mccId, 'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: 'SELECT customer_client.id, customer_client.status FROM customer_client WHERE customer_client.manager = false' }),
  });
  const data2 = await resp2.json();
  if (Array.isArray(data2)) {
    for (const batch of data2) {
      if (Array.isArray(batch.results)) {
        for (const r of batch.results) {
          const cc = r.customerClient || {};
          const cid = String(cc.id || '');
          if (registeredCids.has(cid) && cc.status !== 'ENABLED') {
            console.log('  CID ' + cid + ' status=' + cc.status + ' (已注册但非 ENABLED)');
          }
        }
      }
    }
  }

  await conn.end();
}
main().catch(e => console.error(e));
"
