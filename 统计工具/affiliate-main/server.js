// Express后端服务器
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = 3000;

// 中间件
app.use(cors()); // 允许跨域
app.use(express.json()); // 解析JSON
app.use(express.static('public')); // 静态文件服务

// ============ 工具函数 ============
function generateSign(data) {
  const salt = 'TSf03xGHykY';
  return crypto.createHash('md5').update(data + salt, 'utf-8').digest('hex');
}

// ============ API接口 ============

/**
 * API: 登录LinkHaitao
 * POST /api/login
 * Body: { username, password, code, timestamp }
 */
app.post('/api/login', async (req, res) => {
  const { username, password, code, timestamp } = req.body;

  // 参数验证
  if (!username || !password || !code) {
    return res.json({
      success: false,
      message: '缺少必要参数',
    });
  }

  try {
    // 使用前端传来的timestamp（和验证码图片对应的timestamp）
    const t = timestamp || Date.now().toString();
    const remember = '1';
    const sign = generateSign(username + password + code + remember + t);

    console.log('登录参数:');
    console.log('  username:', username);
    console.log('  password:', password);
    console.log('  code:', code);
    console.log('  timestamp:', t);
    console.log('  sign:', sign);

    const response = await axios.post(
      'https://www.linkhaitao.com/api2.php?c=login&a=login',
      new URLSearchParams({
        sign: sign,
        uname: username,
        password: password,
        code: code,
        remember: remember,
        t: t,
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    console.log('API响应:', JSON.stringify(response.data, null, 2));

    // 检查登录结果
    const isSuccess = response.data.code === '0200' || response.data.msg === 'success';

    if (isSuccess && response.data.payload && response.data.payload.auth_token) {
      res.json({
        success: true,
        message: '登录成功',
        data: {
          token: response.data.payload.auth_token,
          username: response.data.payload.uname,
          uid: response.data.payload.uid,
          expireTime: response.data.payload.expire_time,
        },
      });
    } else {
      res.json({
        success: false,
        message: response.data.msg || response.data.error_info || '登录失败',
      });
    }
  } catch (error) {
    console.error('登录错误:', error.message);
    res.json({
      success: false,
      message: '登录请求失败: ' + error.message,
    });
  }
});

// 存储验证码timestamp（简单的内存存储，生产环境应该用Redis）
const captchaTimestamps = new Map();

/**
 * API: 获取验证码图片
 * GET /api/captcha
 */
app.get('/api/captcha', async (req, res) => {
  try {
    const timestamp = Date.now();
    const url = `https://www.linkhaitao.com/api2.php?c=verifyCode&a=getCode&t=${timestamp}`;

    const response = await axios.get(url, {
      responseType: 'arraybuffer',
    });

    // 将timestamp放在响应头中，前端可以获取
    res.set('Content-Type', 'image/png');
    res.set('X-Captcha-Timestamp', timestamp.toString());

    // 存储timestamp（10分钟有效）
    const sessionId = `captcha_${Date.now()}`;
    captchaTimestamps.set(sessionId, timestamp);
    res.set('X-Session-Id', sessionId);

    // 清理过期的timestamp（10分钟前的）
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    for (const [key, value] of captchaTimestamps.entries()) {
      if (value < tenMinutesAgo) {
        captchaTimestamps.delete(key);
      }
    }

    res.send(response.data);
  } catch (error) {
    console.error('获取验证码失败:', error.message);
    res.status(500).json({
      success: false,
      message: '获取验证码失败',
    });
  }
});

/**
 * API: 获取订单明细
 * POST /api/fetch-orders
 * Body: { token, startDate, endDate, page, pageSize }
 */
app.post('/api/fetch-orders', async (req, res) => {
  const { token, startDate, endDate, page = 1, pageSize = 100 } = req.body;

  if (!token || !startDate || !endDate) {
    return res.json({
      success: false,
      message: '缺少必要参数',
    });
  }

  try {
    const exportFlag = '0';
    const signData = `${startDate}${endDate}${page}${pageSize}${exportFlag}`;
    const sign = generateSign(signData);

    const response = await axios.post(
      'https://www.linkhaitao.com/api2.php?c=report&a=transactionDetail',
      new URLSearchParams({
        sign: sign,
        start_date: startDate,
        end_date: endDate,
        page: page.toString(),
        page_size: pageSize.toString(),
        export: exportFlag,
      }),
      {
        headers: {
          'Lh-Authorization': token,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    const isSuccess = response.data.code === '0200' || response.data.msg === '成功';

    if (isSuccess && response.data.payload) {
      res.json({
        success: true,
        message: '数据获取成功',
        data: response.data.payload,
      });
    } else {
      res.json({
        success: false,
        message: response.data.msg || '数据获取失败',
      });
    }
  } catch (error) {
    console.error('获取订单失败:', error.message);
    res.json({
      success: false,
      message: '请求失败: ' + error.message,
    });
  }
});

/**
 * API: 按商家汇总数据
 * POST /api/summary
 * Body: { orders[] }
 */
app.post('/api/summary', (req, res) => {
  const { orders } = req.body;

  if (!orders || !Array.isArray(orders)) {
    return res.json({
      success: false,
      message: '无效的订单数据',
    });
  }

  try {
    const merchantMap = new Map();

    orders.forEach(order => {
      const mcid = order.mcid;
      if (!merchantMap.has(mcid)) {
        merchantMap.set(mcid, {
          mcid: mcid,
          m_id: order.m_id,
          sitename: order.sitename,
          orderCount: 0,
          totalAmount: 0,
          totalCommission: 0,
          pendingCommission: 0,
          confirmedCommission: 0,
          rejectedCommission: 0,
        });
      }

      const merchant = merchantMap.get(mcid);
      merchant.orderCount++;
      merchant.totalAmount += parseFloat(order.amount || 0);

      const commission = parseFloat(order.total_cmsn || 0);
      merchant.totalCommission += commission;

      if (order.status === 'Pending') {
        merchant.pendingCommission += commission;
      } else if (order.status === 'Confirmed' || order.status === 'Paid') {
        merchant.confirmedCommission += commission;
      } else if (order.status === 'Rejected' || order.status === 'Cancelled') {
        merchant.rejectedCommission += commission;
      }
    });

    const summary = Array.from(merchantMap.values());
    summary.sort((a, b) => b.totalCommission - a.totalCommission);

    res.json({
      success: true,
      data: summary,
    });
  } catch (error) {
    console.error('汇总计算失败:', error.message);
    res.json({
      success: false,
      message: '汇总计算失败',
    });
  }
});

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: '服务运行正常',
    timestamp: new Date().toISOString(),
  });
});

// 启动服务器
app.listen(PORT, () => {
  console.log('\n🚀 服务器启动成功！');
  console.log('=' .repeat(60));
  console.log(`📡 服务地址: http://localhost:${PORT}`);
  console.log(`🔗 打开浏览器访问: http://localhost:${PORT}`);
  console.log('=' .repeat(60));
  console.log('\n💡 提示: 按 Ctrl+C 停止服务器\n');
});
