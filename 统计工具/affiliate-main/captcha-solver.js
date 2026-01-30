// 验证码识别模块
// 支持多种识别方式

const axios = require('axios');
const fs = require('fs');

/**
 * 方法1: 使用2Captcha服务 (付费，但准确率高)
 * 注册地址: https://2captcha.com
 */
async function solve2Captcha(imageBuffer, apiKey) {
  try {
    console.log('🔍 使用2Captcha识别验证码...');

    // 上传验证码图片
    const uploadResponse = await axios.post('http://2captcha.com/in.php', {
      key: apiKey,
      method: 'base64',
      body: imageBuffer.toString('base64'),
    });

    const captchaId = uploadResponse.data.split('|')[1];

    // 轮询获取结果
    for (let i = 0; i < 20; i++) {
      await sleep(3000);

      const resultResponse = await axios.get('http://2captcha.com/res.php', {
        params: {
          key: apiKey,
          action: 'get',
          id: captchaId,
        },
      });

      if (resultResponse.data.includes('OK|')) {
        const code = resultResponse.data.split('|')[1];
        console.log('✅ 识别成功:', code);
        return code;
      }
    }

    throw new Error('识别超时');
  } catch (error) {
    console.error('❌ 2Captcha识别失败:', error.message);
    return null;
  }
}

/**
 * 方法2: 使用TrueCaptcha (免费，但有请求限制)
 */
async function solveTrueCaptcha(imageBuffer) {
  try {
    console.log('🔍 使用TrueCaptcha识别验证码...');

    const response = await axios.post('https://api.apitruecaptcha.org/one/gettext', {
      userid: 'your_userid',  // 需要注册
      apikey: 'your_apikey',
      data: imageBuffer.toString('base64'),
    });

    if (response.data.result) {
      console.log('✅ 识别成功:', response.data.result);
      return response.data.result;
    }

    throw new Error('识别失败');
  } catch (error) {
    console.error('❌ TrueCaptcha识别失败:', error.message);
    return null;
  }
}

/**
 * 方法3: 手动输入 (最可靠，适合测试)
 */
async function solveManual(imageBuffer, captchaUrl) {
  console.log('\n📸 验证码已保存到: captcha.png');
  console.log('🔗 验证码URL:', captchaUrl);

  // 保存验证码图片到本地
  fs.writeFileSync('captcha.png', imageBuffer);

  console.log('\n⚠️  请打开 captcha.png 查看验证码');
  console.log('或者在浏览器中打开上面的URL');

  // 使用 readline 获取用户输入
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question('\n👉 请输入验证码 (4位数字): ', (answer) => {
      rl.close();
      console.log('✅ 已输入:', answer);
      resolve(answer.trim());
    });
  });
}

/**
 * 方法4: 使用ddddocr Python库 (需要安装Python环境)
 * 这是一个开源的验证码识别库，准确率较高
 */
async function solveDdddocr(imageBuffer) {
  try {
    console.log('🔍 使用ddddocr识别验证码...');

    // 保存临时图片
    fs.writeFileSync('temp_captcha.png', imageBuffer);

    // 调用Python脚本
    const { execSync } = require('child_process');
    const result = execSync('python ocr_solver.py temp_captcha.png', {
      encoding: 'utf-8',
    });

    const code = result.trim();
    console.log('✅ 识别成功:', code);

    // 清理临时文件
    fs.unlinkSync('temp_captcha.png');

    return code;
  } catch (error) {
    console.error('❌ ddddocr识别失败:', error.message);
    return null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  solve2Captcha,
  solveTrueCaptcha,
  solveManual,
  solveDdddocr,
};
