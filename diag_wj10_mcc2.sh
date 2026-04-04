#!/bin/bash
cd /home/ubuntu/Google-Data-Analysis/crm-mvp
export $(grep -v '^#' .env | grep -v '^$' | xargs)

node -e "
const { JWT } = require('google-auth-library');
const mysql = require('mysql2/promise');

async function query(token, devToken, mccId, cid, gaql) {
  const resp = await fetch('https://googleads.googleapis.com/v23/customers/' + cid.replace(/-/g,'') + '/googleAds:searchStream', {
    method: 'POST', headers: {
      'Authorization': 'Bearer ' + token, 'developer-token': devToken,
      'login-customer-id': mccId.replace(/-/g,''), 'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: gaql }),
  });
  if (!resp.ok) { const t = await resp.text(); return { error: t.slice(0,300) }; }
  const data = await resp.json();
  const results = [];
  if (Array.isArray(data)) {
    for (const batch of data) {
      if (Array.isArray(batch.results)) results.push(...batch.results);
    }
  }
  return { results };
}

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
  const mccId = mcc.mcc_id;

  // 1. 查询 MCC 自身的费用（作为 customer 查询）
  console.log('=== 1. MCC 自身账户级别费用 ===');
  const mccCost = await query(token, devToken, mccId, mccId,
    \"SELECT metrics.cost_micros FROM customer WHERE segments.date BETWEEN '2026-03-01' AND '2026-03-26'\");
  if (mccCost.error) {
    console.log('  MCC 查询失败: ' + mccCost.error);
  } else {
    let total = 0;
    for (const r of mccCost.results) total += Number(r.metrics?.costMicros || 0);
    console.log('  MCC 账户级别总费用: \\$' + (total/1000000).toFixed(2));
  }

  // 2. 查询所有子账户（包括 manager=true 的子管理账户）
  console.log('');
  console.log('=== 2. MCC 所有子账户（含子管理账户）===');
  const allClients = await query(token, devToken, mccId, mccId,
    'SELECT customer_client.id, customer_client.descriptive_name, customer_client.status, customer_client.manager, customer_client.level FROM customer_client');
  if (allClients.error) {
    console.log('  查询失败: ' + allClients.error);
  } else {
    const managers = [];
    const nonManagers = [];
    for (const r of allClients.results) {
      const cc = r.customerClient || {};
      const item = { cid: String(cc.id||''), name: cc.descriptiveName||'', status: cc.status||'', manager: cc.manager, level: cc.level };
      if (cc.manager) managers.push(item);
      else nonManagers.push(item);
    }
    console.log('  子管理账户(manager=true): ' + managers.length);
    for (const m of managers) console.log('    CID ' + m.cid + ' (' + m.name + ') status=' + m.status + ' level=' + m.level);
    console.log('  普通子账户(manager=false): ' + nonManagers.length);
    console.log('  (已注册: 29, 状态分布: ENABLED=' + nonManagers.filter(n=>n.status==='ENABLED').length + ' CANCELED=' + nonManagers.filter(n=>n.status==='CANCELED').length + ')');
  }

  // 3. 查询 MCC 下每个子账户的费用（通过 customer_client 资源）
  console.log('');
  console.log('=== 3. 通过 customer_client 资源查询各子账户费用 ===');
  const clientCosts = await query(token, devToken, mccId, mccId,
    \"SELECT customer_client.id, customer_client.descriptive_name, metrics.cost_micros FROM customer_client WHERE segments.date BETWEEN '2026-03-01' AND '2026-03-26' AND customer_client.manager = false\");
  if (clientCosts.error) {
    console.log('  查询失败: ' + clientCosts.error);
  } else {
    let total = 0;
    for (const r of clientCosts.results) {
      const cc = r.customerClient || {};
      const cost = Number(r.metrics?.costMicros || 0) / 1000000;
      total += cost;
      if (cost > 0.01) console.log('  CID ' + cc.id + ': \\$' + cost.toFixed(2));
    }
    console.log('  customer_client 总费用: \\$' + total.toFixed(2));
  }

  // 4. 查询 MCC 自身的 campaign 费用
  console.log('');
  console.log('=== 4. MCC 自身 campaign 费用（如果有）===');
  const mccCampaigns = await query(token, devToken, mccId, mccId,
    \"SELECT campaign.id, campaign.name, metrics.cost_micros FROM campaign WHERE segments.date BETWEEN '2026-03-01' AND '2026-03-26' AND metrics.cost_micros > 0\");
  if (mccCampaigns.error) {
    console.log('  查询失败（正常，MCC 通常没有自己的 campaign）: ' + mccCampaigns.error.slice(0,100));
  } else {
    if (mccCampaigns.results.length === 0) {
      console.log('  MCC 自身无 campaign');
    } else {
      for (const r of mccCampaigns.results) {
        const c = r.campaign || {};
        const cost = Number(r.metrics?.costMicros || 0) / 1000000;
        console.log('  Campaign ' + c.id + ' (' + c.name + '): \\$' + cost.toFixed(2));
      }
    }
  }

  await conn.end();
}
main().catch(e => console.error(e));
"
