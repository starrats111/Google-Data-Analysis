// 测试 Rewardoo Payment API
const { getRewardooWithdrawalSummary } = require('./rewardoo-payment-utils');
const Database = require('better-sqlite3');

async function testRewardooPayment() {
  console.log('🧪 测试 Rewardoo Payment API\n');

  const db = new Database('./data.db');

  // 获取 Rewardoo 账号
  const accounts = db.prepare(`
    SELECT id, account_name, api_token, affiliate_name
    FROM platform_accounts
    WHERE platform = 'rewardoo'
  `).all();

  console.log(`📊 找到 ${accounts.length} 个 Rewardoo 账号\n`);

  for (const account of accounts) {
    console.log(`\n🔍 测试账号: ${account.account_name} (${account.affiliate_name})`);
    
    if (!account.api_token) {
      console.log('  ⚠️  没有 API Token，跳过');
      continue;
    }

    try {
      // 查询所有历史数据（从 2020-01-01 到今天）
      const summary = await getRewardooWithdrawalSummary(
        account.api_token,
        '2020-01-01',
        new Date().toISOString().split('T')[0]
      );
      
      console.log(`  ✅ 获取成功:`);
      console.log(`     可提现金额: $${summary.available.toFixed(2)} (需要从其他 API 获取)`);
      console.log(`     提现中金额: $${summary.processing.toFixed(2)}`);
      console.log(`     已提现金额: $${summary.withdrawn.toFixed(2)}`);
      console.log(`     总计金额: $${summary.total.toFixed(2)}`);
      console.log(`     提现历史: ${summary.history.length} 条记录`);
      
      if (summary.history.length > 0) {
        console.log(`\n     最近提现记录:`);
        summary.history.slice(0, 3).forEach(h => {
          console.log(`       - ${h.paid_date}: $${h.amount.toFixed(2)} (${h.status})`);
        });
      }

      // 显示所有提现记录的详细信息
      if (summary.payments.length > 0) {
        console.log(`\n     所有提现记录:`);
        summary.payments.forEach((p, index) => {
          console.log(`\n     [${index + 1}] ID: ${p.withdrawal_id}`);
          console.log(`         请求时间: ${p.withdrawal_time}`);
          console.log(`         金额: $${p.withdrawal_amount}`);
          console.log(`         状态: ${p.status}`);
          console.log(`         更新时间: ${p.update_time}`);
          if (p.bank_name) console.log(`         银行: ${p.bank_name}`);
          if (p.recipient) console.log(`         收款人: ${p.recipient}`);
        });
      }
    } catch (error) {
      console.log(`  ❌ 获取失败: ${error.message}`);
    }
  }

  db.close();
  console.log('\n✅ 测试完成');
}

testRewardooPayment().catch(console.error);
