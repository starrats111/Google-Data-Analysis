// 测试提现管理 API

const Database = require('better-sqlite3');
const db = new Database('./data.db');

console.log('=== 测试提现管理 API 逻辑 ===\n');

// 模拟 summary API 的逻辑
console.log('1. 测试 Summary API 逻辑\n');

const accounts = db.prepare(`
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
`).all();

console.log(`找到 ${accounts.length} 个账号\n`);

let totalAvailable = 0;
let totalProcessing = 0;

accounts.forEach(account => {
  // 可提现金额
  const availableResult = db.prepare(`
    SELECT COALESCE(SUM(commission), 0) as amount
    FROM orders
    WHERE platform_account_id = ?
      AND status = 'Approved'
      AND settlement_date IS NOT NULL
      AND paid_date IS NULL
  `).get(account.id);
  
  const available = parseFloat(availableResult.amount || 0);

  // 提现中金额
  const processingResult = db.prepare(`
    SELECT COALESCE(SUM(o.commission), 0) as amount, COUNT(*) as count
    FROM orders o
    INNER JOIN withdrawal_requests wr ON o.withdrawal_request_id = wr.id
    WHERE o.platform_account_id = ?
      AND wr.status = 'processing'
  `).get(account.id);

  const processing = parseFloat(processingResult.amount || 0);

  totalAvailable += available;
  totalProcessing += processing;

  console.log(`${account.account_name} (${account.username})`);
  console.log(`  可提现: $${available.toFixed(2)}`);
  console.log(`  提现中: $${processing.toFixed(2)}`);
  console.log();
});

console.log('='.repeat(60));
console.log(`总可提现: $${totalAvailable.toFixed(2)}`);
console.log(`总提现中: $${totalProcessing.toFixed(2)}`);
console.log();

// 模拟 payment-history API 的逻辑
console.log('2. 测试 Payment History API 逻辑\n');

const accountsWithToken = db.prepare(`
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
  WHERE pa.platform = 'partnermatic'
    AND pa.api_token IS NOT NULL
    AND pa.api_token != ''
  ORDER BY u.username, pa.account_name
`).all();

console.log(`找到 ${accountsWithToken.length} 个有 API Token 的账号\n`);

accountsWithToken.forEach(account => {
  const availableResult = db.prepare(`
    SELECT COALESCE(SUM(commission), 0) as amount
    FROM orders
    WHERE platform_account_id = ?
      AND status = 'Approved'
      AND settlement_date IS NOT NULL
      AND paid_date IS NULL
  `).get(account.id);
  
  const availableAmount = parseFloat(availableResult.amount || 0);
  
  console.log(`${account.account_name} (${account.username})`);
  console.log(`  可提现: $${availableAmount.toFixed(2)}`);
  console.log(`  API Token: ${account.api_token ? '✅' : '❌'}`);
  console.log();
});

db.close();

console.log('✅ API 逻辑测试完成');
