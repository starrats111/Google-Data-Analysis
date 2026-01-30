// 完整版测试脚本：包含验证码识别
// 运行方式：node test-linkhaitao-full.js

const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const readline = require('readline');

// ============ 配置区 ============
const CONFIG = {
  username: 'omnilearn',
  password: 'Ltt.104226',

  // 查询日期范围
  startDate: '2024-12-01',  // 改成有数据的日期
  endDate: '2024-12-31',

  // 验证码识别方式: 'manual'(手动输入) | '2captcha' | 'ddddocr'
  captchaMethod: 'manual',

  // 如果使用2Captcha，需要填写API Key
  captchaApiKey: '',
};

// ============ 工具函数 ============
function generateSign(data) {
  const salt = 'TSf03xGHykY';
  return crypto.createHash('md5').update(data + salt).digest('hex');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ 验证码识别 ============

// 方法1: 手动输入（最可靠）
async function solveManual(imageBuffer, timestamp) {
  console.log('\n📸 验证码已保存到: captcha.png');
  console.log(`🔗 或访问: https://www.linkhaitao.com/api2.php?c=verifyCode&a=getCode&t=${timestamp}`);

  // 保存验证码图片
  fs.writeFileSync('captcha.png', imageBuffer);

  console.log('\n⚠️  请打开 captcha.png 查看验证码图片');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question('\n👉 请输入验证码 (4位字符): ', (answer) => {
      rl.close();
      const code = answer.trim();
      console.log(`✅ 已输入: ${code}`);
      resolve(code);
    });
  });
}

// 方法2: 使用2Captcha服务
async function solve2Captcha(imageBuffer, apiKey) {
  console.log('🔍 使用2Captcha识别...');

  try {
    // 提交验证码
    const submitRes = await axios.post('http://2captcha.com/in.php', null, {
      params: {
        key: apiKey,
        method: 'base64',
        body: imageBuffer.toString('base64'),
        json: 1,
      },
    });

    if (submitRes.data.status !== 1) {
      throw new Error(submitRes.data.request);
    }

    const captchaId = submitRes.data.request;
    console.log(`📤 已提交，ID: ${captchaId}`);

    // 轮询获取结果
    for (let i = 0; i < 30; i++) {
      await sleep(3000);

      const resultRes = await axios.get('http://2captcha.com/res.php', {
        params: {
          key: apiKey,
          action: 'get',
          id: captchaId,
          json: 1,
        },
      });

      if (resultRes.data.status === 1) {
        const code = resultRes.data.request;
        console.log(`✅ 识别成功: ${code}`);
        return code;
      }

      if (resultRes.data.request !== 'CAPCHA_NOT_READY') {
        throw new Error(resultRes.data.request);
      }

      process.stdout.write('.');
    }

    throw new Error('识别超时');
  } catch (error) {
    console.error(`❌ 2Captcha失败: ${error.message}`);
    return null;
  }
}

// 方法3: 使用ddddocr（需要Python环境）
async function solveDdddocr(imageBuffer) {
  console.log('🔍 使用ddddocr识别...');

  try {
    const { execSync } = require('child_process');

    // 保存临时文件
    const tempFile = 'temp_captcha.png';
    fs.writeFileSync(tempFile, imageBuffer);

    // 调用Python脚本
    const result = execSync(`python ocr_solver.py ${tempFile}`, {
      encoding: 'utf-8',
    });

    const code = result.trim();
    console.log(`✅ 识别成功: ${code}`);

    // 清理
    fs.unlinkSync(tempFile);

    return code;
  } catch (error) {
    console.error(`❌ ddddocr失败: ${error.message}`);
    return null;
  }
}

// ============ 核心功能 ============

// 获取验证码图片
async function getCaptchaImage() {
  const timestamp = Date.now();
  const url = `https://www.linkhaitao.com/api2.php?c=verifyCode&a=getCode&t=${timestamp}`;

  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
    });

    return {
      imageBuffer: Buffer.from(response.data),
      timestamp: timestamp.toString(),
    };
  } catch (error) {
    throw new Error(`获取验证码失败: ${error.message}`);
  }
}

// 识别验证码（支持多种方式）
async function solveCaptcha(imageBuffer, timestamp) {
  switch (CONFIG.captchaMethod) {
    case 'manual':
      return await solveManual(imageBuffer, timestamp);

    case '2captcha':
      if (!CONFIG.captchaApiKey) {
        console.error('❌ 请配置2Captcha API Key');
        return null;
      }
      return await solve2Captcha(imageBuffer, CONFIG.captchaApiKey);

    case 'ddddocr':
      return await solveDdddocr(imageBuffer);

    default:
      console.error(`❌ 未知的验证码识别方式: ${CONFIG.captchaMethod}`);
      return null;
  }
}

