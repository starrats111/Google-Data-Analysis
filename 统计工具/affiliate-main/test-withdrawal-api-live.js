const axios = require('axios');
require('dotenv').config();

// 修改为你的服务器地址
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

async function testAPIs() {
  console.log('=== 测试提现管理 API（实际环境）===\n');
  console.log(`服务器地址: ${BASE_URL}\n`);
  
  try {
    // 1. 登录
    console.log('1️⃣ 登录...');
    const loginRes = await axios.post(`${BASE_URL}/api/login`, {
      email: 'super@admin.com',
      password: 'admin123'
    });
    
    if (!loginRes.data.success) {
      console.log('❌ 登录失败:', loginRes.data.message);
      return;
    }
    
    const token = loginRes.data.token;
    console.log('✅ 登录成功\n');
    
    // 2. 测试 summary API
    console.log('2️⃣ 测试 /api/super-admin/withdrawal/summary\n');
    const summaryRes = await axios.get(`${BASE_URL}/api/super-admin/withdrawal/summary`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    console.log('响应数据:');
    console.log(JSON.stringify(summaryRes.data, null, 2));
    console.log();
    
    if (summaryRes.data.success) {
      const data = summaryRes.data.data;
      console.log('📊 汇总数据:');
      console.log(`   可提现: $${data.totals.availableToWithdraw.toFixed(2)}`);
      console.log(`   提现中: $${data.totals.processingAmount.toFixed(2)}`);
      console.log(`   已提现: $${data.totals.withdrawnAmount.toFixed(2)}`);
      console.log(`   账号数: ${data.accounts.length}`);
      console.log();
      
      console.log('📋 账号明细:');
      data.accounts.forEach((acc, i) => {
        console.log(`   ${i + 1}. ${acc.accountName} (${acc.username})`);
        console.log(`      可提现: $${acc.availableToWithdraw.toFixed(2)}`);
        console.log(`      提现中: $${acc.processingAmount.toFixed(2)}`);
        console.log(`      已提现: $${acc.withdrawnAmount.toFixed(2)}`);
      });
    }
    console.log('\n' + '='.repeat(60) + '\n');
    
    // 3. 测试 payment-history API
    console.log('3️⃣ 测试 /api/super-admin/withdrawal/payment-history\n');
    const historyRes = await axios.get(`${BASE_URL}/api/super-admin/withdrawal/payment-history`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    console.log('响应数据:');
    console.log(JSON.stringify(historyRes.data, null, 2));
    console.log();
    
    if (historyRes.data.success) {
      const data = historyRes.data.data;
      console.log(`📊 返回 ${data.total_accounts} 个账号\n`);
      
      data.accountPayments.forEach((acc, i) => {
        console.log(`${i + 1}. ${acc.account_name} (${acc.username})`);
        console.log(`   可提现: $${acc.available_amount.toFixed(2)}`);
        console.log(`   已提现: $${acc.total_amount.toFixed(2)}`);
        console.log(`   提现记录: ${acc.payment_count} 条`);
        console.log();
      });
    }
    
  } catch (error) {
    console.error('❌ 测试失败:', error.message);
    if (error.response) {
      console.error('响应状态:', error.response.status);
      console.error('响应数据:', error.response.data);
    }
  }
}

testAPIs();
