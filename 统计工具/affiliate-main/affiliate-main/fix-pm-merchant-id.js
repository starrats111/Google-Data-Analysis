// 修复PM订单的merchant_id：从mcid改为buStoreId
const db = require('better-sqlite3')('data.db');

console.log('🔧 开始修复PM订单的merchant_id...\n');

// 1. 查询所有PM账号
const pmAccounts = db.prepare(`
  SELECT id FROM platform_accounts WHERE platform = 'partnermatic'
`).all();

if (pmAccounts.length === 0) {
  console.log('❌ 没有找到PM账号');
  db.close();
  process.exit(0);
}

console.log(`📌 找到 ${pmAccounts.length} 个PM账号\n`);

// 2. 查询所有PM订单
const pmOrders = db.prepare(`
  SELECT id, order_id, merchant_id, merchant_name, raw_data
  FROM orders
  WHERE platform_account_id IN (${pmAccounts.map(a => a.id).join(',')})
`).all();

console.log(`📦 找到 ${pmOrders.length} 条PM订单\n`);

// 3. 准备更新语句
const updateStmt = db.prepare(`
  UPDATE orders
  SET merchant_id = ?
  WHERE id = ?
`);

let updatedCount = 0;
let skippedCount = 0;
let errorCount = 0;

console.log('🔄 开始更新merchant_id...\n');

// 4. 逐个更新订单的merchant_id
pmOrders.forEach((order, index) => {
  try {
    const rawData = JSON.parse(order.raw_data);
    const buStoreId = rawData.buStoreId;

    if (buStoreId) {
      const newMerchantId = String(buStoreId);

      // 检查是否需要更新
      if (order.merchant_id !== newMerchantId) {
        updateStmt.run(newMerchantId, order.id);
        updatedCount++;

        if (updatedCount <= 5) {
          console.log(`✅ 订单 ${order.order_id}: ${order.merchant_id} -> ${newMerchantId}`);
        }
      } else {
        skippedCount++;
      }
    } else {
      console.log(`⚠️  订单 ${order.order_id}: 缺少buStoreId`);
      errorCount++;
    }
  } catch (e) {
    console.error(`❌ 订单 ${order.order_id} 解析失败:`, e.message);
    errorCount++;
  }

  // 每100条显示进度
  if ((index + 1) % 100 === 0) {
    console.log(`   进度: ${index + 1}/${pmOrders.length}`);
  }
});

console.log('\n📊 更新完成:');
console.log(`   ✅ 已更新: ${updatedCount} 条`);
console.log(`   ⏭️  跳过（已正确）: ${skippedCount} 条`);
console.log(`   ❌ 错误: ${errorCount} 条`);

// 5. 验证更新结果
console.log('\n🔍 验证更新结果（前5条）:');
const verifyOrders = db.prepare(`
  SELECT order_id, merchant_id, merchant_name, raw_data
  FROM orders
  WHERE platform_account_id IN (${pmAccounts.map(a => a.id).join(',')})
  LIMIT 5
`).all();

verifyOrders.forEach((order, i) => {
  try {
    const rawData = JSON.parse(order.raw_data);
    const buStoreId = String(rawData.buStoreId);
    const match = order.merchant_id === buStoreId ? '✅' : '❌';
    console.log(`  ${match} 订单 ${order.order_id}: merchant_id=${order.merchant_id}, buStoreId=${buStoreId}`);
  } catch (e) {
    console.log(`  ❌ 订单 ${order.order_id}: 数据解析失败`);
  }
});

db.close();
console.log('\n✅ 修复完成！');
