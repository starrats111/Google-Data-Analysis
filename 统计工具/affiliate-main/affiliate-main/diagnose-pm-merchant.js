// 诊断PM订单的merchant_id存储情况
const db = require('better-sqlite3')('data.db');

console.log('🔍 检查PM订单的merchant_id存储情况\n');

// 1. 查询PM账号
const pmAccounts = db.prepare(`
  SELECT id, account_name FROM platform_accounts WHERE platform = 'partnermatic'
`).all();

console.log(`📌 找到 ${pmAccounts.length} 个PM账号`);
pmAccounts.forEach(acc => {
  console.log(`   - ID: ${acc.id}, 账号名: ${acc.account_name}`);
});

if (pmAccounts.length === 0) {
  console.log('❌ 没有找到PM账号');
  db.close();
  process.exit(0);
}

// 2. 查询PM订单的merchant_id
console.log('\n📊 PM订单的merchant_id示例（前5条）:');
const pmOrders = db.prepare(`
  SELECT order_id, merchant_id, merchant_name, raw_data
  FROM orders
  WHERE platform_account_id IN (${pmAccounts.map(a => a.id).join(',')})
  LIMIT 5
`).all();

pmOrders.forEach((order, i) => {
  console.log(`\n订单 ${i + 1}:`);
  console.log(`  order_id: ${order.order_id}`);
  console.log(`  merchant_id (存储值): ${order.merchant_id}`);
  console.log(`  merchant_name: ${order.merchant_name}`);

  // 解析raw_data查看buStoreId
  try {
    const rawData = JSON.parse(order.raw_data);
    console.log(`  buStoreId (原始API): ${rawData.buStoreId}`);
    console.log(`  mcid (原始API): ${rawData.mcid}`);
    console.log(`  buStoreName (原始API): ${rawData.buStoreName}`);
  } catch (e) {
    console.log(`  ❌ raw_data解析失败: ${e.message}`);
  }
});

// 3. 检查merchant_id是否为null或不正确
console.log('\n\n🔍 检查merchant_id是否正确存储了buStoreId:');
const incorrectOrders = db.prepare(`
  SELECT COUNT(*) as count FROM orders
  WHERE platform_account_id IN (${pmAccounts.map(a => a.id).join(',')})
  AND (merchant_id IS NULL OR merchant_id = '')
`).get();

console.log(`  merchant_id为空的订单数: ${incorrectOrders.count}`);

// 4. 统计不同的merchant_id值
console.log('\n📈 merchant_id值统计（前10个）:');
const merchantStats = db.prepare(`
  SELECT merchant_id, COUNT(*) as count
  FROM orders
  WHERE platform_account_id IN (${pmAccounts.map(a => a.id).join(',')})
  GROUP BY merchant_id
  ORDER BY count DESC
  LIMIT 10
`).all();

merchantStats.forEach(stat => {
  console.log(`  ${stat.merchant_id}: ${stat.count} 条订单`);
});

db.close();
console.log('\n✅ 诊断完成');
