const { db } = require('./db');

console.log('=== 检查 orders 表结构 ===\n');

// 获取表结构
const schema = db.prepare("PRAGMA table_info(orders)").all();
console.log('orders 表字段:');
console.table(schema);

// 检查订单数据
console.log('\n=== 订单数据示例 ===');
const orders = db.prepare('SELECT * FROM orders LIMIT 3').all();
if (orders.length > 0) {
  console.log('订单数量:', orders.length);
  console.log('\n第一条订单数据:');
  console.log(JSON.stringify(orders[0], null, 2));
} else {
  console.log('❌ 没有订单数据');
}

// 检查平台账号
console.log('\n=== 平台账号数据 ===');
const accounts = db.prepare('SELECT id, user_id, platform, account_name FROM platform_accounts LIMIT 5').all();
console.table(accounts);

// 检查订单统计
console.log('\n=== 订单统计（按 platform_account_id）===');
const stats = db.prepare(`
  SELECT 
    platform_account_id,
    COUNT(*) as order_count,
    SUM(commission_amount) as total_commission,
    status
  FROM orders 
  GROUP BY platform_account_id, status
  ORDER BY platform_account_id
`).all();
console.table(stats);
