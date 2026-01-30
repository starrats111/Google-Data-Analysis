const Database = require('better-sqlite3');
const db = new Database('./data.db');

console.log('=== 检查 living001 账号的订单数据 ===\n');

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

console.log('📋 账号信息:');
console.log(`  ID: ${account.id}`);
console.log(`  用户: ${account.username}`);
console.log(`  账号名: ${account.account_name}`);
console.log(`  联盟名: ${account.affiliate_name}`);
console.log();

// 统计各状态的订单
const statusStats = db.prepare(`
  SELECT 
    status,
    COUNT(*) as count,
    SUM(commission) as total_commission,
    COUNT(CASE WHEN settlement_date IS NOT NULL THEN 1 END) as with_settlement_date,
    COUNT(CASE WHEN paid_date IS NOT NULL THEN 1 END) as with_paid_date
  FROM orders
  WHERE platform_account_id = ?
  GROUP BY status
`).all(account.id);

console.log('📊 订单状态统计:');
statusStats.forEach(stat => {
  console.log(`  ${stat.status}:`);
  console.log(`    数量: ${stat.count}`);
  console.log(`    总佣金: $${stat.total_commission.toFixed(2)}`);
  console.log(`    有 settlement_date: ${stat.with_settlement_date}`);
  console.log(`    有 paid_date: ${stat.with_paid_date}`);
});
console.log();

// 检查是否有 Approved 订单
const approvedOrders = db.prepare(`
  SELECT 
    order_id,
    merchant_name,
    commission,
    status,
    settlement_date,
    paid_date,
    settlement_id,
    payment_id
  FROM orders
  WHERE platform_account_id = ?
    AND status = 'Approved'
  ORDER BY order_date DESC
  LIMIT 10
`).all(account.id);

console.log(`📝 Approved 订单 (前10条):`);
if (approvedOrders.length === 0) {
  console.log('  ❌ 没有 Approved 订单');
} else {
  approvedOrders.forEach(order => {
    console.log(`  订单 ${order.order_id}:`);
    console.log(`    商家: ${order.merchant_name}`);
    console.log(`    佣金: $${order.commission}`);
    console.log(`    状态: ${order.status}`);
    console.log(`    结算日期: ${order.settlement_date || 'NULL'}`);
    console.log(`    支付日期: ${order.paid_date || 'NULL'}`);
    console.log(`    结算ID: ${order.settlement_id || 'NULL'}`);
    console.log(`    支付ID: ${order.payment_id || 'NULL'}`);
  });
}
console.log();

// 检查 Pending 订单样本
const pendingOrders = db.prepare(`
  SELECT 
    order_id,
    merchant_name,
    commission,
    status,
    order_date,
    settlement_date,
    paid_date
  FROM orders
  WHERE platform_account_id = ?
    AND status = 'Pending'
  ORDER BY commission DESC
  LIMIT 5
`).all(account.id);

console.log(`📝 Pending 订单样本 (佣金最高的5条):`);
pendingOrders.forEach(order => {
  console.log(`  订单 ${order.order_id}:`);
  console.log(`    商家: ${order.merchant_name}`);
  console.log(`    佣金: $${order.commission}`);
  console.log(`    下单日期: ${order.order_date}`);
    console.log(`    结算日期: ${order.settlement_date || 'NULL'}`);
});
console.log();

// 计算可提现金额（按照 API 逻辑）
const withdrawableAmount = db.prepare(`
  SELECT 
    COUNT(*) as count,
    COALESCE(SUM(commission), 0) as total
  FROM orders
  WHERE platform_account_id = ?
    AND status = 'Approved'
    AND settlement_date IS NOT NULL
    AND paid_date IS NULL
`).get(account.id);

console.log('💰 可提现金额（按当前 API 逻辑）:');
console.log(`  订单数: ${withdrawableAmount.count}`);
console.log(`  总金额: $${withdrawableAmount.total.toFixed(2)}`);
console.log();

console.log('🎯 问题分析:');
console.log('  PartnerMatic 后台显示: $1,313.56 可提现');
console.log(`  我们系统显示: $${withdrawableAmount.total.toFixed(2)} 可提现`);
console.log('  差异原因: 数据库中没有 Approved + settlement_date 的订单');
console.log();

db.close();
