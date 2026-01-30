const Database = require('better-sqlite3');
const db = new Database('./data.db');

console.log('=== 检查 API Token ===\n');

const accounts = db.prepare(`
  SELECT 
    pa.id,
    pa.account_name,
    pa.api_token,
    u.username
  FROM platform_accounts pa
  INNER JOIN users u ON pa.user_id = u.id
  WHERE pa.platform = 'partnermatic'
  ORDER BY u.username, pa.account_name
`).all();

console.log(`找到 ${accounts.length} 个 PM 账号\n`);

accounts.forEach((account, index) => {
  console.log(`${index + 1}. ${account.account_name} (${account.username})`);
  console.log(`   ID: ${account.id}`);
  console.log(`   API Token: ${account.api_token ? '✅ 有' : '❌ 无'}`);
  
  if (account.api_token) {
    // 检查可提现金额
    const available = db.prepare(`
      SELECT COALESCE(SUM(commission), 0) as amount
      FROM orders
      WHERE platform_account_id = ?
        AND status = 'Approved'
        AND settlement_date IS NOT NULL
        AND paid_date IS NULL
    `).get(account.id);
    
    console.log(`   💰 可提现: $${available.amount.toFixed(2)}`);
  }
  
  console.log();
});

db.close();
