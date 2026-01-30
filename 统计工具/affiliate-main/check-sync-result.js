const Database = require('better-sqlite3');
const db = new Database('./data.db');

console.log('=== 检查同步结果 ===\n');

// 获取所有 PM 账号
const accounts = db.prepare(`
  SELECT pa.*, u.username 
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
  
  // 检查订单总数
  const totalOrders = db.prepare(`
    SELECT COUNT(*) as count FROM orders WHERE platform_account_id = ?
  `).get(account.id);
  console.log(`   总订单: ${totalOrders.count}`);
  
  // 检查 Approved 订单
  const approved = db.prepare(`
    SELECT 
      COUNT(*) as count,
      SUM(commission) as total
    FROM orders 
    WHERE platform_account_id = ? AND status = 'Approved'
  `).get(account.id);
  console.log(`   Approved: ${approved.count} 条, $${(approved.total || 0).toFixed(2)}`);
  
  // 检查有 settlement_date 的订单
  const withSettlement = db.prepare(`
    SELECT COUNT(*) as count FROM orders 
    WHERE platform_account_id = ? 
      AND status = 'Approved'
      AND settlement_date IS NOT NULL
  `).get(account.id);
  console.log(`   有 settlement_date: ${withSettlement.count}`);
  
  // 检查有 paid_date 的订单
  const withPaid = db.prepare(`
    SELECT COUNT(*) as count FROM orders 
    WHERE platform_account_id = ? 
      AND status = 'Approved'
      AND paid_date IS NOT NULL
  `).get(account.id);
  console.log(`   有 paid_date: ${withPaid.count}`);
  
  // 计算可提现金额
  const withdrawable = db.prepare(`
    SELECT 
      COUNT(*) as count,
      SUM(commission) as total
    FROM orders
    WHERE platform_account_id = ?
      AND status = 'Approved'
      AND settlement_date IS NOT NULL
      AND paid_date IS NULL
  `).get(account.id);
  
  const available = withdrawable.total || 0;
  totalAvailable += available;
  
  console.log(`   💰 可提现: ${withdrawable.count} 条, $${available.toFixed(2)}`);
  
  if (withdrawable.count === 0 && approved.count > 0) {
    console.log(`   ⚠️  问题: 有 ${approved.count} 条 Approved 订单，但可提现为 0`);
    if (withSettlement.count === 0) {
      console.log(`   ❌ 原因: 没有 settlement_date（需要同步）`);
    } else if (withSettlement.count === withPaid.count) {
      console.log(`   ✅ 原因: 所有订单都已支付（正常）`);
    }
  }
  
  console.log();
});

console.log('='.repeat(60));
console.log(`\n💰 总可提现金额: $${totalAvailable.toFixed(2)}\n`);

// 检查最近更新时间
console.log('📅 最近更新时间:');
const recentUpdate = db.prepare(`
  SELECT MAX(updated_at) as last_update
  FROM orders
  WHERE platform_account_id IN (${accounts.map(a => a.id).join(',')})
`).get();

console.log(`   ${recentUpdate.last_update || '从未更新'}\n`);

db.close();
