const { db } = require('./db');

console.log('=== 检查 PartnerMatic 订单状态 ===\n');

// 获取 PartnerMatic 账号
const pmAccounts = db.prepare(`
  SELECT id, user_id, account_name 
  FROM platform_accounts 
  WHERE platform = 'partnermatic'
`).all();

console.log('PartnerMatic 账号:');
console.table(pmAccounts);

// 检查每个账号的订单
pmAccounts.forEach(account => {
  console.log(`\n=== 账号: ${account.account_name} (ID: ${account.id}, User: ${account.user_id}) ===`);
  
  const orders = db.prepare(`
    SELECT 
      id,
      order_id,
      merchant_name,
      order_amount,
      commission,
      status,
      order_date,
      settlement_date,
      paid_date
    FROM orders 
    WHERE platform_account_id = ?
    ORDER BY id DESC
    LIMIT 10
  `).all(account.id);
  
  if (orders.length > 0) {
    console.log(`订单数量: ${orders.length}`);
    console.table(orders);
    
    // 统计各状态订单
    const statusStats = db.prepare(`
      SELECT 
        status,
        COUNT(*) as count,
        SUM(commission) as total_commission
      FROM orders 
      WHERE platform_account_id = ?
      GROUP BY status
    `).all(account.id);
    
    console.log('\n状态统计:');
    console.table(statusStats);
  } else {
    console.log('❌ 没有订单');
  }
});

console.log('\n=== 提现管理需要的数据 ===');
console.log('提现管理功能需要:');
console.log('1. PartnerMatic 平台的订单');
console.log('2. 订单状态为 "approved" (已批准)');
console.log('3. 有 settlement_date (结算日期) 的订单才能提现');
console.log('4. 有 paid_date (支付日期) 的订单表示已支付');

console.log('\n当前问题:');
console.log('❌ 订单状态都是 "untreated"，需要改为 "approved"');
console.log('❌ settlement_date 和 paid_date 都是 null');
