// 测试脚本：验证LinkHaitao API是否能工作
// 运行方式：node test-linkhaitao.js

const axios = require('axios');
const crypto = require('crypto');

// ============ 配置区 ============
const CONFIG = {
  // 从你的config.ini中复制过来
  username: 'lanshao3',
  password: 'Kydir+405',
  //username: 'omnilearn',
  //password: 'Ltt.104226',

  // 查询日期范围
  startDate: '2025-01-01',
  endDate: '2025-01-15',
};

// ============ 工具函数 ============
function generateSign(data) {
  const salt = 'TSf03xGHykY'; // LH的固定salt
  return crypto.createHash('md5').update(data + salt).digest('hex');
}

// ============ 核心功能 ============

// 步骤1：登录LH获取token
async function loginLH(username, password) {
  console.log('🔐 开始登录LinkHaitao...');

  try {
    // 这里简化了验证码部分，假设你已经有token
    // 实际使用时需要处理验证码识别

    const timestamp = Date.now().toString();
    const remember = '1';
    const code = '0000'; // 简化：跳过验证码

    const sign = generateSign(username + password + code + remember + timestamp);

    const response = await axios.post(
      'https://www.linkhaitao.com/api2.php?c=login&a=login',
      new URLSearchParams({
        sign: sign,
        uname: username,
        password: password,
        code: code,
        remember: remember,
        t: timestamp,
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    if (response.data.error_no === 'lh_suc') {
      const token = response.data.payload.auth_token;
      console.log('✅ 登录成功！Token:', token.substring(0, 20) + '...');
      return token;
    } else {
      console.error('❌ 登录失败:', response.data.error_info);
      return null;
    }
  } catch (error) {
    console.error('❌ 登录请求失败:', error.message);
    return null;
  }
}

// 步骤2：获取佣金数据
async function fetchCommissionData(token, startDate, endDate) {
  console.log(`\n📊 开始获取佣金数据 (${startDate} ~ ${endDate})...`);

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

    if (response.data.error_no === 'lh_suc') {
      const data = response.data.payload.info;
      console.log(`✅ 获取成功！共 ${data.length} 条商家数据\n`);

      // 打印前3条数据示例
      console.log('📦 数据示例：');
      data.slice(0, 3).forEach((item, index) => {
        console.log(`\n[${index + 1}] 商家ID: ${item.mcid}`);
        console.log(`    点击数: ${item.click_num}`);
        console.log(`    订单数: ${item.cps_total_order}`);
        console.log(`    佣金: $${item.cps_total_aff}`);
      });

      // 计算汇总
      const summary = {
        totalClicks: data.reduce((sum, item) => sum + parseInt(item.click_num), 0),
        totalOrders: data.reduce((sum, item) => sum + parseInt(item.cps_total_order), 0),
        totalCommission: data.reduce((sum, item) => {
          const amount = parseFloat(item.cps_total_aff.replace(/,/g, ''));
          return sum + amount;
        }, 0),
      };

      console.log('\n💰 汇总数据：');
      console.log(`    总点击: ${summary.totalClicks}`);
      console.log(`    总订单: ${summary.totalOrders}`);
      console.log(`    总佣金: $${summary.totalCommission.toFixed(2)}`);

      return data;

    } else {
      console.error('❌ 获取数据失败:', response.data.error_info);
      return null;
    }
  } catch (error) {
    console.error('❌ 请求失败:', error.message);
    return null;
  }
}

// ============ 主程序 ============
async function main() {
  console.log('🚀 LinkHaitao 数据采集测试脚本\n');
  console.log('=' .repeat(50));

  // 检查配置
  if (!CONFIG.username || CONFIG.username === '你的LinkHaitao用户名') {
    console.error('❌ 请先在脚本中配置你的用户名和密码！');
    console.log('\n💡 提示：修改 CONFIG 对象中的 username 和 password');
    return;
  }

  // 步骤1：登录
  const token = await loginLH(CONFIG.username, CONFIG.password);

  if (!token) {
    console.error('\n❌ 登录失败，无法继续');
    return;
  }

  // 等待1秒
  await new Promise(resolve => setTimeout(resolve, 1000));

  // 步骤2：获取数据
  const data = await fetchCommissionData(token, CONFIG.startDate, CONFIG.endDate);

  if (data) {
    console.log('\n' + '='.repeat(50));
    console.log('✅ 测试成功！数据采集功能正常工作');
    console.log('🎉 你可以继续下一步了！');
  } else {
    console.log('\n❌ 数据获取失败，请检查token是否有效');
  }
}

// 运行
main().catch(error => {
  console.error('💥 程序崩溃:', error);
});
