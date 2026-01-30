const { db } = require('./db');

console.log('=== living001 账号信息 ===\n');

const account = db.prepare(`
  SELECT * FROM platform_accounts 
  WHERE account_name = 'living001'
`).get();

console.table([account]);

console.log('\n=== living001 订单统计 ===\n');

const stats = db.prepare(`
  SELECT 
    status,
    COUNT(*) as count,
    SUM(commission) as total_commission
  FROM orders 
  WHERE platform_account_id = ?
  GROUP BY status
`).all(account.id);

console.table(stats);

console.log('\n=== living001 最近20个订单 ===\n');

const orders = db.prepare(`
  SELECT 
    id,
    order_id,
    merchant_name,
    commission,
    status,
    order_date,
    settlement_date,
    paid_date
  FROM orders 
  WHERE platform_account_id = ?
  ORDER BY id DESC
  LIMIT 20
`).all(account.id);

console.table(orders);

console.log('\n=== 问题分析 ===\n');
console.log('PartnerMatic 后台显示: $1,313.56 可提现');
console.log('我们系统显示: $0.00');
console.log('\n可能原因:');
console.log('1. living001 的订单状态都是 Pending，没有 Approved');
console.log('2. 提现管理只显示 Approved 且有 settlement_date 的订单');
console.log('3. 需要更新订单状态或从 PartnerMatic API 同步最新数据');
