/**
 * LinkHaitao API 诊断工具
 * 用于测试特定用户的 LinkHaitao API Token 是否正常工作
 */

const Database = require('better-sqlite3');
const axios = require('axios');

const db = new Database('data.db');

async function testLHApiForUser(username) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🔍 开始诊断用户: ${username}`);
  console.log('='.repeat(60));
  
  // 查找用户
  const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(username, username);
  
  if (!user) {
    console.log(`❌ 未找到用户: ${username}`);
    return;
  }
  
  console.log(`✅ 找到用户: ${user.username || user.email} (ID: ${user.id})`);
  
  // 查找该用户的 LinkHaitao 账号
  const lhAccounts = db.prepare('SELECT * FROM platform_accounts WHERE user_id = ? AND platform = ?')
    .all(user.id, 'linkhaitao');
  
  if (lhAccounts.length === 0) {
    console.log(`❌ 该用户没有配置 LinkHaitao 账号`);
    return;
  }
  
  console.log(`\n📋 找到 ${lhAccounts.length} 个 LinkHaitao 账号:\n`);
  
  // 测试每个账号
  for (const account of lhAccounts) {
    console.log(`${'─'.repeat(60)}`);
    console.log(`📌 账号: ${account.account_name}`);
    console.log(`   Affiliate名称: ${account.affiliate_name || 'N/A'}`);
    console.log(`   账号ID: ${account.id}`);
    console.log(`   创建时间: ${account.created_at}`);
    
    // 检查 API Token
    if (!account.api_token) {
      console.log(`   ❌ 未配置 API Token（将使用模拟登录方式）`);
      console.log(`   💡 建议: 在平台账号设置中添加 API Token`);
      continue;
    }
    
    const tokenPreview = account.api_token.substring(0, 10) + '...' + account.api_token.substring(account.api_token.length - 10);
    console.log(`   ✅ 已配置 API Token: ${tokenPreview}`);
    console.log(`   Token长度: ${account.api_token.length} 字符`);
    
    // 测试 API 请求
    console.log(`\n   🧪 测试 API 请求...`);
    
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(endDate.getDate() - 30); // 最近30天
    
    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];
    
    console.log(`   📅 日期范围: ${startDateStr} 至 ${endDateStr}`);
    
    try {
      const params = new URLSearchParams({
        token: account.api_token,
        begin_date: startDateStr,
        end_date: endDateStr,
        page: '1',
        per_page: '100'
      });
      
      const apiUrl = `https://www.linkhaitao.com/api.php?mod=medium&op=cashback2&${params.toString()}`;
      console.log(`   🔗 请求URL: https://www.linkhaitao.com/api.php?mod=medium&op=cashback2&token=***&begin_date=${startDateStr}&end_date=${endDateStr}&page=1&per_page=100`);
      
      const response = await axios.get(apiUrl, {
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      console.log(`   📡 HTTP 状态: ${response.status}`);
      
      // 分析响应
      if (response.data.status) {
        console.log(`   📦 API状态码: ${response.data.status.code}`);
        console.log(`   📦 API消息: ${response.data.status.msg}`);
        
        if (response.data.status.code === 0) {
          // 成功
          const orders = response.data.data?.list || [];
          console.log(`   ✅ API 调用成功！`);
          console.log(`   📊 返回订单数: ${orders.length} 条`);
          
          if (orders.length > 0) {
            const sampleOrder = orders[0];
            console.log(`\n   📝 示例订单数据:`);
            console.log(`      订单号: ${sampleOrder.order_id || sampleOrder.sign_id}`);
            console.log(`      商家: ${sampleOrder.advertiser_name}`);
            console.log(`      商家ID: ${sampleOrder.m_id}`);
            console.log(`      订单金额: $${sampleOrder.sale_amount}`);
            console.log(`      佣金: $${sampleOrder.cashback}`);
            console.log(`      状态: ${sampleOrder.status}`);
            console.log(`      订单时间: ${sampleOrder.order_time}`);
          }
        } else {
          // API 返回错误
          console.log(`   ❌ API 返回错误: ${response.data.status.msg}`);
          console.log(`   💡 可能的原因:`);
          console.log(`      - API Token 已过期或无效`);
          console.log(`      - 账号权限不足`);
          console.log(`      - 日期范围超出限制`);
        }
      } else {
        console.log(`   ❌ 响应格式异常: 缺少 status 字段`);
        console.log(`   响应数据: ${JSON.stringify(response.data).substring(0, 200)}`);
      }
      
    } catch (error) {
      console.log(`   ❌ API 请求失败: ${error.message}`);
      
      if (error.response) {
        console.log(`   HTTP 状态: ${error.response.status}`);
        console.log(`   响应数据: ${JSON.stringify(error.response.data).substring(0, 200)}`);
      }
      
      if (error.code === 'ENOTFOUND') {
        console.log(`   💡 网络错误: 无法连接到 LinkHaitao API 服务器`);
      } else if (error.code === 'ETIMEDOUT') {
        console.log(`   💡 请求超时: LinkHaitao API 响应太慢`);
      }
    }
  }
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`✅ 诊断完成`);
  console.log('='.repeat(60) + '\n');
}

async function testAllFailedUsers() {
  console.log('\n🔍 开始诊断所有失败的用户...\n');
  
  const failedUsers = [
    '蓝倩倩',
    '吴雅静',
    '林念魁',
    '包海倩',
    'CX',
    '徐文君'
  ];
  
  for (const username of failedUsers) {
    await testLHApiForUser(username);
    // 延迟1秒，避免请求过快
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  console.log('\n🎉 所有用户诊断完成！\n');
}

// 命令行参数解析
const args = process.argv.slice(2);

if (args.length === 0) {
  console.log('\n使用方法:');
  console.log('  node test-lh-api-diagnosis.js <username>     # 测试单个用户');
  console.log('  node test-lh-api-diagnosis.js --all          # 测试所有失败的用户');
  console.log('\n示例:');
  console.log('  node test-lh-api-diagnosis.js 蓝倩倩');
  console.log('  node test-lh-api-diagnosis.js CX');
  console.log('  node test-lh-api-diagnosis.js --all\n');
  process.exit(0);
}

if (args[0] === '--all') {
  testAllFailedUsers().catch(console.error);
} else {
  testLHApiForUser(args[0]).catch(console.error);
}

