const Database = require('better-sqlite3');
const db = new Database('./data.db');

console.log('=== 调试生产环境问题 ===\n');

// 1. 检查这些账号的 ID
const accountNames = ['pm1', 'PM2', 'PM1', 'PM11'];
console.log('1. 查找账号 ID:\n');

const accounts = db.prepare(`
  SELECT 
    pa.id,
    pa.account_name,
    pa.platform,
    u.username,
    u.email
  FROM platform_accounts pa
  INNER JOIN users u ON pa.user_id = u.id
  WHERE pa.platform = 'partnermatic'
  ORDER BY pa.id
`).all();

console.log(`找到 ${accounts.length} 个 PM 账号:\n`);
accounts.forEach(acc => {
  console.log(`ID: ${acc.id}, 账号: ${acc.account_name}, 用户: ${acc.username}, 邮箱: ${acc.email}`);
});

console.log('\n' + '='.repeat(60) + '\n');

// 2. 检查每个账号的订单和可提现金额
console.log('2. 检查每个账号的数据:\n');

accounts.forEach(account => {
  console.log(`账号: ${account.account_name} (ID: ${account.id})`);
  
  // 总订单数
  const total = db.prepare(`
    SELECT COUNT(*) as count FROM orders WHERE platform_account_id = ?
  `).get(account.id);
  console.log(`  总订单: ${total.count}`);
  
  // Approved 订单
  const approved = db.prepare(`
    SELECT 
      COUNT(*) as count,
      COALESCE(SUM(commission), 0) as total
    FROM orders 
    WHERE platform_account_id = ? AND status = 'Approved'
  `).get(account.id);
  console.log(`  Approved: ${approved.count} 条, 佣金 $${approved.total.toFixed(2)}`);
  
  // 有 settlement_date 的
  const withSettlement = db.prepare(`
    SELECT COUNT(*) as count FROM orders 
    WHERE platform_account_id = ? 
      AND status = 'Approved'
      AND settlement_date IS NOT NULL
  `).get(account.id);
  console.log(`  有 settlement_date: ${withSettlement.count}`);
  
  // 有 paid_date 的
  const withPaid = db.prepare(`
    SELECT COUNT(*) as count FROM orders 
    WHERE platform_account_id = ? 
      AND status = 'Approved'
      AND paid_date IS NOT NULL
  `).get(account.id);
  console.log(`  有 paid_date: ${withPaid.count}`);
  
  // 可提现金额（API 使用的查询）
  const available = db.prepare(`
    SELECT COALESCE(SUM(commission), 0) as amount
    FROM orders
    WHERE platform_account_id = ?
      AND status = 'Approved'
      AND settlement_date IS NOT NULL
      AND paid_date IS NULL
  `).get(account.id);
  console.log(`  💰 可提现: $${available.amount.toFixed(2)}`);
  
  // 如果可提现为 0，检查原因
  if (available.amount === 0 && approved.count > 0) {
    console.log(`  ⚠️  问题: 有 ${approved.count} 条 Approved 但可提现为 0`);
    if (withSettlement.count === 0) {
      console.log(`  ❌ 原因: 所有订单都没有 settlement_date`);
    } else if (withSettlement.count === withPaid.count) {
      console.log(`  ✅ 原因: 所有订单都已支付（正常）`);
    } else {
      console.log(`  ❓ 原因: 未知 (settlement: ${withSettlement.count}, paid: ${withPaid.count})`);
    }
  }
  
  console.log();
});

console.log('='.repeat(60) + '\n');

// 3. 检查 settlement_date 字段是否存在
console.log('3. 检查表结构:\n');
const columns = db.prepare(`PRAGMA table_info(orders)`).all();
const settlementFields = ['settlement_id', 'settlement_date', 'paid_date', 'payment_id'];
settlementFields.forEach(field => {
  const exists = columns.some(col => col.name === field);
  console.log(`  ${field}: ${exists ? '✅ 存在' : '❌ 不存在'}`);
});

console.log('\n' + '='.repeat(60) + '\n');

// 4. 随机抽查几条订单的 raw_data
console.log('4. 抽查订单的 raw_data:\n');
const sampleOrders = db.prepare(`
  SELECT id, order_id, status, commission, settlement_date, paid_date, raw_data
  FROM orders
  WHERE platform_account_id IN (${accounts.map(a => a.id).join(',')})
    AND status = 'Approved'
  LIMIT 3
`).all();

sampleOrders.forEach(order => {
  console.log(`订单 ${order.order_id}:`);
  console.log(`  状态: ${order.status}, 佣金: $${order.commission}`);
  console.log(`  settlement_date: ${order.settlement_date || 'NULL'}`);
  console.log(`  paid_date: ${order.paid_date || 'NULL'}`);
  
  try {
    const rawData = JSON.parse(order.raw_data);
    console.log(`  raw_data 中的字段:`);
    console.log(`    settlement_id: ${rawData.settlement_id || 'N/A'}`);
    console.log(`    settlement_date: ${rawData.settlement_date || 'N/A'}`);
    console.log(`    paid_date: ${rawData.paid_date || 'N/A'}`);
    console.log(`    payment_id: ${rawData.payment_id || 'N/A'}`);
  } catch (e) {
    console.log(`  raw_data 解析失败`);
  }
  console.log();
});

db.close();

console.log('=== 调试完成 ===');
