require('dotenv').config();
const axios = require('axios');

// 从命令行参数或环境变量读取配置
const PM_API_TOKEN = process.argv[2] || process.env.PM_API_TOKEN;

if (!PM_API_TOKEN) {
  console.error('❌ 缺少 API Token');
  console.log('\n使用方法:');
  console.log('  node test-transaction-v3-api.js <API_TOKEN>');
  console.log('  或在 .env 文件中设置 PM_API_TOKEN=你的token\n');
  process.exit(1);
}

console.log(`🔑 Token: ${PM_API_TOKEN.substring(0, 10)}...`);
console.log(`🔑 Token长度: ${PM_API_TOKEN.length}\n`);

// 测试 Transaction V3 API
async function testTransactionV3API() {
  console.log('='.repeat(80));
  console.log('测试 PartnerMatic Transaction V3 API');
  console.log('='.repeat(80));
  console.log(`时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  console.log('='.repeat(80));

  // 测试不同的日期范围
  const testCases = [
    {
      name: '最近7天',
      start_date: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      end_date: new Date().toISOString().split('T')[0]
    },
    {
      name: '最近30天',
      start_date: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      end_date: new Date().toISOString().split('T')[0]
    },
    {
      name: '2024年12月',
      start_date: '2024-12-01',
      end_date: '2024-12-31'
    }
  ];

  for (const testCase of testCases) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`测试场景: ${testCase.name}`);
    console.log(`日期范围: ${testCase.start_date} 至 ${testCase.end_date}`);
    console.log('='.repeat(80));

    try {
      // 准备请求参数
      const params = {
        source: 'partnermatic',
        token: PM_API_TOKEN,
        beginDate: testCase.start_date,
        endDate: testCase.end_date,
        curPage: 1,
        perPage: 50
      };

      console.log('\n📤 请求参数:');
      const displayParams = { ...params, token: '***TOKEN***' };
      console.log(JSON.stringify(displayParams, null, 2));

      // 发送请求 (使用 POST 方法)
      const response = await axios.post('https://api.partnermatic.com/api/transaction_v3', params, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 30000
      });

      console.log('\n📥 响应状态:', response.status);
      console.log('响应数据:');
      console.log(JSON.stringify(response.data, null, 2));

      // 分析响应数据
      if (response.data && response.data.code === 200) {
        const data = response.data.data;
        console.log('\n✅ API 调用成功');
        
        if (data && data.list) {
          console.log(`\n📊 数据统计:`);
          console.log(`  - 总记录数: ${data.total || 0}`);
          console.log(`  - 当前页记录数: ${data.list.length}`);
          console.log(`  - 当前页: ${data.page || 1}`);
          console.log(`  - 每页大小: ${data.page_size || 50}`);

          if (data.list.length > 0) {
            console.log(`\n📋 第一条记录示例:`);
            console.log(JSON.stringify(data.list[0], null, 2));

            // 分析字段
            console.log(`\n🔍 字段分析:`);
            const firstRecord = data.list[0];
            Object.keys(firstRecord).forEach(key => {
              console.log(`  - ${key}: ${typeof firstRecord[key]} = ${firstRecord[key]}`);
            });

            // 统计金额
            let totalAmount = 0;
            let totalCommission = 0;
            data.list.forEach(item => {
              if (item.amount) totalAmount += parseFloat(item.amount) || 0;
              if (item.commission) totalCommission += parseFloat(item.commission) || 0;
            });

            console.log(`\n💰 金额汇总 (当前页):`);
            console.log(`  - 总交易金额: ${totalAmount.toFixed(2)}`);
            console.log(`  - 总佣金: ${totalCommission.toFixed(2)}`);
          } else {
            console.log('\n⚠️  该日期范围内没有数据');
          }
        }
      } else {
        console.log('\n❌ API 返回错误');
        console.log(`错误代码: ${response.data?.code}`);
        console.log(`错误信息: ${response.data?.msg || response.data?.message}`);
      }

    } catch (error) {
      console.error('\n❌ 请求失败:');
      if (error.response) {
        console.error(`状态码: ${error.response.status}`);
        console.error('响应数据:', JSON.stringify(error.response.data, null, 2));
      } else if (error.request) {
        console.error('未收到响应');
      } else {
        console.error('错误信息:', error.message);
      }
    }
  }

  // 对比其他 API
  console.log('\n\n' + '='.repeat(80));
  console.log('对比其他 Transaction API');
  console.log('='.repeat(80));

  const compareDate = {
    start_date: '2024-12-01',
    end_date: '2024-12-31'
  };

  // 测试 transaction_v3
  console.log('\n📍 Transaction V3 API:');
  try {
    const params = {
      source: 'partnermatic',
      token: PM_API_TOKEN,
      beginDate: compareDate.start_date,
      endDate: compareDate.end_date,
      curPage: 1,
      perPage: 10
    };
    
    const response = await axios.post('https://api.partnermatic.com/api/transaction_v3', params, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 30000
    });

    if (response.data?.code === 200) {
      console.log(`  ✅ 记录数: ${response.data.data?.list?.length || 0}`);
      console.log(`  总数: ${response.data.data?.total || 0}`);
    }
  } catch (error) {
    console.log(`  ❌ 失败: ${error.message}`);
  }

  // 测试原始 transaction API
  console.log('\n📍 Transaction API (原始):');
  try {
    const params = {
      source: 'partnermatic',
      token: PM_API_TOKEN,
      beginDate: compareDate.start_date,
      endDate: compareDate.end_date,
      curPage: 1,
      perPage: 10
    };
    
    const response = await axios.post('https://api.partnermatic.com/api/transaction', params, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 30000
    });

    if (response.data?.code === 200) {
      console.log(`  ✅ 记录数: ${response.data.data?.list?.length || 0}`);
      console.log(`  总数: ${response.data.data?.total || 0}`);
    }
  } catch (error) {
    console.log(`  ❌ 失败: ${error.message}`);
  }

  console.log('\n' + '='.repeat(80));
  console.log('测试完成');
  console.log('='.repeat(80));
}

// 运行测试
testTransactionV3API().catch(error => {
  console.error('程序执行失败:', error);
  process.exit(1);
});
