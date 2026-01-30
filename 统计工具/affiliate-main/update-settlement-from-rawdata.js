#!/usr/bin/env node

/**
 * 从订单的 raw_data 中提取 settlement 信息并更新到字段
 * 这样就不需要重新调用 PM API
 */

const Database = require('better-sqlite3');
const db = new Database('./data.db');

console.log('🔄 从 raw_data 更新 settlement 字段...\n');

// 获取所有 PM 账号
const accounts = db.prepare(`
  SELECT pa.id, pa.account_name, u.username
  FROM platform_accounts pa
  INNER JOIN users u ON pa.user_id = u.id
  WHERE pa.platform = 'partnermatic'
  ORDER BY u.username, pa.account_name
`).all();

console.log(`找到 ${accounts.length} 个 PM 账号\n`);

let totalProcessed = 0;
let totalUpdated = 0;

// 准备更新语句
const updateStmt = db.prepare(`
  UPDATE orders 
  SET settlement_id = ?,
      settlement_date = ?,
      paid_date = ?,
      payment_id = ?,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);

// 处理每个账号
accounts.forEach(account => {
  console.log(`📦 处理账号: ${account.account_name} (${account.username})`);
  
  // 获取该账号的所有订单
  const orders = db.prepare(`
    SELECT id, order_id, raw_data, settlement_date, paid_date
    FROM orders
    WHERE platform_account_id = ?
  `).all(account.id);
  
  console.log(`  找到 ${orders.length} 条订单`);
  
  let accountUpdated = 0;
  let accountProcessed = 0;
  
  orders.forEach(order => {
    try {
      // 解析 raw_data
      const rawData = JSON.parse(order.raw_data);
      
      // 检查是否需要更新
      const needsUpdate = 
        (rawData.settlement_id && !order.settlement_date) ||
        (rawData.settlement_date && !order.settlement_date) ||
        (rawData.paid_date && !order.paid_date) ||
        (rawData.payment_id && !order.payment_id);
      
      if (needsUpdate) {
        // 从 raw_data 提取字段
        const settlementId = rawData.settlement_id || null;
        const settlementDate = rawData.settlement_date || null;
        const paidDate = rawData.paid_date || null;
        const paymentId = rawData.payment_id || null;
        
        // 更新数据库
        const result = updateStmt.run(
          settlementId,
          settlementDate,
          paidDate,
          paymentId,
          order.id
        );
        
        if (result.changes > 0) {
          accountUpdated++;
        }
      }
      
      accountProcessed++;
    } catch (error) {
      console.error(`  ❌ 处理订单 ${order.order_id} 失败:`, error.message);
    }
  });
  
  totalProcessed += accountProcessed;
  totalUpdated += accountUpdated;
  
  console.log(`  ✅ 处理 ${accountProcessed} 条, 更新 ${accountUpdated} 条\n`);
});

console.log('='.repeat(60));
console.log(`\n✅ 完成！总计处理 ${totalProcessed} 条订单, 更新 ${totalUpdated} 条\n`);

// 显示更新后的可提现金额
console.log('💰 更新后的可提现金额:\n');

accounts.forEach(account => {
  const available = db.prepare(`
    SELECT COALESCE(SUM(commission), 0) as amount
    FROM orders
    WHERE platform_account_id = ?
      AND status = 'Approved'
      AND settlement_date IS NOT NULL
      AND paid_date IS NULL
  `).get(account.id);
  
  console.log(`  ${account.account_name}: $${available.amount.toFixed(2)}`);
});

db.close();

console.log('\n🎉 更新完成！现在可以刷新提现管理页面查看结果。');
