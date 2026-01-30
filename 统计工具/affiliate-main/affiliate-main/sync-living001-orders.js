const Database = require('better-sqlite3');
const axios = require('axios');
const db = new Database('./data.db');

console.log('=== 同步 living001 订单状态和结算信息 ===\n');

// 获取 living001 账号信息
const account = db.prepare(`
  SELECT pa.*, u.username 
  FROM platform_accounts pa
  INNER JOIN users u ON pa.user_id = u.id
  WHERE pa.account_name = 'living001'
`).get();

if (!account) {
  console.log('❌ 未找到 living001 账号');
  process.exit(1);
}

if (!account.api_token) {
  console.log('❌ living001 账号没有 api_token');
  process.exit(1);
}

console.log('📋 账号信息:');
console.log(`  ID: ${account.id}`);
console.log(`  用户: ${account.username}`);
console.log(`  账号名: ${account.account_name}`);
console.log(`  Token: ${account.api_token.substring(0, 10)}...`);
console.log();

// 调用 Transaction V3 API 获取订单数据
async function fetchTransactionV3(page = 1) {
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

  console.log(`📤 调用 Transaction V3 API (第 ${page} 页)...`);
  
  try {
    const response = await axios.post(url, requestBody, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if ((response.data.code === 0 || response.data.code === '0') && response.data.data) {
      return response.data.data;
    } else {
      console.error('❌ API 返回错误:', response.data);
      return null;
    }
  } catch (error) {
    console.error('❌ API 调用失败:', error.message);
    if (error.response) {
      console.error('响应状态:', error.response.status);
      console.error('响应数据:', error.response.data);
    }
    return null;
  }
}

async function syncOrders() {
  let page = 1;
  let totalFetched = 0;
  let totalUpdated = 0;
  let hasApprovedOrders = 0;
  
  while (true) {
    const data = await fetchTransactionV3(page);
    
    if (!data || !data.list || data.list.length === 0) {
      console.log(`✅ 第 ${page} 页没有更多数据，停止获取`);
      break;
    }

    console.log(`📥 获取到 ${data.list.length} 条订单`);
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

      // 使用第一个 item 的数据（通常一个订单只有一个 item）
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
          console.log(`  ✅ 更新订单 ${orderId}: ${status}, 结算日期: ${settlementDate}, 佣金: ${item.sale_comm}`);
        }
      }
    }

    // 检查是否还有更多页
    if (data.list.length < 100) {
      console.log(`✅ 第 ${page} 页数据不足100条，已获取所有数据`);
      break;
    }

    page++;
    
    // 避免请求过快
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log();
  console.log('📊 同步结果:');
  console.log(`  总共获取: ${totalFetched} 条订单`);
  console.log(`  成功更新: ${totalUpdated} 条订单`);
  console.log(`  Approved 订单: ${hasApprovedOrders} 条`);
  console.log();

  // 重新统计数据
  const stats = db.prepare(`
    SELECT 
      status,
      COUNT(*) as count,
      SUM(commission) as total_commission,
      COUNT(CASE WHEN settlement_date IS NOT NULL THEN 1 END) as with_settlement_date
    FROM orders
    WHERE platform_account_id = ?
    GROUP BY status
  `).all(account.id);

  console.log('📊 更新后的订单统计:');
  stats.forEach(stat => {
    console.log(`  ${stat.status}:`);
    console.log(`    数量: ${stat.count}`);
    console.log(`    总佣金: $${stat.total_commission.toFixed(2)}`);
    console.log(`    有结算日期: ${stat.with_settlement_date}`);
  });
  console.log();

  // 计算可提现金额
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

  console.log('💰 可提现金额:');
  console.log(`  订单数: ${withdrawable.count}`);
  console.log(`  总金额: $${withdrawable.total.toFixed(2)}`);
  console.log();
}

syncOrders()
  .then(() => {
    console.log('✅ 同步完成');
    db.close();
  })
  .catch(error => {
    console.error('❌ 同步失败:', error);
    db.close();
    process.exit(1);
  });
