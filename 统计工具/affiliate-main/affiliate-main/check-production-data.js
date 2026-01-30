const Database = require('better-sqlite3');
const db = new Database('./data.db');

console.log('=== 检查生产环境数据 ===\n');

// 1. 检查所有 PM 账号
const accounts = db.prepare(`
  SELECT pa.id, pa.account_name, pa.affiliate_name, u.username
  FROM platform_accounts pa
  INNER JOIN users u ON pa.user_id = u.id
  WHERE pa.platform = 'partnermatic'
  ORDER BY pa.account_name
`).all();

console.log(`📋 找到 ${accounts.length} 个 PM 账号:\n`);

let totalOrders = 0;
let accountsWithOrders = 0;
let accountsWithoutOrders = 0;

accounts.forEach((account, index) => {
  const orderCount = db.prepare(`
    SELECT COUNT(*) as count FROM orders WHERE platform_account_id = ?
  `).get(account.id);
  
  const count = orderCount.count;
  totalOrders += count;
  
  if (count > 0) {
    accountsWithOrders++;
    console.log(`${index + 1}. ✅ ${account.account_name} (${account.username}): ${count} 条订单`);
  } else {
    accountsWithoutOrders++;
    console.log(`${index + 1}. ❌ ${account.account_name} (${account.username}): 0 条订单`);
  }
});

console.log('\n' + '='.repeat(60));
console.log(`\n📊 统计:`);
console.log(`   总账号数: ${accounts.length}`);
console.log(`   有订单的账号: ${accountsWithOrders}`);
console.log(`   没有订单的账号: ${accountsWithoutOrders}`);
console.log(`   总订单数: ${totalOrders}`);

if (accountsWithoutOrders > 0) {
  console.log(`\n⚠️  发现 ${accountsWithoutOrders} 个账号没有订单数据！`);
  console.log(`\n💡 解决方案:`);
  console.log(`   1. 在"数据采集"页面采集这些账号的订单数据`);
  console.log(`   2. 采集完成后，再运行"同步数据"更新 settlement_date`);
  console.log(`\n📝 需要采集的账号:`);
  
  accounts.forEach(account => {
    const orderCount = db.prepare(`
      SELECT COUNT(*) as count FROM orders WHERE platform_account_id = ?
    `).get(account.id);
    
    if (orderCount.count === 0) {
      console.log(`   - ${account.account_name} (${account.username})`);
    }
  });
}

console.log();

db.close();