// 步骤1: 登录LH获取token（带验证码识别）
async function loginLH(username, password) {
  console.log('🔐 开始登录LinkHaitao...\n');

  // 尝试最多10次（验证码可能识别错误）
  for (let attempt = 1; attempt <= 10; attempt++) {
    console.log(`📍 第 ${attempt} 次尝试...`);

    try {
      // 1. 获取验证码图片
      const { imageBuffer, timestamp } = await getCaptchaImage();
      console.log('✅ 验证码图片获取成功');

      // 2. 识别验证码
      const code = await solveCaptcha(imageBuffer, timestamp);

      if (!code || code.length !== 4) {
        console.log('⚠️  验证码无效，重试...\n');
        continue;
      }

      // 3. 提交登录
      const remember = '1';

      // 注意：sign计算时使用原始密码，但提交时密码需要URL编码
      const sign = generateSign(username + password + code + remember + timestamp);

      console.log('🔐 登录参数调试:');
      console.log(`    username: ${username}`);
      console.log(`    password: ${password}`);
      console.log(`    code: ${code}`);
      console.log(`    timestamp: ${timestamp}`);
      console.log(`    sign: ${sign}`);

      const response = await axios.post(
        'https://www.linkhaitao.com/api2.php?c=login&a=login',
        new URLSearchParams({
          sign: sign,
          uname: username,
          password: password,  // axios会自动URL编码
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

      // 4. 检查结果
      console.log('📡 API响应:', JSON.stringify(response.data, null, 2));

      // 兼容新旧两种API响应格式
      const isSuccess = response.data.error_no === 'lh_suc' ||
                       response.data.code === '0200' ||
                       response.data.msg === 'success';

      if (isSuccess && response.data.payload && response.data.payload.auth_token) {
        const token = response.data.payload.auth_token;
        console.log('\n✅ 登录成功！');
        console.log(`👤 用户: ${response.data.payload.uname || username}`);
        console.log(`🆔 UID: ${response.data.payload.uid || 'N/A'}`);
        console.log(`🔑 Token: ${token.substring(0, 50)}...`);
        console.log(`⏰ 有效期至: ${response.data.payload.expire_time || 'N/A'}`);
        return token;
      } else {
        const errorInfo = response.data.error_info || response.data.msg || response.data.error_no || '未知错误';
        console.log(`❌ 登录失败: ${errorInfo}`);

        // 如果是验证码错误，继续重试
        if (errorInfo.includes('验证码') || errorInfo.includes('code') ||
            errorInfo.includes('Code') || errorInfo.includes('验证')) {
          console.log('⚠️  验证码错误，重试...\n');
          await sleep(1000);
          continue;
        } else if (errorInfo.includes('密码') || errorInfo.includes('password') ||
                   errorInfo.includes('账号') || errorInfo.includes('account')) {
          // 账号密码错误，直接返回
          console.error('\n❌ 账号或密码错误，停止尝试');
          return null;
        } else {
          // 其他错误，重试
          console.log('⚠️  登录失败，重试...\n');
          await sleep(1000);
          continue;
        }
      }
    } catch (error) {
      console.error(`❌ 请求失败: ${error.message}`);

      if (attempt < 10) {
        console.log('⚠️  等待2秒后重试...\n');
        await sleep(2000);
      }
    }
  }

  console.error('\n❌ 尝试10次后仍然失败');
  return null;
}

// 步骤2: 获取佣金数据
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

    // 兼容新旧两种API响应格式
    const isSuccess = response.data.error_no === 'lh_suc' ||
                     response.data.code === '0200' ||
                     response.data.msg === 'success';

    if (isSuccess && response.data.payload && response.data.payload.info) {
      const data = response.data.payload.info;
      console.log(`✅ 获取成功！共 ${data.length} 条商家数据\n`);

      if (data.length === 0) {
        console.log('⚠️  该日期范围内没有数据');
        return [];
      }

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
      console.error('❌ 获取数据失败:', response.data.error_info || response.data.msg || response.data.error_no);
      return null;
    }
  } catch (error) {
    console.error('❌ 请求失败:', error.message);
    return null;
  }
}

// ============ 主程序 ============
async function main() {
  console.log('🚀 LinkHaitao 完整版数据采集测试\n');
  console.log('=' .repeat(60));

  // 显示配置
  console.log('\n📋 当前配置:');
  console.log(`    用户名: ${CONFIG.username}`);
  console.log(`    日期范围: ${CONFIG.startDate} ~ ${CONFIG.endDate}`);
  console.log(`    验证码识别方式: ${CONFIG.captchaMethod}`);
  console.log('\n' + '='.repeat(60));

  // 步骤1: 登录
  const token = await loginLH(CONFIG.username, CONFIG.password);

  if (!token) {
    console.error('\n❌ 登录失败，无法继续');
    console.log('\n💡 提示：');
    console.log('    1. 检查用户名和密码是否正确');
    console.log('    2. 手动输入验证码时请仔细核对');
    console.log('    3. 可以尝试使用付费的2Captcha服务提高准确率');
    return;
  }

  // 等待1秒
  await sleep(1000);

  // 步骤2: 获取数据
  const data = await fetchCommissionData(token, CONFIG.startDate, CONFIG.endDate);

  if (data && data.length > 0) {
    console.log('\n' + '='.repeat(60));
    console.log('✅ 测试成功！数据采集功能正常工作');
    console.log('🎉 你可以继续开发下一步了！');
    console.log('\n💡 提示: Token已获取，你可以保存下来直接使用');
    console.log(`    Token: ${token}`);
  } else {
    console.log('\n⚠️  数据获取失败或该时间段无数据');
    console.log('💡 提示: 尝试修改日期范围，选择有数据的时间段');
  }
}

// 运行
main().catch(error => {
  console.error('💥 程序崩溃:', error);
  process.exit(1);
});
