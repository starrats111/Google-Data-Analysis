const Database = require('better-sqlite3');
const axios = require('axios');
const db = new Database('./data.db');

console.log('=== 同步所有 PartnerMatic 账号的订单状态 ===\n');

// 获取所有 PartnerMatic 账号
const accounts = db.prepare(`
  SELECT pa.*, u.username 
  FROM platform_accounts pa
  INNER JOIN users u ON pa.user_id = u.id
  WHERE pa.platform = 'partnermatic'
    AND pa.api_token IS NOT NULL
  ORDER BY u.username, pa.account_name
`).all();

console.log(`找到 ${accounts.length} 个 PartnerMatic 账号\n`);

// 调用 Transaction V3 API 获取订单数据
async function fetchTransactionV3(account, page = 1) {
  const url = 'https://api.partnermatic.com/api/transaction_v3';
  
  const requestBody = {
    appId: 32,
    beginDate: '2025-01-01',
    endDate: '2026-12-31',
    curPage: page,
    perPage: 100,
    source: 'partnermatic',
    token: account.api_token
  };

  try {
    const response = await axios.post(url, requestBody, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if ((response.data.code === 0 || response.data.code === '0') && response.data.data) {
      return response.data.data;
    } else {
      console.error(`  ❌ API 返回错误:`, response.data.message);
      return null;
    }
  } catch (error) {
    console.error(`  ❌ API 调用失败:`, error.message);
    return null;
  }
}

async function syncAccount(account) {
  console.log(`\n📋 同步账号: ${account.account_name} (${account.username})`);
  console.log(`  账号ID: ${account.id}`);
  console.log(`  Token: ${account.api_token.substring(0, 10)}...`);
  
  let page = 1;
  let totalFetched = 0;
  let totalUpdated = 0;
  let hasApprovedOrders = 0;
  
  while (true) {
    const data = await fetchTransactionV3(account, page);
    
    if (!data || !data.list || data.list.length === 0) {
      break;
    }

    totalFetched += data.list.length;

    // 更新数据库中的订单
    const updateStmt = db.prepare(`
      UPDATE orders
      SET 
        status = ?,
        settlement_id = ?,
        settlement_date = ?,
        paid_date = ?,
        payment_id = ?
      WHERE order_id = ?
        AND platform_account_id = ?
    `);

    for (const order of data.list) {
      // Transaction V3 API 的数据结构：status 等字段在 items 数组中
      if (!order.items || order.items.length === 0) {
        continue;
      }

      // 使用第一个 item 的数据
      const item = order.items[0];
      
      const orderId = order.order_id;
      const status = item.status || 'Pending';
      const settlementId = item.settlement_id || null;
      const settlementDate = item.settlement_date || null;
      const paidDate = item.paid_date || null;
      const paymentId = item.payment_id && item.payment_id !== '0' ? item.payment_id : null;

      // 更新订单
      const result = updateStmt.run(
        status,
        settlementId,
        settlementDate,
        paidDate,
        paymentId,
        orderId,
        account.id
      );

      if (result.changes > 0) {
        totalUpdated++;
        if (status === 'Approved' && settlementDate) {
          hasApprovedOrders++;
        }
      }
    }

    // 检查是否还有更多页
    if (data.list.length < 100) {
      break;
    }

    page++;
    
    // 避免请求过快
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log(`  ✅ 获取: ${totalFetched} 条订单`);
  console.log(`  ✅ 更新: ${totalUpdated} 条订单`);
  console.log(`  ✅ Approved: ${hasApprovedOrders} 条订单`);

  // 统计该账号的可提现金额
  const withdrawable = db.prepare(`
    SELECT 
      COUNT(*) as count,
      COALESCE(SUM(commission), 0) as total
    FROM orders
    WHERE platform_account_id = ?
      AND status = 'Approved'
      AND settlement_date IS NOT NULL
      AND paid_date IS NULL
  `).get(account.id);

  console.log(`  💰 可提现: ${withdrawable.count} 条订单, $${withdrawable.total.toFixed(2)}`);
}

async function syncAllAccounts() {
  for (const account of accounts) {
    await syncAccount(account);
  }

  console.log('\n\n=== 同步完成 ===\n');

  // 显示总体统计
  const summary = db.prepare(`
    SELECT 
      pa.account_name,
      u.username,
      COUNT(CASE WHEN o.status = 'Approved' AND o.settlement_date IS NOT NULL AND o.paid_date IS NULL THEN 1 END) as withdrawable_count,
      COALESCE(SUM(CASE WHEN o.status = 'Approved' AND o.settlement_date IS NOT NULL AND o.paid_date IS NULL THEN o.commission END), 0) as withdrawable_amount,
      COUNT(CASE WHEN o.status = 'Approved' AND o.paid_date IS NOT NULL THEN 1 END) as withdrawn_count,
      COALESCE(SUM(CASE WHEN o.status = 'Approved' AND o.paid_date IS NOT NULL THEN o.commission END), 0) as withdrawn_amount
    FROM platform_accounts pa
    INNER JOIN users u ON pa.user_id = u.id
    LEFT JOIN orders o ON o.platform_account_id = pa.id
    WHERE pa.platform = 'partnermatic'
    GROUP BY pa.id, pa.account_name, u.username
    ORDER BY u.username, pa.account_name
  `).all();

  console.log('📊 各账号提现统计:\n');
  summary.forEach(row => {
    console.log(`${row.account_name} (${row.username}):`);
    console.log(`  可提现: ${row.withdrawable_count} 条订单, $${row.withdrawable_amount.toFixed(2)}`);
    console.log(`  已提现: ${row.withdrawn_count} 条订单, $${row.withdrawn_amount.toFixed(2)}`);
  });

  db.close();
}

syncAllAccounts()
  .then(() => {
    console.log('\n✅ 所有账号同步完成');
  })
  .catch(error => {
    console.error('\n❌ 同步失败:', error);
    db.close();
    process.exit(1);
  });
