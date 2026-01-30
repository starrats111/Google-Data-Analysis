// 测试 LinkBux 提现摘要功能
const { getLinkBuxWithdrawalSummary } = require('./linkbux-payment-utils');
const Database = require('better-sqlite3');

async function testLinkBuxWithdrawal() {
  console.log('🧪 测试 LinkBux 提现摘要功能（查询所有历史数据）\n');

  const db = new Database('./data.db');

  // 获取 LinkBux 账号
  const accounts = db.prepare(`
    SELECT id, account_name, api_token, affiliate_name
    FROM platform_accounts
    WHERE platform = 'linkbux'
  `).all();

  console.log(`📊 找到 ${accounts.length} 个 LinkBux 账号\n`);

  for (const account of accounts) {
    console.log(`\n🔍 测试账号: ${account.account_name} (${account.affiliate_name})`);
    
    if (!account.api_token) {
      console.log('  ⚠️  没有 API Token，跳过');
      continue;
    }

    try {
      // 查询所有历史数据（从 2020-01-01 到今天）
      const summary = await getLinkBuxWithdrawalSummary(account.api_token, '2020-01-01', new Date().toISOString().split('T')[0]);
      
      console.log(`  ✅ 获取成功:`);
      console.log(`     可提现金额: $${summary.withdrawable.toFixed(2)}`);
      console.log(`     已提现金额: $${summary.withdrawn.toFixed(2)}`);
      console.log(`     总计金额: $${summary.total.toFixed(2)}`);
      console.log(`     提现历史: ${summary.history.length} 条记录`);
      
      if (summary.history.length > 0) {
        console.log(`\n     最近提现记录:`);
        summary.history.slice(0, 3).forEach(h => {
          console.log(`       - ${h.paid_date}: $${h.amount.toFixed(2)} (${h.records.length} 条结算)`);
        });
      }
    } catch (error) {
      console.log(`  ❌ 获取失败: ${error.message}`);
    }
  }

  db.close();
  console.log('\n✅ 测试完成');
}

testLinkBuxWithdrawal().catch(console.error);
