const Database = require('better-sqlite3');
const db = new Database('./data.db');

console.log('=== 检查所有 PM 账号 ===\n');

// 获取所有 PM 账号
const accounts = db.prepare(`
  SELECT 
    pa.id,
    pa.account_name,
    pa.affiliate_name,
    pa.api_token,
    u.username,
    u.email,
    u.role
  FROM platform_accounts pa
  INNER JOIN users u ON pa.user_id = u.id
  WHERE pa.platform = 'partnermatic'
  ORDER BY u.username, pa.account_name
`).all();

console.log(`找到 ${accounts.length} 个 PM 账号\n`);

let totalAvailable = 0;

accounts.forEach((account, index) => {
  console.log(`${index + 1}. ${account.account_name} (${account.username})`);
  console.log(`   ID: ${account.id}`);
  console.log(`   邮箱: ${account.email}`);
  console.log(`   角色: ${account.role}`);
  console.log(`   Affiliate: ${account.affiliate_name || 'N/A'}`);
  console.log(`   API Token: ${account.api_token ? '✅ 有' : '❌ 无'}`);
  
  // 检查订单
  const orders = db.prepare(`
    SELECT COUNT(*) as count FROM orders WHERE platform_account_id = ?
  `).get(account.id);
  console.log(`   订单数: ${orders.count}`);
  
  if (orders.count > 0) {
    // 可提现金额
    const available = db.prepare(`
      SELECT COALESCE(SUM(commission), 0) as amount
      FROM orders
      WHERE platform_account_id = ?
        AND status = 'Approved'
        AND settlement_date IS NOT NULL
        AND paid_date IS NULL
    `).get(account.id);
    
    console.log(`   💰 可提现: $${available.amount.toFixed(2)}`);
    totalAvailable += available.amount;
  } else {
    console.log(`   💰 可提现: $0.00 (无订单)`);
  }
  
  console.log();
});

console.log('='.repeat(60));
console.log(`\n💰 总可提现金额: $${totalAvailable.toFixed(2)}\n`);

db.close();
