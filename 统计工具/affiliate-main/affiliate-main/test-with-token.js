// 使用已有token直接获取数据（跳过登录）
// 适合：你已经有token，不想每次都登录

const axios = require('axios');
const crypto = require('crypto');

// ============ 配置区 ============
const CONFIG = {
  // 从旧系统或浏览器中获取的token
  token: '在这里填入你的token',

  // 查询日期范围
  startDate: '2024-12-01',
  endDate: '2024-12-31',
};

// ============ 工具函数 ============
function generateSign(data) {
  const salt = 'TSf03xGHykY';
  return crypto.createHash('md5').update(data + salt).digest('hex');
}

// ============ 核心功能 ============
async function fetchCommissionData(token, startDate, endDate) {
  console.log(`📊 开始获取佣金数据 (${startDate} ~ ${endDate})...\n`);

  try {
    const page = '1';
    const pageSize = '2000';
    const exportFlag = '0';

    const sign = generateSign(`m_id${startDate}${endDate}${page}${pageSize}${exportFlag}`);

    const response = await axios.post(
      'https://www.linkhaitao.com/api2.php?c=report&a=performance',
      new URLSearchParams({
        sign: sign,
        group_by: 'm_id',
        start_date: startDate,
        end_date: endDate,
        page: page,
        page_size: pageSize,
        export: exportFlag,
      }),
      {
        headers: {
          'Lh-Authorization': token,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    console.log('📡 API响应:', JSON.stringify(response.data, null, 2));

    if (response.data.error_no === 'lh_suc') {
      const data = response.data.payload.info;
      console.log(`\n✅ 获取成功！共 ${data.length} 条商家数据\n`);

      if (data.length === 0) {
        console.log('⚠️  该日期范围内没有数据');
        return [];
      }

      // 打印前3条数据示例
      console.log('📦 数据示例：');
      data.slice(0, 3).forEach((item, index) => {
        console.log(`\n[${index + 1}] 商家ID: ${item.mcid}`);
        console.log(`    商家名称: ${item.m_id || 'N/A'}`);
        console.log(`    点击数: ${item.click_num}`);
        console.log(`    订单数: ${item.cps_total_order}`);
        console.log(`    佣金: $${item.cps_total_aff}`);
      });

      // 计算汇总
      const summary = {
        totalClicks: data.reduce((sum, item) => sum + parseInt(item.click_num || 0), 0),
        totalOrders: data.reduce((sum, item) => sum + parseInt(item.cps_total_order || 0), 0),
        totalCommission: data.reduce((sum, item) => {
          const amount = parseFloat((item.cps_total_aff || '0').replace(/,/g, ''));
          return sum + amount;
        }, 0),
      };

      console.log('\n💰 汇总数据：');
      console.log(`    总点击: ${summary.totalClicks}`);
      console.log(`    总订单: ${summary.totalOrders}`);
      console.log(`    总佣金: $${summary.totalCommission.toFixed(2)}`);

      return data;
    } else {
      console.error('❌ 获取数据失败:', response.data.error_info || response.data.error_no);

      if (response.data.error_no === 'lh_auth_error') {
        console.log('\n💡 Token已过期，请重新登录获取新token');
      }

      return null;
    }
  } catch (error) {
    console.error('❌ 请求失败:', error.message);
    if (error.response) {
      console.error('响应数据:', error.response.data);
    }
    return null;
  }
}

// ============ 主程序 ============
async function main() {
  console.log('🚀 LinkHaitao Token测试\n');
  console.log('=' .repeat(60));

  // 检查配置
  if (!CONFIG.token || CONFIG.token === '在这里填入你的token') {
    console.error('❌ 请先配置Token！\n');
    console.log('💡 如何获取Token：');
    console.log('   方法1: 运行 npm run test:lh-full 登录后复制token');
    console.log('   方法2: 从旧系统的config.ini中复制');
    console.log('   方法3: 用浏览器F12查看Network请求头\n');
    return;
  }

  console.log('📋 当前配置:');
  console.log(`    Token: ${CONFIG.token.substring(0, 30)}...`);
  console.log(`    日期范围: ${CONFIG.startDate} ~ ${CONFIG.endDate}\n`);
  console.log('=' .repeat(60) + '\n');

  // 直接获取数据
  const data = await fetchCommissionData(CONFIG.token, CONFIG.startDate, CONFIG.endDate);

  if (data && data.length > 0) {
    console.log('\n' + '='.repeat(60));
    console.log('✅ 测试成功！Token有效，数据采集正常');
    console.log('🎉 可以继续开发了！');
  } else if (data && data.length === 0) {
    console.log('\n⚠️  Token有效，但该时间段无数据');
    console.log('💡 提示: 尝试修改日期范围');
  } else {
    console.log('\n❌ 测试失败');
  }
}

main().catch(error => {
  console.error('💥 程序崩溃:', error);
  process.exit(1);
});
