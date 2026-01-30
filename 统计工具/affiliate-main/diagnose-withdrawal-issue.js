const Database = require('better-sqlite3');
const db = new Database('./data.db');

console.log('=== 诊断提现管理数据问题 ===\n');

// 1. 检查所有账号（不限平台）
console.log('1️⃣ 检查所有账号:\n');
const allPlatformAccounts = db.prepare(`
  SELECT 
    pa.id,
    pa.platform,
    pa.account_name,
    pa.affiliate_name,
    pa.api_token,
    u.username,
    u.email
  FROM platform_accounts pa
  INNER JOIN users u ON pa.user_id = u.id
  ORDER BY pa.platform, pa.account_name
`).all();

console.log(`总共 ${allPlatformAccounts.length} 个账号:\n`);
const platformGroups = {};
allPlatformAccounts.forEach(acc => {
  if (!platformGroups[acc.platform]) {
    platformGroups[acc.platform] = [];
  }
  platformGroups[acc.platform].push(acc);
});

Object.keys(platformGroups).forEach(platform => {
  console.log(`📦 ${platform.toUpperCase()} (${platformGroups[platform].length} 个):`);
  platformGroups[platform].forEach(acc => {
    console.log(`   - ${acc.account_name} (${acc.username}) - Token: ${acc.api_token ? '✅' : '❌'}`);
  });
  console.log();
});

// 2. 检查所有 PM 账号
console.log('\n2️⃣ 检查 PartnerMatic 账号:\n');
const allAccounts = db.prepare(`
  SELECT 
    pa.id,
    pa.account_name,
    pa.affiliate_name,
    pa.api_token,
    u.username,
    u.email
  FROM platform_accounts pa
  INNER JOIN users u ON pa.user_id = u.id
  WHERE pa.platform = 'partnermatic'
  ORDER BY pa.account_name
`).all();

console.log(`总共 ${allAccounts.length} 个 PM 账号:\n`);
allAccounts.forEach(acc => {
  console.log(`  - ${acc.account_name} (${acc.username})`);
  console.log(`    ID: ${acc.id}`);
  console.log(`    API Token: ${acc.api_token ? '✅ 有' : '❌ 无'}`);
  console.log();
});

// 2. 检查每个账号的订单数据
console.log('\n2️⃣ 检查每个账号的订单数据:\n');
allAccounts.forEach(acc => {
  console.log(`📋 ${acc.account_name}:`);
  
  // 总订单数
  const totalOrders = db.prepare(`
    SELECT COUNT(*) as count FROM orders WHERE platform_account_id = ?
  `).get(acc.id);
  console.log(`   总订单: ${totalOrders.count}`);
  
  // Approved 订单
  const approvedOrders = db.prepare(`
    SELECT 
      COUNT(*) as count,
      SUM(commission) as total
    FROM orders 
    WHERE platform_account_id = ? AND status = 'Approved'
  `).get(acc.id);
  console.log(`   Approved: ${approvedOrders.count} 条, $${(approvedOrders.total || 0).toFixed(2)}`);
  
  // 有 settlement_date 的订单
  const withSettlement = db.prepare(`
    SELECT COUNT(*) as count FROM orders 
    WHERE platform_account_id = ? AND settlement_date IS NOT NULL
  `).get(acc.id);
  console.log(`   有 settlement_date: ${withSettlement.count}`);
  
  // 有 paid_date 的订单
  const withPaid = db.prepare(`
    SELECT COUNT(*) as count FROM orders 
    WHERE platform_account_id = ? AND paid_date IS NOT NULL
  `).get(acc.id);
  console.log(`   有 paid_date: ${withPaid.count}`);
  
  // 可提现订单（关键查询）
  const withdrawable = db.prepare(`
    SELECT 
      COUNT(*) as count,
      SUM(commission) as total
    FROM orders
    WHERE platform_account_id = ?
      AND status = 'Approved'
      AND settlement_date IS NOT NULL
      AND paid_date IS NULL
  `).get(acc.id);
  console.log(`   💰 可提现: ${withdrawable.count} 条, $${(withdrawable.total || 0).toFixed(2)}`);
  console.log();
});

// 3. 检查 API 返回的数据
console.log('\n3️⃣ 模拟 API 查询:\n');
const apiQuery = `
  SELECT 
    pa.id,
    pa.platform,
    pa.account_name,
    pa.affiliate_name,
    pa.api_token,
    u.id as user_id,
    u.username,
    u.email
  FROM platform_accounts pa
  INNER JOIN users u ON pa.user_id = u.id
  WHERE pa.platform = 'partnermatic'
  ORDER BY u.username, pa.account_name
`;

const apiAccounts = db.prepare(apiQuery).all();
console.log(`API 会返回 ${apiAccounts.length} 个账号\n`);

// 4. 检查是否有 API Token 为空的情况
console.log('4️⃣ 检查 API Token 状态:\n');
const noToken = allAccounts.filter(acc => !acc.api_token || acc.api_token === '');
if (noToken.length > 0) {
  console.log(`⚠️  发现 ${noToken.length} 个账号没有 API Token:`);
  noToken.forEach(acc => {
    console.log(`   - ${acc.account_name} (${acc.username})`);
  });
} else {
  console.log('✅ 所有账号都有 API Token');
}

// 5. 检查数据库表结构
console.log('\n5️⃣ 检查 orders 表字段:\n');
const tableInfo = db.prepare(`PRAGMA table_info(orders)`).all();
const hasSettlementDate = tableInfo.find(col => col.name === 'settlement_date');
const hasPaidDate = tableInfo.find(col => col.name === 'paid_date');

console.log(`   settlement_date 字段: ${hasSettlementDate ? '✅ 存在' : '❌ 不存在'}`);
console.log(`   paid_date 字段: ${hasPaidDate ? '✅ 存在' : '❌ 不存在'}`);

// 6. 检查最近是否运行过同步脚本
console.log('\n6️⃣ 检查数据更新时间:\n');
const recentUpdates = db.prepare(`
  SELECT 
    platform_account_id,
    MAX(updated_at) as last_update
  FROM orders
  WHERE platform_account_id IN (${allAccounts.map(a => a.id).join(',')})
  GROUP BY platform_account_id
`).all();

recentUpdates.forEach(update => {
  const acc = allAccounts.find(a => a.id === update.platform_account_id);
  console.log(`   ${acc.account_name}: ${update.last_update || '从未更新'}`);
});

console.log('\n' + '='.repeat(60));
console.log('\n💡 诊断建议:\n');

if (noToken.length > 0) {
  console.log('❌ 问题1: 有账号缺少 API Token');
  console.log('   解决: 在平台账号管理中添加 API Token\n');
}

const hasNoData = allAccounts.some(acc => {
  const orders = db.prepare(`SELECT COUNT(*) as count FROM orders WHERE platform_account_id = ?`).get(acc.id);
  return orders.count === 0;
});

if (hasNoData) {
  console.log('❌ 问题2: 有账号没有订单数据');
  console.log('   解决: 先采集订单数据\n');
}

const needsSync = allAccounts.some(acc => {
  const withdrawable = db.prepare(`
    SELECT COUNT(*) as count FROM orders
    WHERE platform_account_id = ?
      AND status = 'Approved'
      AND settlement_date IS NOT NULL
  `).get(acc.id);
  return withdrawable.count === 0;
});

if (needsSync) {
  console.log('❌ 问题3: 订单缺少 settlement_date 数据');
  console.log('   解决: 运行同步脚本');
  console.log('   命令: node sync-all-pm-orders.js\n');
}

db.close();
