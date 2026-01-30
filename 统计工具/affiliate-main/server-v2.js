// 多用户SaaS系统 - Express后端服务器

// 设置控制台编码为UTF-8（修复Windows终端中文乱码）
if (process.platform === 'win32') {
  try {
    const { execSync } = require('child_process');
    execSync('chcp 65001', { stdio: 'ignore' });
  } catch (e) {
    // 忽略错误
  }
}

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const ExcelJS = require('exceljs');
require('dotenv').config();

const { db, initDatabase } = require('./db');
const {
  hashPassword,
  verifyPassword,
  generateToken,
  verifyToken,
  encryptPassword,
  decryptPassword,
  generateSign,
} = require('./utils');

// LinkBux Payment API 工具函数
const {
  getLinkBuxWithdrawalSummary
} = require('./linkbux-payment-utils');

// Rewardoo Payment API 工具函数
const {
  calculateRewardooAvailableBalance,
  getRewardooWithdrawalSummary
} = require('./rewardoo-payment-utils');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ 平台限制配置表 ============
const PLATFORM_LIMITS = {
  linkhaitao: {
    maxDaysPerRequest: 31,        // 日期范围限制：31天
    maxHistoryMonths: 36,         // 历史数据限制：36个月
    maxItemsPerPage: 40000,       // 单页上限：40000条
    currentItemsPerPage: 40000,   // 当前使用：40000条（已优化）
    requestInterval: 16000,       // 请求间隔：16秒（实际限制：2/30s，即30秒内最多2次，15秒/次+1秒缓冲）
    supportsPagination: true,
    paginationField: 'page',
    totalPageField: null,
    errorCode: {
      dateRangeExceeded: 1006,    // 查询时间跨度不能超过31天
      frequencyTooHigh: 1002,     // 呼叫频率太高
      historyExceeded: 1007,      // 超过36个月
      rateLimit: 9999             // 请求频率限制：2/30s（实际限制，文档可能过时）
    }
  },
  partnermatic: {
    maxDaysPerRequest: 62,        // 日期范围限制：62天
    maxHistoryMonths: null,       // 历史数据限制：未知
    maxItemsPerPage: 2000,        // 单页上限：2000条
    currentItemsPerPage: 2000,    // 当前使用：2000条
    requestInterval: 2000,         // 请求间隔：2秒（保守设置，避免频率限制）
    supportsPagination: true,
    paginationField: 'curPage',
    totalField: 'total',           // API返回total字段
    errorCode: {
      dateRangeExceeded: 1004,    // 查询时间跨度不能超过62天
      frequencyTooHigh: 1002,     // 呼叫频率过高
      invalidParams: 10001         // 缺少必需参数或格式错误
    }
  },
  linkbux: {
    maxDaysPerRequest: 62,        // 日期范围限制：62天
    maxHistoryMonths: 36,         // 历史数据限制：36个月
    maxItemsPerPage: 1000,        // 单页上限：1000条
    currentItemsPerPage: 1000,    // 当前使用：1000条
    requestInterval: 2000,         // 请求间隔：2秒（保守设置，避免频率限制）
    supportsPagination: true,
    paginationField: 'page',
    totalPageField: 'total_page', // API返回total_page字段
    errorCode: {
      dateRangeExceeded: 1006,    // 查询时间跨度不能超过62天
      frequencyTooHigh: 1002,      // 呼叫频率过高
      historyExceeded: 1014,      // 超过36个月
      invalidParams: 1003          // 缺少必需参数或格式错误
    }
  },
  rewardoo: {
    maxDaysPerRequest: 62,        // 日期范围限制：62天
    maxHistoryMonths: null,       // 历史数据限制：未知
    maxItemsPerPage: 1000,        // 单页上限：1000条
    currentItemsPerPage: 1000,    // 当前使用：1000条
    requestInterval: 2000,         // 请求间隔：2秒（保守设置，避免频率限制）
    supportsPagination: true,
    paginationField: 'page',
    totalPageField: 'total_page', // API返回total_page字段
    errorCode: {
      dateRangeExceeded: 1006,    // 查询时间跨度不能超过62天
      frequencyTooHigh: 1002,      // 呼叫频率过高
      invalidParams: 1003          // 缺少必需参数或格式错误
    }
  }
};

// 初始化数据库
initDatabase();

// 中间件
app.use(cors({
  origin: [
    'http://localhost:3000',
    'https://affiliate-marketing-saas.shop',
    'https://www.affiliate-marketing-saas.shop',
    'https://affiliate-production-fc5a.up.railway.app'
  ],
  credentials: true
}));
app.use(express.json());

// ============ 认证中间件 ============
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ success: false, message: '未提供认证token' });
  }

  const user = verifyToken(token);
  if (!user) {
    return res.status(403).json({ success: false, message: 'Token无效或已过期' });
  }

  req.user = user;
  next();
}

// ============ 超级管理员权限中间件 ============
function requireSuperAdmin(req, res, next) {
  // 必须先通过authenticateToken验证
  if (!req.user) {
    return res.status(401).json({ success: false, message: '未认证' });
  }

  // 验证用户角色
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ 
      success: false, 
      message: '权限不足：需要超级管理员权限' 
    });
  }

  next();
}

// ============ 审计日志中间件 ============
function auditLog(action) {
  return (req, res, next) => {
    const startTime = Date.now();
    
    // 记录审计日志的函数
    const recordLog = () => {
      const executionTime = Date.now() - startTime;
      
      // 异步记录审计日志，不阻塞响应
      setImmediate(() => {
        try {
          const targetUserId = req.params.id ? parseInt(req.params.id) : null;
          let targetUsername = null;
          
          // 如果有目标用户ID，查询用户名
          if (targetUserId) {
            const targetUser = db.prepare('SELECT username FROM users WHERE id = ?').get(targetUserId);
            targetUsername = targetUser ? targetUser.username : null;
          }
          
          db.prepare(`
            INSERT INTO audit_logs (
              admin_id, admin_username, action, target_user_id, target_username,
              request_path, request_method, ip_address, execution_time, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          `).run(
            req.user.id,
            req.user.username,
            action,
            targetUserId,
            targetUsername,
            req.path,
            req.method,
            req.ip || req.connection.remoteAddress,
            executionTime
          );
        } catch (error) {
          console.error('❌ 审计日志记录失败:', error.message);
        }
      });
    };
    
    // 保存原始方法
    const originalSend = res.send;
    const originalJson = res.json;
    
    // 重写 send 方法
    res.send = function(data) {
      recordLog();
      return originalSend.call(this, data);
    };
    
    // 重写 json 方法
    res.json = function(data) {
      recordLog();
      return originalJson.call(this, data);
    };
    
    next();
  };
}

// ============ 用户认证API ============

/**
 * API: 用户注册
 * POST /api/auth/register
 */
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, username, invitation_code } = req.body;

    if (!email || !password || !username) {
      return res.json({ success: false, message: '缺少必要参数' });
    }

    // 验证邀请码
    if (!invitation_code) {
      return res.json({ success: false, message: '请输入邀请码' });
    }

    // 检查邀请码是否存在且有效
    const inviteCode = db.prepare(`
      SELECT id, code, max_uses, used_count, expires_at, is_active, role
      FROM invitation_codes
      WHERE code = ? AND is_active = 1
    `).get(invitation_code);

    if (!inviteCode) {
      return res.json({ success: false, message: '邀请码无效或已失效' });
    }

    // 检查邀请码是否已过期
    if (inviteCode.expires_at) {
      const expiresAt = new Date(inviteCode.expires_at);
      if (expiresAt < new Date()) {
        return res.json({ success: false, message: '邀请码已过期' });
      }
    }

    // 检查邀请码使用次数
    if (inviteCode.used_count >= inviteCode.max_uses) {
      return res.json({ success: false, message: '邀请码使用次数已达上限' });
    }

    // 检查邮箱是否已存在
    const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existingUser) {
      return res.json({ success: false, message: '该邮箱已被注册' });
    }

    // 先加密密码
    const passwordHash = await hashPassword(password);

    // 使用事务创建用户和更新邀请码
    const transaction = db.transaction(() => {
      // 创建用户（状态为待审核）
    const result = db
        .prepare(`
          INSERT INTO users (email, password_hash, username, approval_status, invitation_code_id, role)
          VALUES (?, ?, ?, 'pending', ?, ?)
        `)
        .run(email, passwordHash, username, inviteCode.id, inviteCode.role || 'user');

      // 更新邀请码使用次数
      db.prepare(`
        UPDATE invitation_codes
        SET used_count = used_count + 1,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(inviteCode.id);

      return result;
    });

    const result = transaction();

    console.log(`✅ 新用户注册: ${username} (${email}), 邀请码: ${invitation_code}, 状态: 待审核`);

    res.json({
      success: true,
      message: '注册成功，请等待管理员审核',
      data: { 
        user: { 
          id: result.lastInsertRowid, 
          email, 
          username,
          approval_status: 'pending'
        } 
      },
    });
  } catch (error) {
    console.error('注册错误:', error);
    res.json({ success: false, message: '注册失败: ' + error.message });
  }
});
/**
 * API: 用户登录
 * POST /api/auth/login
 */
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.json({ success: false, message: '缺少必要参数' });
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      return res.json({ success: false, message: '邮箱或密码错误' });
    }

    // 检查用户审核状态
    if (user.approval_status === 'pending') {
      return res.json({ success: false, message: '账号正在审核中，请等待管理员审核通过' });
    }

    if (user.approval_status === 'rejected') {
      return res.json({ success: false, message: '账号审核未通过，请联系管理员' });
    }

    const isValid = await verifyPassword(password, user.password_hash);
    if (!isValid) {
      return res.json({ success: false, message: '邮箱或密码错误' });
    }

    // 检查账号是否被禁用
    if (user.is_active === 0 || user.is_active === false) {
      return res.json({ success: false, message: '账号已被禁用，请联系管理员' });
    }

    // Token中包含role信息
    const role = user.role || 'user';
    const token = generateToken({ 
      id: user.id, 
      email: user.email, 
      username: user.username,
      role: role
    });

    res.json({
      success: true,
      message: '登录成功',
      data: { 
        token, 
        user: { 
          id: user.id, 
          email: user.email, 
          username: user.username,
          role: role
        } 
      },
    });
  } catch (error) {
    console.error('登录错误:', error);
    res.json({ success: false, message: '登录失败: ' + error.message });
  }
});

/**
 * API: 获取当前用户信息
 * GET /api/auth/me
 */
app.get('/api/auth/me', authenticateToken, (req, res) => {
  const user = db.prepare('SELECT id, email, username, role, created_at FROM users WHERE id = ?').get(req.user.id);

  if (!user) {
    return res.json({ success: false, message: '用户不存在' });
  }

  res.json({ success: true, data: user });
});

/**
 * API: 更新用户个人信息
 * PUT /api/user/profile
 */
app.put('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const { username, currentPassword, newPassword } = req.body;
    const userId = req.user.id;

    // 获取当前用户信息
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) {
      return res.json({ success: false, message: '用户不存在' });
    }

    // 检查是否有内容需要更新
    if (!username && !newPassword) {
      return res.json({ success: false, message: '没有提供要更新的信息' });
    }

    // 如果要修改密码，必须验证当前密码
    if (newPassword) {
      if (!currentPassword) {
        return res.json({ success: false, message: '修改密码需要提供当前密码' });
      }

      // 验证当前密码
      const isPasswordValid = await verifyPassword(currentPassword, user.password_hash);
      if (!isPasswordValid) {
        return res.json({ success: false, message: '当前密码不正确' });
      }

      // 验证新密码长度
      if (newPassword.length < 6) {
        return res.json({ success: false, message: '新密码长度至少为6位' });
      }

      // 加密新密码
      const newPasswordHash = await hashPassword(newPassword);

      // 更新密码
      if (username) {
        // 同时更新用户名和密码
        db.prepare(`
          UPDATE users 
          SET username = ?, password_hash = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(username, newPasswordHash, userId);
      } else {
        // 只更新密码
        db.prepare(`
          UPDATE users 
          SET password_hash = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(newPasswordHash, userId);
      }

      return res.json({ success: true, message: '个人信息更新成功' });
    }

    // 只更新用户名
    if (username) {
      if (!username.trim()) {
        return res.json({ success: false, message: '用户名不能为空' });
      }

      db.prepare(`
        UPDATE users 
        SET username = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(username.trim(), userId);

      return res.json({ success: true, message: '用户名更新成功' });
    }

    res.json({ success: false, message: '没有提供要更新的信息' });

  } catch (error) {
    console.error('更新个人信息错误:', error);
    res.json({ success: false, message: '更新失败: ' + error.message });
  }
});

// ============ 平台账号管理API ============

/**
 * API: 添加平台账号
 * POST /api/platform-accounts
 */
app.post('/api/platform-accounts', authenticateToken, (req, res) => {
  try {
    const { platform, accountName, accountPassword, affiliateName, apiToken } = req.body;

    if (!platform || !accountName) {
      return res.json({ success: false, message: '缺少必要参数' });
    }

    // LB、RW、LH、PM平台必须使用API Token
    if (platform === 'linkbux' || platform === 'rewardoo' || platform === 'linkhaitao' || platform === 'partnermatic') {
      if (!apiToken) {
        const platformNames = {
          'linkbux': 'LinkBux',
          'rewardoo': 'Rewardoo',
          'linkhaitao': 'LinkHaitao',
          'partnermatic': 'PartnerMatic'
        };
        const platformName = platformNames[platform] || platform;
        return res.json({ success: false, message: `${platformName}平台需要提供API Token` });
      }
    } else {
      // 其他平台必须提供密码
      if (!accountPassword) {
        return res.json({ success: false, message: '请提供账号密码' });
      }
    }

    // 加密密码（如果有）
    const encryptedPassword = accountPassword ? encryptPassword(accountPassword) : null;

    const result = db
      .prepare(
        'INSERT INTO platform_accounts (user_id, platform, account_name, account_password, affiliate_name, api_token) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(req.user.id, platform, accountName, encryptedPassword, affiliateName || null, apiToken || null);

    res.json({
      success: true,
      message: '平台账号添加成功',
      data: { id: result.lastInsertRowid, platform, accountName, affiliateName },
    });
  } catch (error) {
    if (error.message.includes('UNIQUE')) {
      return res.json({ success: false, message: '该平台账号已存在' });
    }
    console.error('添加平台账号错误:', error);
    res.json({ success: false, message: '添加失败: ' + error.message });
  }
});

/**
 * API: 获取平台账号列表
 * GET /api/platform-accounts
 */
app.get('/api/platform-accounts', authenticateToken, (req, res) => {
  try {
    const accounts = db
      .prepare(
        'SELECT id, platform, account_name, affiliate_name, is_active, created_at FROM platform_accounts WHERE user_id = ?'
      )
      .all(req.user.id);

    res.json({ success: true, data: accounts });
  } catch (error) {
    console.error('获取平台账号错误:', error);
    res.json({ success: false, message: '获取失败: ' + error.message });
  }
});

/**
 * API: 删除平台账号
 * DELETE /api/platform-accounts/:id
 */
app.delete('/api/platform-accounts/:id', authenticateToken, (req, res) => {
  try {
    const { id } = req.params;

    const result = db
      .prepare('DELETE FROM platform_accounts WHERE id = ? AND user_id = ?')
      .run(id, req.user.id);

    if (result.changes === 0) {
      return res.json({ success: false, message: '账号不存在或无权删除' });
    }

    res.json({ success: true, message: '删除成功' });
  } catch (error) {
    console.error('删除平台账号错误:', error);
    res.json({ success: false, message: '删除失败: ' + error.message });
  }
});

// ============ LH平台自动登录 ============

// 存储验证码timestamp
const captchaTimestamps = new Map();

/**
 * 获取验证码图片（内部使用）
 */
async function getCaptchaImage() {
  const timestamp = Date.now();
  const url = `https://www.linkhaitao.com/api2.php?c=verifyCode&a=getCode&t=${timestamp}`;

  const response = await axios.get(url, { responseType: 'arraybuffer' });

  return {
    imageBuffer: response.data,
    timestamp: timestamp.toString(),
  };
}

/**
 * 调用Python OCR识别验证码
 */
async function recognizeCaptcha(imageBuffer) {
  const fs = require('fs');
  const path = require('path');
  const { spawn } = require('child_process');

  // 保存临时图片
  const tempFile = path.join(__dirname, 'temp_captcha.png');
  fs.writeFileSync(tempFile, imageBuffer);

  return new Promise((resolve, reject) => {
    const python = spawn('python', ['ocr_solver.py', tempFile]);

    let result = '';
    python.stdout.on('data', data => {
      result += data.toString();
    });

    python.on('close', code => {
      fs.unlinkSync(tempFile); // 删除临时文件

      if (code !== 0) {
        return reject(new Error('OCR识别失败'));
      }

      const code_text = result.trim();
      if (code_text && code_text.length === 4) {
        resolve(code_text);
      } else {
        reject(new Error('OCR结果无效: ' + code_text));
      }
    });
  });
}
/**
 * 自动登录LH平台（带验证码识别）
 */
async function autoLoginLH(accountName, accountPassword) {
  let attempts = 0;
  const maxAttempts = 5;

  while (attempts < maxAttempts) {
    attempts++;

    try {
      // 获取验证码
      const { imageBuffer, timestamp } = await getCaptchaImage();

      // OCR识别
      const code = await recognizeCaptcha(imageBuffer);
      console.log(`[尝试 ${attempts}] 验证码识别结果: ${code}`);

      // 登录
      const remember = '1';
      const sign = generateSign(accountName + accountPassword + code + remember + timestamp);

      const response = await axios.post(
        'https://www.linkhaitao.com/api2.php?c=login&a=login',
        new URLSearchParams({
          sign: sign,
          uname: accountName,
          password: accountPassword,
          code: code,
          remember: remember,
          t: timestamp,
        }),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }
      );

      const isSuccess =
        response.data.code === '0200' ||
        response.data.msg === 'success' ||
        response.data.error_no === 'lh_suc';

      if (isSuccess && response.data.payload && response.data.payload.auth_token) {
        console.log('✅ LH平台自动登录成功');
        return {
          success: true,
          token: response.data.payload.auth_token,
          uid: response.data.payload.uid,
          expireTime: response.data.payload.expire_time,
        };
      } else {
        console.log(`❌ 登录失败: ${response.data.msg || response.data.error_info}`);
      }
    } catch (error) {
      console.error(`[尝试 ${attempts}] 登录异常:`, error.message);
    }
  }

  throw new Error(`自动登录失败，已尝试 ${maxAttempts} 次`);
}

/**
 * 获取或刷新LH平台token
 */
async function getLHToken(platformAccountId) {
  // 查询缓存的token
  const tokenRecord = db
    .prepare(
      `
    SELECT token, expire_time FROM platform_tokens
    WHERE platform_account_id = ?
    ORDER BY created_at DESC LIMIT 1
  `
    )
    .get(platformAccountId);

  // 检查token是否有效
  if (tokenRecord && tokenRecord.expire_time) {
    const expireTime = new Date(tokenRecord.expire_time);
    if (expireTime > new Date()) {
      console.log('✅ 使用缓存的LH token');
      return tokenRecord.token;
    }
  }

  // Token过期或不存在，重新登录
  console.log('🔄 Token已过期，开始自动登录LH平台...');

  const account = db
    .prepare('SELECT account_name, account_password FROM platform_accounts WHERE id = ?')
    .get(platformAccountId);

  if (!account) {
    throw new Error('平台账号不存在');
  }

  const accountPassword = decryptPassword(account.account_password);
  const loginResult = await autoLoginLH(account.account_name, accountPassword);

  // 保存新token
  db.prepare(
    'INSERT INTO platform_tokens (platform_account_id, token, expire_time) VALUES (?, ?, ?)'
  ).run(platformAccountId, loginResult.token, loginResult.expireTime);

  return loginResult.token;
}

// ============ 工具函数 ============

/**
 * 生成标准化的商家标识符（merchant_slug）
 * 规则：小写 + 移除所有非字母数字字符
 * @param {string} merchantName - 商家名称
 * @returns {string} - 标准化后的商家标识符
 * @example
 * generateMerchantSlug("Screwfix - FR") // 返回 "screwfixfr"
 * generateMerchantSlug("Champion US") // 返回 "championus"
 */
function generateMerchantSlug(merchantName) {
  if (!merchantName) return '';
  return merchantName.toLowerCase().replace(/[^a-z0-9]/g, '');
}
// ============ 所有平台现在都使用API Token ============
// LH、PM、LB、RW平台使用固定API Token，不需要登录，直接从账号配置中读取
// ============ 数据采集API（改造版）============

// ============ 平台限制检查工具函数 ============

/**
 * 检查日期范围是否在允许范围内
 * @param {string} platform - 平台名称
 * @param {string} startDate - 开始日期 (YYYY-MM-DD)
 * @param {string} endDate - 结束日期 (YYYY-MM-DD)
 * @returns {Object} { valid: boolean, needsSplit: boolean, dateRanges: Array }
 */
function checkDateRange(platform, startDate, endDate) {
  const limits = PLATFORM_LIMITS[platform];
  if (!limits || !limits.maxDaysPerRequest) {
    return { valid: true, needsSplit: false, dateRanges: [{ startDate, endDate }] };
  }

  const start = new Date(startDate);
  const end = new Date(endDate);
  const daysDiff = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1; // +1 包含起始和结束日期

  if (daysDiff <= limits.maxDaysPerRequest) {
    return { valid: true, needsSplit: false, dateRanges: [{ startDate, endDate }] };
  }

  // 需要分割日期范围
  const dateRanges = [];
  let currentStart = new Date(start);
  const endDateObj = new Date(end);

  while (currentStart <= endDateObj) {
    const currentEnd = new Date(currentStart);
    currentEnd.setDate(currentEnd.getDate() + limits.maxDaysPerRequest - 1); // -1 因为包含起始日期

    if (currentEnd > endDateObj) {
      currentEnd.setTime(endDateObj.getTime());
    }

    dateRanges.push({
      startDate: currentStart.toISOString().split('T')[0],
      endDate: currentEnd.toISOString().split('T')[0]
    });

    currentStart = new Date(currentEnd);
    currentStart.setDate(currentStart.getDate() + 1); // 下一天开始
  }

  return {
    valid: true,
    needsSplit: true,
    originalDays: daysDiff,
    splitCount: dateRanges.length,
    dateRanges
  };
}
/**
 * 检查历史数据限制（是否在允许的历史数据范围内）
 * @param {string} platform - 平台名称
 * @param {string} startDate - 开始日期 (YYYY-MM-DD)
 * @returns {Object} { valid: boolean, error: string }
 */
function checkHistoryLimit(platform, startDate) {
  const limits = PLATFORM_LIMITS[platform];
  if (!limits || !limits.maxHistoryMonths) {
    return { valid: true };
  }

  const start = new Date(startDate);
  const today = new Date();
  const maxHistoryDate = new Date(today);
  maxHistoryDate.setMonth(maxHistoryDate.getMonth() - limits.maxHistoryMonths);

  if (start < maxHistoryDate) {
    return {
      valid: false,
      error: `查询日期不能早于最近${limits.maxHistoryMonths}个月。最早可查询日期：${maxHistoryDate.toISOString().split('T')[0]}`
    };
  }

  return { valid: true };
}

/**
 * 休眠函数（用于请求频率控制）
 * @param {number} ms - 毫秒数
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 通用分页循环采集函数
 * @param {Function} fetchPage - 获取单页数据的函数，返回 { orders: [], hasMore: boolean, totalPages?: number }
 * @param {Object} options - 配置选项
 * @returns {Promise<Array>} 所有页面的订单数据
 */
async function collectWithPagination(fetchPage, options = {}) {
  const {
    platform = 'unknown',
    maxPages = 1000,  // 最大页数限制，防止无限循环
    requestInterval = 1000,  // 请求间隔（毫秒）
    onPageComplete = null  // 每页完成后的回调函数
  } = options;

  const allOrders = [];
  let currentPage = 1;
  let hasMore = true;
  let totalPages = null;

  console.log(`📄 开始分页采集 (${platform})...`);

  while (hasMore && currentPage <= maxPages) {
    try {
      console.log(`📄 [${platform}] 正在采集第 ${currentPage} 页${totalPages ? ` / ${totalPages}` : ''}...`);
      
      const result = await fetchPage(currentPage);
      
      if (result.orders && result.orders.length > 0) {
        allOrders.push(...result.orders);
        console.log(`✅ [${platform}] 第 ${currentPage} 页采集完成，获取 ${result.orders.length} 条订单（累计 ${allOrders.length} 条）`);
      } else {
        console.log(`⚠️ [${platform}] 第 ${currentPage} 页无数据`);
      }

      // 更新分页信息
      if (result.totalPages !== undefined) {
        totalPages = result.totalPages;
      }
      
      hasMore = result.hasMore !== false; // 默认如果hasMore未定义，继续采集
      
      // 如果已知总页数，检查是否已采集完
      if (totalPages && currentPage >= totalPages) {
        hasMore = false;
      }

      // 每页完成后的回调
      if (onPageComplete) {
        onPageComplete(currentPage, result.orders?.length || 0, allOrders.length);
      }

      // 如果还有更多页，等待后继续
      if (hasMore && currentPage < maxPages) {
        currentPage++;
        if (requestInterval > 0) {
          await sleep(requestInterval);
        }
      } else {
        hasMore = false;
      }
    } catch (error) {
      console.error(`❌ [${platform}] 第 ${currentPage} 页采集失败: ${error.message}`);
      // 如果是频率限制错误，抛出以便上层重试
      if (error.rateLimit) {
        throw error;
      }
      // 其他错误，停止采集
      hasMore = false;
    }
  }

  if (currentPage > maxPages) {
    console.warn(`⚠️ [${platform}] 已达到最大页数限制 (${maxPages})，停止采集`);
  }

  console.log(`✅ [${platform}] 分页采集完成，共采集 ${currentPage} 页，总计 ${allOrders.length} 条订单`);
  
  return allOrders;
}

/**
 * API: 采集订单数据（支持LH、PM、LB平台）
 * POST /api/collect-orders
 */
app.post('/api/collect-orders', authenticateToken, async (req, res) => {
  try {
    const { platformAccountId, startDate, endDate } = req.body;

    if (!platformAccountId || !startDate || !endDate) {
      return res.json({ success: false, message: '缺少必要参数' });
    }

    // 验证账号归属
    const account = db
      .prepare('SELECT * FROM platform_accounts WHERE id = ? AND user_id = ?')
      .get(platformAccountId, req.user.id);

    if (!account) {
      return res.json({ success: false, message: '平台账号不存在或无权访问' });
    }

    // 检查历史数据限制
    const historyCheck = checkHistoryLimit(account.platform, startDate);
    if (!historyCheck.valid) {
      return res.json({ success: false, message: historyCheck.error });
    }

    // 检查并分割日期范围
    const dateRangeCheck = checkDateRange(account.platform, startDate, endDate);
    if (!dateRangeCheck.valid) {
      return res.json({ success: false, message: '日期范围检查失败' });
    }

    // 如果日期范围需要分割，使用自动分割功能
    if (dateRangeCheck.needsSplit) {
      console.log(`📅 日期范围超过限制，自动分割为 ${dateRangeCheck.splitCount} 个区间`);
      return await collectOrdersWithDateSplit(req, res, account, dateRangeCheck.dateRanges);
    }

    // 日期范围在限制内，直接调用采集方法
    if (account.platform === 'linkhaitao') {
      return await collectLHOrders(req, res, account, startDate, endDate);
    } else if (account.platform === 'partnermatic') {
      return await collectPMOrders(req, res, account, startDate, endDate);
    } else if (account.platform === 'linkbux') {
      return await collectLBOrders(req, res, account, startDate, endDate);
    } else if (account.platform === 'rewardoo') {
      return await collectRWOrders(req, res, account, startDate, endDate);
    } else {
      return res.json({ success: false, message: `不支持的平台: ${account.platform}` });
    }
  } catch (error) {
    console.error('采集订单错误:', error);
    res.json({ success: false, message: '采集失败: ' + error.message });
  }
});

/**
 * 使用日期分割采集订单（当日期范围超过限制时）
 */
async function collectOrdersWithDateSplit(req, res, account, dateRanges) {
  try {
    const allOrders = [];
    let totalNew = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalDeleted = 0;
    let successCount = 0;
    let failCount = 0;

    const limits = PLATFORM_LIMITS[account.platform];
    const requestInterval = limits?.requestInterval || 1000; // 默认1秒间隔

    for (let i = 0; i < dateRanges.length; i++) {
      const { startDate, endDate } = dateRanges[i];
      
      console.log(`📅 [${i + 1}/${dateRanges.length}] 采集日期范围: ${startDate} 至 ${endDate}`);

      try {
        // 创建临时响应对象来收集结果
        let collectedResult = null;
        let retryCount = 0;
        const maxRetries = 3; // 最多重试3次
        
        // 重试循环（主要用于处理频率限制）
        while (retryCount <= maxRetries) {
          try {
            // 根据平台调用相应的采集方法（内部版本，不直接res.json）
            if (account.platform === 'linkhaitao') {
              collectedResult = await collectLHOrdersInternal(req, account, startDate, endDate);
            } else if (account.platform === 'partnermatic') {
              collectedResult = await collectPMOrdersInternal(req, account, startDate, endDate);
            } else if (account.platform === 'linkbux') {
              collectedResult = await collectLBOrdersInternal(req, account, startDate, endDate);
            } else if (account.platform === 'rewardoo') {
              collectedResult = await collectRWOrdersInternal(req, account, startDate, endDate);
            } else {
              throw new Error(`不支持的平台: ${account.platform}`);
            }
            
            // 如果成功，跳出重试循环
            break;
          } catch (error) {
            // 检查是否是频率限制错误且还有重试机会
            if (error.rateLimit && retryCount < maxRetries) {
              retryCount++;
              const waitTime = error.retryAfter || 16000; // 遇到频率限制时等待16秒（实际限制可能是2/30s）
              console.log(`⏳ [${i + 1}/${dateRanges.length}] 遇到频率限制，等待 ${waitTime/1000} 秒后重试 (${retryCount}/${maxRetries})...`);
              await sleep(waitTime);
              continue; // 重试
            } else {
              // 非频率限制错误，或重试次数用尽，抛出错误
              throw error;
            }
          }
        }

        if (collectedResult && collectedResult.success) {
          allOrders.push(...(collectedResult.data?.orders || []));
          totalNew += collectedResult.data?.stats?.new || 0;
          totalUpdated += collectedResult.data?.stats?.updated || 0;
          totalSkipped += collectedResult.data?.stats?.skipped || 0;
          totalDeleted += collectedResult.data?.stats?.deleted || 0;
          successCount++;
          if (retryCount > 0) {
            console.log(`✅ [${i + 1}/${dateRanges.length}] 采集成功（重试${retryCount}次）`);
          }
        } else {
          failCount++;
          console.error(`❌ [${i + 1}/${dateRanges.length}] 采集失败: ${collectedResult?.message || '未知错误'}`);
        }
      } catch (error) {
        failCount++;
        console.error(`❌ [${i + 1}/${dateRanges.length}] 采集异常: ${error.message}`);
        // 继续处理下一个日期区间，不中断整个流程
      }

      // 请求间隔（避免频率限制）
      // 对于LinkHaitao，需要更长的间隔以确保30秒窗口内不超过2次请求
      if (i < dateRanges.length - 1) {
        let interval = requestInterval;
        if (account.platform === 'linkhaitao') {
          // LinkHaitao限制是2/30s，需要确保在30秒窗口内不超过2次
          // 如果上一个区间刚完成，需要等待至少16秒，但为了安全，等待20秒
          interval = 20000; // 20秒，确保30秒窗口内不超过2次请求
        }
        console.log(`⏸️  等待 ${interval/1000} 秒后继续下一个日期区间...`);
        await sleep(interval);
      }
    }

    // 汇总结果
    let message = `采集完成（共${dateRanges.length}个日期区间）：`;
    const details = [];
    if (totalNew > 0) details.push(`新增 ${totalNew} 条`);
    if (totalUpdated > 0) details.push(`更新 ${totalUpdated} 条`);
    if (totalDeleted > 0) details.push(`删除 ${totalDeleted} 条`);
    if (totalSkipped > 0) details.push(`跳过 ${totalSkipped} 条`);
    if (details.length > 0) {
      message += details.join('，');
    }
    if (failCount > 0) {
      message += `（${successCount}个区间成功，${failCount}个区间失败）`;
    }

    res.json({
      success: successCount > 0,
      message: message,
      data: {
        total: allOrders.length,
        orders: allOrders,
        stats: {
          new: totalNew,
          updated: totalUpdated,
          deleted: totalDeleted,
          skipped: totalSkipped,
          total: allOrders.length
        }
      }
    });
  } catch (error) {
    console.error('日期分割采集错误:', error);
    res.json({ success: false, message: '采集失败: ' + error.message });
  }
}
/**
 * 采集LinkHaitao订单数据（支持API Token和模拟登录两种方式）
 */
async function collectLHOrders(req, res, account, startDate, endDate) {
  try {
    let response;
    let orders = [];

    // ========== 方式1：使用API Token（新方式，优先）==========
    if (account.api_token) {
      console.log('📥 使用LH API Token方式采集订单...');
      console.log(`👤 用户: ${req.user?.id}, 账号: ${account.account_name}, Affiliate: ${account.affiliate_name || 'N/A'}`);

      try {
        // 使用分页循环采集所有数据
        const limits = PLATFORM_LIMITS.linkhaitao;
        const perPage = limits.currentItemsPerPage || 4000;
        
        // 定义单页获取函数
        const fetchLHPage = async (page) => {
      const params = new URLSearchParams({
        token: account.api_token,
        begin_date: startDate,
        end_date: endDate,
          page: page.toString(),
          per_page: perPage.toString()
      });

      const apiUrl = `https://www.linkhaitao.com/api.php?mod=medium&op=cashback2&${params.toString()}`;
        
        if (page === 1) {
          console.log(`🔗 请求URL (隐藏token): https://www.linkhaitao.com/api.php?mod=medium&op=cashback2&token=***&begin_date=${startDate}&end_date=${endDate}&page=${page}&per_page=${perPage}`);
        }

        const response = await axios.get(apiUrl, {
          timeout: 30000,  // 30秒超时
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });

        // 打印响应状态（仅第一页）
        if (page === 1) {
        console.log(`📡 LH API 响应状态: ${response.status}`);
        console.log(`📦 响应数据结构: ${JSON.stringify({
          hasStatus: !!response.data.status,
          statusCode: response.data.status?.code,
          statusMsg: response.data.status?.msg,
          hasData: !!response.data.data,
          hasList: !!response.data.data?.list,
          listLength: response.data.data?.list?.length || 0
        })}`);
        }

        // 优先检查频率限制错误
        if (response.data.code === '9999' || response.data.code === 9999 || 
            (response.data.msg && response.data.msg.includes('频率限制'))) {
          const errorMsg = response.data.msg || '请求频率限制';
          console.error(`❌ LH API 频率限制: ${errorMsg}`);
          
          if (!res) {
            const rateLimitError = new Error(`LH API频率限制: ${errorMsg}`);
            rateLimitError.rateLimit = true;
            rateLimitError.retryAfter = 16000; // 遇到频率限制时等待16秒（实际限制可能是2/30s）
            throw rateLimitError;
          }
          
          const errorResult = {
            success: false,
            message: `LH API频率限制: ${errorMsg}。请稍后再试或减少请求频率。`
          };
          if (res) {
            return res.json(errorResult);
          }
          throw new Error(errorResult.message);
        }

        const isSuccess = response.data.status && response.data.status.code === 0;

        if (isSuccess && response.data.data && response.data.data.list) {
          const pageOrders = response.data.data.list;
          // 判断是否还有更多页：如果当前页返回的数据量等于perPage，可能还有更多页
          const hasMore = pageOrders.length >= perPage;
          
          return {
            orders: pageOrders,
            hasMore: hasMore,
            totalPages: null  // LH API不返回总页数，需要根据数据量判断
          };
        } else {
          const errorMsg = (response.data.status && response.data.status.msg) || 
                          response.data.msg || '数据获取失败';
          throw new Error(`LH API错误: ${errorMsg}`);
        }
      };

      // 使用分页循环采集
      const limitsConfig = PLATFORM_LIMITS.linkhaitao;
      orders = await collectWithPagination(fetchLHPage, {
        platform: 'LinkHaitao',
        maxPages: 1000,
        requestInterval: limitsConfig.requestInterval || 16000,  // 使用配置的间隔
        onPageComplete: (page, pageCount, totalCount) => {
          // 可选：每页完成后的回调
        }
      });

        console.log(`✅ LH API Token方式：分页采集完成，共获取 ${orders.length} 条订单`);
      } catch (error) {
        // 如果是频率限制错误，重新抛出以便上层重试
        if (error.rateLimit) {
          throw error;
        }
        // 其他错误，记录并抛出
        console.error(`❌ LH API Token方式采集失败: ${error.message}`);
        throw error;
      }
    }
    // ========== 方式2：使用模拟登录（旧方式，兼容）==========
    else {
      console.log('📥 使用LH模拟登录方式采集订单...');

      // 获取LH token（自动登录）
      const lhToken = await getLHToken(account.id);

      // 获取订单数据
      const exportFlag = '0';
      const page = 1;
      const pageSize = 100;
      const signData = `${startDate}${endDate}${page}${pageSize}${exportFlag}`;
      const sign = generateSign(signData);

      response = await axios.post(
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
            'Lh-Authorization': lhToken,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      const isSuccess = response.data.code === '0200' || response.data.msg === '成功';

      if (isSuccess && response.data.payload) {
        orders = response.data.payload.info || [];
        console.log(`✅ LH模拟登录方式：获取到 ${orders.length} 条订单`);
      } else {
        const errorResult = {
          success: false,
          message: response.data.msg || '数据获取失败',
        };
        if (res) {
          return res.json(errorResult);
        }
        throw new Error(errorResult.message);
      }
    }
    // ========== 统一处理订单数据入库 ==========
    if (orders.length > 0) {

      // ========== 第1步：预处理订单数据，累加同一订单号的多个商品 ==========
      const orderMap = new Map();  // 按order_id分组累加金额

      orders.forEach(order => {
        // 字段映射（根据API方式不同，字段名也不同）
        let orderId, merchantId, merchantName, orderAmount, commission, status, orderDate;

        if (account.api_token) {
          // 新API格式字段映射
          orderId = order.order_id || order.sign_id;  // 订单号
          merchantId = order.m_id;  // 商家ID（重要：使用m_id而不是mcid）
          merchantName = order.advertiser_name;  // 商家名称
          orderAmount = parseFloat(order.sale_amount || 0);  // 订单金额
          commission = parseFloat(order.cashback || 0);  // 佣金
          status = order.status;  // 订单状态（expired/pending/approved等）
          orderDate = order.order_time ? order.order_time.split(' ')[0] : '';  // 订单日期
        } else {
          // 旧API格式字段映射（模拟登录方式）
          orderId = order.id;
          merchantId = order.mcid;
          merchantName = order.sitename;
          orderAmount = parseFloat(order.amount || 0);
          commission = parseFloat(order.total_cmsn || 0);
          status = order.status;
          orderDate = order.date_ymd || order.updated_date;
        }

        // 如果订单已存在于Map中，累加金额和佣金
        if (orderMap.has(orderId)) {
          const existingData = orderMap.get(orderId);
          existingData.orderAmount += orderAmount;
          existingData.commission += commission;
          // 保留最新的原始数据
          existingData.rawData = order;
        } else {
          // 第一次遇到该订单号，创建记录
          orderMap.set(orderId, {
            orderId,
            merchantId,
            merchantName,
            orderAmount,
            commission,
            status,
            orderDate,
            rawData: order
          });
        }
      });

      console.log(`📊 LH API返回 ${orders.length} 条商品数据，合并后得到 ${orderMap.size} 个订单`);

      // ========== 第2步：将合并后的订单数据入库 ==========
      const selectStmt = db.prepare(`
        SELECT id, status, order_amount, commission FROM orders
        WHERE user_id = ? AND platform_account_id = ? AND order_id = ?
      `);

      const insertStmt = db.prepare(`
        INSERT INTO orders
        (user_id, platform_account_id, order_id, merchant_id, merchant_name, merchant_slug,
         order_amount, commission, status, order_date, affiliate_name, raw_data, collected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `);

      const updateStmt = db.prepare(`
        UPDATE orders
        SET status = ?, commission = ?, order_amount = ?,
            merchant_name = ?, merchant_slug = ?, affiliate_name = ?, raw_data = ?, 
            updated_at = datetime('now'), collected_at = datetime('now')
        WHERE id = ?
      `);

      let newCount = 0;       // 新增订单数
      let updatedCount = 0;   // 状态更新数
      let skippedCount = 0;   // 跳过订单数

      orderMap.forEach(orderData => {
        // 直接使用聚合后的数据
        const orderId = orderData.orderId;
        const merchantId = orderData.merchantId;
        const merchantName = orderData.merchantName;
        const orderAmount = orderData.orderAmount;  // 已累加的金额
        const commission = orderData.commission;    // 已累加的佣金
        const status = orderData.status;
        const orderDate = orderData.orderDate;

        // 查询是否存在相同订单号
        const existingOrder = selectStmt.get(req.user.id, account.id, orderId);

        if (existingOrder) {
          // 订单已存在,比对状态和金额
          if (existingOrder.status !== status ||
              Math.abs(existingOrder.order_amount - orderAmount) > 0.01 ||
              Math.abs(existingOrder.commission - commission) > 0.01) {
            // 状态或金额不一致，更新订单
            updateStmt.run(
              status,
              commission,
              orderAmount,
              merchantName,
              generateMerchantSlug(merchantName),
              account.affiliate_name || null,
              JSON.stringify(orderData.rawData),
              existingOrder.id
            );
            updatedCount++;
            console.log(`📝 LH订单 ${orderId} 更新: 金额${existingOrder.order_amount}→${orderAmount}, 佣金${existingOrder.commission}→${commission}`);
          } else {
            // 数据一致，跳过
            skippedCount++;
          }
        } else {
          // 订单不存在，插入新订单
          insertStmt.run(
            req.user.id,
            account.id,
            orderId,
            merchantId,
            merchantName,
            generateMerchantSlug(merchantName),
            orderAmount,
            commission,
            status,
            orderDate,
            account.affiliate_name || null,
            JSON.stringify(orderData.rawData)
          );
          newCount++;
        }
      });

      // 构建详细的结果消息
      let message = `采集完成：`;
      const details = [];
      if (newCount > 0) details.push(`新增 ${newCount} 条`);
      if (updatedCount > 0) details.push(`更新 ${updatedCount} 条`);
      if (skippedCount > 0) details.push(`跳过 ${skippedCount} 条`);
      message += details.join('，');

      console.log(`✅ LH ${message}`);

      const result = {
        success: true,
        message: message,
        data: {
          total: orders.length,
          orders: orders,
          stats: {
            new: newCount,
            updated: updatedCount,
            skipped: skippedCount,
            total: orders.length
          }
        },
      };

      // 如果res存在，直接返回响应；否则返回结果对象（供内部调用）
      if (res) {
        return res.json(result);
      }
      return result;
    } else {
      // 没有订单数据
      const result = {
        success: true,
        message: '采集完成：未找到订单数据',
        data: {
          total: 0,
          orders: [],
          stats: {
            new: 0,
            updated: 0,
            skipped: 0,
            total: 0
          }
        }
      };

      if (res) {
        return res.json(result);
      }
      return result;
    }
  } catch (error) {
    console.error('采集LH订单错误:', error);
    const result = { success: false, message: '采集失败: ' + error.message };
    if (res) {
      return res.json(result);
    }
    throw error; // 内部调用时抛出错误，让调用者处理
  }
}

/**
 * LinkHaitao订单采集内部函数（不直接返回响应，供日期分割使用）
 */
async function collectLHOrdersInternal(req, account, startDate, endDate) {
  return await collectLHOrders(req, null, account, startDate, endDate);
}
/**
 * 采集PartnerMatic订单数据（使用API Token）
 */
async function collectPMOrders(req, res, account, startDate, endDate) {
  try {
    // 获取PM API token（从account.api_token字段读取）
    const pmToken = account.api_token;

    if (!pmToken) {
      const errorResult = {
        success: false,
        message: 'PartnerMatic账号未配置API Token，请在账号设置中添加'
      };
      if (res) {
        return res.json(errorResult);
      }
      throw new Error(errorResult.message);
    }

    console.log('📥 开始采集PM订单...');

    // 使用分页循环采集所有数据
    const limits = PLATFORM_LIMITS.partnermatic;
    const perPage = limits.currentItemsPerPage || 2000;
    
    // 定义单页获取函数
    const fetchPMPage = async (page) => {
    const response = await axios.post(
      'https://api.partnermatic.com/api/transaction_v3',  // 使用 V3 API
      {
        source: 'partnermatic',
        token: pmToken,
        // V3 API 不需要 dataScope 参数
        beginDate: startDate,
        endDate: endDate,
          curPage: page,
          perPage: perPage
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    // PM新API响应格式：{ code: "0", message: "success", data: { total, list: [...] } }
      // 检查频率限制错误（错误代码：1002）
      if (response.data.code === '1002' || (response.data.message && response.data.message.includes('频率'))) {
        const errorMsg = response.data.message || '请求频率限制';
        console.error(`❌ PM API 频率限制: ${errorMsg}`);
        
        if (!res) {
          const rateLimitError = new Error(`PM API频率限制: ${errorMsg}`);
          rateLimitError.rateLimit = true;
          rateLimitError.retryAfter = 2000; // 2秒后重试
          throw rateLimitError;
        }
        
        throw new Error(`PM API频率限制: ${errorMsg}`);
      }

    const isSuccess = response.data.code === '0' && response.data.data;

    if (isSuccess && response.data.data.list) {
        const pageOrders = response.data.data.list || [];
        const total = response.data.data.total || 0;
        const totalPages = Math.ceil(total / perPage);
        
        return {
          orders: pageOrders,
          hasMore: page < totalPages,
          totalPages: totalPages
        };
      } else {
        const errorMsg = response.data.message || 'PM数据获取失败';
        throw new Error(`PM API错误: ${errorMsg}`);
      }
    };

    // 使用分页循环采集
    const limitsConfig = PLATFORM_LIMITS.partnermatic;
    const allOrders = await collectWithPagination(fetchPMPage, {
      platform: 'PartnerMatic',
      maxPages: 1000,
      requestInterval: limitsConfig.requestInterval || 1000,
    });

    const orders = allOrders;

      console.log(`✅ PM API返回 ${orders.length} 条商品数据`);

      // ========== 第1步：预处理订单数据，累加同一订单号的多个商品 ==========
      const orderMap = new Map();  // 按order_id分组累加金额

      orders.forEach(order => {
        // V3 API 数据结构：订单级别 + items 数组
        const orderId = order.oid || order.order_id;  // V3 使用 oid
        const merchantId = order.mid || order.brand_id;
        const merchantName = order.merchant_name;
        
        // 订单日期处理
        let orderDate = '';
        if (order.order_time) {
          if (typeof order.order_time === 'string' && order.order_time.includes('-')) {
            // V3 API 返回格式化的日期字符串 "2026-01-15 10:32:09"
            orderDate = order.order_time.split(' ')[0];
          } else if (typeof order.order_time === 'number' || !isNaN(parseInt(order.order_time))) {
            // 时间戳格式
            const timestamp = (typeof order.order_time === 'number' ? order.order_time : parseInt(order.order_time)) * 1000;
            orderDate = new Date(timestamp).toISOString().split('T')[0];
          }
        }
        
        // 处理 items 数组（V3 API 的商品列表）
        const items = order.items || [order];  // 如果没有 items，把整个 order 当作一个 item
        
        items.forEach(item => {
          const orderAmount = parseFloat(item.sale_amount || 0);
          const commission = parseFloat(item.sale_comm || 0);
          
          // 状态映射
          let status = 'Pending';
          if (item.status === 'Approved') status = 'Approved';
          else if (item.status === 'Rejected' || item.status === 'Canceled') status = 'Rejected';
          else status = 'Pending';
          
          // 如果订单已存在于Map中，累加金额和佣金
          if (orderMap.has(orderId)) {
            const existingData = orderMap.get(orderId);
            existingData.orderAmount += orderAmount;
            existingData.commission += commission;
            // 保留最新的原始数据（包含 settlement 信息）
            existingData.rawData = item;  // 保存 item 数据，因为 settlement 字段在 item 中
          } else {
            // 第一次遇到该订单号，创建记录
            orderMap.set(orderId, {
              orderId,
              merchantId,
              merchantName,
              orderAmount,
              commission,
              status,
              orderDate,
              rawData: item  // 保存 item 数据，因为 settlement 字段在 item 中
            });
          }
        });
      });
      console.log(`📊 PM API返回 ${orders.length} 条订单数据，合并后得到 ${orderMap.size} 个订单`);

      // ========== 第2步：同步删除数据库中API不存在的订单（日期范围内） ==========
      // 只删除明显无效的订单（Pending + 佣金为0），保留有状态的订单以确保结算率和拒付率计算的准确性
      // 查询数据库中该日期范围内的所有订单（包括状态和佣金信息）
      const dbOrdersInRange = db.prepare(`
        SELECT order_id, status, commission FROM orders
        WHERE user_id = ? AND platform_account_id = ?
          AND order_date >= ? AND order_date <= ?
      `).all(req.user.id, account.id, startDate, endDate);

      // 找出API中不存在的订单
      const apiOrderIds = new Set(orderMap.keys());
      const ordersNotInAPI = dbOrdersInRange.filter(dbOrder => !apiOrderIds.has(dbOrder.order_id));

      // 只删除明显无效的订单：状态为Pending且佣金为0或null
      const ordersToDelete = ordersNotInAPI.filter(order => {
        const status = order.status || 'Pending';
        const commission = parseFloat(order.commission || 0);
        // 只删除Pending状态且佣金为0的订单
        return status === 'Pending' && commission === 0;
      });

      let deletedCount = 0;
      if (ordersToDelete.length > 0) {
        const deleteStmt = db.prepare(`
          DELETE FROM orders
          WHERE user_id = ? AND platform_account_id = ? AND order_id = ?
        `);

        ordersToDelete.forEach(order => {
          deleteStmt.run(req.user.id, account.id, order.order_id);
          deletedCount++;
        });

        console.log(`🗑️  PM删除 ${deletedCount} 个明显无效的订单（Pending + 佣金为0）`);
        
        // 如果有其他不在API中的订单但被保留，记录日志
        const keptCount = ordersNotInAPI.length - deletedCount;
        if (keptCount > 0) {
          console.log(`📊 PM保留 ${keptCount} 个不在API中的订单（有状态或佣金，用于结算率/拒付率计算）`);
        }
      } else if (ordersNotInAPI.length > 0) {
        // 虽然没有删除，但有订单不在API中，记录日志
        console.log(`📊 PM保留 ${ordersNotInAPI.length} 个不在API中的订单（有状态或佣金，用于结算率/拒付率计算）`);
      }

      // ========== 第3步：将合并后的订单数据入库 ==========
      const selectStmt = db.prepare(`
        SELECT id, status, order_amount, commission, settlement_id, settlement_date, paid_date, payment_id 
        FROM orders
        WHERE user_id = ? AND platform_account_id = ? AND order_id = ?
      `);

      const insertStmt = db.prepare(`
        INSERT INTO orders
        (user_id, platform_account_id, order_id, merchant_id, merchant_name, merchant_slug,
         order_amount, commission, status, order_date, affiliate_name, raw_data, collected_at,
         settlement_id, settlement_date, paid_date, payment_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?)
      `);

      const updateStmt = db.prepare(`
        UPDATE orders
        SET status = ?, commission = ?, order_amount = ?,
            merchant_name = ?, merchant_slug = ?, affiliate_name = ?, raw_data = ?, 
            settlement_id = ?, settlement_date = ?, paid_date = ?, payment_id = ?,
            updated_at = datetime('now'), collected_at = datetime('now')
        WHERE id = ?
      `);

      let newCount = 0;
      let updatedCount = 0;
      let skippedCount = 0;

      orderMap.forEach(orderData => {
        // 直接使用聚合后的数据
        const orderId = orderData.orderId;
        const merchantId = orderData.merchantId;
        const merchantName = orderData.merchantName;
        const orderAmount = orderData.orderAmount;  // 已累加的金额
        const commission = orderData.commission;    // 已累加的佣金
        const status = orderData.status;
        const orderDate = orderData.orderDate;
        
        // 提取提现相关字段
        const rawData = orderData.rawData;
        const settlementId = rawData.settlement_id || null;
        const settlementDate = rawData.settlement_date || null;
        const paidDate = rawData.paid_date || null;
        const paymentId = rawData.payment_id || null;

        // 查询是否存在相同订单号
        const existingOrder = selectStmt.get(req.user.id, account.id, orderId);

        if (existingOrder) {
          // 订单已存在，检查是否需要更新
          const needsUpdate = 
            existingOrder.status !== status ||
            Math.abs(existingOrder.order_amount - orderAmount) > 0.01 ||
            Math.abs(existingOrder.commission - commission) > 0.01 ||
            // 检查 settlement 字段是否需要更新
            (settlementId && !existingOrder.settlement_id) ||
            (settlementDate && !existingOrder.settlement_date) ||
            (paidDate && !existingOrder.paid_date) ||
            (paymentId && !existingOrder.payment_id);
          
          if (needsUpdate) {
            // 状态、金额或 settlement 字段不一致，更新订单
            updateStmt.run(
              status,
              commission,
              orderAmount,
              merchantName,
              generateMerchantSlug(merchantName),
              account.affiliate_name || null,
              JSON.stringify(orderData.rawData),
              settlementId,
              settlementDate,
              paidDate,
              paymentId,
              existingOrder.id
            );
            updatedCount++;
            console.log(`📝 PM订单 ${orderId} 更新: 金额${existingOrder.order_amount}→${orderAmount}, 佣金${existingOrder.commission}→${commission}`);
          } else {
            // 数据一致，跳过
            skippedCount++;
          }
        } else {
          // 订单不存在，插入新订单
          insertStmt.run(
            req.user.id,
            account.id,
            orderId,
            merchantId,
            merchantName,
            generateMerchantSlug(merchantName),
            orderAmount,
            commission,
            status,
            orderDate,
            account.affiliate_name || null,
            JSON.stringify(orderData.rawData),
            settlementId,
            settlementDate,
            paidDate,
            paymentId
          );
          newCount++;
        }
      });

      // 构建详细的结果消息
      let message = `采集完成：`;
      const details = [];
      if (newCount > 0) details.push(`新增 ${newCount} 条`);
      if (updatedCount > 0) details.push(`更新 ${updatedCount} 条`);
      if (deletedCount > 0) details.push(`删除 ${deletedCount} 条`);
      if (skippedCount > 0) details.push(`跳过 ${skippedCount} 条`);
      message += details.join('，');

      console.log(`✅ PM ${message}`);

      const result = {
        success: true,
        message: message,
        data: {
          total: orderMap.size,  // 使用合并后的订单数量
          orders: Array.from(orderMap.values()).map(orderData => {
            // 使用合并后的订单数据
            return {
              id: orderData.orderId,
              mcid: orderData.merchantId,
              sitename: orderData.merchantName,
              amount: orderData.orderAmount,
              total_cmsn: orderData.commission,
              status: orderData.status,
              date_ymd: orderData.orderDate
            };
          }),
          stats: {
            new: newCount,
            updated: updatedCount,
            deleted: deletedCount,
            skipped: skippedCount,
            total: orders.length
          }
        },
      };

      if (res) {
        return res.json(result);
      }
      return result;
  } catch (error) {
    console.error('采集PM订单错误:', error);
    const errorResult = { success: false, message: '采集失败: ' + error.message };
    if (res) {
      return res.json(errorResult);
    }
    throw error;
  }
}

/**
 * PartnerMatic订单采集内部函数（不直接返回响应，供日期分割使用）
 */
async function collectPMOrdersInternal(req, account, startDate, endDate) {
  return await collectPMOrders(req, null, account, startDate, endDate);
}

/**
 * 采集LinkBux订单数据
 */
async function collectLBOrders(req, res, account, startDate, endDate) {
  try {
    // 获取LB API token（从account.api_token字段读取，而不是登录获取）
    const lbToken = account.api_token;

    if (!lbToken) {
      const errorResult = {
        success: false,
        message: 'LinkBux账号未配置API Token，请在账号设置中添加'
      };
      if (res) {
        return res.json(errorResult);
      }
      throw new Error(errorResult.message);
    }

    console.log('📥 开始采集LB订单...');

    // 使用分页循环采集所有数据
    const limits = PLATFORM_LIMITS.linkbux;
    const perPage = limits.currentItemsPerPage || 1000;
    
    // 定义单页获取函数
    const fetchLBPage = async (page) => {
    const params = new URLSearchParams({
      token: lbToken,
      begin_date: startDate,
      end_date: endDate,
      type: 'json',
      status: 'All',  // 获取所有状态：Approved、Pending、Rejected
        page: page.toString(),
        limit: perPage.toString()   // 每页最大1000条（API限制）
    });

    const apiUrl = `https://www.linkbux.com/api.php?mod=medium&op=transaction_v2&${params.toString()}`;

    const response = await axios.get(apiUrl);

    // LB API响应格式（有两种）：
    // 成功: { status: { code: 0, msg: "Success" }, data: { total_trans, total_page, list: [...] } }
    // 失败: { status: { code: 1000, msg: "error" } }
      // 频率限制: { code: 1002, msg: "呼叫频率过高" }
      const errorCode = response.data.code || (response.data.status && response.data.status.code);
      
      // 检查频率限制错误（错误代码：1002）
      if (errorCode === 1002 || errorCode === '1002' || 
          (response.data.msg && response.data.msg.includes('频率')) ||
          (response.data.status && response.data.status.msg && response.data.status.msg.includes('频率'))) {
        const errorMsg = response.data.msg || (response.data.status && response.data.status.msg) || '请求频率限制';
        console.error(`❌ LB API 频率限制: ${errorMsg}`);
        
        if (!res) {
          const rateLimitError = new Error(`LB API频率限制: ${errorMsg}`);
          rateLimitError.rateLimit = true;
          rateLimitError.retryAfter = 2000; // 2秒后重试
          throw rateLimitError;
        }
        
        throw new Error(`LB API频率限制: ${errorMsg}`);
      }

    const isSuccess =
      (response.data.code === 0 || response.data.code === '0') ||
      (response.data.status && (response.data.status.code === 0 || response.data.status.code === '0'));

    if (isSuccess && response.data.data) {
        const pageOrders = response.data.data.list || response.data.data.transactions || [];
        const totalPage = response.data.data.total_page || 1;
        
        return {
          orders: pageOrders,
          hasMore: page < totalPage,
          totalPages: totalPage
        };
      } else {
        const errorMessage = response.data.msg || (response.data.status && response.data.status.msg) || 'LB数据获取失败';
        throw new Error(`LB API错误: ${errorMessage} (code: ${errorCode})`);
      }
    };

    // 使用分页循环采集
    const limitsConfig = PLATFORM_LIMITS.linkbux;
    const allOrders = await collectWithPagination(fetchLBPage, {
      platform: 'LinkBux',
      maxPages: 1000,
      requestInterval: limitsConfig.requestInterval || 1000,
    });

    const orders = allOrders;

      // ========== 第1步：预处理订单数据，累加同一订单号的多个商品 ==========
      const orderMap = new Map();  // 按order_id分组累加金额

      orders.forEach(order => {
        const orderId = order.order_id || order.linkbux_id;
        const merchantId = order.mid;
        const merchantName = order.merchant_name;
        const orderAmount = parseFloat(order.sale_amount || 0);
        const commission = parseFloat(order.sale_comm || 0);

        // 状态映射：Approved/Pending/Rejected
        let status = 'Pending';
        if (order.status === 'Approved') status = 'Approved';
        else if (order.status === 'Rejected') status = 'Rejected';
        else status = 'Pending';

        // 订单日期：order_time是秒级时间戳，需转换为YYYY-MM-DD格式
        let orderDate = '';
        if (order.order_time) {
          if (typeof order.order_time === 'number') {
            const timestamp = order.order_time * 1000;
            orderDate = new Date(timestamp).toISOString().split('T')[0];
          } else if (typeof order.order_time === 'string') {
            orderDate = order.order_time.split(' ')[0];
          }
        } else if (order.validation_date) {
          orderDate = typeof order.validation_date === 'string' ? order.validation_date.split(' ')[0] : '';
        }

        // 如果订单已存在于Map中，累加金额和佣金
        if (orderMap.has(orderId)) {
          const existingData = orderMap.get(orderId);
          existingData.orderAmount += orderAmount;
          existingData.commission += commission;
          // 保留最新的原始数据
          existingData.rawData = order;
        } else {
          // 第一次遇到该订单号，创建记录
          orderMap.set(orderId, {
            orderId,
            merchantId,
            merchantName,
            orderAmount,
            commission,
            status,
            orderDate,
            rawData: order
          });
        }
      });

      console.log(`📊 LB API返回 ${orders.length} 条商品数据，合并后得到 ${orderMap.size} 个订单`);

      // ========== 第2步：将合并后的订单数据入库 ==========
      const selectStmt = db.prepare(`
        SELECT id, status, order_amount, commission FROM orders
        WHERE user_id = ? AND platform_account_id = ? AND order_id = ?
      `);

      const insertStmt = db.prepare(`
        INSERT INTO orders
        (user_id, platform_account_id, order_id, merchant_id, merchant_name, merchant_slug,
         order_amount, commission, status, order_date, affiliate_name, raw_data, collected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `);

      const updateStmt = db.prepare(`
        UPDATE orders
        SET status = ?, commission = ?, order_amount = ?,
            merchant_name = ?, merchant_slug = ?, affiliate_name = ?, raw_data = ?, 
            updated_at = datetime('now'), collected_at = datetime('now')
        WHERE id = ?
      `);

      let newCount = 0;       // 新增订单数
      let updatedCount = 0;   // 状态更新数
      let skippedCount = 0;   // 跳过订单数

      orderMap.forEach(orderData => {
        // 直接使用聚合后的数据
        const orderId = orderData.orderId;
        const merchantId = orderData.merchantId;
        const merchantName = orderData.merchantName;
        const orderAmount = orderData.orderAmount;  // 已累加的金额
        const commission = orderData.commission;    // 已累加的佣金
        const status = orderData.status;
        const orderDate = orderData.orderDate;

        // 查询是否存在相同订单号
        const existingOrder = selectStmt.get(req.user.id, account.id, orderId);

        if (existingOrder) {
          // 订单已存在，比对状态和金额
          if (existingOrder.status !== status ||
              Math.abs(existingOrder.order_amount - orderAmount) > 0.01 ||
              Math.abs(existingOrder.commission - commission) > 0.01) {
            // 状态或金额不一致，更新订单
            updateStmt.run(
              status,
              commission,
              orderAmount,
              merchantName,
              generateMerchantSlug(merchantName),
              account.affiliate_name || null,
              JSON.stringify(orderData.rawData),
              existingOrder.id
            );
            updatedCount++;
            console.log(`📝 LB订单 ${orderId} 更新: 金额${existingOrder.order_amount}→${orderAmount}, 佣金${existingOrder.commission}→${commission}`);
          } else {
            // 数据一致，跳过
            skippedCount++;
          }
        } else {
          // 订单不存在，插入新订单
          insertStmt.run(
            req.user.id,
            account.id,
            orderId,
            merchantId,
            merchantName,
            generateMerchantSlug(merchantName),
            orderAmount,
            commission,
            status,
            orderDate,
            account.affiliate_name || null,
            JSON.stringify(orderData.rawData)
          );
          newCount++;
        }
      });

      // 构建详细的结果消息
      let message = `采集完成：`;
      const details = [];
      if (newCount > 0) details.push(`新增 ${newCount} 条`);
      if (updatedCount > 0) details.push(`更新 ${updatedCount} 条`);
      if (skippedCount > 0) details.push(`跳过 ${skippedCount} 条`);
      message += details.join('，');

      console.log(`✅ LB ${message}`);

      const result = {
        success: true,
        message: message,
        data: {
          total: orders.length,  // API返回的原始数据行数
          total_trans: orderMap.size,  // 真实交易数（去重后）
          total_page: 1,  // 分页信息在collectWithPagination中处理
          orders: Array.from(orderMap.values()).map(orderData => {
            // 使用合并后的订单数据
            return {
              id: orderData.orderId,
              mcid: orderData.merchantId,
              sitename: orderData.merchantName,
              amount: orderData.orderAmount,
              total_cmsn: orderData.commission,
              status: orderData.status,
              date_ymd: orderData.orderDate
            };
          }),
          stats: {
            new: newCount,
            updated: updatedCount,
            skipped: skippedCount,
            total: orders.length
          }
        },
      };

      if (res) {
        return res.json(result);
      }
      return result;
  } catch (error) {
    console.error('采集LB订单错误:', error);
    const errorResult = { success: false, message: '采集失败: ' + error.message };
    if (res) {
      return res.json(errorResult);
    }
    throw error;
  }
}

/**
 * LinkBux订单采集内部函数（不直接返回响应，供日期分割使用）
 */
async function collectLBOrdersInternal(req, account, startDate, endDate) {
  return await collectLBOrders(req, null, account, startDate, endDate);
}
/**
 * 采集Rewardoo订单数据
 */
async function collectRWOrders(req, res, account, startDate, endDate) {
  try {
    // 获取RW API token（从account.api_token字段读取）
    const rwToken = account.api_token;

    if (!rwToken) {
      const errorResult = {
        success: false,
        message: 'Rewardoo账号未配置API Token，请在账号设置中添加'
      };
      if (res) {
        return res.json(errorResult);
      }
      throw new Error(errorResult.message);
    }

    console.log('📥 开始采集RW订单...');

    // 使用分页循环采集所有数据
    const limits = PLATFORM_LIMITS.rewardoo;
    const perPage = limits.currentItemsPerPage || 1000;
    
    // 定义单页获取函数
    const fetchRWPage = async (page) => {
    const params = new URLSearchParams({
      token: rwToken,
      begin_date: startDate,
      end_date: endDate,
        page: page.toString(),
        limit: perPage.toString()
    });

    const apiUrl = 'https://admin.rewardoo.com/api.php?mod=medium&op=transaction_details';

    const response = await axios.post(apiUrl, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    // RW API响应格式与LB类似
      // 频率限制: { code: 1002, msg: "呼叫频率过高" }
      const errorCode = response.data.code || (response.data.status && response.data.status.code);
      
      // 检查频率限制错误（错误代码：1002）
      if (errorCode === 1002 || errorCode === '1002' || 
          (response.data.msg && response.data.msg.includes('频率')) ||
          (response.data.status && response.data.status.msg && response.data.status.msg.includes('频率'))) {
        const errorMsg = response.data.msg || (response.data.status && response.data.status.msg) || '请求频率限制';
        console.error(`❌ RW API 频率限制: ${errorMsg}`);
        
        if (!res) {
          const rateLimitError = new Error(`RW API频率限制: ${errorMsg}`);
          rateLimitError.rateLimit = true;
          rateLimitError.retryAfter = 2000; // 2秒后重试
          throw rateLimitError;
        }
        
        throw new Error(`RW API频率限制: ${errorMsg}`);
      }

    const isSuccess =
      (response.data.code === 0 || response.data.code === '0') ||
      (response.data.status && (response.data.status.code === 0 || response.data.status.code === '0'));

    if (isSuccess && response.data.data) {
        const pageOrders = response.data.data.list || response.data.data.transactions || [];
        const totalPage = response.data.data.total_page || 1;
        
        return {
          orders: pageOrders,
          hasMore: page < totalPage,
          totalPages: totalPage
        };
      } else {
        const errorMessage = response.data.msg || (response.data.status && response.data.status.msg) || 'RW数据获取失败';
        throw new Error(`RW API错误: ${errorMessage} (code: ${errorCode})`);
      }
    };

    // 使用分页循环采集
    const limitsConfig = PLATFORM_LIMITS.rewardoo;
    const allOrders = await collectWithPagination(fetchRWPage, {
      platform: 'Rewardoo',
      maxPages: 1000,
      requestInterval: limitsConfig.requestInterval || 1000,
    });

    const orders = allOrders;

      // ========== 第1步：预处理订单数据，累加同一订单号的多个商品 ==========
      const orderMap = new Map();

      orders.forEach(order => {
        const orderId = order.order_id || order.rewardoo_id;
        const merchantId = order.mid;
        const merchantName = order.merchant_name;
        const orderAmount = parseFloat(order.sale_amount || 0);
        const commission = parseFloat(order.sale_comm || 0);

        // 状态映射
        let status = 'Pending';
        if (order.status === 'Approved') status = 'Approved';
        else if (order.status === 'Rejected') status = 'Rejected';
        else status = 'Pending';

        // 订单日期处理
        let orderDate = '';
        if (order.order_time) {
          if (typeof order.order_time === 'number') {
            // 数字类型：秒级时间戳
            const timestamp = order.order_time * 1000;
            orderDate = new Date(timestamp).toISOString().split('T')[0];
          } else if (typeof order.order_time === 'string') {
            // 字符串类型：可能是时间戳字符串或日期字符串
            const numericTimestamp = parseInt(order.order_time);
            if (!isNaN(numericTimestamp) && order.order_time.length === 10) {
              // 10位数字字符串，是秒级时间戳
              const timestamp = numericTimestamp * 1000;
              orderDate = new Date(timestamp).toISOString().split('T')[0];
            } else {
              // 日期字符串格式
              orderDate = order.order_time.split(' ')[0];
            }
          }
        } else if (order.validation_date && order.validation_date !== 'null') {
          orderDate = typeof order.validation_date === 'string' ? order.validation_date.split(' ')[0] : '';
        }

        // 如果订单已存在于Map中，累加金额和佣金
        if (orderMap.has(orderId)) {
          const existingData = orderMap.get(orderId);
          existingData.orderAmount += orderAmount;
          existingData.commission += commission;
          existingData.rawData = order;
        } else {
          orderMap.set(orderId, {
            orderId,
            merchantId,
            merchantName,
            orderAmount,
            commission,
            status,
            orderDate,
            rawData: order
          });
        }
      });

      console.log(`📊 RW API返回 ${orders.length} 条商品数据，合并后得到 ${orderMap.size} 个订单`);

      // ========== 第2步：将合并后的订单数据入库 ==========
      const selectStmt = db.prepare(`
        SELECT id, status, order_amount, commission FROM orders
        WHERE user_id = ? AND platform_account_id = ? AND order_id = ?
      `);

      const insertStmt = db.prepare(`
        INSERT INTO orders
        (user_id, platform_account_id, order_id, merchant_id, merchant_name, merchant_slug,
         order_amount, commission, status, order_date, affiliate_name, raw_data, collected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `);

      const updateStmt = db.prepare(`
        UPDATE orders
        SET status = ?, commission = ?, order_amount = ?,
            merchant_name = ?, merchant_slug = ?, affiliate_name = ?, raw_data = ?, 
            updated_at = datetime('now'), collected_at = datetime('now')
        WHERE id = ?
      `);

      let newCount = 0;
      let updatedCount = 0;
      let skippedCount = 0;

      orderMap.forEach(orderData => {
        const orderId = orderData.orderId;
        const merchantId = orderData.merchantId;
        const merchantName = orderData.merchantName;
        const orderAmount = orderData.orderAmount;
        const commission = orderData.commission;
        const status = orderData.status;
        const orderDate = orderData.orderDate;

        const existingOrder = selectStmt.get(req.user.id, account.id, orderId);

        if (existingOrder) {
          if (existingOrder.status !== status ||
              Math.abs(existingOrder.order_amount - orderAmount) > 0.01 ||
              Math.abs(existingOrder.commission - commission) > 0.01) {
            updateStmt.run(
              status,
              commission,
              orderAmount,
              merchantName,
              generateMerchantSlug(merchantName),
              account.affiliate_name || null,
              JSON.stringify(orderData.rawData),
              existingOrder.id
            );
            updatedCount++;
            console.log(`📝 RW订单 ${orderId} 更新: 金额${existingOrder.order_amount}→${orderAmount}, 佣金${existingOrder.commission}→${commission}`);
          } else {
            skippedCount++;
          }
        } else {
          insertStmt.run(
            req.user.id,
            account.id,
            orderId,
            merchantId,
            merchantName,
            generateMerchantSlug(merchantName),
            orderAmount,
            commission,
            status,
            orderDate,
            account.affiliate_name || null,
            JSON.stringify(orderData.rawData)
          );
          newCount++;
        }
      });
      let message = `采集完成：`;
      const details = [];
      if (newCount > 0) details.push(`新增 ${newCount} 条`);
      if (updatedCount > 0) details.push(`更新 ${updatedCount} 条`);
      if (skippedCount > 0) details.push(`跳过 ${skippedCount} 条`);
      message += details.join('，');

      console.log(`✅ RW ${message}`);

      const result = {
        success: true,
        message: message,
        data: {
          total: orders.length,  // API返回的原始数据行数
          total_trans: orderMap.size,  // 真实交易数（去重后）
          total_page: 1,  // 分页信息在collectWithPagination中处理
          orders: Array.from(orderMap.values()).map(orderData => {
            // 使用合并后的订单数据
            return {
              id: orderData.orderId,
              mcid: orderData.merchantId,
              sitename: orderData.merchantName,
              amount: orderData.orderAmount,
              total_cmsn: orderData.commission,
              status: orderData.status,
              date_ymd: orderData.orderDate
            };
          }),
          stats: {
            new: newCount,
            updated: updatedCount,
            skipped: skippedCount,
            total: orders.length
          }
        },
      };

      if (res) {
        return res.json(result);
      }
      return result;
  } catch (error) {
    console.error('采集RW订单错误:', error);
    const errorResult = { success: false, message: '采集失败: ' + error.message };
    if (res) {
      return res.json(errorResult);
    }
    throw error;
  }
}

/**
 * Rewardoo订单采集内部函数（不直接返回响应，供日期分割使用）
 */
async function collectRWOrdersInternal(req, account, startDate, endDate) {
  return await collectRWOrders(req, null, account, startDate, endDate);
}

/**
 * API: 获取历史订单
 * GET /api/orders
 */
app.get('/api/orders', authenticateToken, (req, res) => {
  try {
    const { startDate, endDate, platformAccountId, status, page, pageSize } = req.query;

    let query = `
      SELECT 
        o.*,
        pa.account_name as platform_account_name,
        pa.platform as platform_name,
        pa.affiliate_name
      FROM orders o
      LEFT JOIN platform_accounts pa ON o.platform_account_id = pa.id
      WHERE o.user_id = ?
    `;
    const params = [req.user.id];

    if (startDate) {
      query += ' AND DATE(o.order_date) >= ?';
      params.push(startDate);
    }

    if (endDate) {
      query += ' AND DATE(o.order_date) <= ?';
      params.push(endDate);
    }

    if (platformAccountId) {
      query += ' AND o.platform_account_id = ?';
      params.push(platformAccountId);
    }

    // 支持状态筛选：Pending, Approved, Rejected, 或全部
    if (status && status !== 'all') {
      // 状态映射：前端传的是中文，需要映射到数据库状态
      const statusMap = {
        'pending': 'Pending',
        '待确认': 'Pending',
        'confirmed': 'Approved',
        '已确认': 'Approved',
        'rejected': 'Rejected',
        '已拒绝': 'Rejected'
      };
      const dbStatus = statusMap[status.toLowerCase()] || status;
      query += ' AND o.status = ?';
      params.push(dbStatus);
    }

    query += ' ORDER BY o.order_date DESC';

    // 支持分页
    // 如果只传了pageSize而没有page，默认page=1
    const queryPageNum = page ? parseInt(page) : (pageSize ? 1 : null);
    const queryPageSizeNum = pageSize ? parseInt(pageSize) : null;
    
    if (queryPageNum && queryPageSizeNum) {
      const offset = (queryPageNum - 1) * queryPageSizeNum;
      query += ` LIMIT ${queryPageSizeNum} OFFSET ${offset}`;
    } else if (queryPageSizeNum) {
      // 只传了pageSize，默认从第一页开始
      query += ` LIMIT ${queryPageSizeNum}`;
    } else {
      // 都没有传，默认返回1000条
      query += ' LIMIT 1000';
    }

    const orders = db.prepare(query).all(...params);

    // 获取总数（用于分页）
    let countQuery = 'SELECT COUNT(*) as total FROM orders o WHERE o.user_id = ?';
    const countParams = [req.user.id];
    
    if (startDate) {
      countQuery += ' AND DATE(o.order_date) >= ?';
      countParams.push(startDate);
    }
    if (endDate) {
      countQuery += ' AND DATE(o.order_date) <= ?';
      countParams.push(endDate);
    }
    if (platformAccountId) {
      countQuery += ' AND o.platform_account_id = ?';
      countParams.push(platformAccountId);
    }
    if (status && status !== 'all') {
      const statusMap = {
        'pending': 'Pending',
        '待确认': 'Pending',
        'confirmed': 'Approved',
        '已确认': 'Approved',
        'rejected': 'Rejected',
        '已拒绝': 'Rejected'
      };
      const dbStatus = statusMap[status.toLowerCase()] || status;
      countQuery += ' AND o.status = ?';
      countParams.push(dbStatus);
    }

    const totalResult = db.prepare(countQuery).get(...countParams);
    const total = totalResult ? totalResult.total : 0;

    // 计算分页信息（用于返回给前端）
    const responsePageNum = page ? parseInt(page) : (pageSize ? 1 : 1);
    const responsePageSizeNum = pageSize ? parseInt(pageSize) : 1000;
    const totalPages = Math.ceil(total / responsePageSizeNum);
    
    res.json({ 
      success: true, 
      data: orders,
      pagination: {
        total,
        page: responsePageNum,
        pageSize: responsePageSizeNum,
        totalPages: totalPages
      }
    });
  } catch (error) {
    console.error('获取订单错误:', error);
    res.json({ success: false, message: '获取失败: ' + error.message });
  }
});

/**
 * API: 获取统计数据
 * GET /api/stats
 */
app.get('/api/stats', authenticateToken, (req, res) => {
  try {
    const { startDate, endDate, platformAccountId, status } = req.query;

    // 查询订单统计（总佣金只包含已确认和待确认的）
    let query = `
      SELECT
        COUNT(*) as total_orders,
        SUM(order_amount) as total_amount,
        SUM(CASE WHEN UPPER(TRIM(status)) IN ('APPROVED', 'PENDING') THEN commission ELSE 0 END) as total_commission,
        SUM(CASE WHEN UPPER(TRIM(status)) = 'APPROVED' THEN commission ELSE 0 END) as confirmed_commission,
        SUM(CASE WHEN UPPER(TRIM(status)) = 'PENDING' THEN commission ELSE 0 END) as pending_commission,
        SUM(CASE WHEN UPPER(TRIM(status)) = 'REJECTED' THEN commission ELSE 0 END) as rejected_commission
      FROM orders WHERE user_id = ?
    `;
    const params = [req.user.id];

    if (startDate) {
      query += ' AND DATE(order_date) >= ?';
      params.push(startDate);
    }

    if (endDate) {
      query += ' AND DATE(order_date) <= ?';
      params.push(endDate);
    }

    if (platformAccountId) {
      query += ' AND platform_account_id = ?';
      params.push(platformAccountId);
    }

    // 支持状态筛选
    if (status && status !== 'all') {
      const statusMap = {
        'pending': 'Pending',
        '待确认': 'Pending',
        'confirmed': 'Approved',
        '已确认': 'Approved',
        'rejected': 'Rejected',
        '已拒绝': 'Rejected'
      };
      const dbStatus = statusMap[status.toLowerCase()] || status;
      query += ' AND status = ?';
      params.push(dbStatus);
    }

    const stats = db.prepare(query).get(...params);
    console.log(`📊 [统计API] 订单统计查询结果:`, stats);
    console.log(`📊 [统计API] 查询参数:`, { startDate, endDate, platformAccountId, userId: req.user.id });

    // 计算总预算：按日期和广告系列分组，每个广告系列每天只算一次预算
    // 只计算在日期范围内有数据的天数
    let budgetQuery = `
      SELECT
        SUM(campaign_budget) as total_budget
      FROM (
        SELECT 
          date,
          campaign_name,
          MAX(campaign_budget) as campaign_budget,
          MAX(currency) as currency
        FROM google_ads_data
        WHERE user_id = ?
          AND campaign_name IS NOT NULL 
          AND campaign_name != ''
          AND campaign_budget IS NOT NULL
          AND campaign_budget > 0
    `;
    const budgetParams = [req.user.id];

    if (startDate) {
      budgetQuery += ' AND date >= ?';
      budgetParams.push(startDate);
    }

    if (endDate) {
      budgetQuery += ' AND date <= ?';
      budgetParams.push(endDate);
    }

    // 如果提供了平台账号ID，需要根据affiliate_name过滤
    if (platformAccountId) {
      const account = db.prepare('SELECT affiliate_name FROM platform_accounts WHERE id = ? AND user_id = ?').get(platformAccountId, req.user.id);
      if (account && account.affiliate_name) {
        budgetQuery += ' AND LOWER(affiliate_name) = LOWER(?)';
        budgetParams.push(account.affiliate_name);
      }
    }

    budgetQuery += `
        GROUP BY date, campaign_name
        ) AS daily_campaign_budgets
    `;

    const budgetStats = db.prepare(budgetQuery).get(...budgetParams);
    stats.total_budget = budgetStats?.total_budget || 0;
    
    console.log(`📊 [统计API] 预算统计查询结果:`, budgetStats);
    console.log(`📊 [统计API] 最终返回数据:`, stats);

    res.json({ success: true, data: stats });
  } catch (error) {
    console.error('获取统计错误:', error);
    res.json({ success: false, message: '获取失败: ' + error.message });
  }
});
/**
 * 分析函数：计算广告系列的分析指标和建议
 */
function analyzeCampaign(data, dailyData, config) {
  const {
    total_impressions = 0,
    total_clicks = 0,
    total_cost = 0,
    total_commission = 0,
    order_count = 0,
    total_budget = 0,
    avg_lost_is_budget = 0,
    avg_lost_is_rank = 0
  } = data;

  // ========== 1. 基础指标计算 ==========
  const ctr = total_impressions > 0 ? (total_clicks / total_impressions * 100) : 0;
  const cpc = total_clicks > 0 ? (total_cost / total_clicks) : 0;
  const cvr = total_clicks > 0 ? (order_count / total_clicks * 100) : 0;
  const cpa = order_count > 0 ? (total_cost / order_count) : 0;
  const roas = total_cost > 0 ? (total_commission / total_cost) : (total_commission > 0 ? Infinity : 0); // 如果cost=0但commission>0，ROAS为无穷大
  const profit = total_commission - total_cost;
  const profitMargin = total_commission > 0 ? (profit / total_commission * 100) : 0;
  const avgCommission = order_count > 0 ? (total_commission / order_count) : 0;
  const budgetUtilization = total_budget > 0 ? (total_cost / total_budget) : 0;

  // 标准化 LostIS 单位（确保是百分比格式 0-100）
  // 规范化丢失展示份额百分比：确保值在 0-100 之间
  let lostISPercent = (parseFloat(avg_lost_is_budget) || 0);
  if (lostISPercent <= 1) {
    lostISPercent = lostISPercent * 100;
  }
  lostISPercent = Math.max(0, Math.min(100, lostISPercent));
  
  let lostISRankPercent = (parseFloat(avg_lost_is_rank) || 0);
  if (lostISRankPercent <= 1) {
    lostISRankPercent = lostISRankPercent * 100;
  }
  lostISRankPercent = Math.max(0, Math.min(100, lostISRankPercent));

  // 处理ROAS为无穷大的情况（有佣金但没有广告成本）
  const validRoas = isFinite(roas) ? roas : 999; // 用999表示极高ROAS

  // ========== 2. 样本充分性检查 ==========
  const isLowSample = order_count < config.minOrders || total_clicks < config.minClicks;
  // ========== 3. 多指标趋势分析（线性回归斜率 + 最近趋势检测） ==========
  // 计算多个关键指标的趋势：CTR, CPC, CVR, ROAS
  const calculateTrend = (values) => {
    if (!values || values.length < 3) return { trend: 'stable', slope: 0 };
    
    const n = values.length;
    const x = Array.from({ length: n }, (_, i) => i + 1);
    const xMean = x.reduce((a, b) => a + b, 0) / n;
    const yMean = values.reduce((a, b) => a + b, 0) / n;

    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < n; i++) {
      numerator += (x[i] - xMean) * (values[i] - yMean);
      denominator += Math.pow(x[i] - xMean, 2);
    }

    const slope = denominator > 0 ? (numerator / denominator) : 0;
    
    // 🔥 新增：检查最近趋势（优先考虑最近数据的变化）
    // 如果最后一天相比前一天下降超过50%，判断为下降
    let recentTrend = 'stable';
    if (n >= 2) {
      const lastValue = values[n - 1];
      const prevValue = values[n - 2];
      if (prevValue > 0) {
        const changePercent = ((lastValue - prevValue) / prevValue) * 100;
        if (changePercent < -50) {
          // 最后一天暴跌超过50%，判断为下降
          recentTrend = 'falling';
        } else if (changePercent > 30) {
          // 最后一天大幅上升超过30%，判断为上升
          recentTrend = 'rising';
        }
      }
    }
    
    // 🔥 如果最近趋势明显下降，优先使用最近趋势；否则使用整体趋势
    let trend = 'stable';
    if (recentTrend === 'falling') {
      trend = 'falling';
    } else if (recentTrend === 'rising') {
      trend = 'rising';
    } else {
      // 使用整体线性回归趋势
    if (slope > config.trendThreshold) {
      trend = 'rising';
    } else if (slope < -config.trendThreshold) {
      trend = 'falling';
      }
    }
    
    return { trend, slope };
  };

  let trend = 'stable';
  let trendSlope = 0;
  let trends = {
    roas: { trend: 'stable', slope: 0 },
    ctr: { trend: 'stable', slope: 0 },
    cpc: { trend: 'stable', slope: 0 },
    cvr: { trend: 'stable', slope: 0 }
  };

  if (dailyData && dailyData.length >= 3) {
    // 计算ROAS趋势
    const roasValues = dailyData.map(d => {
      const cost = d.cost || 0;
      const commission = d.commission || 0;
      return cost > 0 ? (commission / cost) : 0;
    });
    trends.roas = calculateTrend(roasValues);
    trend = trends.roas.trend;
    trendSlope = trends.roas.slope;

    // 计算CTR趋势
    const ctrValues = dailyData.map(d => {
      const impressions = d.impressions || 0;
      const clicks = d.clicks || 0;
      return impressions > 0 ? (clicks / impressions * 100) : 0;
    });
    trends.ctr = calculateTrend(ctrValues);

    // 计算CPC趋势
    const cpcValues = dailyData.map(d => {
      const clicks = d.clicks || 0;
      const cost = d.cost || 0;
      return clicks > 0 ? (cost / clicks) : 0;
    });
    trends.cpc = calculateTrend(cpcValues);

    // 计算CVR趋势
    const cvrValues = dailyData.map(d => {
      const clicks = d.clicks || 0;
      const orderCount = d.order_count || 0;
      return clicks > 0 ? (orderCount / clicks * 100) : 0;
    });
    trends.cvr = calculateTrend(cvrValues);
  }

  // ========== 4. 波动性计算（变异系数） ==========
  let volatility = 'low';
  if (dailyData && dailyData.length >= 3) {
    const roasValues = dailyData.map(d => {
      const cost = d.cost || 0;
      const commission = d.commission || 0;
      return cost > 0 ? (commission / cost) : 0;
    });
    const mean = roasValues.reduce((a, b) => a + b, 0) / roasValues.length;
    const variance = roasValues.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / roasValues.length;
    const stdDev = Math.sqrt(variance);
    const coefficientOfVariation = mean > 0 ? (stdDev / mean) : 0;
    
    if (coefficientOfVariation > config.volatilityThreshold) {
      volatility = 'high';
    }
  }

  // ========== 5. 异常检测 ==========
  let hasAnomaly = false;
  if (dailyData && dailyData.length >= 2) {
    const roasValues = dailyData.map(d => {
      const cost = d.cost || 0;
      const commission = d.commission || 0;
      return cost > 0 ? (commission / cost) : 0;
    });
    const avgRoas = roasValues.reduce((a, b) => a + b, 0) / roasValues.length;
    hasAnomaly = roasValues.some(roas => Math.abs(roas - avgRoas) / avgRoas > config.anomalyThreshold);
  }

  // ========== 6. 增量估算（当LostIS% >= 15%时） ==========
  let incrementalAnalysis = null;
  if (lostISPercent >= config.lostISThreshold) {
    const lostISRatio = lostISPercent / 100;
    const potentialImpressions = total_impressions / (1 - lostISRatio);
    const incrementalImpressions = potentialImpressions - total_impressions;
    const incrementalClicks = incrementalImpressions * (ctr / 100);
    const incrementalOrders = incrementalClicks * (cvr / 100);
    const incrementalCommission = incrementalOrders * avgCommission;
    const incrementalCost = incrementalClicks * cpc;
    const incrementalROAS = incrementalCost > 0 ? (incrementalCommission / incrementalCost) : 0;

    incrementalAnalysis = {
      potentialImpressions,
      incrementalImpressions,
      incrementalClicks,
      incrementalOrders,
      incrementalCommission,
      incrementalCost,
      incrementalROAS
    };
  }

  // ========== 7. 规则引擎（多维度决策） ==========
  let suggestion = '建议维持';
  let confidence = '中';
  let reason = '表现中等，建议继续观察';
  let budgetIncrease = null;
  let optimizationHint = null;
  let optimizationType = null; // 优化类型：'creative', 'bidding', 'stability', 'general'

  // 计算信心等级（基于样本和波动性）
  const calculateConfidence = () => {
    if (isLowSample || volatility === 'high') {
      return '低';
    } else if (volatility === 'low' && !isLowSample && order_count >= 10 && total_clicks >= 200) {
      return '高';
    }
    return '中';
  };

  const buildMetrics = () => ({
    ctr: parseFloat(ctr.toFixed(2)),
    cpc: parseFloat(cpc.toFixed(4)),
    cvr: parseFloat(cvr.toFixed(2)),
    cpa: parseFloat(cpa.toFixed(2)),
    roas: parseFloat((isFinite(roas) ? roas : 0).toFixed(2)),
    profit: parseFloat(profit.toFixed(2)),
    profitMargin: parseFloat(profitMargin.toFixed(2)),
    avgCommission: parseFloat(avgCommission.toFixed(2)),
    budgetUtilization: parseFloat(budgetUtilization.toFixed(2)),
    lostISBudget: parseFloat(lostISPercent.toFixed(2)),
    lostISRank: parseFloat(lostISRankPercent.toFixed(2)),
    trend,
    trendSlope: parseFloat(trendSlope.toFixed(4)),
    trends: {
      roas: trends.roas,
      ctr: trends.ctr,
      cpc: trends.cpc,
      cvr: trends.cvr
    },
    volatility,
    isLowSample,
    hasAnomaly,
    incrementalAnalysis
  });

  // ========== 决策规则引擎 ==========
  // 按照新策略：暂停、维持、加预算三类建议

  // 2. 异常检测（记录但不直接建议）
  if (hasAnomaly) {
    optimizationHint = '单日ROAS异常波动，建议检查外部因素（如促销或竞争）';
  }

  // 3. 暂停条件（优先级最高，即使样本不足也要检查）
  // 规则1：ROAS <1，且趋势下降，且非预算受限 (LostIS% < 10%)
  // 规则2：CPA > 单笔佣金 * 0.5，且 CVR < 1% (低转化)
  if ((validRoas < config.roasMedium && trend === 'falling' && lostISPercent < 10) ||
      (cpa > avgCommission * 0.5 && cvr < config.cvrLow)) {
    suggestion = '建议暂停';
    confidence = trend === 'falling' ? '高' : '中';
    reason = `盈利性差（ROAS低于${config.roasMedium}且趋势下降且非预算受限，或CPA过高且转化率低），继续投放可能亏损`;
    return { suggestion, confidence, reason, budgetIncrease, optimizationHint, optimizationType, metrics: buildMetrics() };
  }

  // 4. 增加预算条件（优先级最高，即使样本不足也要检查）
  // 4.1 规则1：LostIS% ≥ 15%，且 ROAS ≥ 2，且趋势上升，且增量ROAS ≥ 目标ROAS (默认2)
  if (lostISPercent >= config.lostISThreshold && 
      validRoas >= config.roasGood && 
      trend === 'rising' && 
      incrementalAnalysis && 
      incrementalAnalysis.incrementalROAS >= config.roasGood) {
    const increasePercent = Math.min(lostISPercent * 0.5, 50);
    suggestion = '建议增加预算';
    confidence = '高';
    reason = '预算受限导致机会损失，且盈利潜力高（LostIS≥15%、ROAS≥2、趋势上升、增量ROAS≥目标）';
    budgetIncrease = Math.round(increasePercent);
    return { suggestion, confidence, reason, budgetIncrease, optimizationHint, optimizationType, metrics: buildMetrics() };
  }

  // 4.2 规则2：点击量不足时建议增加预算（辅助判断，即使样本不足也要检查）
  // 计算最近7天平均点击
  let avgDailyClicks = 0;
  if (dailyData && dailyData.length > 0) {
    // 取最近7天的数据，如果不足7天则取全部
    const recentDays = dailyData.slice(-7);
    const totalRecentClicks = recentDays.reduce((sum, d) => sum + (d.clicks || 0), 0);
    avgDailyClicks = totalRecentClicks / recentDays.length;
  } else {
    // 如果没有每日数据，使用总点击数除以天数（假设是7天）
    avgDailyClicks = total_clicks / 7;
  }

  // 点击量不足的判断条件：
  // 1. 平均点击 < 50
  // 2. 预算利用率 > 80%（预算快用完了）
  // 3. LostIS% (预算) > 15%（预算受限）
  // 4. ROAS要求：根据LostIS%和样本情况动态调整
  //    - 如果LostIS% >= 30%（严重受限），ROAS >= 0.5即可（允许小幅亏损，因为可能是预算不足导致）
  //    - 如果样本不足，ROAS >= 0.8（避免严重亏损）
  //    - 否则，ROAS >= 1.5（需要盈利）
  // 5. 趋势稳定或上升（不是下降）
  const minClicksThreshold = 50; // 可配置的点击量阈值
  const minBudgetUtilization = 0.8; // 预算利用率阈值
  // 根据LostIS%和样本情况动态调整ROAS要求
  let minRoasForClickIncrease = 1.5; // 默认要求ROAS >= 1.5
  if (lostISPercent >= 30) {
    // LostIS%很高（>=30%），严重预算受限，降低ROAS要求到0.5
    minRoasForClickIncrease = 0.5;
  } else if (isLowSample) {
    // 样本不足时，降低ROAS要求到0.8
    minRoasForClickIncrease = 0.8;
  }

  // 计算最近3天的预算受限情况
  let recentLostISValues = [];
  if (dailyData && dailyData.length > 0) {
    const recentLostISDays = dailyData.slice(-3);
    recentLostISValues = recentLostISDays.map(d => {
      let val = parseFloat(d.lost_is_budget) || 0;
      if (val <= 1) {
        val = val * 100;
      }
      return Math.max(0, val);
    });
  }
  const recentLostISBelowThreshold =
    recentLostISValues.length > 0 &&
    recentLostISValues.every(val => val < config.lostISThreshold);

  if (!recentLostISBelowThreshold &&
      avgDailyClicks < minClicksThreshold &&
      budgetUtilization > minBudgetUtilization &&
      lostISPercent >= config.lostISThreshold &&
      validRoas >= minRoasForClickIncrease &&
      (trend === 'stable' || trend === 'rising')) {
    
    // 计算需要增加的预算：(50 - 平均点击) * CPC
    const clicksNeeded = minClicksThreshold - avgDailyClicks;
    const additionalBudget = clicksNeeded * cpc;
    
    // 计算增加预算的百分比，但不超过当前预算的50%
    let increasePercent = 0;
    if (total_budget > 0) {
      increasePercent = (additionalBudget / total_budget) * 100;
      increasePercent = Math.min(increasePercent, 50); // 最多增加50%
    }
    
    // 如果计算出的增加预算百分比 >= 5%，才建议增加预算
    if (increasePercent >= 5) {
      suggestion = '建议增加预算';
      confidence = isLowSample ? '低' : '中'; // 样本不足时降低信心
      const sampleNote = isLowSample ? `（样本量不足，但预算受限明显）` : '';
      reason = `点击量不足（平均${avgDailyClicks.toFixed(1)}个/天，目标50个/天），预算利用率高（${(budgetUtilization * 100).toFixed(1)}%），且预算受限（LostIS${lostISPercent.toFixed(1)}%）${sampleNote}，建议增加预算以获取更多点击`;
      budgetIncrease = Math.round(increasePercent);
      return { suggestion, confidence, reason, budgetIncrease, optimizationHint, optimizationType, metrics: buildMetrics() };
    }
  }

  // 1. 样本不足检查（在增加预算条件之后，如果都不满足才检查样本）
  if (isLowSample) {
    // 样本不足时，如果趋势稳定/上升，建议维持；否则继续监测
    if (trend === 'stable' || trend === 'rising') {
      suggestion = '建议维持';
      confidence = '低';
      reason = `样本量不足（订单${order_count}个，点击${total_clicks}次），但趋势良好，建议继续观察`;
      return { suggestion, confidence, reason, budgetIncrease, optimizationHint, optimizationType, metrics: buildMetrics() };
    } else {
      suggestion = '继续监测';
      confidence = '低';
      reason = `样本量不足（订单${order_count}个，点击${total_clicks}次），建议继续收集数据`;
      return { suggestion, confidence, reason, budgetIncrease, optimizationHint, optimizationType, metrics: buildMetrics() };
    }
  }

  // 5. 其他优化策略（作为"建议维持"的优化提示）
  // 5.1 LostIS%高但ROAS<1.0：先优化，再评估加预算
  if (lostISPercent >= config.lostISThreshold && validRoas < config.roasMedium) {
    suggestion = '建议维持';
    confidence = calculateConfidence();
    optimizationType = 'general';
    reason = '预算受限但ROAS偏低，建议先优化广告质量（提升质量分、优化着陆页、添加否词）再考虑加预算';
    optimizationHint = '预算受限但ROAS偏低，建议先优化广告质量（提升质量分、优化着陆页、添加否词）再考虑加预算';
    return { suggestion, confidence, reason, budgetIncrease, optimizationHint, optimizationType, metrics: buildMetrics() };
  }

  // 5.2 CTR < 2%：优化创意/关键词相关性
  if (ctr < config.ctrLow) {
    suggestion = '建议维持';
    confidence = calculateConfidence();
    optimizationType = 'creative';
    optimizationHint = 'CTR偏低，建议优化创意/关键词相关性（AB测试文案、添加长尾关键词）';
    reason = optimizationHint;
    return { suggestion, confidence, reason, budgetIncrease, optimizationHint, optimizationType, metrics: buildMetrics() };
  }

  // 5.3 高波动：改为放到决策链末尾的兜底提示（不在此处返回）

  // 6. 维持条件
  // 规则：ROAS 在 1–1.9 之间，或样本不足，且趋势稳定/轻微上升 → 建议维持
  if (validRoas >= config.roasMedium && validRoas < config.roasGood) {
    // ROAS在1-1.9之间，如果趋势稳定或上升，建议维持
    if (trend === 'stable' || trend === 'rising') {
        suggestion = '建议维持';
        confidence = calculateConfidence();
        reason = '表现中等，需观察更多数据';
      
      // 一般优化库：基于搜索词报告添加否词；提升质量分以降低CPC；优化着陆页以提高CVR
        const generalTips = [];
        if (cpc > (config.cpcMedium || 0.03)) generalTips.push('提升质量分以降低CPC');
        if (cvr < (config.cvrMedium || 2.0)) generalTips.push('优化着陆页以提高CVR');
        if (ctr < (config.ctrMedium || 3.0)) generalTips.push('基于搜索词报告添加否词');
      
      if (generalTips.length > 0) {
        optimizationHint = generalTips.join('；');
        optimizationType = 'general';
      }
      
      return { suggestion, confidence, reason, budgetIncrease, optimizationHint, optimizationType, metrics: buildMetrics() };
    } else {
      // ROAS在1-1.9之间但趋势下降，建议维持但降低信心
        suggestion = '建议维持';
        confidence = '低';
        reason = 'ROAS在合理范围但趋势下降，建议密切观察';
      return { suggestion, confidence, reason, budgetIncrease, optimizationHint, optimizationType, metrics: buildMetrics() };
    }
  }

  // 7. 处理其他边界情况
  // 7.1 ROAS >= 2.0 但没有满足增加预算条件
  if (validRoas >= config.roasGood && !budgetIncrease) {
      suggestion = '建议维持';
      confidence = calculateConfidence();
    reason = trend === 'falling' ? 'ROAS优秀但趋势下降，建议检查原因并优化' : 'ROAS优秀，建议继续保持当前表现';
    if (trend === 'falling') {
      optimizationType = 'general';
      optimizationHint = 'ROAS优秀但趋势下降，建议检查原因并优化';
    }
    return { suggestion, confidence, reason, budgetIncrease, optimizationHint, optimizationType, metrics: buildMetrics() };
  }

  // 7.2 ROAS < 1.0 但趋势不是下降，且LostIS% < 10%（不满足暂停条件）
  if (validRoas < config.roasMedium && trend !== 'falling' && lostISPercent < 10) {
    suggestion = '建议维持';
    confidence = calculateConfidence();
    optimizationType = 'general';
    reason = 'ROAS偏低但趋势良好，建议优化广告质量以提升ROAS（提升质量分、优化着陆页、添加否词）';
    optimizationHint = '基于搜索词报告添加否词；提升质量分以降低CPC；优化着陆页以提高CVR';
    return { suggestion, confidence, reason, budgetIncrease, optimizationHint, optimizationType, metrics: buildMetrics() };
  }
  
  // 7.3 默认维持（兜底）
  suggestion = '建议维持';
  confidence = calculateConfidence();
  reason = '表现中等，需观察更多数据';
  optimizationHint = '基于搜索词报告添加否词；提升质量分以降低CPC；优化着陆页以提高CVR';
  optimizationType = 'general';

  return { suggestion, confidence, reason, budgetIncrease, optimizationHint, optimizationType, metrics: buildMetrics() };
}
/**
 * API: 获取商家汇总数据（包含广告数据）
 * GET /api/merchant-summary
 */
app.get('/api/merchant-summary', authenticateToken, (req, res) => {
  try {
    const { startDate, endDate, platformAccountIds, showStatus } = req.query;

    const parsedAccountIds = platformAccountIds
      ? platformAccountIds.split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id))
      : [];

    let selectedAffiliateNamesLower = [];
    if (parsedAccountIds.length > 0) {
      const placeholders = parsedAccountIds.map(() => '?').join(',');
      selectedAffiliateNamesLower = db.prepare(`
        SELECT DISTINCT affiliate_name FROM platform_accounts
        WHERE id IN (${placeholders}) AND user_id = ?
      `).all(...parsedAccountIds, req.user.id)
        .map(row => row.affiliate_name)
        .filter(name => name)
        .map(name => name.toLowerCase());

      if (selectedAffiliateNamesLower.length > 0) {
        console.log(`📊 过滤广告数据：只显示 affiliate_name 为 [${selectedAffiliateNamesLower.join(', ')}] 的数据`);
      }
    }

    // 第一步：获取订单汇总（关联平台账号获取affiliate_name，使用merchant_slug）
    let orderQuery = `
      SELECT
        o.merchant_id,
        o.merchant_name,
        o.merchant_slug,
        LOWER(COALESCE(pa.affiliate_name, '')) as affiliate_name,
        COUNT(*) as order_count,
        SUM(o.order_amount) as total_amount,
        SUM(CASE WHEN UPPER(TRIM(o.status)) IN ('APPROVED', 'PENDING') THEN o.commission ELSE 0 END) as total_commission,
        SUM(CASE WHEN UPPER(TRIM(o.status)) = 'APPROVED' THEN o.commission ELSE 0 END) as confirmed_commission,
        SUM(CASE WHEN UPPER(TRIM(o.status)) = 'PENDING' THEN o.commission ELSE 0 END) as pending_commission,
        SUM(CASE WHEN UPPER(TRIM(o.status)) = 'REJECTED' THEN o.commission ELSE 0 END) as rejected_commission
      FROM orders o
      LEFT JOIN platform_accounts pa ON o.platform_account_id = pa.id
      WHERE o.user_id = ?
    `;
    const orderParams = [req.user.id];

    if (startDate) {
      orderQuery += ' AND DATE(o.order_date) >= ?';
      orderParams.push(startDate);
    }

    if (endDate) {
      orderQuery += ' AND DATE(o.order_date) <= ?';
      orderParams.push(endDate);
    }

    // 支持多账号ID过滤（逗号分隔的字符串）
    if (parsedAccountIds.length > 0) {
      const placeholders = parsedAccountIds.map(() => '?').join(',');
        orderQuery += ` AND o.platform_account_id IN (${placeholders})`;
      orderParams.push(...parsedAccountIds);
    }

    orderQuery += " GROUP BY o.user_id, LOWER(COALESCE(pa.affiliate_name, '')), o.merchant_id ORDER BY total_commission DESC";

    const orderSummary = db.prepare(orderQuery).all(...orderParams);
    console.log(`📊 订单汇总查询结果: ${orderSummary.length} 个商家`);
    console.log(`📊 订单汇总查询SQL: ${orderQuery}`);
    console.log(`📊 订单汇总查询参数:`, orderParams);
    if (orderSummary.length > 0) {
      console.log('样例商家:', JSON.stringify(orderSummary[0], null, 2));
      // 🔍 调试：检查所有订单汇总数据
      orderSummary.forEach((order, index) => {
        if (order.order_count > 0) {
          console.log(`📊 订单汇总[${index}]:`, {
            merchant_id: order.merchant_id,
            merchant_name: order.merchant_name,
            affiliate_name: order.affiliate_name,
            affiliate_name_type: typeof order.affiliate_name,
            affiliate_name_is_null: order.affiliate_name === null,
            order_count: order.order_count,
            total_commission: order.total_commission,
            confirmed_commission: order.confirmed_commission,
            pending_commission: order.pending_commission
          });
        }
      });
      // 🔍 调试：检查订单状态和佣金（针对有订单但佣金为0的情况）
      orderSummary.forEach(order => {
        if (order.order_count > 0 && (!order.total_commission || order.total_commission === 0)) {
          // 检查所有订单（不限制状态）
          const debugQuery1 = `
            SELECT 
              o.merchant_id,
              o.status,
              COUNT(*) as count,
              SUM(o.commission) as total_commission_raw,
              SUM(CASE WHEN UPPER(TRIM(o.status)) IN ('APPROVED', 'PENDING') THEN o.commission ELSE 0 END) as total_commission_filtered
            FROM orders o
            LEFT JOIN platform_accounts pa ON o.platform_account_id = pa.id
            WHERE o.user_id = ? AND o.merchant_id = ? 
              AND (LOWER(pa.affiliate_name) = LOWER(?) OR (pa.affiliate_name IS NULL AND ? IS NULL))
            GROUP BY o.merchant_id, o.status
          `;
          const debugResult1 = db.prepare(debugQuery1).all(req.user.id, order.merchant_id, order.affiliate_name || null, order.affiliate_name || null);
          console.log(`🔍 商家 ${order.merchant_name}(${order.merchant_id}, ${order.affiliate_name}) 订单状态调试:`, JSON.stringify(debugResult1, null, 2));
          
          // 检查日期范围内的订单
          let debugQuery2 = `
            SELECT 
              DATE(o.order_date) as order_date,
              o.status,
              COUNT(*) as count,
              SUM(o.commission) as total_commission_raw,
              SUM(CASE WHEN UPPER(TRIM(o.status)) IN ('APPROVED', 'PENDING') THEN o.commission ELSE 0 END) as total_commission_filtered
            FROM orders o
            LEFT JOIN platform_accounts pa ON o.platform_account_id = pa.id
            WHERE o.user_id = ? AND o.merchant_id = ? 
              AND (LOWER(pa.affiliate_name) = LOWER(?) OR (pa.affiliate_name IS NULL AND ? IS NULL))
          `;
          const debugParams2 = [req.user.id, order.merchant_id, order.affiliate_name || null, order.affiliate_name || null];
          if (startDate) {
            debugQuery2 += ' AND DATE(o.order_date) >= ?';
            debugParams2.push(startDate);
          }
          if (endDate) {
            debugQuery2 += ' AND DATE(o.order_date) <= ?';
            debugParams2.push(endDate);
          }
          debugQuery2 += ' GROUP BY DATE(o.order_date), o.status ORDER BY order_date DESC LIMIT 10';
          const debugResult2 = db.prepare(debugQuery2).all(...debugParams2);
          console.log(`🔍 商家 ${order.merchant_name}(${order.merchant_id}, ${order.affiliate_name}) 日期范围内订单调试:`, JSON.stringify(debugResult2, null, 2));
        }
      });
    }

    // 第二步：获取广告数据汇总（按merchant_id + affiliate_name分组）
    // 预算取日期范围内最新日期的值（而不是固定某天），展示/点击/广告费取日期范围内累计
    // 注意：广告费数据已统一存储为USD（采集时CNY按汇率7.13转换）
    let adsQuery = `
      SELECT
        merchant_id,
        LOWER(affiliate_name) as affiliate_name,
        GROUP_CONCAT(DISTINCT campaign_name) as campaign_names,
        MAX(campaign_budget) as total_budget,
        MAX(currency) as currency,
        SUM(impressions) as total_impressions,
        SUM(clicks) as total_clicks,
        SUM(cost) as total_cost,
        COALESCE(AVG(lost_impression_share_budget), 0) as avg_lost_is_budget,
        COALESCE(AVG(lost_impression_share_rank), 0) as avg_lost_is_rank,
        MAX(date) as last_data_date
      FROM google_ads_data
      WHERE user_id = ? AND campaign_name IS NOT NULL AND campaign_name != ''
    `;
    const adsParams = [req.user.id];

    if (startDate) {
      adsQuery += ' AND date >= ?';
      adsParams.push(startDate);
    }

    if (endDate) {
      adsQuery += ' AND date <= ?';
      adsParams.push(endDate);
    }

    // 🔥 新增：根据选中的平台账号过滤affiliate_name（转小写比较）
    if (selectedAffiliateNamesLower.length > 0) {
      const affiliatePlaceholders = selectedAffiliateNamesLower.map(() => '?').join(',');
          adsQuery += ` AND LOWER(affiliate_name) IN (${affiliatePlaceholders})`;
      adsParams.push(...selectedAffiliateNamesLower);
    }

    adsQuery += ' GROUP BY merchant_id, LOWER(affiliate_name)';

    const adsSummary = db.prepare(adsQuery).all(...adsParams);
    console.log(`📊 广告数据查询结果: ${adsSummary.length} 个商家`);
    if (adsSummary.length > 0) {
      console.log('样例广告商家:', adsSummary[0]);
      console.log('样例丢失展示份额数据:', {
        avg_lost_is_budget: adsSummary[0].avg_lost_is_budget,
        avg_lost_is_rank: adsSummary[0].avg_lost_is_rank,
        type_budget: typeof adsSummary[0].avg_lost_is_budget,
        type_rank: typeof adsSummary[0].avg_lost_is_rank
      });
    }

    // 第三步：判断广告系列状态（活跃/暂停）并过滤
    // 判断逻辑：最近一天（默认昨天，或用户选择的结束日期）预算/展示/点击全为0，则视为暂停
    const getYesterdayDateString = () => {
      const date = new Date();
      date.setDate(date.getDate() - 1);
      return date.toISOString().split('T')[0];
    };
    const statusDate = endDate || getYesterdayDateString();
    console.log(`📊 状态判定基准日期：${statusDate}`);

    let lastDayActivityQuery = `
      SELECT
          merchant_id,
        LOWER(affiliate_name) as affiliate_name,
        MAX(campaign_budget) as last_day_budget,
        SUM(impressions) as last_day_impressions,
        SUM(clicks) as last_day_clicks
        FROM google_ads_data
        WHERE user_id = ? AND date = ? AND campaign_name IS NOT NULL AND campaign_name != ''
      `;
    const lastDayActivityParams = [req.user.id, statusDate];

    if (selectedAffiliateNamesLower.length > 0) {
      const affiliatePlaceholders = selectedAffiliateNamesLower.map(() => '?').join(',');
      lastDayActivityQuery += ` AND LOWER(affiliate_name) IN (${affiliatePlaceholders})`;
      lastDayActivityParams.push(...selectedAffiliateNamesLower);
          }

    lastDayActivityQuery += ' GROUP BY merchant_id, LOWER(affiliate_name)';
    const lastDayActivityRows = db.prepare(lastDayActivityQuery).all(...lastDayActivityParams);
    console.log(`📊 最近一天(${statusDate})广告数据：${lastDayActivityRows.length} 条`);

    const buildMerchantKey = (affiliateName, merchantId) => {
      const merchantIdStr = String(merchantId || '');
      return `${req.user.id}_${(affiliateName || '').toLowerCase()}_${merchantIdStr}`;
    };

    const lastDayMetricsMap = new Map();
    lastDayActivityRows.forEach(row => {
      lastDayMetricsMap.set(buildMerchantKey(row.affiliate_name, row.merchant_id), {
        last_day_budget: row.last_day_budget || 0,
        last_day_impressions: row.last_day_impressions || 0,
        last_day_clicks: row.last_day_clicks || 0
      });
    });

    const statusCache = new Map();
    const resolveStatus = (affiliateName, merchantId) => {
      const key = buildMerchantKey(affiliateName, merchantId);
      if (statusCache.has(key)) {
        return statusCache.get(key);
      }
      
      const metrics = lastDayMetricsMap.get(key);
      let status = 'paused';
      if (metrics) {
        const hasActivity =
          (Number(metrics.last_day_budget) || 0) > 0 ||
          (Number(metrics.last_day_impressions) || 0) > 0 ||
          (Number(metrics.last_day_clicks) || 0) > 0;
        status = hasActivity ? 'active' : 'paused';
      }

      statusCache.set(key, status);
      return status;
    };
    
    // 过滤广告数据（根据showStatus参数）
    let filteredAdsSummary = adsSummary;
    if (showStatus && showStatus !== 'all') {
      filteredAdsSummary = adsSummary.filter(ads => {
        const status = resolveStatus(ads.affiliate_name, ads.merchant_id);
        if (showStatus === 'active') {
          return status === 'active';
        }
        if (showStatus === 'paused') {
          return status === 'paused';
        }
        return true;
      });
      console.log(`📊 状态过滤：${showStatus}，过滤前: ${adsSummary.length}，过滤后: ${filteredAdsSummary.length}`);
    }
    
    // 为每个广告数据添加状态标识
    filteredAdsSummary.forEach(ads => {
      ads.status = resolveStatus(ads.affiliate_name, ads.merchant_id);
    });

    // 第四步：合并数据（使用user_id + affiliate_name + merchant_id作为复合键）
    const adsMap = new Map();
    filteredAdsSummary.forEach(ads => {
      if (ads.merchant_id && ads.affiliate_name) {
        // 使用 user_id + affiliate_name + merchant_id 作为复合键（统一转小写比较，确保类型一致）
        const adsMerchantId = String(ads.merchant_id || '');
        const key = `${req.user.id}_${(ads.affiliate_name || '').toLowerCase()}_${adsMerchantId}`;
        adsMap.set(key, {
          campaign_names: ads.campaign_names || '',
          total_budget: ads.total_budget || 0,
          total_impressions: ads.total_impressions || 0,
          total_clicks: ads.total_clicks || 0,
          total_cost: ads.total_cost || 0,
          status: ads.status || 'active',
          last_data_date: ads.last_data_date || ''
        });
      }
    });

    // ========== 改进：显示所有数据（订单+广告），完整合并 ==========
    // 🔥 新策略：直接对每个广告数据查询订单数据，不依赖订单汇总查询的结果
    const mergedSummary = [];
    const processedKeys = new Set(); // 防止重复

    console.log(`📊 开始合并数据：订单数据 ${orderSummary.length} 条，广告数据 ${filteredAdsSummary.length} 条`);
    
    // 🔥 直接处理所有广告数据，对每个广告数据都查询订单数据
    filteredAdsSummary.forEach(ads => {
      if (!ads.merchant_id || !ads.affiliate_name) {
        return; // 跳过无效数据
      }

      const adsMerchantId = String(ads.merchant_id || '');
      const key = `${req.user.id}_${(ads.affiliate_name || '').toLowerCase()}_${adsMerchantId}`;
      
      if (processedKeys.has(key)) {
        return; // 已经处理过，跳过
      }
      processedKeys.add(key);

      // 🔥 直接查询订单数据（先尝试 merchant_id + affiliate_name，如果没结果再用 merchant_id）
      // 🔥 确保 merchant_id 类型正确（转换为字符串或数字，取决于数据库中的类型）
      const merchantIdForQuery = ads.merchant_id;
      console.log(`🔍 开始查询商家 ${merchantIdForQuery}(${ads.affiliate_name}) 的订单数据，类型: ${typeof merchantIdForQuery}`);
      
      let findOrderQuery = `
        SELECT 
          COUNT(*) as order_count,
          SUM(o.order_amount) as total_amount,
          SUM(CASE WHEN UPPER(TRIM(o.status)) IN ('APPROVED', 'PENDING') THEN o.commission ELSE 0 END) as total_commission,
          SUM(CASE WHEN UPPER(TRIM(o.status)) = 'APPROVED' THEN o.commission ELSE 0 END) as confirmed_commission,
          SUM(CASE WHEN UPPER(TRIM(o.status)) = 'PENDING' THEN o.commission ELSE 0 END) as pending_commission,
          SUM(CASE WHEN UPPER(TRIM(o.status)) = 'REJECTED' THEN o.commission ELSE 0 END) as rejected_commission,
          SUM(CASE WHEN UPPER(TRIM(o.status)) != 'REJECTED' THEN o.commission ELSE 0 END) as total_commission_non_rejected,
          MAX(o.merchant_name) as merchant_name,
          MAX(o.merchant_slug) as merchant_slug
        FROM orders o
        LEFT JOIN platform_accounts pa ON o.platform_account_id = pa.id
        WHERE o.user_id = ? 
          AND o.merchant_id = ?
          AND LOWER(COALESCE(pa.affiliate_name, '')) = LOWER(COALESCE(?, ''))
      `;
      const findOrderParams = [req.user.id, merchantIdForQuery, ads.affiliate_name || ''];
      if (startDate) {
        findOrderQuery += ' AND DATE(o.order_date) >= ?';
        findOrderParams.push(startDate);
      }
      if (endDate) {
        findOrderQuery += ' AND DATE(o.order_date) <= ?';
        findOrderParams.push(endDate);
      }
      console.log(`🔍 查询SQL: ${findOrderQuery}`);
      console.log(`🔍 查询参数:`, findOrderParams);
      let findOrderResult = db.prepare(findOrderQuery).all(...findOrderParams);
      console.log(`🔍 查询结果:`, JSON.stringify(findOrderResult, null, 2));
      
      // 🔥 如果查询到了订单，但过滤后的佣金为 0，检查非 Rejected 状态的佣金
      if (findOrderResult && findOrderResult.length > 0 && findOrderResult[0].order_count > 0) {
        if ((!findOrderResult[0].total_commission || findOrderResult[0].total_commission === 0) && 
            findOrderResult[0].total_commission_non_rejected > 0) {
          console.log(`⚠️  商家 ${ads.merchant_id}(${ads.affiliate_name})：过滤后佣金为 0，但非 Rejected 佣金为 ${findOrderResult[0].total_commission_non_rejected}，使用非 Rejected 佣金`);
          findOrderResult[0].total_commission = findOrderResult[0].total_commission_non_rejected;
        }
      }
      
      // 🔥 调试：检查订单的实际状态和佣金值
      if (findOrderResult && findOrderResult.length > 0 && findOrderResult[0].order_count > 0) {
        let debugStatusQuery = `
          SELECT 
            o.status,
            COUNT(*) as count,
            SUM(o.commission) as total_commission_raw,
            SUM(CASE WHEN UPPER(TRIM(o.status)) IN ('APPROVED', 'PENDING') THEN o.commission ELSE 0 END) as total_commission_filtered
          FROM orders o
          LEFT JOIN platform_accounts pa ON o.platform_account_id = pa.id
          WHERE o.user_id = ? 
            AND o.merchant_id = ?
            AND LOWER(COALESCE(pa.affiliate_name, '')) = LOWER(COALESCE(?, ''))
        `;
        const debugStatusParams = [req.user.id, merchantIdForQuery, ads.affiliate_name || ''];
        if (startDate) {
          debugStatusQuery += ' AND DATE(o.order_date) >= ?';
          debugStatusParams.push(startDate);
        }
        if (endDate) {
          debugStatusQuery += ' AND DATE(o.order_date) <= ?';
          debugStatusParams.push(endDate);
        }
        debugStatusQuery += ' GROUP BY o.status';
        const debugStatusResult = db.prepare(debugStatusQuery).all(...debugStatusParams);
        console.log(`🔍 商家 ${merchantIdForQuery}(${ads.affiliate_name}) 订单状态详情:`, JSON.stringify(debugStatusResult, null, 2));
        
        // 🔥 如果 total_commission 为 0，检查所有订单的佣金值
        if (findOrderResult[0].total_commission === 0 || !findOrderResult[0].total_commission) {
          let debugCommissionQuery = `
            SELECT 
              o.status,
              o.commission,
              o.order_date,
              COUNT(*) as count
            FROM orders o
            LEFT JOIN platform_accounts pa ON o.platform_account_id = pa.id
            WHERE o.user_id = ? 
              AND o.merchant_id = ?
              AND LOWER(COALESCE(pa.affiliate_name, '')) = LOWER(COALESCE(?, ''))
          `;
          const debugCommissionParams = [req.user.id, merchantIdForQuery, ads.affiliate_name || ''];
          if (startDate) {
            debugCommissionQuery += ' AND DATE(o.order_date) >= ?';
            debugCommissionParams.push(startDate);
          }
          if (endDate) {
            debugCommissionQuery += ' AND DATE(o.order_date) <= ?';
            debugCommissionParams.push(endDate);
          }
          debugCommissionQuery += ' LIMIT 10';
          const debugCommissionResult = db.prepare(debugCommissionQuery).all(...debugCommissionParams);
          console.log(`🔍 商家 ${merchantIdForQuery}(${ads.affiliate_name}) 订单佣金详情（前10条）:`, JSON.stringify(debugCommissionResult, null, 2));
        }
      }
      
      // 🔥 如果使用 affiliate_name 查询没结果，尝试只用 merchant_id 查询
      if (!findOrderResult || findOrderResult.length === 0 || !findOrderResult[0].order_count || findOrderResult[0].order_count === 0) {
        console.log(`⚠️  商家 ${ads.merchant_id}(${ads.affiliate_name})：使用 affiliate_name 查询无结果，尝试只用 merchant_id 查询`);
        let fallbackQuery = `
          SELECT 
            COUNT(*) as order_count,
            SUM(o.order_amount) as total_amount,
            SUM(CASE WHEN UPPER(TRIM(o.status)) IN ('APPROVED', 'PENDING') THEN o.commission ELSE 0 END) as total_commission,
            SUM(CASE WHEN UPPER(TRIM(o.status)) = 'APPROVED' THEN o.commission ELSE 0 END) as confirmed_commission,
            SUM(CASE WHEN UPPER(TRIM(o.status)) = 'PENDING' THEN o.commission ELSE 0 END) as pending_commission,
            SUM(CASE WHEN UPPER(TRIM(o.status)) = 'REJECTED' THEN o.commission ELSE 0 END) as rejected_commission,
            SUM(CASE WHEN UPPER(TRIM(o.status)) != 'REJECTED' THEN o.commission ELSE 0 END) as total_commission_non_rejected,
            MAX(o.merchant_name) as merchant_name,
            MAX(o.merchant_slug) as merchant_slug,
            GROUP_CONCAT(DISTINCT LOWER(COALESCE(pa.affiliate_name, ''))) as affiliate_names
          FROM orders o
          LEFT JOIN platform_accounts pa ON o.platform_account_id = pa.id
          WHERE o.user_id = ? 
            AND o.merchant_id = ?
        `;
        const fallbackParams = [req.user.id, ads.merchant_id];
        if (startDate) {
          fallbackQuery += ' AND DATE(o.order_date) >= ?';
          fallbackParams.push(startDate);
        }
        if (endDate) {
          fallbackQuery += ' AND DATE(o.order_date) <= ?';
          fallbackParams.push(endDate);
        }
        findOrderResult = db.prepare(fallbackQuery).all(...fallbackParams);
        if (findOrderResult && findOrderResult.length > 0 && findOrderResult[0].order_count > 0) {
          console.log(`✅ 商家 ${ads.merchant_id}(${ads.affiliate_name})：使用 merchant_id 查询找到订单数据，订单数 ${findOrderResult[0].order_count}，过滤后佣金 ${findOrderResult[0].total_commission}，非 Rejected 佣金 ${findOrderResult[0].total_commission_non_rejected}，订单中的 affiliate_names: ${findOrderResult[0].affiliate_names}`);
          // 🔥 如果过滤后的佣金为 0，但非 Rejected 佣金 > 0，使用非 Rejected 佣金
          if ((!findOrderResult[0].total_commission || findOrderResult[0].total_commission === 0) && findOrderResult[0].total_commission_non_rejected > 0) {
            console.log(`⚠️  商家 ${ads.merchant_id}(${ads.affiliate_name})：过滤后佣金为 0，但非 Rejected 佣金为 ${findOrderResult[0].total_commission_non_rejected}，使用非 Rejected 佣金`);
            findOrderResult[0].total_commission = findOrderResult[0].total_commission_non_rejected;
          }
        }
      }
      
      const orderData = findOrderResult && findOrderResult.length > 0 ? findOrderResult[0] : {
          order_count: 0,
          total_amount: 0,
          total_commission: 0,
          confirmed_commission: 0,
          pending_commission: 0,
          rejected_commission: 0,
        merchant_name: '',
        merchant_slug: ''
      };
      
      // 🔥 确保 total_commission 不是 null
      const finalCommission = orderData.total_commission !== null && orderData.total_commission !== undefined ? parseFloat(orderData.total_commission) || 0 : 0;
      const finalOrderCount = orderData.order_count !== null && orderData.order_count !== undefined ? parseInt(orderData.order_count) || 0 : 0;
      
      // 🔥 如果订单数 > 0 但佣金为 0，尝试查询所有状态的订单佣金（不限制状态，只用 merchant_id）
      let debugInfo = null;
      if (finalOrderCount > 0 && finalCommission === 0) {
        // 🔥 使用回退查询（只用 merchant_id，不限制 affiliate_name）
        let debugAllStatusQuery = `
          SELECT 
            SUM(CASE WHEN UPPER(TRIM(o.status)) != 'REJECTED' THEN o.commission ELSE 0 END) as total_commission_non_rejected
          FROM orders o
          LEFT JOIN platform_accounts pa ON o.platform_account_id = pa.id
          WHERE o.user_id = ? 
            AND o.merchant_id = ?
        `;
        const debugAllStatusParams = [req.user.id, merchantIdForQuery];
        if (startDate) {
          debugAllStatusQuery += ' AND DATE(o.order_date) >= ?';
          debugAllStatusParams.push(startDate);
        }
        if (endDate) {
          debugAllStatusQuery += ' AND DATE(o.order_date) <= ?';
          debugAllStatusParams.push(endDate);
        }
        const debugAllStatusResult = db.prepare(debugAllStatusQuery).all(...debugAllStatusParams);
        const nonRejectedCommission = debugAllStatusResult && debugAllStatusResult.length > 0 ? parseFloat(debugAllStatusResult[0].total_commission_non_rejected) || 0 : 0;
        
        if (nonRejectedCommission > 0) {
          console.log(`⚠️  商家 ${ads.merchant_id}(${ads.affiliate_name})：订单数 ${finalOrderCount}，但过滤后的佣金为 0，非 Rejected 状态的佣金为 ${nonRejectedCommission}，说明订单状态可能不是 'APPROVED' 或 'PENDING'`);
          // 🔥 如果非 Rejected 状态的佣金 > 0，使用非 Rejected 状态的佣金
          debugInfo = {
            warning: `订单状态可能不是 'APPROVED' 或 'PENDING'，非 Rejected 状态的佣金: ${nonRejectedCommission}`,
            nonRejectedCommission: nonRejectedCommission
          };
          // 🔥 更新佣金数据
          orderData.total_commission = nonRejectedCommission;
          const finalCommissionUpdated = parseFloat(nonRejectedCommission) || 0;
          mergedSummary.push({
            merchant_id: ads.merchant_id,
            merchant_name: orderData.merchant_name || '',
            merchant_slug: orderData.merchant_slug || '',
            affiliate_name: ads.affiliate_name,
            order_count: finalOrderCount,
            total_amount: parseFloat(orderData.total_amount) || 0,
            total_commission: finalCommissionUpdated,
            confirmed_commission: parseFloat(orderData.confirmed_commission) || 0,
            pending_commission: parseFloat(orderData.pending_commission) || 0,
            rejected_commission: parseFloat(orderData.rejected_commission) || 0,
          campaign_names: ads.campaign_names,
          total_budget: ads.total_budget,
          total_impressions: ads.total_impressions,
          total_clicks: ads.total_clicks,
          total_cost: ads.total_cost,
          avg_lost_is_budget: parseFloat(ads.avg_lost_is_budget) || 0,
          avg_lost_is_rank: parseFloat(ads.avg_lost_is_rank) || 0,
          status: ads.status || 'active',
            last_data_date: ads.last_data_date || '',
            _debug: debugInfo
          });
          return; // 跳过下面的 push
        }
      }
      
      if (finalOrderCount > 0) {
        console.log(`✅ 商家 ${ads.merchant_id}(${ads.affiliate_name})：最终订单数据 - 订单数 ${finalOrderCount}，佣金 ${finalCommission}，原始值: ${orderData.total_commission}`);
      } else {
        console.log(`⚠️  商家 ${ads.merchant_id}(${ads.affiliate_name})：未找到订单数据`);
      }
      
      mergedSummary.push({
        merchant_id: ads.merchant_id,
        merchant_name: orderData.merchant_name || '',
        merchant_slug: orderData.merchant_slug || '',
        affiliate_name: ads.affiliate_name,
        order_count: finalOrderCount,
        total_amount: parseFloat(orderData.total_amount) || 0,
        total_commission: finalCommission,
        confirmed_commission: parseFloat(orderData.confirmed_commission) || 0,
        pending_commission: parseFloat(orderData.pending_commission) || 0,
        rejected_commission: parseFloat(orderData.rejected_commission) || 0,
        campaign_names: ads.campaign_names,
        total_budget: ads.total_budget,
        total_impressions: ads.total_impressions,
        total_clicks: ads.total_clicks,
        total_cost: ads.total_cost,
        avg_lost_is_budget: parseFloat(ads.avg_lost_is_budget) || 0,
        avg_lost_is_rank: parseFloat(ads.avg_lost_is_rank) || 0,
        status: ads.status || 'active',
        last_data_date: ads.last_data_date || ''
      });
    });
    
    // 🔥 旧的合并逻辑已移除，现在直接对每个广告数据查询订单数据

    // 🔥 最终过滤：只保留有广告系列名称的数据
    const filteredSummary = mergedSummary.filter(merchant => 
      merchant.campaign_names && 
      merchant.campaign_names.trim() !== '' && 
      merchant.campaign_names !== '-'
    );

    console.log(`📊 最终合并结果: ${mergedSummary.length} 个商家，过滤后: ${filteredSummary.length} 个商家（仅包含有广告系列名称的商家）`);

    // ========== 新增：为每个商家添加分析建议（可选，失败不影响数据返回）==========
    // 配置参数（未来可以从数据库或配置文件中读取）
    const analysisConfig = {
      targetROAS: 1.2, // 目标ROAS（用于一般判断）
      roasGood: 2.0, // 优秀ROAS阈值（用于增加预算判断）
      roasMedium: 1.0, // 中等ROAS阈值（维持范围下限）
      roasMaintainMax: 1.9, // 维持范围上限
      minOrders: 5, // 最少订单数
      minClicks: 100, // 最少点击数
      volatilityThreshold: 0.3, // 波动阈值（变异系数）
      trendThreshold: 0.1, // 趋势阈值（斜率）
      anomalyThreshold: 0.4, // 异常阈值（40%）
      lostISThreshold: 15, // 预算受限阈值（15%）
      ctrLow: 2.0, // 低CTR阈值（2%）
      cvrLow: 1.0, // 低CVR阈值（1%）
      cpcHigh: 0.05, // 高CPC阈值（$0.05）
      cpcMedium: 0.03, // 中等CPC阈值（$0.03）
      cvrMedium: 2.0, // 中等CVR阈值（2%）
      ctrMedium: 3.0 // 中等CTR阈值（3%）
    };

    // 为每个商家添加分析建议（如果失败，只返回默认建议，不影响数据返回）
    const summaryWithAnalysis = filteredSummary.map((merchant) => {
      // 确保有默认的分析字段
      let analysisResult = { suggestion: '继续监测', confidence: '低', reason: '数据加载中' };
      
      try {
        // 确保必要字段存在
        if (!merchant.avg_lost_is_budget) merchant.avg_lost_is_budget = 0;
        if (!merchant.avg_lost_is_rank) merchant.avg_lost_is_rank = 0;
        
        // 获取该商家的每日数据
        const campaignNames = (merchant.campaign_names || '').split(',').map(n => n.trim()).filter(n => n);
        if (campaignNames.length === 0) {
          analysisResult = { suggestion: '继续监测', confidence: '低', reason: '缺少广告系列名称' };
        } else {
          try {
            // 获取第一个广告系列的每日数据（用于趋势分析）
            const dailyQuery = `
              SELECT
                date,
                SUM(impressions) as impressions,
                SUM(clicks) as clicks,
                SUM(cost) as cost,
                MAX(campaign_budget) as budget,
                AVG(lost_impression_share_budget) as lost_is_budget,
                AVG(lost_impression_share_rank) as lost_is_rank
              FROM google_ads_data
              WHERE user_id = ? 
                AND merchant_id = ?
                AND LOWER(affiliate_name) = LOWER(?)
                AND campaign_name IN (${campaignNames.map(() => '?').join(',')})
                AND date >= ?
                AND date <= ?
              GROUP BY date
              ORDER BY date ASC
            `;

            const dailyParams = [req.user.id, merchant.merchant_id, merchant.affiliate_name, ...campaignNames, startDate || '', endDate || ''];
            const dailyAdsDataRaw = db.prepare(dailyQuery).all(...dailyParams);
            const dailyAdsData = dailyAdsDataRaw.map(row => ({
              ...row,
              lost_is_budget: parseFloat(row.lost_is_budget) || 0,
              lost_is_rank: parseFloat(row.lost_is_rank) || 0
            }));

            // 获取每日订单数据（只包含已确认和待确认的佣金）
            const dailyOrdersQuery = `
              SELECT
                DATE(order_date) as date,
                COUNT(*) as order_count,
                SUM(CASE WHEN UPPER(TRIM(o.status)) IN ('APPROVED', 'PENDING') THEN o.commission ELSE 0 END) as commission
              FROM orders o
              LEFT JOIN platform_accounts pa ON o.platform_account_id = pa.id
              WHERE o.user_id = ?
                AND o.merchant_id = ?
                AND LOWER(COALESCE(pa.affiliate_name, '')) = LOWER(COALESCE(?, ''))
                AND DATE(o.order_date) >= ?
                AND DATE(o.order_date) <= ?
              GROUP BY DATE(o.order_date)
              ORDER BY DATE(o.order_date) ASC
            `;

            const dailyOrdersParams = [req.user.id, merchant.merchant_id, merchant.affiliate_name || '', startDate || '', endDate || ''];
            const dailyOrdersData = db.prepare(dailyOrdersQuery).all(...dailyOrdersParams);

            // 合并每日数据
            const dailyMap = new Map();
            dailyAdsData.forEach(ad => {
              dailyMap.set(ad.date, {
                ...ad,
                order_count: 0,
                commission: 0
              });
            });
            dailyOrdersData.forEach(order => {
              const date = order.date;
              if (dailyMap.has(date)) {
                dailyMap.get(date).order_count = order.order_count || 0;
                dailyMap.get(date).commission = order.commission || 0;
              } else {
                dailyMap.set(date, {
                  date,
                  impressions: 0,
                  clicks: 0,
                  cost: 0,
                  budget: 0,
                  lost_is_budget: 0,
                  lost_is_rank: 0,
                  order_count: order.order_count || 0,
                  commission: order.commission || 0
                });
              }
            });

            const dailyData = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

            // 执行分析
            const analysis = analyzeCampaign(merchant, dailyData, analysisConfig);
            analysisResult = {
              suggestion: analysis.suggestion,
              confidence: analysis.confidence,
              reason: analysis.reason,
              budgetIncrease: analysis.budgetIncrease,
              metrics: analysis.metrics || null
            };

            // 记录分析结果到数据库（异步，不阻塞响应，失败也不影响）
            try {
              const metricsJson = analysis.metrics ? JSON.stringify(analysis.metrics) : null;
              const insertStmt = db.prepare(`
                INSERT INTO campaign_analysis 
                (user_id, merchant_id, affiliate_name, campaign_name, date_range_start, date_range_end,
                 suggestion, confidence, reason, budget_increase, metrics)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `);
              insertStmt.run(
                req.user.id,
                merchant.merchant_id,
                merchant.affiliate_name,
                merchant.campaign_names,
                startDate || '',
                endDate || '',
                analysisResult.suggestion,
                analysisResult.confidence,
                analysisResult.reason,
                analysisResult.budgetIncrease || null,
                metricsJson
              );
            } catch (err) {
              // 静默失败，不影响数据返回
              console.error('记录分析结果失败（不影响数据返回）:', err.message);
            }
          } catch (analysisError) {
            // 分析失败，使用默认建议
            console.error(`分析商家 ${merchant.merchant_id} 失败（不影响数据返回）:`, analysisError.message);
            analysisResult = { suggestion: '继续监测', confidence: '低', reason: '分析中，请稍候' };
          }
        }
      } catch (error) {
        // 任何错误都不影响数据返回
        console.error(`处理商家 ${merchant.merchant_id} 时出错（不影响数据返回）:`, error.message);
        analysisResult = { suggestion: '继续监测', confidence: '低', reason: '数据加载中' };
      }

      // 始终返回原始数据，只是添加分析建议
      return {
        ...merchant,
        analysis: analysisResult
      };
    });

    // 🔥 按ROI从大到小排序
    summaryWithAnalysis.sort((a, b) => {
      const roiA = a.total_cost > 0 ? ((a.total_commission - a.total_cost) / a.total_cost * 100) : -Infinity;
      const roiB = b.total_cost > 0 ? ((b.total_commission - b.total_cost) / b.total_cost * 100) : -Infinity;
      return roiB - roiA;  // 降序排列
    });

    console.log(`📊 商家汇总最终返回: ${summaryWithAnalysis.length} 条记录`);
    if (summaryWithAnalysis.length > 0) {
      console.log('📊 第一条记录样例:', {
        merchant_id: summaryWithAnalysis[0].merchant_id,
        campaign_names: summaryWithAnalysis[0].campaign_names,
        has_analysis: !!summaryWithAnalysis[0].analysis
      });
    }

    res.json({ success: true, data: summaryWithAnalysis });
  } catch (error) {
    console.error('获取商家汇总错误:', error);
    res.json({ success: false, message: '获取失败: ' + error.message });
  }
});

/**
 * API: 获取广告系列按天详细数据
 * GET /api/campaign-daily-details
 * Query: merchantId, campaignName, affiliateName, startDate, endDate
 */
app.get('/api/campaign-daily-details', authenticateToken, (req, res) => {
  try {
    const { merchantId, campaignName, affiliateName, startDate, endDate } = req.query;

    if (!merchantId || !campaignName || !affiliateName || !startDate || !endDate) {
      return res.json({ success: false, message: '缺少必要参数' });
    }

    console.log(`📊 获取广告系列按天详细数据：merchantId=${merchantId}, campaignName=${campaignName}, affiliateName=${affiliateName}`);

    // 1. 查询广告数据（按天分组）
    let adsQuery = `
      SELECT
        date,
        SUM(impressions) as impressions,
        SUM(clicks) as clicks,
        SUM(cost) as cost,
        MAX(campaign_budget) as budget,
        MAX(currency) as currency,
        AVG(lost_impression_share_budget) as lost_is_budget,
        AVG(lost_impression_share_rank) as lost_is_rank
      FROM google_ads_data
      WHERE user_id = ?
        AND merchant_id = ?
        AND campaign_name = ?
        AND LOWER(affiliate_name) = LOWER(?)
        AND date >= ?
        AND date <= ?
      GROUP BY date
      ORDER BY date DESC
    `;

    const adsParams = [req.user.id, merchantId, campaignName, affiliateName, startDate, endDate];
    const adsData = db.prepare(adsQuery).all(...adsParams);

    // 2. 查询订单数据（按天分组）
    let ordersQuery = `
      SELECT
        DATE(order_date) as date,
        COUNT(*) as order_count,
        SUM(commission) as commission
      FROM orders o
      LEFT JOIN platform_accounts pa ON o.platform_account_id = pa.id
      WHERE o.user_id = ?
        AND o.merchant_id = ?
        AND LOWER(pa.affiliate_name) = LOWER(?)
        AND DATE(o.order_date) >= ?
        AND DATE(o.order_date) <= ?
      GROUP BY DATE(o.order_date)
      ORDER BY DATE(o.order_date) DESC
    `;

    const ordersParams = [req.user.id, merchantId, affiliateName, startDate, endDate];
    const ordersData = db.prepare(ordersQuery).all(...ordersParams);

    // 3. 合并数据（以日期为键）
    const dailyMap = new Map();

    // 先添加广告数据
    adsData.forEach(ad => {
      dailyMap.set(ad.date, {
        date: ad.date,
        impressions: ad.impressions || 0,
        clicks: ad.clicks || 0,
        cost: ad.cost || 0,
        budget: ad.budget || 0,
        currency: ad.currency || 'USD',
        lost_is_budget: parseFloat(ad.lost_is_budget) || 0,
        lost_is_rank: parseFloat(ad.lost_is_rank) || 0,
        order_count: 0,
        commission: 0
      });
    });

    // 再添加订单数据（合并或新增）
    ordersData.forEach(order => {
      const date = order.date;
      if (dailyMap.has(date)) {
        const existing = dailyMap.get(date);
        existing.order_count = order.order_count || 0;
        existing.commission = order.commission || 0;
      } else {
        // 如果某天只有订单没有广告数据
        dailyMap.set(date, {
          date: date,
          impressions: 0,
          clicks: 0,
          cost: 0,
          budget: 0,
          currency: 'USD',
          lost_is_budget: 0,
          lost_is_rank: 0,
          order_count: order.order_count || 0,
          commission: order.commission || 0
        });
      }
    });
    // 4. 转换为数组并计算指标
    const dailyStats = Array.from(dailyMap.values()).map(day => {
      const clicks = day.clicks || 0;
      const orders = day.order_count || 0;
      const commission = day.commission || 0;
      const cost = day.cost || 0;

      // 计算指标
      const cr = clicks > 0 ? (orders / clicks * 100) : 0;
      const epc = clicks > 0 ? (commission / clicks) : 0;
      const cpc = clicks > 0 ? (cost / clicks) : 0;
      const roi = cost > 0 ? ((commission - cost) / cost) : 0;

      return {
        date: day.date,
        impressions: day.impressions,
        clicks: clicks,
        cost: cost,
        budget: day.budget,
        currency: day.currency,
        lost_is_budget: day.lost_is_budget || 0,
        lost_is_rank: day.lost_is_rank || 0,
        order_count: orders,
        commission: commission,
        cr: parseFloat(cr.toFixed(2)),
        epc: parseFloat(epc.toFixed(2)),
        cpc: parseFloat(cpc.toFixed(2)),
        roi: parseFloat(roi.toFixed(2))
      };
    });

    // 按日期倒序排列（最新的在前）
    dailyStats.sort((a, b) => {
      return new Date(b.date) - new Date(a.date);
    });

    res.json({
      success: true,
      data: {
        campaign_name: campaignName,
        merchant_id: merchantId,
        affiliate_name: affiliateName,
        daily_stats: dailyStats
      }
    });

  } catch (error) {
    console.error('获取广告系列按天详细数据错误:', error);
    res.json({ success: false, message: '获取失败: ' + error.message });
  }
});

/**
 * 从Google Sheets URL提取sheet ID
 */
function extractSheetId(url) {
  const match = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : null;
}

/**
 * API: 添加Google表格
 * POST /api/google-sheets
 */
app.post('/api/google-sheets', authenticateToken, (req, res) => {
  try {
    const { sheetName, sheetUrl, description } = req.body;

    if (!sheetName || !sheetUrl) {
      return res.json({ success: false, message: '缺少必要参数' });
    }

    // 提取sheet ID
    const sheetId = extractSheetId(sheetUrl);
    if (!sheetId) {
      return res.json({ success: false, message: '无效的Google表格URL' });
    }

    const result = db
      .prepare(
        'INSERT INTO google_sheets (user_id, sheet_name, sheet_url, sheet_id, description) VALUES (?, ?, ?, ?, ?)'
      )
      .run(req.user.id, sheetName, sheetUrl, sheetId, description || '');

    res.json({ success: true, data: { id: result.lastInsertRowid } });
  } catch (error) {
    console.error('添加Google表格错误:', error);
    res.json({ success: false, message: '添加失败: ' + error.message });
  }
});

/**
 * API: 获取Google表格列表
 * GET /api/google-sheets
 */
app.get('/api/google-sheets', authenticateToken, (req, res) => {
  try {
    const sheets = db
      .prepare('SELECT id, sheet_name, sheet_url, sheet_id, description, created_at FROM google_sheets WHERE user_id = ? ORDER BY id DESC')
      .all(req.user.id);
    res.json({ success: true, data: sheets });
  } catch (error) {
    console.error('获取Google表格列表错误:', error);
    res.json({ success: false, message: '获取失败: ' + error.message });
  }
});

/**
 * API: 删除Google表格
 * DELETE /api/google-sheets/:id
 */
app.delete('/api/google-sheets/:id', authenticateToken, (req, res) => {
  try {
    const sheetId = parseInt(req.params.id);
    if (isNaN(sheetId)) return res.json({ success: false, message: '参数错误' });

    const sheet = db
      .prepare('SELECT * FROM google_sheets WHERE id = ? AND user_id = ?')
      .get(sheetId, req.user.id);
    if (!sheet) return res.json({ success: false, message: 'Google表格不存在或无权访问' });

    // 先删除关联的广告数据
    db.prepare('DELETE FROM google_ads_data WHERE sheet_id = ? AND user_id = ?').run(sheetId, req.user.id);
    // 再删除表格记录
    db.prepare('DELETE FROM google_sheets WHERE id = ? AND user_id = ?').run(sheetId, req.user.id);

    res.json({ success: true });
  } catch (error) {
    console.error('删除Google表格错误:', error);
    res.json({ success: false, message: '删除失败: ' + error.message });
  }
});
/**
 * API: 导出商家汇总为Excel
 * POST /api/export/merchant-summary
 */
app.post('/api/export/merchant-summary', authenticateToken, async (req, res) => {
  try {
    console.log('📊 收到导出商家汇总请求');
    const { startDate, endDate, platformAccountIds } = req.body;

    console.log(`📊 开始生成商家汇总Excel：用户=${req.user.id}, 日期=${startDate}至${endDate}`);

    // 复用查询逻辑（与 GET /api/merchant-summary 相同）
    let orderQuery = `
      SELECT
        o.merchant_id,
        o.merchant_name,
        o.merchant_slug,
        LOWER(pa.affiliate_name) as affiliate_name,
        COUNT(*) as order_count,
        SUM(o.order_amount) as total_amount,
        SUM(o.commission) as total_commission,
        SUM(CASE WHEN o.status = 'Approved' THEN o.commission ELSE 0 END) as confirmed_commission,
        SUM(CASE WHEN o.status = 'Pending' THEN o.commission ELSE 0 END) as pending_commission,
        SUM(CASE WHEN o.status = 'Rejected' THEN o.commission ELSE 0 END) as rejected_commission
      FROM orders o
      LEFT JOIN platform_accounts pa ON o.platform_account_id = pa.id
      WHERE o.user_id = ?
    `;
    const orderParams = [req.user.id];

    if (startDate) {
      orderQuery += ' AND o.order_date >= ?';
      orderParams.push(startDate);
    }

    if (endDate) {
      orderQuery += ' AND o.order_date <= ?';
      orderParams.push(endDate);
    }

    // 处理platformAccountIds（可能是数组或逗号分隔的字符串）
    let accountIds = [];
    if (platformAccountIds) {
      if (Array.isArray(platformAccountIds)) {
        accountIds = platformAccountIds.map(id => parseInt(id)).filter(id => !isNaN(id));
      } else if (typeof platformAccountIds === 'string') {
        accountIds = platformAccountIds.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
      }
      if (accountIds.length > 0) {
        const placeholders = accountIds.map(() => '?').join(',');
        orderQuery += ` AND o.platform_account_id IN (${placeholders})`;
        orderParams.push(...accountIds);
      }
    }

    orderQuery += ' GROUP BY o.user_id, LOWER(pa.affiliate_name), o.merchant_id ORDER BY total_commission DESC';

    const orderSummary = db.prepare(orderQuery).all(...orderParams);

    // 查询广告数据
    let adsQuery = `
      SELECT
        merchant_id,
        LOWER(affiliate_name) as affiliate_name,
        GROUP_CONCAT(DISTINCT campaign_name) as campaign_names,
        MAX(campaign_budget) as total_budget,
        MAX(currency) as currency,
        SUM(impressions) as total_impressions,
        SUM(clicks) as total_clicks,
        SUM(cost) as total_cost
      FROM google_ads_data
      WHERE user_id = ? AND campaign_name IS NOT NULL AND campaign_name != ''
    `;
    const adsParams = [req.user.id];

    if (startDate) {
      adsQuery += ' AND date >= ?';
      adsParams.push(startDate);
    }

    if (endDate) {
      adsQuery += ' AND date <= ?';
      adsParams.push(endDate);
    }

    // 使用之前处理的accountIds（如果为空则重新处理）
    if (accountIds.length === 0 && platformAccountIds) {
      if (Array.isArray(platformAccountIds)) {
        accountIds = platformAccountIds.map(id => parseInt(id)).filter(id => !isNaN(id));
      } else if (typeof platformAccountIds === 'string') {
        accountIds = platformAccountIds.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
      }
    }
    
      if (accountIds.length > 0) {
        const placeholders = accountIds.map(() => '?').join(',');
        const selectedAffiliateNames = db.prepare(`
          SELECT DISTINCT affiliate_name FROM platform_accounts
          WHERE id IN (${placeholders}) AND user_id = ?
        `).all(...accountIds, req.user.id)
          .map(row => row.affiliate_name)
          .filter(name => name)
          .map(name => name.toLowerCase());

        if (selectedAffiliateNames.length > 0) {
          const affiliatePlaceholders = selectedAffiliateNames.map(() => '?').join(',');
          adsQuery += ` AND LOWER(affiliate_name) IN (${affiliatePlaceholders})`;
          adsParams.push(...selectedAffiliateNames);
        console.log(`📊 过滤广告数据：只显示 affiliate_name 为 [${selectedAffiliateNames.join(', ')}] 的数据`);
      }
    }

    adsQuery += ' GROUP BY merchant_id, LOWER(affiliate_name)';

    const adsSummary = db.prepare(adsQuery).all(...adsParams);

    // 合并数据
    const mergedSummary = [];
    const processedKeys = new Set();

    orderSummary.forEach(order => {
      if (!order.merchant_id) return;

      const key = `${req.user.id}_${(order.affiliate_name || '').toLowerCase()}_${order.merchant_id}`;
      processedKeys.add(key);

      const matchingAds = adsSummary.find(ads => {
        const adsKey = `${req.user.id}_${(ads.affiliate_name || '').toLowerCase()}_${ads.merchant_id}`;
        return adsKey === key;
      });

      if (matchingAds) {
        mergedSummary.push({
          merchant_id: order.merchant_id,
          merchant_name: order.merchant_name,
          merchant_slug: order.merchant_slug,
          affiliate_name: order.affiliate_name,
          campaign_names: matchingAds.campaign_names,
          order_count: order.order_count,
          total_commission: order.total_commission,
          total_budget: matchingAds.total_budget,
          total_impressions: matchingAds.total_impressions,
          total_clicks: matchingAds.total_clicks,
          total_cost: matchingAds.total_cost
        });
      } else {
        // 没有广告数据，跳过不在商家汇总中展示（与GET接口保持一致）
        console.log(`ℹ️  商家 ${order.merchant_name}(${order.affiliate_name}) 没有广告数据，已跳过`);
      }
    });

    adsSummary.forEach(ads => {
      if (!ads.merchant_id || !ads.affiliate_name) return;

      const key = `${req.user.id}_${(ads.affiliate_name || '').toLowerCase()}_${ads.merchant_id}`;
      
      if (!processedKeys.has(key)) {
        // 这是纯广告数据，没有对应订单，但需要显示
        mergedSummary.push({
          merchant_id: ads.merchant_id,
          merchant_name: '',
          merchant_slug: '',
          affiliate_name: ads.affiliate_name,
          campaign_names: ads.campaign_names,
          order_count: 0,
          total_commission: 0,
          total_budget: ads.total_budget,
          total_impressions: ads.total_impressions,
          total_clicks: ads.total_clicks,
          total_cost: ads.total_cost
        });
        console.log(`ℹ️  纯广告数据 ${ads.campaign_names}(${ads.affiliate_name}) 没有对应订单，但会显示`);
      }
    });

    const filteredSummary = mergedSummary.filter(merchant => 
      merchant.campaign_names && merchant.campaign_names.trim() !== '' && merchant.campaign_names !== '-'
    );

    // 按ROI排序（与GET接口保持一致，使用百分比形式比较）
    filteredSummary.sort((a, b) => {
      const roiA = a.total_cost > 0 ? ((a.total_commission - a.total_cost) / a.total_cost * 100) : -Infinity;
      const roiB = b.total_cost > 0 ? ((b.total_commission - b.total_cost) / b.total_cost * 100) : -Infinity;
      return roiB - roiA;  // 降序排列
    });

    if (filteredSummary.length === 0) {
      return res.json({ success: false, message: '暂无数据可导出' });
    }

    // 创建Excel工作簿
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('商家汇总');

    // 计算统计数据
    const totalBudget = filteredSummary.reduce((sum, m) => sum + (m.total_budget || 0), 0);
    const totalCost = filteredSummary.reduce((sum, m) => sum + (m.total_cost || 0), 0);
    const totalCommission = filteredSummary.reduce((sum, m) => sum + (m.total_commission || 0), 0);
    const totalOrders = filteredSummary.reduce((sum, m) => sum + (m.order_count || 0), 0);
    const totalClicks = filteredSummary.reduce((sum, m) => sum + (m.total_clicks || 0), 0);
    const overallROI = totalCost > 0 ? ((totalCommission - totalCost) / totalCost) : 0;

    // 获取当前用户信息
    const user = db.prepare('SELECT username, email FROM users WHERE id = ?').get(req.user.id);
    const username = user.username || user.email.split('@')[0];

    console.log(`📊 最终合并结果: ${mergedSummary.length} 个商家，过滤后: ${filteredSummary.length} 个商家（仅包含有广告系列名称的商家）`);

    // 添加标题行（扩展到15列，因为增加了用户名和联盟名称）
    worksheet.mergeCells('A1:O1');
    const titleCell = worksheet.getCell('A1');
    titleCell.value = '📊 商家汇总数据统计报表';
    titleCell.font = { bold: true, size: 16 };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3F2FD' } };
    titleCell.border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' }
    };
    worksheet.getRow(1).height = 30;

    // 添加统计信息行
    worksheet.mergeCells('A2:O2');
    const infoCell = worksheet.getCell('A2');
    infoCell.value = `统计周期：${startDate || '全部'} 至 ${endDate || '今天'}  |  导出时间：${new Date().toLocaleString('zh-CN')}`;
    infoCell.font = { size: 11 };
    infoCell.alignment = { horizontal: 'center', vertical: 'middle' };
    infoCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3F2FD' } };
    infoCell.border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' }
    };
    worksheet.getRow(2).height = 25;

    // 添加汇总统计行
    worksheet.mergeCells('A3:O3');
    const statsCell = worksheet.getCell('A3');
    statsCell.value = `总预算：$${totalBudget.toFixed(2)}  |  总广告费：$${totalCost.toFixed(2)}  |  总佣金：$${totalCommission.toFixed(2)}  |  整体ROI：${overallROI.toFixed(2)}  |  商家数：${filteredSummary.length}  |  总订单：${totalOrders}`;
    statsCell.font = { bold: true, size: 11 };
    statsCell.alignment = { horizontal: 'center', vertical: 'middle' };
    statsCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9C4' } };
    statsCell.border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' }
    };
    worksheet.getRow(3).height = 25;

    // 空行
    worksheet.getRow(4).height = 10;

    // 添加表头（添加用户名和联盟名称列，与平台显示一致）
    const headerRow = worksheet.getRow(5);
    headerRow.values = ['排名', '商家ID', '用户名', '联盟名称', '广告系列', '预算', '展示', '点击', '广告费', '订单数', '总佣金', 'CR', 'EPC', 'CPC', 'ROI'];
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF667EEA' } };
    headerRow.eachCell(cell => {
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' }
      };
    });
    headerRow.height = 25;
    // 添加数据行
    filteredSummary.forEach((merchant, index) => {
      const clicks = merchant.total_clicks || 0;
      const orders = merchant.order_count || 0;
      const commission = merchant.total_commission || 0;
      const cost = merchant.total_cost || 0;

      // 计算指标（与前端显示保持一致）
      const cr = clicks > 0 ? (orders / clicks * 100) : 0;  // CR为百分比
      const epc = clicks > 0 ? (commission / clicks) : 0;
      const cpc = clicks > 0 ? (cost / clicks) : 0;
      const roi = cost > 0 ? ((commission - cost) / cost) : 0;  // ROI保持小数形式
      
      // 获取用户名和联盟名称
      const affiliateName = merchant.affiliate_name || '';
      // 如果affiliate_name为空，尝试从campaign_names中提取
      let displayAffiliateName = affiliateName;
      if (!displayAffiliateName && merchant.campaign_names) {
        // 从广告系列名称中提取联盟名称（例如：460-lh1-clippervacations 中的 lh1）
        const match = merchant.campaign_names.match(/\d+-([a-zA-Z0-9]+)-/);
        if (match && match[1]) {
          displayAffiliateName = match[1];
        }
      }

      const rowIndex = 6 + index;
      const row = worksheet.getRow(rowIndex);
      row.values = [
        index + 1,
        merchant.merchant_id || '-',
        username,  // 用户名
        displayAffiliateName || '-',  // 联盟名称
        merchant.campaign_names || '-',
        merchant.total_budget || 0,
        merchant.total_impressions || 0,
        clicks,
        cost,
        orders,
        commission,
        cr,
        epc,
        cpc,
        roi
      ];

      // 设置数字格式（列索引已调整，因为增加了2列：用户名和联盟名称）
      row.getCell(6).numFmt = '$#,##0.00';  // 预算（第6列）
      row.getCell(9).numFmt = '$#,##0.00';  // 广告费（第9列）
      row.getCell(11).numFmt = '$#,##0.00';  // 总佣金（第11列）
      row.getCell(12).numFmt = '0.00%';     // CR（第12列，百分比格式）
      row.getCell(13).numFmt = '$#,##0.00'; // EPC（第13列）
      row.getCell(14).numFmt = '$#,##0.00'; // CPC（第14列）
      row.getCell(15).numFmt = '0.00';      // ROI（第15列）

      // ROI颜色：正数绿色，负数红色（调整列索引）
      const roiCell = row.getCell(15);
      if (roi >= 0) {
        roiCell.font = { color: { argb: 'FF28A745' }, bold: true };
      } else {
        roiCell.font = { color: { argb: 'FFDC3545' }, bold: true };
      }

      // 斑马纹背景
      if (index % 2 === 1) {
        row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8F9FA' } };
      }

      // 边框
      row.eachCell(cell => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' }
        };
        cell.alignment = { vertical: 'middle' };
      });

      // 第一列（排名）居中
      row.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };

      row.height = 20;
    });

    // 设置列宽（增加用户名和联盟名称列）
    worksheet.columns = [
      { key: 'rank', width: 8 },
      { key: 'merchant_id', width: 12 },
      { key: 'username', width: 12 },
      { key: 'affiliate_name', width: 12 },
      { key: 'campaign', width: 35 },
      { key: 'budget', width: 12 },
      { key: 'impressions', width: 12 },
      { key: 'clicks', width: 10 },
      { key: 'cost', width: 12 },
      { key: 'orders', width: 10 },
      { key: 'commission', width: 12 },
      { key: 'cr', width: 10 },
      { key: 'epc', width: 12 },
      { key: 'cpc', width: 12 },
      { key: 'roi', width: 10 }
    ];

    // 生成文件名
    const dateStr = startDate && endDate ? `${startDate}至${endDate}` : '全部数据';
    const filename = `商家汇总_${username}_${dateStr}.xlsx`;

    // 设置响应头
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);

    // 写入响应流
    await workbook.xlsx.write(res);
    res.end();

    console.log(`✅ Excel导出成功：${filename}, 共${filteredSummary.length}条数据`);

  } catch (error) {
    console.error('导出Excel错误:', error);
    res.json({ success: false, message: '导出失败: ' + error.message });
  }
});
/**
 * API: 超管导出用户商家汇总为Excel
 * POST /api/super-admin/export/user-summary/:userId
 */
app.post('/api/super-admin/export/user-summary/:userId', authenticateToken, requireSuperAdmin, auditLog('export_user_summary'), async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const { startDate, endDate } = req.body;

    console.log(`📊 超管导出用户商家汇总Excel：用户=${userId}, 日期=${startDate}至${endDate}`);

    // 获取用户信息
    const user = db.prepare('SELECT username, email FROM users WHERE id = ?').get(userId);
    if (!user) {
      return res.json({ success: false, message: '用户不存在' });
    }
    const username = user.username || user.email.split('@')[0];

    // 获取广告数据
    let adsQuery = `
      SELECT
        merchant_id,
        LOWER(affiliate_name) as affiliate_name,
        GROUP_CONCAT(DISTINCT campaign_name) as campaign_names,
        MAX(campaign_budget) as total_budget,
        MAX(currency) as currency,
        SUM(impressions) as total_impressions,
        SUM(clicks) as total_clicks,
        SUM(cost) as total_cost
      FROM google_ads_data
      WHERE user_id = ? AND campaign_name IS NOT NULL AND campaign_name != ''
    `;
    const adsParams = [userId];

    if (startDate) {
      adsQuery += ' AND date >= ?';
      adsParams.push(startDate);
    }

    if (endDate) {
      adsQuery += ' AND date <= ?';
      adsParams.push(endDate);
    }

    adsQuery += ' GROUP BY merchant_id, LOWER(affiliate_name)';
    const adsSummary = db.prepare(adsQuery).all(...adsParams);

    // 获取订单数据
    let orderQuery = `
      SELECT
        o.merchant_id,
        o.merchant_name,
        LOWER(pa.affiliate_name) as affiliate_name,
        COUNT(*) as order_count,
        SUM(o.commission) as total_commission
      FROM orders o
      LEFT JOIN platform_accounts pa ON o.platform_account_id = pa.id
      WHERE o.user_id = ?
    `;
    const orderParams = [userId];

    if (startDate) {
      orderQuery += ' AND o.order_date >= ?';
      orderParams.push(startDate);
    }

    if (endDate) {
      orderQuery += ' AND o.order_date <= ?';
      orderParams.push(endDate);
    }

    orderQuery += ' GROUP BY o.user_id, LOWER(pa.affiliate_name), o.merchant_id';
    const orderSummary = db.prepare(orderQuery).all(...orderParams);

    // 合并数据
    const mergedSummary = [];
    const processedKeys = new Set();

    orderSummary.forEach(order => {
      if (!order.merchant_id) return;
      const key = `${userId}_${(order.affiliate_name || '').toLowerCase()}_${order.merchant_id}`;
      processedKeys.add(key);

      const matchingAds = adsSummary.find(ads => {
        const adsKey = `${userId}_${(ads.affiliate_name || '').toLowerCase()}_${ads.merchant_id}`;
        return adsKey === key;
      });

      if (matchingAds) {
        mergedSummary.push({
          merchant_id: order.merchant_id,
          merchant_name: order.merchant_name,
          campaign_names: matchingAds.campaign_names,
          order_count: order.order_count,
          total_commission: order.total_commission,
          total_budget: matchingAds.total_budget,
          total_impressions: matchingAds.total_impressions,
          total_clicks: matchingAds.total_clicks,
          total_cost: matchingAds.total_cost
        });
      }
    });

    adsSummary.forEach(ads => {
      if (!ads.merchant_id || !ads.affiliate_name) return;
      const key = `${userId}_${(ads.affiliate_name || '').toLowerCase()}_${ads.merchant_id}`;

      if (!processedKeys.has(key)) {
        mergedSummary.push({
          merchant_id: ads.merchant_id,
          merchant_name: '',
          campaign_names: ads.campaign_names,
          order_count: 0,
          total_commission: 0,
          total_budget: ads.total_budget,
          total_impressions: ads.total_impressions,
          total_clicks: ads.total_clicks,
          total_cost: ads.total_cost
        });
      }
    });

    const filteredSummary = mergedSummary.filter(merchant =>
      merchant.campaign_names && merchant.campaign_names.trim() !== '' && merchant.campaign_names !== '-'
    );

    // 按ROI排序
    filteredSummary.sort((a, b) => {
      const roiA = a.total_cost > 0 ? ((a.total_commission - a.total_cost) / a.total_cost) : -Infinity;
      const roiB = b.total_cost > 0 ? ((b.total_commission - b.total_cost) / b.total_cost) : -Infinity;
      return roiB - roiA;
    });

    if (filteredSummary.length === 0) {
      return res.json({ success: false, message: '暂无数据可导出' });
    }

    // 创建Excel工作簿
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('商家汇总');

    // 计算统计数据
    const totalBudget = filteredSummary.reduce((sum, m) => sum + (m.total_budget || 0), 0);
    const totalCost = filteredSummary.reduce((sum, m) => sum + (m.total_cost || 0), 0);
    const totalCommission = filteredSummary.reduce((sum, m) => sum + (m.total_commission || 0), 0);
    const totalOrders = filteredSummary.reduce((sum, m) => sum + (m.order_count || 0), 0);
    const totalClicks = filteredSummary.reduce((sum, m) => sum + (m.total_clicks || 0), 0);
    const overallROI = totalCost > 0 ? ((totalCommission - totalCost) / totalCost) : 0;

    // 添加标题行
    worksheet.mergeCells('A1:M1');
    const titleCell = worksheet.getCell('A1');
    titleCell.value = `📊 用户商家汇总数据 - ${username}`;
    titleCell.font = { bold: true, size: 16 };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3F2FD' } };
    titleCell.border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' }
    };
    worksheet.getRow(1).height = 30;

    // 添加统计信息行
    worksheet.mergeCells('A2:M2');
    const infoCell = worksheet.getCell('A2');
    infoCell.value = `统计周期：${startDate || '全部'} 至 ${endDate || '今天'}  |  导出时间：${new Date().toLocaleString('zh-CN')}`;
    infoCell.font = { size: 11 };
    infoCell.alignment = { horizontal: 'center', vertical: 'middle' };
    infoCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3F2FD' } };
    infoCell.border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' }
    };
    worksheet.getRow(2).height = 25;

    // 添加汇总统计行
    worksheet.mergeCells('A3:M3');
    const statsCell = worksheet.getCell('A3');
    statsCell.value = `总预算：$${totalBudget.toFixed(2)}  |  总广告费：$${totalCost.toFixed(2)}  |  总佣金：$${totalCommission.toFixed(2)}  |  整体ROI：${overallROI.toFixed(2)}  |  商家数：${filteredSummary.length}  |  总订单：${totalOrders}`;
    statsCell.font = { bold: true, size: 11 };
    statsCell.alignment = { horizontal: 'center', vertical: 'middle' };
    statsCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9C4' } };
    statsCell.border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' }
    };
    worksheet.getRow(3).height = 25;

    // 空行
    worksheet.getRow(4).height = 10;

    // 添加表头
    const headerRow = worksheet.getRow(5);
    headerRow.values = ['排名', '广告系列', '商家ID', '预算', '展示', '点击', '广告费', '订单数', '总佣金', 'CR', 'EPC', 'CPC', 'ROI'];
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF667EEA' } };
    headerRow.eachCell(cell => {
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' }
      };
    });
    headerRow.height = 25;
    // 添加数据行
    filteredSummary.forEach((merchant, index) => {
      const clicks = merchant.total_clicks || 0;
      const orders = merchant.order_count || 0;
      const commission = merchant.total_commission || 0;
      const cost = merchant.total_cost || 0;

      const cr = clicks > 0 ? (orders / clicks * 100) : 0;
      const epc = clicks > 0 ? (commission / clicks) : 0;
      const cpc = clicks > 0 ? (cost / clicks) : 0;
      const roi = cost > 0 ? ((commission - cost) / cost) : 0;

      const rowIndex = 6 + index;
      const row = worksheet.getRow(rowIndex);
      row.values = [
        index + 1,
        merchant.campaign_names || '-',
        merchant.merchant_id,
        merchant.total_budget || 0,
        merchant.total_impressions || 0,
        clicks,
        cost,
        orders,
        commission,
        cr,
        epc,
        cpc,
        roi
      ];

      // 设置数字格式
      row.getCell(4).numFmt = '$#,##0.00';
      row.getCell(7).numFmt = '$#,##0.00';
      row.getCell(9).numFmt = '$#,##0.00';
      row.getCell(10).numFmt = '0.00%';
      row.getCell(11).numFmt = '$#,##0.00';
      row.getCell(12).numFmt = '$#,##0.00';
      row.getCell(13).numFmt = '0.00';

      // ROI颜色
      const roiCell = row.getCell(13);
      if (roi >= 0) {
        roiCell.font = { color: { argb: 'FF28A745' }, bold: true };
      } else {
        roiCell.font = { color: { argb: 'FFDC3545' }, bold: true };
      }

      // 斑马纹背景
      if (index % 2 === 1) {
        row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8F9FA' } };
      }

      // 边框
      row.eachCell(cell => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' }
        };
        cell.alignment = { vertical: 'middle' };
      });

      row.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
      row.height = 20;
    });

    // 设置列宽
    worksheet.columns = [
      { key: 'rank', width: 8 },
      { key: 'campaign', width: 35 },
      { key: 'merchant_id', width: 12 },
      { key: 'budget', width: 12 },
      { key: 'impressions', width: 12 },
      { key: 'clicks', width: 10 },
      { key: 'cost', width: 12 },
      { key: 'orders', width: 10 },
      { key: 'commission', width: 12 },
      { key: 'cr', width: 10 },
      { key: 'epc', width: 12 },
      { key: 'cpc', width: 12 },
      { key: 'roi', width: 10 }
    ];

    // 生成文件名
    const dateStr = startDate && endDate ? `${startDate}至${endDate}` : '全部数据';
    const filename = `用户商家汇总_${username}_${dateStr}.xlsx`;

    // 设置响应头
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);

    // 写入响应流
    await workbook.xlsx.write(res);
    res.end();

    console.log(`✅ 超管Excel导出成功：${filename}, 共${filteredSummary.length}条数据`);

  } catch (error) {
    console.error('超管导出Excel错误:', error);
    res.json({ success: false, message: '导出失败: ' + error.message });
  }
});

/**
 * 从广告系列名提取联盟名称和商家编号
 * 格式：596-pm1-Champion-US-0826-71017
 * 联盟名称：第1个-和第2个-之间 → pm1
 * 商家编号：最后一个-之后 → 71017（数字ID）
 * 同时生成商家标识符：基于商家名称的标准化字符串（用于匹配字符串格式的merchant_id）
 */
function extractCampaignInfo(campaignName) {
  if (!campaignName) {
    return { affiliateName: '', merchantId: '', merchantSlug: '' };
  }

  const parts = campaignName.split('-');

  // 联盟名称：第2个元素（索引1）
  const affiliateName = parts.length >= 2 ? parts[1] : '';

  // 商家编号：最后一个元素（数字ID）
  const merchantId = parts.length > 0 ? parts[parts.length - 1] : '';

  // 商家名称：第3个元素到倒数第3个元素之间（去掉：序号、联盟、国家、日期、ID）
  // 例如：596-pm1-Champion-US-0826-71017 -> Champion
  let merchantName = '';
  if (parts.length >= 5) {
    // 从索引2开始，到倒数第3个（不包含国家、日期、ID）
    const nameEnd = parts.length - 3;
    merchantName = parts.slice(2, nameEnd).join('-');
  }

  // 生成标准化的商家标识符：小写+移除空格和特殊字符
  // 例如："Champion" -> "champion", "Lily and Me Clothing" -> "lilyandmeclothing"
  const merchantSlug = merchantName.toLowerCase().replace(/[^a-z0-9]/g, '');

  return { affiliateName, merchantId, merchantSlug };
}
/**
 * API: 采集Google表格数据
 * POST /api/collect-google-sheets
 */
app.post('/api/collect-google-sheets', authenticateToken, async (req, res) => {
  try {
    const { sheetId } = req.body;

    if (!sheetId) {
      return res.json({ success: false, message: '缺少必要参数' });
    }

    // 验证表格归属
    const sheet = db
      .prepare('SELECT * FROM google_sheets WHERE id = ? AND user_id = ?')
      .get(sheetId, req.user.id);

    if (!sheet) {
      return res.json({ success: false, message: 'Google表格不存在或无权访问' });
    }

    // 构建CSV导出URL（公开表格可直接访问）
    const csvUrl = `https://docs.google.com/spreadsheets/d/${sheet.sheet_id}/export?format=csv&gid=0`;

    console.log(`📥 开始采集Google表格: ${sheet.sheet_name}`);

    // 获取CSV数据
    const response = await axios.get(csvUrl);
    const csvData = response.data;

    // 解析CSV数据
    const lines = csvData.split('\n');

    // 根据你的描述，A3开始是数据，所以跳过前2行
    const dataLines = lines.slice(2).filter(line => line.trim());

    let newCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;

    // 获取今天的日期（用于增量更新）
    const today = new Date().toISOString().split('T')[0];

    // 准备SQL语句
    const selectStmt = db.prepare(`
      SELECT id FROM google_ads_data
      WHERE sheet_id = ? AND date = ? AND campaign_name = ?
    `);

    const insertStmt = db.prepare(`
      INSERT INTO google_ads_data
      (user_id, sheet_id, date, campaign_name, affiliate_name, merchant_id, merchant_slug, campaign_budget, currency, impressions, clicks, cost, lost_impression_share_budget, lost_impression_share_rank, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    const updateStmt = db.prepare(`
      UPDATE google_ads_data
      SET affiliate_name = ?, merchant_id = ?, merchant_slug = ?, campaign_budget = ?, currency = ?, impressions = ?, clicks = ?, cost = ?, lost_impression_share_budget = ?, lost_impression_share_rank = ?, updated_at = datetime('now')
      WHERE id = ?
    `);

    // 🔥 新增：在内存中先去重（相同campaign_name + 相同date = 重复）
    const uniqueDataMap = new Map();  // 键: "campaignName|date", 值: 行数据
    // 解析每一行数据
    for (const line of dataLines) {
      if (!line.trim()) continue;

      // CSV解析（简单处理，假设没有包含逗号的字段）
      const fields = line.split(',').map(f => f.trim().replace(/^"|"$/g, ''));

      if (fields.length < 11) continue; // 数据不完整，至少需要11列

      // 🔥 重要：CSV导出的列顺序与谷歌表格界面显示的顺序不同！
      // CSV列顺序：0=广告系列名, 1=目标投放国家, 2=最终到达网址, 3=广告系列预算, 4=广告系列预算所属货币,
      // 5=广告系列类型, 6=出价策略, 7=日期, 8=展示次数, 9=点击次数, 10=花费
      // 11-12=广告系列所属账（跳过，不存储）
      // 13=因预算而减少的展示份额, 14=因评级减少的展示份额
      // 
      // ⚠️  但是！谷歌表格界面中显示的列顺序是：H=日期, I=点击次数, J=展示次数, K=花费
      // 所以CSV导出时，列8和列9的数据实际上是对调的！
      // 列8的表头虽然写着"展示次数"，但实际数据是点击次数
      // 列9的表头虽然写着"点击次数"，但实际数据是展示次数
      const campaignName = fields[0] || '';
      const date = fields[7] || '';
      const budget = parseFloat(fields[3]) || 0;
      const currency = fields[4] || '';
      const impressions = parseInt(fields[9]) || 0;  // 🔥 修复：列9才是展示次数
      const clicks = parseInt(fields[8]) || 0;  // 🔥 修复：列8才是点击次数
      const cost = parseFloat(fields[10]) || 0;
      
      // 读取丢失展示份额字段（列13和14，跳过列11、12）
      // 数据格式可能是小数（0-1）或百分比（0-100），需要规范化
      let lostISBudget = fields.length > 13 ? parseFloat(fields[13]) || 0 : 0;  // 列13：因预算而减少的展示份额
      let lostISRank = fields.length > 14 ? parseFloat(fields[14]) || 0 : 0;    // 列14：因评级减少的展示份额
      
      // 规范化丢失展示份额：确保值在 0-1 之间（数据库存储格式）
      // 如果值 > 100，可能是数据错误，限制为 100%（存储为 1.0）
      // 如果值在 1-100 之间，是百分比格式，除以 100 转换为小数
      // 如果值在 0-1 之间，已经是小数格式，保持不变
      if (lostISBudget > 100) {
        // 如果值 > 100，可能是数据错误（比如 90.01 被错误地存储为 9001）
        // 尝试除以 100，如果结果仍然 > 1，则限制为 1.0（即 100%）
        lostISBudget = lostISBudget / 100;
        if (lostISBudget > 1) {
          console.warn(`⚠️  因预算丢失展示份额值异常: ${fields[13]}, 已限制为 100% (1.0)`);
          lostISBudget = 1.0;
        }
      } else if (lostISBudget > 1 && lostISBudget <= 100) {
        // 已经是百分比格式（1-100），转换为小数（0-1）
        lostISBudget = lostISBudget / 100;
      }
      // 如果 lostISBudget <= 1，已经是小数格式（0-1），保持不变
      // 确保值在 0-1 范围内
      if (lostISBudget < 0) lostISBudget = 0;
      if (lostISBudget > 1) lostISBudget = 1;
      
      if (lostISRank > 100) {
        lostISRank = lostISRank / 100;
        if (lostISRank > 1) {
          console.warn(`⚠️  因评级丢失展示份额值异常: ${fields[14]}, 已限制为 100% (1.0)`);
          lostISRank = 1.0;
        }
      } else if (lostISRank > 1 && lostISRank <= 100) {
        lostISRank = lostISRank / 100;
      }
      // 确保值在 0-1 范围内
      if (lostISRank < 0) lostISRank = 0;
      if (lostISRank > 1) lostISRank = 1;

      if (!date || !campaignName || campaignName.trim() === '') continue; // 必填字段检查，确保广告系列名不为空

      // 🔥 去重关键：生成唯一键（campaign_name + date）
      const uniqueKey = `${campaignName}|${date}`;

      // 🔥 如果表格中已经遇到过相同的campaign_name+date，跳过（CSV内部去重）
      if (uniqueDataMap.has(uniqueKey)) {
        console.log(`⚠️  跳过重复数据: ${campaignName}, 日期: ${date} (CSV表格内有重复行)`);
        skippedCount++;
        continue;
      }

      // 提取联盟名称、商家编号和商家标识符
      const { affiliateName, merchantId, merchantSlug } = extractCampaignInfo(campaignName);

      // 🔥 汇率转换：如果是CNY，统一转换为USD（汇率7.13）
      const EXCHANGE_RATE = 7.13;
      let finalBudget = budget;
      let finalCost = cost;
      let finalCurrency = currency;
      
      if (currency && currency.toUpperCase() === 'CNY') {
        finalBudget = budget / EXCHANGE_RATE;
        finalCost = cost / EXCHANGE_RATE;
        finalCurrency = 'USD';
      } else if (!currency || currency.trim() === '') {
        // 如果货币类型为空，默认使用USD
        finalCurrency = 'USD';
      }

      // 存入Map，避免CSV内部去重
      uniqueDataMap.set(uniqueKey, {
        campaignName,
        date,
        budget: finalBudget,
        currency: finalCurrency,
        impressions,
        clicks,
        cost: finalCost,
        lostISBudget,
        lostISRank,
        affiliateName,
        merchantId,
        merchantSlug
      });
    }

    // 🔥 遍历去重后的唯一数据，插入/更新数据库
    uniqueDataMap.forEach(data => {
      const { campaignName, date, budget, currency, impressions, clicks, cost, lostISBudget, lostISRank, affiliateName, merchantId, merchantSlug } = data;

      // 增量更新逻辑：只更新今天的数据
      if (date === today) {
        const existing = selectStmt.get(sheetId, date, campaignName);

        if (existing) {
          // 更新今日数据
          updateStmt.run(affiliateName, merchantId, merchantSlug, budget, currency, impressions, clicks, cost, lostISBudget, lostISRank, existing.id);
          updatedCount++;
        } else {
          // 插入新数据
          insertStmt.run(
            req.user.id,
            sheetId,
            date,
            campaignName,
            affiliateName,
            merchantId,
            merchantSlug,
            budget,
            currency,
            impressions,
            clicks,
            cost,
            lostISBudget,
            lostISRank
          );
          newCount++;
        }
      } else {
        // 非今日数据，检查是否存在
        const existing = selectStmt.get(sheetId, date, campaignName);
        if (!existing) {
          // 历史数据不存在，插入
          insertStmt.run(
            req.user.id,
            sheetId,
            date,
            campaignName,
            affiliateName,
            merchantId,
            merchantSlug,
            budget,
            currency,
            impressions,
            clicks,
            cost,
            lostISBudget,
            lostISRank
          );
          newCount++;
        } else {
          // 历史数据存在，但仍然更新预算和货币（可能后补）
          // 只更新关键字段，避免覆盖正确的展示/点击/费用数据
          if (budget && budget > 0) {
            db.prepare(`
              UPDATE google_ads_data
              SET campaign_budget = ?, currency = ?, lost_impression_share_budget = ?, lost_impression_share_rank = ?, updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(budget, currency, lostISBudget, lostISRank, existing.id);
            updatedCount++;
          } else {
            skippedCount++;
          }
        }
      }
    });

    const message = `采集完成：新增 ${newCount} 条，更新 ${updatedCount} 条，跳过 ${skippedCount} 条`;
    console.log(`✅ ${message}`);

    res.json({
      success: true,
      message: message,
      data: {
        stats: {
          new: newCount,
          updated: updatedCount,
          skipped: skippedCount,
          total: dataLines.length
        }
      }
    });
  } catch (error) {
    console.error('采集Google表格错误:', error);
    res.json({ success: false, message: '采集失败: ' + error.message });
  }
});

/**
 * API: 获取Google广告数据
 * GET /api/google-ads-data
 */
app.get('/api/google-ads-data', authenticateToken, (req, res) => {
  try {
    const { startDate, endDate, sheetId } = req.query;

    let query = 'SELECT * FROM google_ads_data WHERE user_id = ?';
    const params = [req.user.id];

    if (startDate) {
      query += ' AND date >= ?';
      params.push(startDate);
    }

    if (endDate) {
      query += ' AND date <= ?';
      params.push(endDate);
    }

    if (sheetId) {
      query += ' AND sheet_id = ?';
      params.push(sheetId);
    }

    query += ' ORDER BY date DESC, campaign_name ASC LIMIT 1000';

    const data = db.prepare(query).all(...params);

    res.json({ success: true, data: data });
  } catch (error) {
    console.error('获取Google广告数据错误:', error);
    res.json({ success: false, message: '获取失败: ' + error.message });
  }
});
/**
 * API: 获取推荐榜单（Top 10 ROI最高的广告系列）
 * GET /api/top-ads-ranking
 */
app.get('/api/top-ads-ranking', authenticateToken, (req, res) => {
  try {
    const { range = 'yesterday', startDate, endDate } = req.query;

    // 计算时间范围
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    
    let queryStartDate, queryEndDate;
    
    if (range === 'yesterday') {
      queryStartDate = yesterday.toISOString().split('T')[0];
      queryEndDate = yesterday.toISOString().split('T')[0];
    } else if (range === 'last7days') {
      const sevenDaysAgo = new Date(yesterday);
      sevenDaysAgo.setDate(yesterday.getDate() - 6);
      queryStartDate = sevenDaysAgo.toISOString().split('T')[0];
      queryEndDate = yesterday.toISOString().split('T')[0];
    } else if (range === 'last30days') {
      const thirtyDaysAgo = new Date(yesterday);
      thirtyDaysAgo.setDate(yesterday.getDate() - 29);
      queryStartDate = thirtyDaysAgo.toISOString().split('T')[0];
      queryEndDate = yesterday.toISOString().split('T')[0];
    } else if (range === 'custom' && startDate && endDate) {
      queryStartDate = startDate;
      queryEndDate = endDate;
    } else {
      // 默认：最近7天
      const sevenDaysAgo = new Date(yesterday);
      sevenDaysAgo.setDate(yesterday.getDate() - 6);
      queryStartDate = sevenDaysAgo.toISOString().split('T')[0];
      queryEndDate = yesterday.toISOString().split('T')[0];
    }

    console.log(`📊 推荐榜单查询：时间范围 ${queryStartDate} 至 ${queryEndDate}`);

    // 第一步：查询所有用户的广告系列数据
    const adsQuery = `
      SELECT 
        user_id,
        campaign_name,
        merchant_id,
        LOWER(affiliate_name) as affiliate_name,
        SUM(cost) as total_cost,
        SUM(clicks) as total_clicks
      FROM google_ads_data
      WHERE campaign_name IS NOT NULL 
        AND campaign_name != ''
        AND date >= ?
        AND date <= ?
        AND cost > 0
      GROUP BY user_id, campaign_name, merchant_id, LOWER(affiliate_name)
    `;

    const adsData = db.prepare(adsQuery).all(queryStartDate, queryEndDate);
    console.log(`📊 广告数据查询结果: ${adsData.length} 条记录`);

    // 第二步：查询所有用户的订单数据
    const ordersQuery = `
      SELECT 
        o.user_id,
        o.platform_account_id,
        o.merchant_id,
        MAX(o.merchant_name) as merchant_name,
        LOWER(pa.affiliate_name) as affiliate_name,
        SUM(o.commission) as total_commission
      FROM orders o
      LEFT JOIN platform_accounts pa ON o.platform_account_id = pa.id
      WHERE DATE(o.order_date) >= ?
        AND DATE(o.order_date) <= ?
      GROUP BY o.user_id, o.platform_account_id, o.merchant_id, LOWER(pa.affiliate_name)
    `;

    const ordersData = db.prepare(ordersQuery).all(queryStartDate, queryEndDate);
    console.log(`📊 订单数据查询结果: ${ordersData.length} 条记录`);

    // 第三步：统计所有商家的推广人数（直接从订单数据统计，更准确）
    const allMerchantPromoterMap = new Map(); // key: merchant_id + affiliate_name, value: Set of user_id + platform_account_id
    
    // 从订单数据中统计推广人数（不管ROI，统计所有有订单的推广用户）
    ordersData.forEach(order => {
      const merchantKey = `${order.merchant_id}_${order.affiliate_name}`;
      if (!allMerchantPromoterMap.has(merchantKey)) {
        allMerchantPromoterMap.set(merchantKey, new Set());
      }
      const promoterSet = allMerchantPromoterMap.get(merchantKey);
      
      // 按 user_id + platform_account_id 统计
      if (order.platform_account_id) {
        promoterSet.add(`${order.user_id}_${order.platform_account_id}`);
      } else {
        promoterSet.add(`${order.user_id}_null`);
      }
    });
    
    // 补充：对于有广告数据但没有订单数据的用户，也统计进去
    adsData.forEach(ad => {
      const merchantKey = `${ad.merchant_id}_${ad.affiliate_name}`;
      if (!allMerchantPromoterMap.has(merchantKey)) {
        allMerchantPromoterMap.set(merchantKey, new Set());
      }
      const promoterSet = allMerchantPromoterMap.get(merchantKey);
      
      // 检查是否已经有订单数据统计过
      const hasOrder = ordersData.some(order => 
        order.user_id === ad.user_id &&
        order.merchant_id === ad.merchant_id &&
        order.affiliate_name === ad.affiliate_name
      );
      
      // 如果没有订单数据，至少记录有广告数据的用户（使用null作为platform_account_id）
      if (!hasOrder) {
        promoterSet.add(`${ad.user_id}_null`);
      }
    });
    // 第四步：关联广告数据和订单数据，计算ROI（只保留ROI > 3的）
    const campaignMap = new Map(); // key: campaign_name, value: { best: {...}, all: [...] }

    adsData.forEach(ad => {
      const campaignKey = ad.campaign_name;
      
      // 查找匹配的订单数据（通过 user_id + merchant_id + affiliate_name）
      const matchingOrders = ordersData.filter(order => 
        order.user_id === ad.user_id &&
        order.merchant_id === ad.merchant_id &&
        order.affiliate_name === ad.affiliate_name
      );

      // 计算该用户该广告系列的总佣金
      const totalCommission = matchingOrders.reduce((sum, order) => sum + (order.total_commission || 0), 0);

      // 计算ROI
      const roi = ad.total_cost > 0 ? (totalCommission / ad.total_cost) : 0;
      const epc = ad.total_clicks > 0 ? (totalCommission / ad.total_clicks) : 0;
      const cpc = ad.total_clicks > 0 ? (ad.total_cost / ad.total_clicks) : 0;

      // 只保留ROI > 3的记录
      if (roi > 3) {
        if (!campaignMap.has(campaignKey)) {
          campaignMap.set(campaignKey, {
            campaign_name: campaignKey,
            best: null,
            all: []
          });
        }

        // 从订单数据中获取merchant_name（google_ads_data表中没有merchant_name列）
        const merchantName = matchingOrders.length > 0 && matchingOrders[0].merchant_name 
          ? matchingOrders[0].merchant_name 
          : null; // 如果没有订单数据，merchant_name为null
        
        const record = {
          user_id: ad.user_id,
          platform_account_id: matchingOrders.length > 0 ? matchingOrders[0].platform_account_id : null,
          merchant_id: ad.merchant_id,
          merchant_name: merchantName,
          affiliate_name: ad.affiliate_name,
          total_cost: ad.total_cost,
          total_clicks: ad.total_clicks,
          total_commission: totalCommission,
          roi: roi,
          epc: epc,
          cpc: cpc
        };

        campaignMap.get(campaignKey).all.push(record);

        // 更新最高ROI记录（同一广告系列选择ROI最高的）
        const current = campaignMap.get(campaignKey);
        if (!current.best || record.roi > current.best.roi) {
          current.best = record;
        }
      }
    });

    // 第五步：统计推广人数并生成最终结果
    // 使用之前统计的所有推广人数（不管ROI）
    const results = Array.from(campaignMap.values())
      .map(campaign => {
        const merchantKey = `${campaign.best.merchant_id}_${campaign.best.affiliate_name}`;
        // 从所有推广人数中获取（包括ROI <= 3的用户）
        const promoterCount = allMerchantPromoterMap.get(merchantKey)?.size || 0;

        return {
          campaign_name: campaign.campaign_name,
          merchant_id: campaign.best.merchant_id,
          merchant_name: campaign.best.merchant_name,
          affiliate_name: campaign.best.affiliate_name,
          epc: parseFloat(campaign.best.epc.toFixed(2)),
          cpc: parseFloat(campaign.best.cpc.toFixed(2)),
          roi: parseFloat(campaign.best.roi.toFixed(2)),
          promoter_count: promoterCount
        };
      })
      .filter(item => item.promoter_count <= 3) // 硬性过滤：只显示推广人数 ≤ 3的广告系列
      .sort((a, b) => b.epc - a.epc) // 按EPC降序排序
      .slice(0, 10) // 取前10个（如果符合条件的不足10个，显示所有符合条件的）
      .map((item, index) => ({
        rank: index + 1,
        ...item
      }));

    console.log(`✅ 推荐榜单生成完成：${results.length} 条记录`);

    // 第六步：生成稳定广告数据（ROI > 3, 推广人数 ≥ 5）
    // 先构造候选集合（基于各 campaign 的最佳记录）
    const stableCandidates = Array.from(campaignMap.values()).map(campaign => {
      const merchantKey = `${campaign.best.merchant_id}_${campaign.best.affiliate_name}`;
      const promoterCount = allMerchantPromoterMap.get(merchantKey)?.size || 0;

      return {
        campaign_name: campaign.campaign_name,
        merchant_id: campaign.best.merchant_id,
        merchant_name: campaign.best.merchant_name,
        affiliate_name: campaign.best.affiliate_name,
        epc: parseFloat(campaign.best.epc.toFixed(2)),
        cpc: parseFloat(campaign.best.cpc.toFixed(2)),
        roi: parseFloat(campaign.best.roi.toFixed(2)),
        promoter_count: promoterCount
      };
    });

    // 对同一商家（merchant_id + affiliate_name）去重：只保留ROI最高的一条
    const bestPerMerchant = new Map();
    for (const item of stableCandidates) {
      const key = `${item.merchant_id}_${item.affiliate_name}`;
      const existed = bestPerMerchant.get(key);
      if (!existed || item.roi > existed.roi) {
        bestPerMerchant.set(key, item);
      }
    }

    const stableResults = Array.from(bestPerMerchant.values())
      .filter(item => item.promoter_count >= 5) // 硬性过滤：只显示推广人数 ≥ 5 的广告系列
      .sort((a, b) => {
        // 先按推广人数降序，推广人数相同时按EPC降序
        if (b.promoter_count !== a.promoter_count) {
          return b.promoter_count - a.promoter_count;
        }
        return b.epc - a.epc;
      })
      .slice(0, 10) // 取前10个商家
      .map((item, index) => ({
        rank: index + 1,
        ...item
      }));

    console.log(`✅ 稳定广告生成完成：${stableResults.length} 条记录`);

    res.json({
      success: true,
      data: results,
      stable_data: stableResults, // 新增稳定广告数据
      meta: {
        date_range: {
          start: queryStartDate,
          end: queryEndDate
        },
        total_candidates: campaignMap.size,
        stable_candidates: stableResults.length
      }
    });
  } catch (error) {
    console.error('获取推荐榜单错误:', error);
    res.json({ success: false, message: '获取失败: ' + error.message });
  }
});

// ============ 超级管理员API ============

/**
 * API: 获取所有用户列表（含统计）
 * GET /api/super-admin/users
 */
app.get('/api/super-admin/users', authenticateToken, requireSuperAdmin, auditLog('view_users_list'), (req, res) => {
  try {
    const { page = 1, pageSize = 20, search = '' } = req.query;
    const offset = (page - 1) * pageSize;

    let whereClause = "WHERE u.role = 'user'";
    let params = [];

    if (search) {
      whereClause += " AND (u.username LIKE ? OR u.email LIKE ?)";
      params.push(`%${search}%`, `%${search}%`);
    }

    // 获取总数
    const countQuery = `SELECT COUNT(*) as total FROM users u ${whereClause}`;
    const { total } = db.prepare(countQuery).get(...params);

    // 获取用户列表（含统计）
    const usersQuery = `
      SELECT 
        u.id,
        u.username,
        u.email,
        u.role,
        u.created_at,
        u.is_active,
        u.approval_status,
        COUNT(DISTINCT pa.id) as account_count,
        COUNT(DISTINCT o.id) as order_count,
        COALESCE(SUM(o.commission), 0) as total_commission
      FROM users u
      LEFT JOIN platform_accounts pa ON u.id = pa.user_id
      LEFT JOIN orders o ON u.id = o.user_id
      ${whereClause}
      GROUP BY u.id
      ORDER BY u.created_at DESC
      LIMIT ? OFFSET ?
    `;
    
    const users = db.prepare(usersQuery).all(...params, pageSize, offset);

    res.json({
      success: true,
      data: {
        total,
        page: parseInt(page),
        pageSize: parseInt(pageSize),
        users: users.map(user => ({
          id: user.id,
          username: user.username,
          email: user.email,
          role: user.role,
          created_at: user.created_at,
          is_active: user.is_active,
          approval_status: user.approval_status || 'approved', // 兼容旧数据
          stats: {
            account_count: user.account_count,
            order_count: user.order_count,
            total_commission: user.total_commission
          }
        }))
      }
    });
  } catch (error) {
    console.error('获取用户列表错误:', error);
    res.json({ success: false, message: '获取失败: ' + error.message });
  }
});
/**
 * API: 获取用户统计分析数据
 * GET /api/super-admin/users/analytics
 * 注意：此路由必须放在 /api/super-admin/users/:id 之前，避免被误匹配
 */
app.get('/api/super-admin/users/analytics', authenticateToken, requireSuperAdmin, auditLog('view_user_analytics'), (req, res) => {
  try {
    const { period = '30', startDate: customStartDate, endDate: customEndDate } = req.query;
    
    let startDateStr, endDateStr, periodDays;
    
    // 如果提供了自定义日期，使用自定义日期；否则根据period计算
    if (customStartDate && customEndDate) {
      startDateStr = customStartDate;
      endDateStr = customEndDate;
      // 计算自定义日期范围的天数
      const startDate = new Date(customStartDate);
      const endDate = new Date(customEndDate);
      periodDays = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;
    } else {
      // 处理 period 参数，如果无效则默认30天
      // 默认日期范围不包含今天（结束日期是昨天）
      const days = parseInt(period);
      if (isNaN(days) || days <= 0) {
        console.log(`⚠️ [用户统计分析] 无效的period参数: ${period}，使用默认值30天`);
        periodDays = 30;
        const today = new Date();
        const endDate = new Date(today);
        endDate.setDate(endDate.getDate() - 1); // 昨天（排除今天）
        const startDate = new Date(endDate);
        startDate.setDate(startDate.getDate() - (periodDays - 1)); // 从昨天往前推periodDays-1天
        startDateStr = startDate.toISOString().split('T')[0];
        endDateStr = endDate.toISOString().split('T')[0];
      } else {
        periodDays = days;
        const today = new Date();
        const endDate = new Date(today);
        endDate.setDate(endDate.getDate() - 1); // 昨天（排除今天）
        const startDate = new Date(endDate);
        startDate.setDate(startDate.getDate() - (periodDays - 1)); // 从昨天往前推periodDays-1天
        startDateStr = startDate.toISOString().split('T')[0];
        endDateStr = endDate.toISOString().split('T')[0];
      }
    }
    
    console.log(`📊 [用户统计分析] 日期范围: ${startDateStr} 至 ${endDateStr}, 天数: ${periodDays}`);

    // 1. 用户活跃度统计
    const activeStats = db.prepare(`
      SELECT 
        COUNT(*) as total_users,
        SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active_users,
        SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) as inactive_users,
        SUM(CASE WHEN DATE(created_at) >= ? THEN 1 ELSE 0 END) as new_users
      FROM users
      WHERE role = 'user'
    `).get(startDateStr);

    // 2. 注册趋势（按天统计，最近N天）
    const registrationTrend = db.prepare(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as count
      FROM users
      WHERE role = 'user' 
        AND DATE(created_at) >= ?
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `).all(startDateStr);

    // 3. 用户贡献度排行（按ROI排序，Top 10）
    // 先获取用户基本信息
    const allUsers = db.prepare(`
      SELECT 
        u.id,
        u.username,
        u.email,
        u.created_at,
        u.is_active,
        COUNT(DISTINCT pa.id) as account_count
      FROM users u
      LEFT JOIN platform_accounts pa ON u.id = pa.user_id
      WHERE u.role = 'user'
      GROUP BY u.id
    `).all();
    
    // 为每个用户计算订单和广告数据（只统计有广告数据的商家对应的订单，与商家汇总逻辑一致）
    const userOrderStats = allUsers.map(user => {
      // 使用EXISTS子查询：只统计在日期范围内有广告数据（有campaign_name）的商家对应的订单
      const orderStats = db.prepare(`
        SELECT 
          COUNT(*) as order_count,
          COALESCE(SUM(o.commission), 0) as total_commission,
          COALESCE(SUM(o.order_amount), 0) as total_amount
        FROM orders o
        LEFT JOIN platform_accounts pa ON o.platform_account_id = pa.id
        WHERE o.user_id = ?
          AND DATE(o.order_date) >= ?
          AND DATE(o.order_date) <= ?
          AND EXISTS (
            SELECT 1 
            FROM google_ads_data gads
            WHERE gads.user_id = o.user_id
              AND gads.merchant_id = o.merchant_id
              AND LOWER(COALESCE(gads.affiliate_name, '')) = LOWER(COALESCE(pa.affiliate_name, ''))
              AND gads.campaign_name IS NOT NULL 
              AND gads.campaign_name != ''
              AND DATE(gads.date) >= ?
              AND DATE(gads.date) <= ?
          )
      `).get(user.id, startDateStr, endDateStr, startDateStr, endDateStr);
      
      return {
        ...user,
        order_count: orderStats?.order_count || 0,
        total_commission: parseFloat(orderStats?.total_commission || 0),
        total_amount: parseFloat(orderStats?.total_amount || 0)
      };
    });
    // 为每个用户计算总广告费用和ROI
    const contributionRanking = userOrderStats.map(user => {
      // 先检查该用户是否有google_ads_data记录
      const adDataCount = db.prepare(`
        SELECT COUNT(*) as count FROM google_ads_data WHERE user_id = ?
      `).get(user.id);
      
      // 查询该用户的总广告费用（USD，在指定日期范围内）
      // 只统计有广告系列名称的数据，与商家汇总逻辑保持一致
      const adCostResult = db.prepare(`
        SELECT 
          COALESCE(SUM(cost), 0) as total_cost,
          COUNT(*) as record_count
        FROM google_ads_data
        WHERE user_id = ?
          AND campaign_name IS NOT NULL 
          AND campaign_name != ''
          AND DATE(date) >= ?
          AND DATE(date) <= ?
      `).get(user.id, startDateStr, endDateStr);
      
      // 验证：查询订单总数和佣金总额（在指定日期范围内，用于调试）
      const orderStats = db.prepare(`
        SELECT 
          COUNT(*) as order_count,
          COALESCE(SUM(commission), 0) as total_commission_sum,
          COALESCE(SUM(CASE WHEN status = 'Approved' THEN commission ELSE 0 END), 0) as confirmed_commission
        FROM orders
        WHERE user_id = ?
          AND DATE(order_date) >= ?
          AND DATE(order_date) <= ?
      `).get(user.id, startDateStr, endDateStr);

      const totalCost = parseFloat(adCostResult?.total_cost || 0);
      const totalCommission = parseFloat(user.total_commission || 0);
      
      // 验证订单统计是否一致
      const orderCountMatch = (user.order_count || 0) === (orderStats?.order_count || 0);
      const commissionMatch = Math.abs(totalCommission - (orderStats?.total_commission_sum || 0)) < 0.01;
      
      // 计算ROI：ROI = (佣金 - 广告费用) / 广告费用
      // 与系统其他地方保持一致的计算方式（小数形式，如 0.25 表示 25%）
      // 如果广告费为0，ROI设为0（无法计算）
      const roi = totalCost > 0 ? ((totalCommission - totalCost) / totalCost) : 0;
      
      console.log(`📊 用户贡献度统计: 用户ID=${user.id}, 用户名=${user.username}`);
      console.log(`   - 订单统计: 总数=${orderStats?.order_count || 0}, 佣金总和=${orderStats?.total_commission_sum || 0}, 已确认佣金=${orderStats?.confirmed_commission || 0}`);
      console.log(`   - 汇总数据: 订单数=${user.order_count || 0}, 总佣金=${totalCommission} (匹配: ${commissionMatch ? '✓' : '✗'})`);
      console.log(`   - 广告数据: 总记录数=${adDataCount?.count || 0}, 有效记录数=${adCostResult?.record_count || 0}, 总广告费=${totalCost}`);
      console.log(`   - ROI计算: ${totalCommission} - ${totalCost} = ${totalCommission - totalCost}, ROI = ${roi.toFixed(4)}`);

      return {
        id: user.id,
        username: user.username,
        email: user.email,
        created_at: user.created_at,
        is_active: user.is_active,
        stats: {
          account_count: user.account_count || 0,
          order_count: user.order_count || 0,
          total_commission: totalCommission,
          total_amount: parseFloat(user.total_amount || 0),
          total_cost: totalCost,
          roi: roi
        }
      };
    })
    .filter(user => {
      // 只显示有佣金或广告费用的用户
      return user.stats.total_commission > 0 || user.stats.total_cost > 0;
    })
    .sort((a, b) => b.stats.roi - a.stats.roi); // 按ROI降序排序

    // 计算所有用户的总佣金和总广告费（用于汇总统计）
    const totalStats = {
      total_commission: 0,
      total_cost: 0,
      total_amount: 0,
      total_orders: 0
    };
    
    userOrderStats.forEach(user => {
      totalStats.total_commission += user.total_commission || 0;
      totalStats.total_amount += user.total_amount || 0;
      totalStats.total_orders += user.order_count || 0;
    });
    
    contributionRanking.forEach(user => {
      totalStats.total_cost += user.stats.total_cost || 0;
    });

    // 只返回Top 10用于排行显示
    const top10Ranking = contributionRanking.slice(0, 10);

    console.log(`📊 用户贡献度排行最终结果: ${contributionRanking.length} 个用户（显示Top 10）`);
    console.log(`📊 所有用户汇总统计:`, totalStats);

    // 4. 活跃度分析（有订单、有平台账号、最近30天有活动的用户）
    const activityAnalysis = db.prepare(`
      SELECT 
        COUNT(DISTINCT CASE WHEN o.id IS NOT NULL THEN u.id END) as users_with_orders,
        COUNT(DISTINCT CASE WHEN pa.id IS NOT NULL THEN u.id END) as users_with_accounts,
        COUNT(DISTINCT CASE WHEN o.order_date >= DATE('now', '-30 days') THEN u.id END) as active_last_30_days
      FROM users u
      LEFT JOIN orders o ON u.id = o.user_id
      LEFT JOIN platform_accounts pa ON u.id = pa.user_id
      WHERE u.role = 'user'
    `).get();

    res.json({
      success: true,
      data: {
        active_stats: {
          total_users: activeStats.total_users || 0,
          active_users: activeStats.active_users || 0,
          inactive_users: activeStats.inactive_users || 0,
          new_users: activeStats.new_users || 0,
          period_days: periodDays
        },
        registration_trend: registrationTrend.map(item => ({
          date: item.date,
          count: item.count
        })),
        contribution_ranking: top10Ranking,
        total_stats: {
          total_commission: totalStats.total_commission,
          total_cost: totalStats.total_cost,
          total_amount: totalStats.total_amount,
          total_orders: totalStats.total_orders
        },
        activity_analysis: {
          users_with_orders: activityAnalysis.users_with_orders || 0,
          users_with_accounts: activityAnalysis.users_with_accounts || 0,
          active_last_30_days: activityAnalysis.active_last_30_days || 0
        }
      }
    });
  } catch (error) {
    console.error('获取用户统计分析错误:', error);
    res.json({ success: false, message: '获取失败: ' + error.message });
  }
});

/**
 * API: 生成邀请码
 * POST /api/super-admin/invitation-codes
 */
app.post('/api/super-admin/invitation-codes', authenticateToken, requireSuperAdmin, auditLog('create_invitation_code'), (req, res) => {
  try {
    const { max_uses = 1, expires_at = null, role = 'user' } = req.body;

    // 生成随机邀请码（12位字母数字组合）
    const generateCode = () => {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 排除易混淆的字符
      let code = '';
      for (let i = 0; i < 12; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return code;
    };

    let code;
    let attempts = 0;
    do {
      code = generateCode();
      attempts++;
      // 检查邀请码是否已存在
      const existing = db.prepare('SELECT id FROM invitation_codes WHERE code = ?').get(code);
      if (!existing) break;
      if (attempts > 10) {
        return res.json({ success: false, message: '生成邀请码失败，请重试' });
      }
    } while (true);

    // 创建邀请码
    const result = db.prepare(`
      INSERT INTO invitation_codes (code, created_by, max_uses, expires_at, role)
      VALUES (?, ?, ?, ?, ?)
    `).run(code, req.user.id, max_uses, expires_at, role);

    console.log(`✅ 超级管理员生成了邀请码: ${code} (ID: ${result.lastInsertRowid}), 最大使用次数: ${max_uses}`);

    res.json({
      success: true,
      message: '邀请码生成成功',
      data: {
        id: result.lastInsertRowid,
        code,
        max_uses,
        expires_at,
        role,
        used_count: 0,
        is_active: 1
      }
    });
  } catch (error) {
    console.error('生成邀请码错误:', error);
    res.json({ success: false, message: '生成失败: ' + error.message });
  }
});

/**
 * API: 获取邀请码列表
 * GET /api/super-admin/invitation-codes
 */
app.get('/api/super-admin/invitation-codes', authenticateToken, requireSuperAdmin, auditLog('view_invitation_codes'), (req, res) => {
  try {
    const codes = db.prepare(`
      SELECT 
        ic.id,
        ic.code,
        ic.max_uses,
        ic.used_count,
        ic.expires_at,
        ic.role,
        ic.is_active,
        ic.created_at,
        u.username as created_by_username
      FROM invitation_codes ic
      LEFT JOIN users u ON ic.created_by = u.id
      ORDER BY ic.created_at DESC
    `).all();

    res.json({
      success: true,
      data: codes.map(code => ({
        ...code,
        is_expired: code.expires_at ? new Date(code.expires_at) < new Date() : false,
        is_used_up: code.used_count >= code.max_uses,
        can_use: code.is_active === 1 && 
                 (code.expires_at ? new Date(code.expires_at) >= new Date() : true) &&
                 code.used_count < code.max_uses
      }))
    });
  } catch (error) {
    console.error('获取邀请码列表错误:', error);
    res.json({ success: false, message: '获取失败: ' + error.message });
  }
});

/**
 * API: 删除邀请码
 * DELETE /api/super-admin/invitation-codes/:id
 */
app.delete('/api/super-admin/invitation-codes/:id', authenticateToken, requireSuperAdmin, auditLog('delete_invitation_code'), (req, res) => {
  try {
    const codeId = parseInt(req.params.id);
    
    const code = db.prepare('SELECT code FROM invitation_codes WHERE id = ?').get(codeId);
    if (!code) {
      return res.json({ success: false, message: '邀请码不存在' });
    }

    db.prepare('DELETE FROM invitation_codes WHERE id = ?').run(codeId);

    console.log(`✅ 超级管理员删除了邀请码: ${code.code} (ID: ${codeId})`);

    res.json({
      success: true,
      message: '邀请码已删除'
    });
  } catch (error) {
    console.error('删除邀请码错误:', error);
    res.json({ success: false, message: '删除失败: ' + error.message });
  }
});

/**
 * API: 获取审计日志
 * GET /api/super-admin/audit-logs
 */
app.get('/api/super-admin/audit-logs', authenticateToken, requireSuperAdmin, (req, res) => {
  try {
    const { page = 1, pageSize = 50, action, startDate, endDate } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(pageSize);
    
    let query = `
      SELECT 
        al.id,
        al.created_at,
        al.admin_username,
        al.action,
        al.target_username,
        al.target_user_id,
        al.ip_address,
        al.execution_time,
        al.details
      FROM audit_logs al
      WHERE 1=1
    `;
    const params = [];
    
    if (action) {
      query += ' AND al.action = ?';
      params.push(action);
    }
    
    if (startDate) {
      query += ' AND DATE(al.created_at) >= ?';
      params.push(startDate);
    }
    
    if (endDate) {
      query += ' AND DATE(al.created_at) <= ?';
      params.push(endDate);
    }
    
    query += ' ORDER BY al.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(pageSize), offset);
    
    const logs = db.prepare(query).all(...params);
    
    // 获取总数
    let countQuery = `
      SELECT COUNT(*) as total
      FROM audit_logs al
      WHERE 1=1
    `;
    const countParams = [];
    
    if (action) {
      countQuery += ' AND al.action = ?';
      countParams.push(action);
    }
    
    if (startDate) {
      countQuery += ' AND DATE(al.created_at) >= ?';
      countParams.push(startDate);
    }
    
    if (endDate) {
      countQuery += ' AND DATE(al.created_at) <= ?';
      countParams.push(endDate);
    }
    
    const total = db.prepare(countQuery).get(...countParams).total;
    
    res.json({
      success: true,
      data: {
        logs,
        total,
        page: parseInt(page),
        pageSize: parseInt(pageSize)
      }
    });
  } catch (error) {
    console.error('获取审计日志错误:', error);
    res.json({ success: false, message: '获取失败: ' + error.message });
  }
});

/**
 * API: 审核通过用户
 * PUT /api/super-admin/users/:id/approve
 */
app.put('/api/super-admin/users/:id/approve', authenticateToken, requireSuperAdmin, auditLog('approve_user'), async (req, res) => {
  try {
    const userId = parseInt(req.params.id);

    const user = db.prepare('SELECT id, username, email, approval_status FROM users WHERE id = ?').get(userId);
    if (!user) {
      return res.json({ success: false, message: '用户不存在' });
    }

    if (user.approval_status === 'approved') {
      return res.json({ success: false, message: '用户已通过审核' });
    }

    db.prepare(`
      UPDATE users 
      SET approval_status = 'approved',
          updated_at = datetime('now')
      WHERE id = ?
    `).run(userId);

    console.log(`✅ 超级管理员审核通过用户: ${user.username} (${user.email}, ID: ${userId})`);

    res.json({
      success: true,
      message: '用户审核通过'
    });
  } catch (error) {
    console.error('审核用户错误:', error);
    res.json({ success: false, message: '审核失败: ' + error.message });
  }
});

/**
 * API: 审核拒绝用户
 * PUT /api/super-admin/users/:id/reject
 */
app.put('/api/super-admin/users/:id/reject', authenticateToken, requireSuperAdmin, auditLog('reject_user'), async (req, res) => {
  try {
    const userId = parseInt(req.params.id);

    const user = db.prepare('SELECT id, username, email, approval_status FROM users WHERE id = ?').get(userId);
    if (!user) {
      return res.json({ success: false, message: '用户不存在' });
    }

    if (user.approval_status === 'rejected') {
      return res.json({ success: false, message: '用户已被拒绝' });
    }

    db.prepare(`
      UPDATE users 
      SET approval_status = 'rejected',
          updated_at = datetime('now')
      WHERE id = ?
    `).run(userId);

    console.log(`✅ 超级管理员审核拒绝用户: ${user.username} (${user.email}, ID: ${userId})`);

    res.json({
      success: true,
      message: '用户审核已拒绝'
    });
  } catch (error) {
    console.error('审核用户错误:', error);
    res.json({ success: false, message: '审核失败: ' + error.message });
  }
});
/**
 * API: 批量审核用户
 * POST /api/super-admin/users/batch-approve
 */
app.post('/api/super-admin/users/batch-approve', authenticateToken, requireSuperAdmin, auditLog('batch_approve_users'), async (req, res) => {
  try {
    const { user_ids, action } = req.body; // action: 'approve' or 'reject'

    if (!user_ids || !Array.isArray(user_ids) || user_ids.length === 0) {
      return res.json({ success: false, message: '请选择要审核的用户' });
    }

    if (!['approve', 'reject'].includes(action)) {
      return res.json({ success: false, message: '无效的操作类型' });
    }

    const approvalStatus = action === 'approve' ? 'approved' : 'rejected';
    let successCount = 0;
    let failCount = 0;

    user_ids.forEach(userId => {
      try {
        const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(userId);
        if (!user) {
          failCount++;
          return;
        }

        // 不能审核超级管理员
        if (user.role === 'super_admin') {
          failCount++;
          return;
        }

        db.prepare(`
          UPDATE users 
          SET approval_status = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(approvalStatus, userId);

        successCount++;
      } catch (error) {
        console.error(`批量审核用户错误 (ID: ${userId}):`, error);
        failCount++;
      }
    });

    console.log(`✅ 批量${action === 'approve' ? '通过' : '拒绝'}用户: 成功 ${successCount} 个，失败 ${failCount} 个`);

    res.json({
      success: true,
      message: `批量${action === 'approve' ? '通过' : '拒绝'}完成`,
      data: {
        success_count: successCount,
        fail_count: failCount
      }
    });
  } catch (error) {
    console.error('批量审核用户错误:', error);
    res.json({ success: false, message: '批量审核失败: ' + error.message });
  }
});

/**
 * API: 获取用户详情
 * GET /api/super-admin/users/:id
 */
app.get('/api/super-admin/users/:id', authenticateToken, requireSuperAdmin, auditLog('view_user_detail'), (req, res) => {
  try {
    const userId = parseInt(req.params.id);

    // 获取用户基本信息
    const user = db.prepare(`
      SELECT id, username, email, role, created_at, updated_at, is_active 
      FROM users 
      WHERE id = ?
    `).get(userId);

    if (!user) {
      return res.json({ success: false, message: '用户不存在' });
    }

    // 获取统计信息
    const stats = db.prepare(`
      SELECT 
        (SELECT COUNT(*) FROM platform_accounts WHERE user_id = ?) as platform_accounts,
        (SELECT COUNT(*) FROM orders WHERE user_id = ?) as total_orders,
        (SELECT COALESCE(SUM(order_amount), 0) FROM orders WHERE user_id = ?) as total_amount,
        (SELECT COALESCE(SUM(commission), 0) FROM orders WHERE user_id = ?) as total_commission,
        (SELECT COUNT(*) FROM google_sheets WHERE user_id = ?) as google_sheets
    `).get(userId, userId, userId, userId, userId);

    res.json({
      success: true,
      data: {
        user,
        stats
      }
    });
  } catch (error) {
    console.error('获取用户详情错误:', error);
    res.json({ success: false, message: '获取失败: ' + error.message });
  }
});

/**
 * API: 获取用户的平台账号
 * GET /api/super-admin/users/:id/accounts
 */
app.get('/api/super-admin/users/:id/accounts', authenticateToken, requireSuperAdmin, auditLog('view_user_accounts'), (req, res) => {
  try {
    const userId = parseInt(req.params.id);

    const accounts = db.prepare(`
      SELECT id, platform, account_name, affiliate_name, is_active, created_at
      FROM platform_accounts
      WHERE user_id = ?
      ORDER BY created_at DESC
    `).all(userId);

    res.json({
      success: true,
      data: accounts
    });
  } catch (error) {
    console.error('获取用户平台账号错误:', error);
    res.json({ success: false, message: '获取失败: ' + error.message });
  }
});

/**
 * API: 获取用户的订单数据
 * GET /api/super-admin/users/:id/orders
 */
app.get('/api/super-admin/users/:id/orders', authenticateToken, requireSuperAdmin, auditLog('view_user_orders'), (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { startDate, endDate, page = 1, pageSize = 50 } = req.query;
    const offset = (page - 1) * pageSize;

    let query = 'SELECT COUNT(*) as total FROM orders WHERE user_id = ?';
    let params = [userId];

    if (startDate) {
      query += ' AND order_date >= ?';
      params.push(startDate);
    }

    if (endDate) {
      query += ' AND order_date <= ?';
      params.push(endDate);
    }

    const { total } = db.prepare(query).get(...params);

    // 获取订单列表
    let ordersQuery = query.replace('COUNT(*) as total', '*') + ' ORDER BY order_date DESC LIMIT ? OFFSET ?';
    const orders = db.prepare(ordersQuery).all(...params, pageSize, offset);

    res.json({
      success: true,
      data: {
        total,
        page: parseInt(page),
        pageSize: parseInt(pageSize),
        orders
      }
    });
  } catch (error) {
    console.error('获取用户订单错误:', error);
    res.json({ success: false, message: '获取失败: ' + error.message });
  }
});
/**
 * API: 获取用户的广告数据
 * GET /api/super-admin/users/:id/ads-data
 */
app.get('/api/super-admin/users/:id/ads-data', authenticateToken, requireSuperAdmin, auditLog('view_user_ads'), (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { startDate, endDate, page = 1, pageSize = 50 } = req.query;
    const offset = (page - 1) * pageSize;

    let query = 'SELECT COUNT(*) as total FROM google_ads_data WHERE user_id = ?';
    let params = [userId];

    if (startDate) {
      query += ' AND date >= ?';
      params.push(startDate);
    }

    if (endDate) {
      query += ' AND date <= ?';
      params.push(endDate);
    }

    const { total } = db.prepare(query).get(...params);

    // 获取广告数据列表
    let adsQuery = query.replace('COUNT(*) as total', '*') + ' ORDER BY date DESC, campaign_name ASC LIMIT ? OFFSET ?';
    const adsData = db.prepare(adsQuery).all(...params, pageSize, offset);

    res.json({
      success: true,
      data: {
        total,
        page: parseInt(page),
        pageSize: parseInt(pageSize),
        adsData
      }
    });
  } catch (error) {
    console.error('获取用户广告数据错误:', error);
    res.json({ success: false, message: '获取失败: ' + error.message });
  }
});
/**
 * API: 获取用户的商家汇总
 * GET /api/super-admin/users/:id/summary
 */
app.get('/api/super-admin/users/:id/summary', authenticateToken, requireSuperAdmin, auditLog('view_user_summary'), (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { startDate, endDate } = req.query;

    // 复用现有的商家汇总逻辑，但使用指定的userId
    let adsQuery = `
      SELECT
        merchant_id,
        LOWER(affiliate_name) as affiliate_name,
        GROUP_CONCAT(DISTINCT campaign_name) as campaign_names,
        MAX(campaign_budget) as total_budget,
        MAX(currency) as currency,
        SUM(impressions) as total_impressions,
        SUM(clicks) as total_clicks,
        SUM(cost) as total_cost
      FROM google_ads_data
      WHERE user_id = ? AND campaign_name IS NOT NULL AND campaign_name != ''
    `;

    const adsParams = [userId];

    if (startDate) {
      adsQuery += ' AND date >= ?';
      adsParams.push(startDate);
    }

    if (endDate) {
      adsQuery += ' AND date <= ?';
      adsParams.push(endDate);
    }

    adsQuery += ' GROUP BY merchant_id, LOWER(affiliate_name)';

    const adsSummary = db.prepare(adsQuery).all(...adsParams);

    // 获取订单汇总
    let orderQuery = `
      SELECT
        o.merchant_id,
        o.merchant_name,
        o.merchant_slug,
        LOWER(pa.affiliate_name) as affiliate_name,
        COUNT(*) as order_count,
        SUM(o.order_amount) as total_amount,
        SUM(o.commission) as total_commission,
        SUM(CASE WHEN o.status = 'Approved' THEN o.commission ELSE 0 END) as confirmed_commission,
        SUM(CASE WHEN o.status = 'Pending' THEN o.commission ELSE 0 END) as pending_commission,
        SUM(CASE WHEN o.status = 'Rejected' THEN o.commission ELSE 0 END) as rejected_commission
      FROM orders o
      LEFT JOIN platform_accounts pa ON o.platform_account_id = pa.id
      WHERE o.user_id = ?
    `;

    const orderParams = [userId];

    if (startDate) {
      orderQuery += ' AND o.order_date >= ?';
      orderParams.push(startDate);
    }

    if (endDate) {
      orderQuery += ' AND o.order_date <= ?';
      orderParams.push(endDate);
    }

    orderQuery += ' GROUP BY o.user_id, LOWER(pa.affiliate_name), o.merchant_id ORDER BY total_commission DESC';

    const orderSummary = db.prepare(orderQuery).all(...orderParams);

    // 合并数据
    const adsMap = new Map();
    adsSummary.forEach(ads => {
      const key = `${userId}_${(ads.affiliate_name || '').toLowerCase()}_${ads.merchant_id}`;
      adsMap.set(key, ads);
    });

    const mergedSummary = [];
    const processedKeys = new Set();

    orderSummary.forEach(order => {
      const key = `${userId}_${(order.affiliate_name || '').toLowerCase()}_${order.merchant_id}`;
      const matchingAds = adsMap.get(key);

      if (matchingAds) {
        mergedSummary.push({
          ...order,
          campaign_names: matchingAds.campaign_names,
          total_budget: matchingAds.total_budget,
          total_impressions: matchingAds.total_impressions,
          total_clicks: matchingAds.total_clicks,
          total_cost: matchingAds.total_cost
        });
        processedKeys.add(key);
      }
    });

    // 添加纯广告数据
    adsSummary.forEach(ads => {
      const key = `${userId}_${(ads.affiliate_name || '').toLowerCase()}_${ads.merchant_id}`;
      if (!processedKeys.has(key)) {
        mergedSummary.push({
          merchant_id: ads.merchant_id,
          merchant_name: '',
          merchant_slug: '',
          affiliate_name: ads.affiliate_name,
          order_count: 0,
          total_amount: 0,
          total_commission: 0,
          confirmed_commission: 0,
          pending_commission: 0,
          rejected_commission: 0,
          campaign_names: ads.campaign_names,
          total_budget: ads.total_budget,
          total_impressions: ads.total_impressions,
          total_clicks: ads.total_clicks,
          total_cost: ads.total_cost
        });
      }
    });

    const filteredSummary = mergedSummary.filter(merchant => 
      merchant.campaign_names && 
      merchant.campaign_names.trim() !== '' && 
      merchant.campaign_names !== '-'
    );

    res.json({ success: true, data: filteredSummary });
  } catch (error) {
    console.error('获取用户商家汇总错误:', error);
    res.json({ success: false, message: '获取失败: ' + error.message });
  }
});

/**
 * API: 获取全平台统计数据
 * GET /api/super-admin/platform-stats
 */
app.get('/api/super-admin/platform-stats', authenticateToken, requireSuperAdmin, auditLog('view_platform_stats'), (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    console.log(`📊 [平台统计API] 请求参数: startDate=${startDate}, endDate=${endDate}`);

    // 用户统计
    const userStats = db.prepare(`
      SELECT 
        COUNT(*) as total_users,
        SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active_users,
        SUM(CASE WHEN strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now') THEN 1 ELSE 0 END) as new_this_month
      FROM users 
      WHERE role = 'user'
    `).get();

    // 平台账号统计
    const platformAccountStats = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN platform = 'linkhaitao' THEN 1 ELSE 0 END) as linkhaitao,
        SUM(CASE WHEN platform = 'partnermatic' THEN 1 ELSE 0 END) as partnermatic,
        SUM(CASE WHEN platform = 'linkbux' THEN 1 ELSE 0 END) as linkbux,
        SUM(CASE WHEN platform = 'rewardoo' THEN 1 ELSE 0 END) as rewardoo
      FROM platform_accounts
    `).get();

    // 订单统计（只统计有广告数据的商家对应的订单，与用户管理统计分析逻辑保持一致）
    // 使用EXISTS子查询：只统计在日期范围内有广告数据（有campaign_name）的商家对应的订单
    let orderQuery = `
      SELECT 
        COUNT(*) as total_orders,
        COALESCE(SUM(o.order_amount), 0) as total_amount,
        COALESCE(SUM(o.commission), 0) as total_commission,
        COALESCE(SUM(CASE WHEN o.status = 'Approved' THEN o.commission ELSE 0 END), 0) as confirmed_commission,
        COALESCE(SUM(CASE WHEN o.status = 'Pending' THEN o.commission ELSE 0 END), 0) as pending_commission
      FROM orders o
      LEFT JOIN platform_accounts pa ON o.platform_account_id = pa.id
      WHERE 1=1
    `;
    const orderParams = [];

    if (startDate) {
      orderQuery += ' AND DATE(o.order_date) >= ?';
      orderParams.push(startDate);
    }

    if (endDate) {
      orderQuery += ' AND DATE(o.order_date) <= ?';
      orderParams.push(endDate);
    }

    // 只统计有广告数据的商家对应的订单（与用户贡献度排行逻辑一致）
    orderQuery += ` AND EXISTS (
      SELECT 1 
      FROM google_ads_data gads
      WHERE gads.user_id = o.user_id
        AND gads.merchant_id = o.merchant_id
        AND LOWER(COALESCE(gads.affiliate_name, '')) = LOWER(COALESCE(pa.affiliate_name, ''))
        AND gads.campaign_name IS NOT NULL 
        AND gads.campaign_name != ''
    `;
    
    if (startDate) {
      orderQuery += ' AND DATE(gads.date) >= ?';
      orderParams.push(startDate);
    }

    if (endDate) {
      orderQuery += ' AND DATE(gads.date) <= ?';
      orderParams.push(endDate);
    }
    
    orderQuery += ' )';

    console.log(`📊 [平台统计API] 订单查询SQL: ${orderQuery}`);
    console.log(`📊 [平台统计API] 订单查询参数:`, orderParams);

    const orderStats = db.prepare(orderQuery).get(...orderParams);

    console.log(`📊 [平台统计API] 订单统计结果:`, {
      total_orders: orderStats.total_orders,
      total_commission: orderStats.total_commission,
      date_range: `${startDate || '全部'} 至 ${endDate || '今天'}`
    });
    
    // 验证：检查订单数据日期范围
    if (startDate || endDate) {
      const orderDateRange = db.prepare(`
        SELECT 
          MIN(DATE(order_date)) as min_date,
          MAX(DATE(order_date)) as max_date,
          COUNT(*) as total
        FROM orders
        ${startDate ? `WHERE DATE(order_date) >= '${startDate}'` : 'WHERE 1=1'}
        ${endDate ? `AND DATE(order_date) <= '${endDate}'` : ''}
      `).get();
      
      console.log(`📊 [平台统计API] 订单日期范围验证:`, {
        查询日期范围: `${startDate || '无限制'} 至 ${endDate || '无限制'}`,
        实际订单日期范围: `${orderDateRange.min_date || '无'} 至 ${orderDateRange.max_date || '无'}`,
        订单总数: orderDateRange.total
      });
      
      // 检查是否有11月2日的数据被包含
      const nov2Check = db.prepare(`
        SELECT COUNT(*) as count, COALESCE(SUM(commission), 0) as total_commission
        FROM orders
        WHERE DATE(order_date) = '2025-11-02'
      `).get();
      
      if (nov2Check && nov2Check.count > 0) {
        console.log(`⚠️ [平台统计API] 发现11月2日订单数据:`, {
          订单数: nov2Check.count,
          佣金: nov2Check.total_commission
        });
      }
    }

    // 广告统计（使用DATE函数确保日期比较准确）
    let adsQuery = `
      SELECT 
        COALESCE(SUM(cost), 0) as total_cost,
        COALESCE(SUM(impressions), 0) as total_impressions,
        COALESCE(SUM(clicks), 0) as total_clicks
      FROM google_ads_data
      WHERE 1=1
    `;
    const adsParams = [];

    if (startDate) {
      adsQuery += ' AND DATE(date) >= ?';
      adsParams.push(startDate);
    }

    if (endDate) {
      adsQuery += ' AND DATE(date) <= ?';
      adsParams.push(endDate);
    }

    console.log(`📊 [平台统计API] 广告查询SQL: ${adsQuery}`);
    console.log(`📊 [平台统计API] 广告查询参数:`, adsParams);

    const adsStats = db.prepare(adsQuery).get(...adsParams);
    
    console.log(`📊 [平台统计API] 广告统计结果:`, {
      total_cost: adsStats.total_cost,
      total_impressions: adsStats.total_impressions,
      total_clicks: adsStats.total_clicks,
      date_range: `${startDate || '全部'} 至 ${endDate || '今天'}`
    });

    // 计算ROI
    const profit = orderStats.total_commission - adsStats.total_cost;
    const roi = adsStats.total_cost > 0 ? profit / adsStats.total_cost : 0;

    res.json({
      success: true,
      data: {
        users: {
          total: userStats.total_users,
          active: userStats.active_users,
          new_this_month: userStats.new_this_month
        },
        platform_accounts: {
          total: platformAccountStats.total,
          by_platform: {
            linkhaitao: platformAccountStats.linkhaitao,
            partnermatic: platformAccountStats.partnermatic,
            linkbux: platformAccountStats.linkbux,
            rewardoo: platformAccountStats.rewardoo
          }
        },
        orders: {
          total: orderStats.total_orders,
          total_amount: orderStats.total_amount,
          total_commission: orderStats.total_commission,
          confirmed_commission: orderStats.confirmed_commission,
          pending_commission: orderStats.pending_commission
        },
        ads: {
          total_cost: adsStats.total_cost,
          total_impressions: adsStats.total_impressions,
          total_clicks: adsStats.total_clicks
        },
        roi: {
          overall: roi,
          profit: profit
        }
      }
    });
  } catch (error) {
    console.error('获取平台统计错误:', error);
    res.json({ success: false, message: '获取失败: ' + error.message });
  }
});

/**
 * POST /api/super-admin/export/platform-stats
 * 导出平台统计数据
 */
app.post('/api/super-admin/export/platform-stats', authenticateToken, requireSuperAdmin, auditLog('export_platform_stats'), async (req, res) => {
  try {
    const { startDate, endDate } = req.body;

    console.log(`📊 超管导出平台统计Excel：日期=${startDate}至${endDate}`);

    // 用户统计
    const userStats = db.prepare(`
      SELECT 
        COUNT(*) as total_users,
        SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active_users,
        SUM(CASE WHEN strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now') THEN 1 ELSE 0 END) as new_this_month
      FROM users 
      WHERE role = 'user'
    `).get();

    // 平台账号统计
    const platformAccountStats = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN platform = 'linkhaitao' THEN 1 ELSE 0 END) as linkhaitao,
        SUM(CASE WHEN platform = 'partnermatic' THEN 1 ELSE 0 END) as partnermatic,
        SUM(CASE WHEN platform = 'linkbux' THEN 1 ELSE 0 END) as linkbux,
        SUM(CASE WHEN platform = 'rewardoo' THEN 1 ELSE 0 END) as rewardoo
      FROM platform_accounts
    `).get();

    // 订单统计
    let orderQuery = `
      SELECT 
        COUNT(*) as total_orders,
        COALESCE(SUM(o.order_amount), 0) as total_amount,
        COALESCE(SUM(o.commission), 0) as total_commission,
        COALESCE(SUM(CASE WHEN o.status = 'Approved' THEN o.commission ELSE 0 END), 0) as confirmed_commission,
        COALESCE(SUM(CASE WHEN o.status = 'Pending' THEN o.commission ELSE 0 END), 0) as pending_commission
      FROM orders o
      LEFT JOIN platform_accounts pa ON o.platform_account_id = pa.id
      WHERE 1=1
    `;
    const orderParams = [];

    if (startDate) {
      orderQuery += ' AND DATE(o.order_date) >= ?';
      orderParams.push(startDate);
    }

    if (endDate) {
      orderQuery += ' AND DATE(o.order_date) <= ?';
      orderParams.push(endDate);
    }

    const orderStats = db.prepare(orderQuery).get(...orderParams);

    // 广告统计
    let adsQuery = `
      SELECT 
        COALESCE(SUM(cost), 0) as total_cost,
        COALESCE(SUM(impressions), 0) as total_impressions,
        COALESCE(SUM(clicks), 0) as total_clicks
      FROM google_ads_data
      WHERE 1=1
    `;
    const adsParams = [];

    if (startDate) {
      adsQuery += ' AND DATE(date) >= ?';
      adsParams.push(startDate);
    }

    if (endDate) {
      adsQuery += ' AND DATE(date) <= ?';
      adsParams.push(endDate);
    }

    const adsStats = db.prepare(adsQuery).get(...adsParams);

    // 计算ROI
    const profit = orderStats.total_commission - adsStats.total_cost;
    const roi = adsStats.total_cost > 0 ? profit / adsStats.total_cost : 0;

    // 创建Excel工作簿
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('平台统计');

    // 添加标题行
    worksheet.mergeCells('A1:B1');
    const titleCell = worksheet.getCell('A1');
    titleCell.value = '平台统计数据';
    titleCell.font = { size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    titleCell.border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' }
    };
    worksheet.getRow(1).height = 30;

    // 添加日期范围信息
    if (startDate || endDate) {
      worksheet.mergeCells('A2:B2');
      const dateCell = worksheet.getCell('A2');
      const dateRange = startDate && endDate ? `${startDate} 至 ${endDate}` : (startDate ? `从 ${startDate}` : `至 ${endDate}`);
      dateCell.value = `日期范围: ${dateRange}`;
      dateCell.font = { size: 12, color: { argb: 'FF6B7280' } };
      dateCell.alignment = { horizontal: 'center', vertical: 'middle' };
      worksheet.getRow(2).height = 25;
    }

    let currentRow = startDate || endDate ? 3 : 2;

    // 用户统计
    worksheet.getRow(currentRow).height = 25;
    worksheet.mergeCells(`A${currentRow}:B${currentRow}`);
    const userTitleCell = worksheet.getCell(`A${currentRow}`);
    userTitleCell.value = '用户统计';
    userTitleCell.font = { size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
    userTitleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B82F6' } };
    userTitleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    userTitleCell.border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' }
    };
    currentRow++;

    const userData = [
      ['总用户数', userStats.total_users],
      ['活跃用户', userStats.active_users],
      ['本月新增', userStats.new_this_month]
    ];

    userData.forEach(([label, value]) => {
      const row = worksheet.getRow(currentRow);
      row.getCell(1).value = label;
      row.getCell(1).font = { bold: true };
      row.getCell(2).value = value;
      row.getCell(2).numFmt = '#,##0';
      row.height = 20;
      row.eachCell(cell => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' }
        };
        cell.alignment = { vertical: 'middle' };
      });
      row.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };
      row.getCell(2).alignment = { horizontal: 'right', vertical: 'middle' };
      currentRow++;
    });

    currentRow++; // 空行

    // 平台账号统计
    worksheet.getRow(currentRow).height = 25;
    worksheet.mergeCells(`A${currentRow}:B${currentRow}`);
    const accountTitleCell = worksheet.getCell(`A${currentRow}`);
    accountTitleCell.value = '平台账号统计';
    accountTitleCell.font = { size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
    accountTitleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B82F6' } };
    accountTitleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    accountTitleCell.border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' }
    };
    currentRow++;

    const accountData = [
      ['总账号数', platformAccountStats.total],
      ['LinkHaitao', platformAccountStats.linkhaitao],
      ['PartnerMatic', platformAccountStats.partnermatic],
      ['LinkBux', platformAccountStats.linkbux],
      ['Rewardoo', platformAccountStats.rewardoo]
    ];

    accountData.forEach(([label, value]) => {
      const row = worksheet.getRow(currentRow);
      row.getCell(1).value = label;
      row.getCell(1).font = { bold: true };
      row.getCell(2).value = value;
      row.getCell(2).numFmt = '#,##0';
      row.height = 20;
      row.eachCell(cell => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' }
        };
        cell.alignment = { vertical: 'middle' };
      });
      row.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };
      row.getCell(2).alignment = { horizontal: 'right', vertical: 'middle' };
      currentRow++;
    });

    currentRow++; // 空行

    // 订单统计
    worksheet.getRow(currentRow).height = 25;
    worksheet.mergeCells(`A${currentRow}:B${currentRow}`);
    const orderTitleCell = worksheet.getCell(`A${currentRow}`);
    orderTitleCell.value = '订单统计';
    orderTitleCell.font = { size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
    orderTitleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B82F6' } };
    orderTitleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    orderTitleCell.border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' }
    };
    currentRow++;

    const orderData = [
      ['总订单数', orderStats.total_orders],
      ['订单总金额', orderStats.total_amount],
      ['总佣金', orderStats.total_commission],
      ['已确认佣金', orderStats.confirmed_commission],
      ['待确认佣金', orderStats.pending_commission]
    ];

    orderData.forEach(([label, value]) => {
      const row = worksheet.getRow(currentRow);
      row.getCell(1).value = label;
      row.getCell(1).font = { bold: true };
      row.getCell(2).value = value;
      if (label.includes('金额') || label.includes('佣金')) {
        row.getCell(2).numFmt = '$#,##0.00';
      } else {
        row.getCell(2).numFmt = '#,##0';
      }
      row.height = 20;
      row.eachCell(cell => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' }
        };
        cell.alignment = { vertical: 'middle' };
      });
      row.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };
      row.getCell(2).alignment = { horizontal: 'right', vertical: 'middle' };
      currentRow++;
    });

    currentRow++; // 空行

    // 广告统计
    worksheet.getRow(currentRow).height = 25;
    worksheet.mergeCells(`A${currentRow}:B${currentRow}`);
    const adsTitleCell = worksheet.getCell(`A${currentRow}`);
    adsTitleCell.value = '广告统计';
    adsTitleCell.font = { size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
    adsTitleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B82F6' } };
    adsTitleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    adsTitleCell.border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' }
    };
    currentRow++;

    const adsData = [
      ['总广告费', adsStats.total_cost],
      ['总展示数', adsStats.total_impressions],
      ['总点击数', adsStats.total_clicks]
    ];

    adsData.forEach(([label, value]) => {
      const row = worksheet.getRow(currentRow);
      row.getCell(1).value = label;
      row.getCell(1).font = { bold: true };
      row.getCell(2).value = value;
      if (label.includes('广告费')) {
        row.getCell(2).numFmt = '$#,##0.00';
      } else {
        row.getCell(2).numFmt = '#,##0';
      }
      row.height = 20;
      row.eachCell(cell => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' }
        };
        cell.alignment = { vertical: 'middle' };
      });
      row.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };
      row.getCell(2).alignment = { horizontal: 'right', vertical: 'middle' };
      currentRow++;
    });

    currentRow++; // 空行

    // ROI统计
    worksheet.getRow(currentRow).height = 25;
    worksheet.mergeCells(`A${currentRow}:B${currentRow}`);
    const roiTitleCell = worksheet.getCell(`A${currentRow}`);
    roiTitleCell.value = 'ROI统计';
    roiTitleCell.font = { size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
    roiTitleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B82F6' } };
    roiTitleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    roiTitleCell.border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' }
    };
    currentRow++;

    const roiData = [
      ['净利润', profit],
      ['ROI', roi]
    ];

    roiData.forEach(([label, value]) => {
      const row = worksheet.getRow(currentRow);
      row.getCell(1).value = label;
      row.getCell(1).font = { bold: true };
      row.getCell(2).value = value;
      if (label === '净利润') {
        row.getCell(2).numFmt = '$#,##0.00';
        // ROI颜色
        const profitCell = row.getCell(2);
        if (profit >= 0) {
          profitCell.font = { color: { argb: 'FF28A745' }, bold: true };
        } else {
          profitCell.font = { color: { argb: 'FFDC3545' }, bold: true };
        }
      } else {
        row.getCell(2).numFmt = '0.00%';
        // ROI颜色
        const roiCell = row.getCell(2);
        if (roi >= 0) {
          roiCell.font = { color: { argb: 'FF28A745' }, bold: true };
        } else {
          roiCell.font = { color: { argb: 'FFDC3545' }, bold: true };
        }
      }
      row.height = 20;
      row.eachCell(cell => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' }
        };
        cell.alignment = { vertical: 'middle' };
      });
      row.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };
      row.getCell(2).alignment = { horizontal: 'right', vertical: 'middle' };
      currentRow++;
    });

    // 设置列宽
    worksheet.columns = [
      { key: 'label', width: 25 },
      { key: 'value', width: 20 }
    ];

    // 生成文件名
    const dateStr = startDate && endDate ? `${startDate}至${endDate}` : '全部数据';
    const filename = `平台统计_${dateStr}.xlsx`;

    // 设置响应头
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);

    // 写入响应流
    await workbook.xlsx.write(res);
    res.end();

    console.log(`✅ 超管平台统计Excel导出成功：${filename}`);

  } catch (error) {
    console.error('超管导出平台统计Excel错误:', error);
    res.json({ success: false, message: '导出失败: ' + error.message });
  }
});

/**
 * API: 获取全平台商家汇总
 * GET /api/super-admin/platform-summary
 */
app.get('/api/super-admin/platform-summary', authenticateToken, requireSuperAdmin, auditLog('view_platform_summary'), (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    // 获取所有用户的广告数据汇总
    let adsQuery = `
      SELECT
        user_id,
        merchant_id,
        LOWER(affiliate_name) as affiliate_name,
        GROUP_CONCAT(DISTINCT campaign_name) as campaign_names,
        SUM(impressions) as total_impressions,
        SUM(clicks) as total_clicks,
        SUM(cost) as total_cost
      FROM google_ads_data
      WHERE campaign_name IS NOT NULL AND campaign_name != ''
    `;

    const adsParams = [];

    if (startDate) {
      adsQuery += ' AND date >= ?';
      adsParams.push(startDate);
    }

    if (endDate) {
      adsQuery += ' AND date <= ?';
      adsParams.push(endDate);
    }

    adsQuery += ' GROUP BY user_id, merchant_id, LOWER(affiliate_name)';

    const adsSummary = db.prepare(adsQuery).all(...adsParams);

    // 获取所有用户的订单汇总
    let orderQuery = `
      SELECT
        o.user_id,
        o.merchant_id,
        o.merchant_name,
        LOWER(pa.affiliate_name) as affiliate_name,
        COUNT(*) as order_count,
        SUM(o.order_amount) as total_amount,
        SUM(o.commission) as total_commission
      FROM orders o
      LEFT JOIN platform_accounts pa ON o.platform_account_id = pa.id
      WHERE 1=1
    `;

    const orderParams = [];

    if (startDate) {
      orderQuery += ' AND o.order_date >= ?';
      orderParams.push(startDate);
    }

    if (endDate) {
      orderQuery += ' AND o.order_date <= ?';
      orderParams.push(endDate);
    }

    orderQuery += ' GROUP BY o.user_id, LOWER(pa.affiliate_name), o.merchant_id';

    const orderSummary = db.prepare(orderQuery).all(...orderParams);

    // 按商家ID和联盟名称聚合全平台数据
    const platformMap = new Map();

    // 处理广告数据
    adsSummary.forEach(ads => {
      const key = `${ads.merchant_id}_${(ads.affiliate_name || '').toLowerCase()}`;
      if (!platformMap.has(key)) {
        platformMap.set(key, {
          merchant_id: ads.merchant_id,
          affiliate_name: ads.affiliate_name,
          campaign_names: ads.campaign_names,
          total_impressions: 0,
          total_clicks: 0,
          total_cost: 0,
          order_count: 0,
          total_amount: 0,
          total_commission: 0
        });
      }
      const item = platformMap.get(key);
      item.total_impressions += ads.total_impressions || 0;
      item.total_clicks += ads.total_clicks || 0;
      item.total_cost += ads.total_cost || 0;
    });

    // 处理订单数据
    orderSummary.forEach(order => {
      const key = `${order.merchant_id}_${(order.affiliate_name || '').toLowerCase()}`;
      if (!platformMap.has(key)) {
        platformMap.set(key, {
          merchant_id: order.merchant_id,
          merchant_name: order.merchant_name,
          affiliate_name: order.affiliate_name,
          campaign_names: '',
          total_impressions: 0,
          total_clicks: 0,
          total_cost: 0,
          order_count: 0,
          total_amount: 0,
          total_commission: 0
        });
      }
      const item = platformMap.get(key);
      item.merchant_name = order.merchant_name;
      item.order_count += order.order_count || 0;
      item.total_amount += order.total_amount || 0;
      item.total_commission += order.total_commission || 0;
    });

    // 转换为数组并排序
    const platformSummary = Array.from(platformMap.values())
      .filter(item => item.campaign_names && item.campaign_names.trim() !== '')
      .sort((a, b) => b.total_commission - a.total_commission);

    res.json({ success: true, data: platformSummary });
  } catch (error) {
    console.error('获取平台商家汇总错误:', error);
    res.json({ success: false, message: '获取失败: ' + error.message });
  }
});
/**
 * API: 创建新用户
 * POST /api/super-admin/users
 */
app.post('/api/super-admin/users', authenticateToken, requireSuperAdmin, auditLog('create_user'), async (req, res) => {
  try {
    const { username, email, password, role = 'user' } = req.body;

    // 验证必填字段
    if (!email || !password) {
      return res.json({ success: false, message: '邮箱和密码为必填项' });
    }

    // 检查邮箱是否已存在
    const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existingUser) {
      return res.json({ success: false, message: '该邮箱已被注册' });
    }

    // 检查用户名是否已存在（如果提供）
    if (username) {
      const existingUsername = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (existingUsername) {
        return res.json({ success: false, message: '该用户名已被使用' });
      }
    }

    // 验证角色
    if (!['user', 'super_admin'].includes(role)) {
      return res.json({ success: false, message: '无效的用户角色' });
    }

    // 加密密码
    const bcrypt = require('bcryptjs');
    const hashedPassword = await bcrypt.hash(password, 10);

    // 创建用户（超管创建的用户自动通过审核）
    const result = db.prepare(`
      INSERT INTO users (username, email, password_hash, role, is_active, approval_status, created_at)
      VALUES (?, ?, ?, ?, 1, 'approved', datetime('now'))
    `).run(username || null, email, hashedPassword, role);

    console.log(`✅ 超级管理员创建了新用户: ${email} (ID: ${result.lastInsertRowid})`);

    res.json({
      success: true,
      message: '用户创建成功',
      data: {
        id: result.lastInsertRowid,
        username: username || null,
        email,
        role
      }
    });
  } catch (error) {
    console.error('创建用户错误:', error);
    res.json({ success: false, message: '创建失败: ' + error.message });
  }
});
/**
 * API: 更新用户信息
 * PUT /api/super-admin/users/:id
 */
app.put('/api/super-admin/users/:id', authenticateToken, requireSuperAdmin, auditLog('update_user'), async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { username, email, password, is_active } = req.body;

    // 不能修改自己
    if (userId === req.user.id) {
      return res.json({ success: false, message: '不能修改自己的账号信息，请使用个人设置功能' });
    }

    // 检查用户是否存在
    const user = db.prepare('SELECT id, email, username, role FROM users WHERE id = ?').get(userId);
    if (!user) {
      return res.json({ success: false, message: '用户不存在' });
    }

    // 不允许修改其他超级管理员（除了is_active）
    if (user.role === 'super_admin' && (username || email || password)) {
      return res.json({ success: false, message: '不能修改其他超级管理员的用户名、邮箱或密码' });
    }

    const updates = [];
    const params = [];

    // 更新用户名
    if (username !== undefined && username !== null) {
      const trimmedUsername = username.trim();
      if (trimmedUsername === '') {
        return res.json({ success: false, message: '用户名不能为空' });
      }
      
      // 检查用户名是否已被其他用户使用
      const existingUser = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(trimmedUsername, userId);
      if (existingUser) {
        return res.json({ success: false, message: '用户名已被使用' });
      }
      
      updates.push('username = ?');
      params.push(trimmedUsername);
    }

    // 更新邮箱
    if (email !== undefined && email !== null) {
      const trimmedEmail = email.trim();
      if (trimmedEmail === '') {
        return res.json({ success: false, message: '邮箱不能为空' });
      }
      
      // 验证邮箱格式
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(trimmedEmail)) {
        return res.json({ success: false, message: '邮箱格式不正确' });
      }
      
      // 检查邮箱是否已被其他用户使用
      const existingUser = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(trimmedEmail, userId);
      if (existingUser) {
        return res.json({ success: false, message: '邮箱已被使用' });
      }
      
      updates.push('email = ?');
      params.push(trimmedEmail);
    }

    // 重置密码
    if (password !== undefined && password !== null) {
      if (password.length < 6) {
        return res.json({ success: false, message: '密码至少需要6位' });
      }
      
      const bcrypt = require('bcryptjs');
      const hashedPassword = await bcrypt.hash(password, 10);
      updates.push('password_hash = ?');
      params.push(hashedPassword);
    }

    // 更新账号状态（启用/禁用）
    if (is_active !== undefined && is_active !== null) {
      updates.push('is_active = ?');
      params.push(is_active ? 1 : 0);
    }

    // 如果没有要更新的内容
    if (updates.length === 0) {
      return res.json({ success: false, message: '没有提供要更新的信息' });
    }

    // 添加updated_at
    updates.push('updated_at = CURRENT_TIMESTAMP');
    
    // 添加userId参数
    params.push(userId);

    // 执行更新
    const updateQuery = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;
    db.prepare(updateQuery).run(...params);

    console.log(`✅ 超级管理员更新了用户信息: ${user.email} (ID: ${userId})`);

    // 获取更新后的用户信息
    const updatedUser = db.prepare('SELECT id, username, email, is_active, updated_at FROM users WHERE id = ?').get(userId);

    res.json({
      success: true,
      message: '用户信息更新成功',
      data: updatedUser
    });
  } catch (error) {
    console.error('更新用户信息错误:', error);
    res.json({ success: false, message: '更新失败: ' + error.message });
  }
});

/**
 * API: 删除用户
 * DELETE /api/super-admin/users/:id
 */
app.delete('/api/super-admin/users/:id', authenticateToken, requireSuperAdmin, (req, res) => {
  try {
    const userId = parseInt(req.params.id);

    // 不能删除自己
    if (userId === req.user.id) {
      return res.json({ success: false, message: '不能删除自己的账号' });
    }

    // 检查用户是否存在
    const user = db.prepare('SELECT id, email, username, role FROM users WHERE id = ?').get(userId);
    if (!user) {
      return res.json({ success: false, message: '用户不存在' });
    }

    // 不允许删除其他超级管理员
    if (user.role === 'super_admin') {
      return res.json({ success: false, message: '不能删除超级管理员账号' });
    }

    // 记录审计日志（在删除之前）
    try {
      db.prepare(`
        INSERT INTO audit_logs (
          admin_id, admin_username, action, target_user_id, target_username,
          request_path, request_method, ip_address, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        req.user.id,
        req.user.username,
        'delete_user',
        userId,
        user.username || user.email,
        req.path,
        req.method,
        req.ip || req.connection.remoteAddress
      );
    } catch (auditError) {
      console.error('❌ 审计日志记录失败:', auditError.message);
    }

    // 开始事务删除用户及其相关数据
    const deleteTransaction = db.transaction(() => {
      // 删除审计日志（管理员相关）
      db.prepare('DELETE FROM audit_logs WHERE admin_id = ?').run(userId);
      
      // 删除审计日志（目标用户相关）
      db.prepare('DELETE FROM audit_logs WHERE target_user_id = ?').run(userId);
      
      // 删除用户的平台账号
      db.prepare('DELETE FROM platform_accounts WHERE user_id = ?').run(userId);
      
      // 删除用户的订单
      db.prepare('DELETE FROM orders WHERE user_id = ?').run(userId);
      
      // 删除用户的广告数据
      db.prepare('DELETE FROM google_ads_data WHERE user_id = ?').run(userId);
      
      // 删除用户的Google表格配置
      db.prepare('DELETE FROM google_sheets WHERE user_id = ?').run(userId);
      
      // 删除用户
      db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    });

    deleteTransaction();

    console.log(`✅ 超级管理员删除了用户: ${user.email} (ID: ${userId})`);

    res.json({
      success: true,
      message: '用户及其相关数据已删除'
    });
  } catch (error) {
    console.error('删除用户错误:', error);
    res.json({ success: false, message: '删除失败: ' + error.message });
  }
});
/**
 * API: 批量更新用户（启用/禁用）
 * POST /api/super-admin/users/batch-update
 */
app.post('/api/super-admin/users/batch-update', authenticateToken, requireSuperAdmin, auditLog('batch_update_users'), async (req, res) => {
  try {
    const { user_ids, action } = req.body;

    if (!Array.isArray(user_ids) || user_ids.length === 0) {
      return res.json({ success: false, message: '请提供要操作的用户ID列表' });
    }

    if (!['enable', 'disable'].includes(action)) {
      return res.json({ success: false, message: '操作类型无效，必须是 enable 或 disable' });
    }

    const isActive = action === 'enable' ? 1 : 0;
    const actionName = action === 'enable' ? '启用' : '禁用';
    
    let successCount = 0;
    let failCount = 0;
    const errors = [];

    // 不能操作自己
    const filteredUserIds = user_ids.filter(id => id !== req.user.id);

    for (const userId of filteredUserIds) {
      try {
        const user = db.prepare('SELECT id, email, username, role FROM users WHERE id = ?').get(userId);
        
        if (!user) {
          failCount++;
          errors.push(`用户ID ${userId} 不存在`);
          continue;
        }

        // 不允许操作其他超级管理员
        if (user.role === 'super_admin') {
          failCount++;
          errors.push(`用户 ${user.email} 是超级管理员，无法${actionName}`);
          continue;
        }

        // 更新用户状态
        db.prepare('UPDATE users SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(isActive, userId);
        successCount++;

        // 记录审计日志
        try {
          db.prepare(`
            INSERT INTO audit_logs (
              admin_id, admin_username, action, target_user_id, target_username,
              request_path, request_method, ip_address, details, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          `).run(
            req.user.id,
            req.user.username,
            `batch_${action}_user`,
            userId,
            user.username || user.email,
            req.path,
            req.method,
            req.ip || req.connection.remoteAddress,
            JSON.stringify({ action, is_active: isActive })
          );
        } catch (auditError) {
          console.error('❌ 审计日志记录失败:', auditError.message);
        }

      } catch (error) {
        failCount++;
        errors.push(`用户ID ${userId} 操作失败: ${error.message}`);
      }
    }

    console.log(`✅ 批量${actionName}用户: 成功 ${successCount} 个，失败 ${failCount} 个`);

    res.json({
      success: true,
      message: `批量${actionName}完成: 成功 ${successCount} 个，失败 ${failCount} 个`,
      data: {
        success_count: successCount,
        fail_count: failCount,
        errors: errors.length > 0 ? errors : undefined
      }
    });
  } catch (error) {
    console.error('批量更新用户错误:', error);
    res.json({ success: false, message: '批量更新失败: ' + error.message });
  }
});

/**
 * API: 批量删除用户
 * POST /api/super-admin/users/batch-delete
 */
app.post('/api/super-admin/users/batch-delete', authenticateToken, requireSuperAdmin, auditLog('batch_delete_users'), (req, res) => {
  try {
    const { user_ids } = req.body;

    if (!Array.isArray(user_ids) || user_ids.length === 0) {
      return res.json({ success: false, message: '请提供要删除的用户ID列表' });
    }

    let successCount = 0;
    let failCount = 0;
    const errors = [];

    // 不能删除自己
    const filteredUserIds = user_ids.filter(id => id !== req.user.id);

    for (const userId of filteredUserIds) {
      try {
        const user = db.prepare('SELECT id, email, username, role FROM users WHERE id = ?').get(userId);
        
        if (!user) {
          failCount++;
          errors.push(`用户ID ${userId} 不存在`);
          continue;
        }

        // 不允许删除其他超级管理员
        if (user.role === 'super_admin') {
          failCount++;
          errors.push(`用户 ${user.email} 是超级管理员，无法删除`);
          continue;
        }

        // 记录审计日志（在删除之前）
        try {
          db.prepare(`
            INSERT INTO audit_logs (
              admin_id, admin_username, action, target_user_id, target_username,
              request_path, request_method, ip_address, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          `).run(
            req.user.id,
            req.user.username,
            'batch_delete_user',
            userId,
            user.username || user.email,
            req.path,
            req.method,
            req.ip || req.connection.remoteAddress
          );
        } catch (auditError) {
          console.error('❌ 审计日志记录失败:', auditError.message);
        }

        // 开始事务删除用户及其相关数据
        const deleteTransaction = db.transaction(() => {
          db.prepare('DELETE FROM audit_logs WHERE admin_id = ?').run(userId);
          db.prepare('DELETE FROM audit_logs WHERE target_user_id = ?').run(userId);
          db.prepare('DELETE FROM platform_accounts WHERE user_id = ?').run(userId);
          db.prepare('DELETE FROM orders WHERE user_id = ?').run(userId);
          db.prepare('DELETE FROM google_ads_data WHERE user_id = ?').run(userId);
          db.prepare('DELETE FROM google_sheets WHERE user_id = ?').run(userId);
          db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        });

        deleteTransaction();
        successCount++;

      } catch (error) {
        failCount++;
        errors.push(`用户ID ${userId} 删除失败: ${error.message}`);
      }
    }

    console.log(`✅ 批量删除用户: 成功 ${successCount} 个，失败 ${failCount} 个`);

    res.json({
      success: true,
      message: `批量删除完成: 成功 ${successCount} 个，失败 ${failCount} 个`,
      data: {
        success_count: successCount,
        fail_count: failCount,
        errors: errors.length > 0 ? errors : undefined
      }
    });
  } catch (error) {
    console.error('批量删除用户错误:', error);
    res.json({ success: false, message: '批量删除失败: ' + error.message });
  }
});

/**
 * API: 批量导出用户数据
 * POST /api/super-admin/users/batch-export
 */
app.post('/api/super-admin/users/batch-export', authenticateToken, requireSuperAdmin, auditLog('batch_export_users'), async (req, res) => {
  try {
    const { user_ids } = req.body;

    if (!Array.isArray(user_ids) || user_ids.length === 0) {
      return res.json({ success: false, message: '请提供要导出的用户ID列表' });
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('用户数据');

    // 添加标题行
    worksheet.addRow(['用户ID', '用户名', '邮箱', '状态', '注册时间', '平台账号数', '订单数', '总佣金($)']);

    // 设置标题行样式
    worksheet.getRow(1).font = { bold: true, size: 12 };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4472C4' }
    };
    worksheet.getRow(1).font = { ...worksheet.getRow(1).font, color: { argb: 'FFFFFFFF' } };
    worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

    let totalAccountCount = 0;
    let totalOrderCount = 0;
    let totalCommission = 0;

    // 获取用户数据
    for (const userId of user_ids) {
      const user = db.prepare(`
        SELECT 
          u.id,
          u.username,
          u.email,
          u.is_active,
          u.created_at,
          COUNT(DISTINCT pa.id) as account_count,
          COUNT(DISTINCT o.id) as order_count,
          COALESCE(SUM(o.commission), 0) as total_commission
        FROM users u
        LEFT JOIN platform_accounts pa ON u.id = pa.user_id
        LEFT JOIN orders o ON u.id = o.user_id
        WHERE u.id = ?
        GROUP BY u.id
      `).get(userId);

      if (user) {
        const status = user.is_active ? '启用' : '禁用';
        const createdDate = new Date(user.created_at).toLocaleDateString('zh-CN');
        
        worksheet.addRow([
          user.id,
          user.username || '',
          user.email,
          status,
          createdDate,
          user.account_count || 0,
          user.order_count || 0,
          parseFloat(user.total_commission || 0).toFixed(2)
        ]);

        totalAccountCount += user.account_count || 0;
        totalOrderCount += user.order_count || 0;
        totalCommission += parseFloat(user.total_commission || 0);
      }
    }

    // 添加汇总行
    const summaryRow = worksheet.addRow([
      '汇总',
      '',
      '',
      '',
      '',
      totalAccountCount,
      totalOrderCount,
      totalCommission.toFixed(2)
    ]);
    summaryRow.font = { bold: true };
    summaryRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFF0F0F0' }
    };

    // 设置列宽
    worksheet.columns = [
      { width: 12 }, // 用户ID
      { width: 20 }, // 用户名
      { width: 30 }, // 邮箱
      { width: 10 }, // 状态
      { width: 15 }, // 注册时间
      { width: 15 }, // 平台账号数
      { width: 12 }, // 订单数
      { width: 15 }  // 总佣金
    ];

    // 生成Excel文件
    const buffer = await workbook.xlsx.writeBuffer();

    // 生成文件名（使用英文避免header编码问题）
    const dateStr = new Date().toISOString().split('T')[0];
    const filename = `user_export_${dateStr}.xlsx`;
    const encodedFilename = encodeURIComponent(`用户数据导出_${dateStr}.xlsx`);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    // 使用 RFC 5987 格式支持中文文件名
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${encodedFilename}`);
    res.send(buffer);

    console.log(`✅ 批量导出用户数据: ${user_ids.length} 个用户`);
  } catch (error) {
    console.error('批量导出用户数据错误:', error);
    res.json({ success: false, message: '导出失败: ' + error.message });
  }
});
/**
 * API: 全平台商家分析（按商家ID分组，显示所有用户数据）
 * GET /api/super-admin/platform-merchant-analysis
 */
app.get('/api/super-admin/platform-merchant-analysis', authenticateToken, requireSuperAdmin, auditLog('view_platform_merchant_analysis'), (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    // 查询广告数据，按商家ID和用户分组
    let adsQuery = `
      SELECT
        g.merchant_id,
        g.user_id,
        u.username,
        u.email,
        LOWER(g.affiliate_name) as affiliate_name,
        GROUP_CONCAT(DISTINCT g.campaign_name) as campaign_names,
        MAX(g.campaign_budget) as total_budget,
        MAX(g.currency) as currency,
        SUM(g.impressions) as total_impressions,
        SUM(g.clicks) as total_clicks,
        SUM(g.cost) as total_cost
      FROM google_ads_data g
      LEFT JOIN users u ON g.user_id = u.id
      WHERE g.campaign_name IS NOT NULL AND g.campaign_name != ''
    `;

    const adsParams = [];
    if (startDate) {
      adsQuery += ' AND g.date >= ?';
      adsParams.push(startDate);
    }
    if (endDate) {
      adsQuery += ' AND g.date <= ?';
      adsParams.push(endDate);
    }

    adsQuery += ' GROUP BY g.merchant_id, g.user_id, LOWER(g.affiliate_name) ORDER BY g.merchant_id, g.user_id';

    const adsData = db.prepare(adsQuery).all(...adsParams);

    // 查询订单数据，按商家ID和用户分组
    let ordersQuery = `
      SELECT
        o.merchant_id,
        o.user_id,
        u.username,
        u.email,
        LOWER(pa.affiliate_name) as affiliate_name,
        COUNT(o.id) as order_count,
        SUM(o.commission) as total_commission
      FROM orders o
      LEFT JOIN platform_accounts pa ON o.platform_account_id = pa.id
      LEFT JOIN users u ON o.user_id = u.id
      WHERE o.merchant_id IS NOT NULL AND o.merchant_id != ''
    `;

    const ordersParams = [];
    if (startDate) {
      ordersQuery += ' AND date(o.order_date) >= ?';
      ordersParams.push(startDate);
    }
    if (endDate) {
      ordersQuery += ' AND date(o.order_date) <= ?';
      ordersParams.push(endDate);
    }

    ordersQuery += ' GROUP BY o.merchant_id, o.user_id, LOWER(pa.affiliate_name) ORDER BY o.merchant_id, o.user_id';

    const ordersData = db.prepare(ordersQuery).all(...ordersParams);

    // 合并数据，按商家ID分组
    const merchantMap = new Map();

    // 处理广告数据
    adsData.forEach(ad => {
      const merchantId = ad.merchant_id;
      if (!merchantMap.has(merchantId)) {
        merchantMap.set(merchantId, {
          merchant_id: merchantId,
          users: new Map()
        });
      }

      const merchant = merchantMap.get(merchantId);
      const userKey = `${ad.user_id}_${(ad.affiliate_name || '').toLowerCase()}`;
      
      if (!merchant.users.has(userKey)) {
        merchant.users.set(userKey, {
          user_id: ad.user_id,
          username: ad.username,
          email: ad.email,
          affiliate_name: ad.affiliate_name,
          campaign_names: ad.campaign_names,
          total_budget: ad.total_budget || 0,
          currency: ad.currency || 'USD',
          total_impressions: ad.total_impressions || 0,
          total_clicks: ad.total_clicks || 0,
          total_cost: ad.total_cost || 0,
          order_count: 0,
          total_commission: 0
        });
      }
    });
    // 处理订单数据
    ordersData.forEach(order => {
      const merchantId = order.merchant_id;
      if (!merchantMap.has(merchantId)) {
        merchantMap.set(merchantId, {
          merchant_id: merchantId,
          users: new Map()
        });
      }

      const merchant = merchantMap.get(merchantId);
      const userKey = `${order.user_id}_${(order.affiliate_name || '').toLowerCase()}`;
      
      if (!merchant.users.has(userKey)) {
        merchant.users.set(userKey, {
          user_id: order.user_id,
          username: order.username,
          email: order.email,
          affiliate_name: order.affiliate_name,
          campaign_names: '',
          total_budget: 0,
          currency: 'USD',
          total_impressions: 0,
          total_clicks: 0,
          total_cost: 0,
          order_count: order.order_count || 0,
          total_commission: order.total_commission || 0
        });
      } else {
        const userData = merchant.users.get(userKey);
        userData.order_count = order.order_count || 0;
        userData.total_commission = order.total_commission || 0;
      }
    });

    // 转换为数组并计算ROI
    const result = Array.from(merchantMap.values()).map(merchant => {
      // 只保留有广告系列名称的用户
      const usersWithAds = Array.from(merchant.users.values()).filter(user => 
        user.campaign_names && user.campaign_names.trim() !== ''
      );
      
      const users = usersWithAds.map(user => {
        const roi = user.total_cost > 0 
          ? ((user.total_commission - user.total_cost) / user.total_cost).toFixed(2)
          : '0.00';
        const cr = user.total_clicks > 0
          ? ((user.order_count / user.total_clicks) * 100).toFixed(2)
          : '0.00';
        const epc = user.total_clicks > 0
          ? (user.total_commission / user.total_clicks).toFixed(2)
          : '0.00';
        const cpc = user.total_clicks > 0
          ? (user.total_cost / user.total_clicks).toFixed(2)
          : '0.00';

        return {
          ...user,
          roi: parseFloat(roi),
          cr: parseFloat(cr),
          epc: parseFloat(epc),
          cpc: parseFloat(cpc)
        };
      });

      // 按 ROI 降序排序用户数据
      users.sort((a, b) => {
        const roiA = a.roi || 0;
        const roiB = b.roi || 0;
        return roiB - roiA; // ROI 高的在前
      });

      // 计算商家总计
      const totals = users.reduce((acc, user) => {
        acc.total_budget += user.total_budget;
        acc.total_impressions += user.total_impressions;
        acc.total_clicks += user.total_clicks;
        acc.total_cost += user.total_cost;
        acc.order_count += user.order_count;
        acc.total_commission += user.total_commission;
        return acc;
      }, {
        total_budget: 0,
        total_impressions: 0,
        total_clicks: 0,
        total_cost: 0,
        order_count: 0,
        total_commission: 0
      });

      const merchantROI = totals.total_cost > 0
        ? ((totals.total_commission - totals.total_cost) / totals.total_cost).toFixed(2)
        : '0.00';

      return {
        merchant_id: merchant.merchant_id,
        users: users,
        totals: {
          ...totals,
          roi: parseFloat(merchantROI)
        }
      };
    });

    // 过滤掉没有用户的商家
    const filteredResult = result.filter(merchant => merchant.users.length > 0);

    // 按 ROI 降序排序
    filteredResult.sort((a, b) => {
      const roiA = a.totals.roi || 0;
      const roiB = b.totals.roi || 0;
      return roiB - roiA; // ROI 高的在前
    });

    res.json({
      success: true,
      data: filteredResult
    });

  } catch (error) {
    console.error('获取平台商家分析错误:', error);
    res.json({ success: false, message: '获取失败: ' + error.message });
  }
});

/**
 * POST /api/super-admin/export/platform-merchant-analysis
 */
app.post('/api/super-admin/export/platform-merchant-analysis', authenticateToken, requireSuperAdmin, auditLog('export_platform_merchant_analysis'), async (req, res) => {
  try {
    const { startDate, endDate } = req.body;

    console.log(`📊 超管导出平台商家分析Excel：日期=${startDate}至${endDate}`);

    // 查询广告数据，按商家ID和用户分组
    let adsQuery = `
      SELECT
        g.merchant_id,
        g.user_id,
        u.username,
        u.email,
        LOWER(g.affiliate_name) as affiliate_name,
        GROUP_CONCAT(DISTINCT g.campaign_name) as campaign_names,
        MAX(g.campaign_budget) as total_budget,
        MAX(g.currency) as currency,
        SUM(g.impressions) as total_impressions,
        SUM(g.clicks) as total_clicks,
        SUM(g.cost) as total_cost
      FROM google_ads_data g
      LEFT JOIN users u ON g.user_id = u.id
      WHERE g.campaign_name IS NOT NULL AND g.campaign_name != ''
    `;

    const adsParams = [];
    if (startDate) {
      adsQuery += ' AND g.date >= ?';
      adsParams.push(startDate);
    }
    if (endDate) {
      adsQuery += ' AND g.date <= ?';
      adsParams.push(endDate);
    }

    adsQuery += ' GROUP BY g.merchant_id, g.user_id, LOWER(g.affiliate_name) ORDER BY g.merchant_id, g.user_id';

    const adsData = db.prepare(adsQuery).all(...adsParams);

    // 查询订单数据，按商家ID和用户分组
    let ordersQuery = `
      SELECT
        o.merchant_id,
        o.user_id,
        u.username,
        u.email,
        LOWER(pa.affiliate_name) as affiliate_name,
        COUNT(o.id) as order_count,
        SUM(o.commission) as total_commission
      FROM orders o
      LEFT JOIN platform_accounts pa ON o.platform_account_id = pa.id
      LEFT JOIN users u ON o.user_id = u.id
      WHERE o.merchant_id IS NOT NULL AND o.merchant_id != ''
    `;

    const ordersParams = [];
    if (startDate) {
      ordersQuery += ' AND date(o.order_date) >= ?';
      ordersParams.push(startDate);
    }
    if (endDate) {
      ordersQuery += ' AND date(o.order_date) <= ?';
      ordersParams.push(endDate);
    }

    ordersQuery += ' GROUP BY o.merchant_id, o.user_id, LOWER(pa.affiliate_name) ORDER BY o.merchant_id, o.user_id';

    const ordersData = db.prepare(ordersQuery).all(...ordersParams);

    // 合并数据，按商家ID分组
    const merchantMap = new Map();

    // 处理广告数据
    adsData.forEach(ad => {
      const merchantId = ad.merchant_id;
      if (!merchantMap.has(merchantId)) {
        merchantMap.set(merchantId, {
          merchant_id: merchantId,
          users: new Map()
        });
      }

      const merchant = merchantMap.get(merchantId);
      const userKey = `${ad.user_id}_${(ad.affiliate_name || '').toLowerCase()}`;
      
      if (!merchant.users.has(userKey)) {
        merchant.users.set(userKey, {
          user_id: ad.user_id,
          username: ad.username,
          email: ad.email,
          affiliate_name: ad.affiliate_name,
          campaign_names: ad.campaign_names,
          total_budget: ad.total_budget || 0,
          currency: ad.currency || 'USD',
          total_impressions: ad.total_impressions || 0,
          total_clicks: ad.total_clicks || 0,
          total_cost: ad.total_cost || 0,
          order_count: 0,
          total_commission: 0
        });
      }
    });

    // 处理订单数据
    ordersData.forEach(order => {
      const merchantId = order.merchant_id;
      if (!merchantMap.has(merchantId)) {
        merchantMap.set(merchantId, {
          merchant_id: merchantId,
          users: new Map()
        });
      }

      const merchant = merchantMap.get(merchantId);
      const userKey = `${order.user_id}_${(order.affiliate_name || '').toLowerCase()}`;
      
      if (!merchant.users.has(userKey)) {
        merchant.users.set(userKey, {
          user_id: order.user_id,
          username: order.username,
          email: order.email,
          affiliate_name: order.affiliate_name,
          campaign_names: '',
          total_budget: 0,
          currency: 'USD',
          total_impressions: 0,
          total_clicks: 0,
          total_cost: 0,
          order_count: order.order_count || 0,
          total_commission: order.total_commission || 0
        });
      } else {
        const userData = merchant.users.get(userKey);
        userData.order_count = order.order_count || 0;
        userData.total_commission = order.total_commission || 0;
      }
    });

    // 转换为数组并计算ROI
    const result = Array.from(merchantMap.values()).map(merchant => {
      // 只保留有广告系列名称的用户
      const usersWithAds = Array.from(merchant.users.values()).filter(user => 
        user.campaign_names && user.campaign_names.trim() !== ''
      );
      
      const users = usersWithAds.map(user => {
        const roi = user.total_cost > 0 
          ? ((user.total_commission - user.total_cost) / user.total_cost)
          : 0;
        const cr = user.total_clicks > 0
          ? ((user.order_count / user.total_clicks) * 100)
          : 0;
        const epc = user.total_clicks > 0
          ? (user.total_commission / user.total_clicks)
          : 0;
        const cpc = user.total_clicks > 0
          ? (user.total_cost / user.total_clicks)
          : 0;

        return {
          ...user,
          roi: roi,
          cr: cr,
          epc: epc,
          cpc: cpc
        };
      });

      // 按 ROI 降序排序用户数据
      users.sort((a, b) => {
        const roiA = a.roi || 0;
        const roiB = b.roi || 0;
        return roiB - roiA;
      });

      // 计算商家总计
      const totals = users.reduce((acc, user) => {
        acc.total_budget += user.total_budget;
        acc.total_impressions += user.total_impressions;
        acc.total_clicks += user.total_clicks;
        acc.total_cost += user.total_cost;
        acc.order_count += user.order_count;
        acc.total_commission += user.total_commission;
        return acc;
      }, {
        total_budget: 0,
        total_impressions: 0,
        total_clicks: 0,
        total_cost: 0,
        order_count: 0,
        total_commission: 0
      });

      const merchantROI = totals.total_cost > 0
        ? ((totals.total_commission - totals.total_cost) / totals.total_cost)
        : 0;

      return {
        merchant_id: merchant.merchant_id,
        users: users,
        totals: {
          ...totals,
          roi: merchantROI
        }
      };
    });

    // 过滤掉没有用户的商家
    const filteredResult = result.filter(merchant => merchant.users.length > 0);

    // 按 ROI 降序排序
    filteredResult.sort((a, b) => {
      const roiA = a.totals.roi || 0;
      const roiB = b.totals.roi || 0;
      return roiB - roiA;
    });

    if (filteredResult.length === 0) {
      return res.json({ success: false, message: '暂无数据可导出' });
    }

    // 创建Excel工作簿
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('平台商家分析');

    // 添加标题行
    worksheet.mergeCells('A1:M1');
    const titleCell = worksheet.getCell('A1');
    titleCell.value = '平台商家分析';
    titleCell.font = { size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    titleCell.border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' }
    };
    worksheet.getRow(1).height = 30;

    // 添加日期范围信息
    if (startDate || endDate) {
      worksheet.mergeCells('A2:M2');
      const dateCell = worksheet.getCell('A2');
      const dateRange = startDate && endDate ? `${startDate} 至 ${endDate}` : (startDate ? `从 ${startDate}` : `至 ${endDate}`);
      dateCell.value = `日期范围: ${dateRange}`;
      dateCell.font = { size: 12, color: { argb: 'FF6B7280' } };
      dateCell.alignment = { horizontal: 'center', vertical: 'middle' };
      worksheet.getRow(2).height = 25;
    }

    // 添加表头
    let currentRow = startDate || endDate ? 3 : 2;
    const headerRow = worksheet.getRow(currentRow);
    headerRow.values = [
      '商家ID',
      '用户',
      '广告系列',
      '预算',
      '展示',
      '点击',
      '广告费',
      '订单',
      '佣金',
      'CR',
      'EPC',
      'CPC',
      'ROI'
    ];
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B82F6' } };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.height = 25;
    headerRow.eachCell(cell => {
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' }
      };
    });

    currentRow++;

    // 添加数据行
    filteredResult.forEach((merchant, merchantIndex) => {
      // 商家汇总行
      const summaryRow = worksheet.getRow(currentRow);
      summaryRow.values = [
        `#${merchantIndex + 1} 商家ID: ${merchant.merchant_id}`,
        '汇总',
        '-',
        merchant.totals.total_budget || 0,
        merchant.totals.total_impressions || 0,
        merchant.totals.total_clicks || 0,
        merchant.totals.total_cost || 0,
        merchant.totals.order_count || 0,
        merchant.totals.total_commission || 0,
        merchant.totals.total_clicks > 0 ? ((merchant.totals.order_count / merchant.totals.total_clicks) * 100) : 0,
        merchant.totals.total_clicks > 0 ? (merchant.totals.total_commission / merchant.totals.total_clicks) : 0,
        merchant.totals.total_clicks > 0 ? (merchant.totals.total_cost / merchant.totals.total_clicks) : 0,
        merchant.totals.roi || 0
      ];
      summaryRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      summaryRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
      summaryRow.height = 22;
      summaryRow.eachCell(cell => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' }
        };
        cell.alignment = { vertical: 'middle' };
      });
      summaryRow.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };
      summaryRow.getCell(4).numFmt = '$#,##0.00';
      summaryRow.getCell(7).numFmt = '$#,##0.00';
      summaryRow.getCell(9).numFmt = '$#,##0.00';
      summaryRow.getCell(10).numFmt = '0.00%';
      summaryRow.getCell(11).numFmt = '$#,##0.00';
      summaryRow.getCell(12).numFmt = '$#,##0.00';
      summaryRow.getCell(13).numFmt = '0.00';
      
      // ROI颜色
      const roiCell = summaryRow.getCell(13);
      if (merchant.totals.roi >= 0) {
        roiCell.font = { color: { argb: 'FF28A745' }, bold: true };
      } else {
        roiCell.font = { color: { argb: 'FFDC3545' }, bold: true };
      }
      currentRow++;

      // 用户明细行
      merchant.users.forEach((user, userIndex) => {
        const userRow = worksheet.getRow(currentRow);
        const username = user.username || (user.email ? user.email.split('@')[0] : '-');
        const displayName = `${username}, ${user.affiliate_name || '-'}`;
        
        userRow.values = [
          merchant.merchant_id,
          displayName,
          user.campaign_names || '-',
          user.total_budget || 0,
          user.total_impressions || 0,
          user.total_clicks || 0,
          user.total_cost || 0,
          user.order_count || 0,
          user.total_commission || 0,
          user.cr || 0,
          user.epc || 0,
          user.cpc || 0,
          user.roi || 0
        ];
        userRow.height = 20;
        userRow.eachCell(cell => {
          cell.border = {
            top: { style: 'thin' },
            left: { style: 'thin' },
            bottom: { style: 'thin' },
            right: { style: 'thin' }
          };
          cell.alignment = { vertical: 'middle' };
        });
        userRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
        userRow.getCell(2).alignment = { horizontal: 'left', vertical: 'middle' };
        userRow.getCell(3).alignment = { horizontal: 'left', vertical: 'middle' };
        userRow.getCell(4).numFmt = '$#,##0.00';
        userRow.getCell(7).numFmt = '$#,##0.00';
        userRow.getCell(9).numFmt = '$#,##0.00';
        userRow.getCell(10).numFmt = '0.00%';
        userRow.getCell(11).numFmt = '$#,##0.00';
        userRow.getCell(12).numFmt = '$#,##0.00';
        userRow.getCell(13).numFmt = '0.00';

        // ROI颜色
        const userRoiCell = userRow.getCell(13);
        if (user.roi >= 0) {
          userRoiCell.font = { color: { argb: 'FF28A745' }, bold: true };
        } else {
          userRoiCell.font = { color: { argb: 'FFDC3545' }, bold: true };
        }

        // 斑马纹背景
        if (userIndex % 2 === 1) {
          userRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8F9FA' } };
        }

        currentRow++;
      });

      // 添加空行分隔商家
      currentRow++;
    });

    // 设置列宽
    worksheet.columns = [
      { key: 'merchant_id', width: 18 },
      { key: 'user', width: 25 },
      { key: 'campaign', width: 40 },
      { key: 'budget', width: 12 },
      { key: 'impressions', width: 12 },
      { key: 'clicks', width: 10 },
      { key: 'cost', width: 12 },
      { key: 'orders', width: 10 },
      { key: 'commission', width: 12 },
      { key: 'cr', width: 10 },
      { key: 'epc', width: 12 },
      { key: 'cpc', width: 12 },
      { key: 'roi', width: 10 }
    ];

    // 生成文件名
    const dateStr = startDate && endDate ? `${startDate}至${endDate}` : '全部数据';
    const filename = `平台商家分析_${dateStr}.xlsx`;

    // 设置响应头
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);

    // 写入响应流
    await workbook.xlsx.write(res);
    res.end();

    console.log(`✅ 超管平台商家分析Excel导出成功：${filename}, 共${filteredResult.length}个商家`);

  } catch (error) {
    console.error('超管导出平台商家分析Excel错误:', error);
    res.json({ success: false, message: '导出失败: ' + error.message });
  }
});
// 辅助函数：采集 Rewardoo 订单
async function fetchRewardooOrders(apiToken, startDate = '2024-01-01', endDate = null) {
  if (!endDate) {
    endDate = new Date().toISOString().split('T')[0];
  }
  const apiUrl = `https://api.rewardoo.com/api/transactions?api_key=${apiToken}&start_date=${startDate}&end_date=${endDate}`;
  const response = await axios.get(apiUrl);
  
  if (response.data && response.data.transactions) {
    return response.data.transactions.map(order => ({
      order_number: order.id,
      order_date: order.date,
      merchant_id: order.merchant_id,
      commission: parseFloat(order.commission || 0),
      status: 'confirmed'
    }));
  }
  return [];
}
/**
 * POST /api/super-admin/batch-collect-sheets
 * 超管批量采集 Google Sheets 数据
 */
app.post('/api/super-admin/batch-collect-sheets', authenticateToken, requireSuperAdmin, auditLog('batch_collect_google_sheets'), async (req, res) => {
  try {
    const { userIds, onlyOutdated } = req.body;
    
    console.log('🔄 超管开始批量采集 Google Sheets 数据...');
    
    // 获取目标用户列表
    let targetUsers = [];
    if (userIds && userIds.length > 0) {
      // 指定用户
      const placeholders = userIds.map(() => '?').join(',');
      targetUsers = db.prepare(`
        SELECT id, username, email FROM users 
        WHERE id IN (${placeholders}) AND role != 'super_admin'
      `).all(...userIds);
    } else {
      // 所有普通用户
      targetUsers = db.prepare('SELECT id, username, email FROM users WHERE role != \'super_admin\'').all();
    }
    
    if (targetUsers.length === 0) {
      return res.json({ success: false, message: '没有找到可采集的用户' });
    }
    
    const results = [];
    let successCount = 0;
    let failedCount = 0;
    
    // 遍历每个用户
    for (const user of targetUsers) {
      const userResult = {
        userId: user.id,
        username: user.username || user.email,
        success: false,
        rowsImported: 0,
        error: null
      };
      
      try {
        // 获取该用户的 Google Sheets
        const sheets = db.prepare('SELECT * FROM google_sheets WHERE user_id = ?').all(user.id);
        
        if (sheets.length === 0) {
          userResult.error = '未配置 Google Sheets';
          failedCount++;
          results.push(userResult);
          continue;
        }
        
        let totalRows = 0;
        
        // 采集该用户的所有表格
        for (const sheet of sheets) {
          try {
            const csvUrl = `https://docs.google.com/spreadsheets/d/${sheet.sheet_id}/export?format=csv&gid=0`;
            const response = await axios.get(csvUrl, { timeout: 10000 });
            const csvData = response.data;
            const lines = csvData.split('\n');
            const dataLines = lines.slice(2).filter(line => line.trim());
            
            const today = new Date().toISOString().split('T')[0];
            const selectStmt = db.prepare('SELECT id FROM google_ads_data WHERE sheet_id = ? AND date = ? AND campaign_name = ?');
            const insertStmt = db.prepare(`
              INSERT INTO google_ads_data
              (user_id, sheet_id, date, campaign_name, affiliate_name, merchant_id, merchant_slug, campaign_budget, currency, impressions, clicks, cost, lost_impression_share_budget, lost_impression_share_rank)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const updateStmt = db.prepare(`
              UPDATE google_ads_data
              SET affiliate_name = ?, merchant_id = ?, merchant_slug = ?, campaign_budget = ?, currency = ?, impressions = ?, clicks = ?, cost = ?, lost_impression_share_budget = ?, lost_impression_share_rank = ?, updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `);
            
            const uniqueDataMap = new Map();
            
            for (const line of dataLines) {
              if (!line.trim()) continue;
              const fields = line.split(',').map(f => f.trim().replace(/^"|"$/g, ''));
              if (fields.length < 11) continue;
              
              const campaignName = fields[0] || '';
              const date = fields[7] || '';
              const budget = parseFloat(fields[3]) || 0;
              const currency = fields[4] || '';
              const impressions = parseInt(fields[8]) || 0;
              const clicks = parseInt(fields[9]) || 0;
              const cost = parseFloat(fields[10]) || 0;
              
              // 读取丢失展示份额字段（列13和14，跳过列11、12）
              // 规范化丢失展示份额：确保值在 0-1 之间（数据库存储格式）
              let lostISBudget = fields.length > 13 ? parseFloat(fields[13]) || 0 : 0;
              let lostISRank = fields.length > 14 ? parseFloat(fields[14]) || 0 : 0;
              
              // 规范化逻辑：与单个表格采集保持一致
              if (lostISBudget > 100) {
                lostISBudget = lostISBudget / 100;
                if (lostISBudget > 1) {
                  console.warn(`⚠️  因预算丢失展示份额值异常: ${fields[13]}, 已限制为 100% (1.0)`);
                  lostISBudget = 1.0;
                }
              } else if (lostISBudget > 1 && lostISBudget <= 100) {
                lostISBudget = lostISBudget / 100;
              }
              if (lostISBudget < 0) lostISBudget = 0;
              if (lostISBudget > 1) lostISBudget = 1;
              
              if (lostISRank > 100) {
                lostISRank = lostISRank / 100;
                if (lostISRank > 1) {
                  console.warn(`⚠️  因评级丢失展示份额值异常: ${fields[14]}, 已限制为 100% (1.0)`);
                  lostISRank = 1.0;
                }
              } else if (lostISRank > 1 && lostISRank <= 100) {
                lostISRank = lostISRank / 100;
              }
              if (lostISRank < 0) lostISRank = 0;
              if (lostISRank > 1) lostISRank = 1;
              
              if (!date || !campaignName || campaignName.trim() === '') continue;
              
              const uniqueKey = `${campaignName}|${date}`;
              if (uniqueDataMap.has(uniqueKey)) continue;
              
              const { affiliateName, merchantId, merchantSlug } = extractCampaignInfo(campaignName);
              
              uniqueDataMap.set(uniqueKey, {
                campaignName, date, budget, currency, impressions, clicks, cost, lostISBudget, lostISRank,
                affiliateName, merchantId, merchantSlug
              });
            }
            
            uniqueDataMap.forEach(data => {
              const { campaignName, date, budget, currency, impressions, clicks, cost, lostISBudget, lostISRank, affiliateName, merchantId, merchantSlug } = data;
              
              if (date === today) {
                const existing = selectStmt.get(sheet.id, date, campaignName);
                if (existing) {
                  updateStmt.run(affiliateName, merchantId, merchantSlug, budget, currency, impressions, clicks, cost, lostISBudget, lostISRank, existing.id);
                } else {
                  insertStmt.run(user.id, sheet.id, date, campaignName, affiliateName, merchantId, merchantSlug, budget, currency, impressions, clicks, cost, lostISBudget, lostISRank);
                }
                totalRows++;
              } else {
                const existing = selectStmt.get(sheet.id, date, campaignName);
                if (!existing) {
                  insertStmt.run(user.id, sheet.id, date, campaignName, affiliateName, merchantId, merchantSlug, budget, currency, impressions, clicks, cost, lostISBudget, lostISRank);
                  totalRows++;
                } else if (budget && budget > 0) {
                  db.prepare('UPDATE google_ads_data SET campaign_budget = ?, currency = ?, lost_impression_share_budget = ?, lost_impression_share_rank = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                    .run(budget, currency, lostISBudget, lostISRank, existing.id);
                  totalRows++;
                }
              }
            });
            
          } catch (sheetError) {
            console.error(`采集表格 ${sheet.sheet_name} 失败:`, sheetError.message);
          }
        }
        
        userResult.success = true;
        userResult.rowsImported = totalRows;
        successCount++;
        console.log(`✅ ${user.username || user.email}: 采集 ${totalRows} 条数据`);
        
      } catch (error) {
        userResult.error = error.message;
        failedCount++;
        console.error(`❌ ${user.username || user.email}: ${error.message}`);
      }
      
      results.push(userResult);
    }
    
    console.log(`🎉 批量采集完成: 成功 ${successCount}/${targetUsers.length} 用户`);
    
    res.json({
      success: true,
      data: {
        total: targetUsers.length,
        success: successCount,
        failed: failedCount,
        details: results
      }
    });
    
  } catch (error) {
    console.error('批量采集 Google Sheets 错误:', error);
    res.json({ success: false, message: '批量采集失败: ' + error.message });
  }
});
/**
 * POST /api/super-admin/batch-collect-platforms
 * 超管批量采集平台订单数据
 */
app.post('/api/super-admin/batch-collect-platforms', authenticateToken, requireSuperAdmin, auditLog('batch_collect_platforms'), async (req, res) => {
  try {
    const { userIds, platforms, onlyOutdated, startDate, endDate } = req.body;
    
    console.log('🔄 超管开始批量采集平台订单数据...');
    console.log(`📅 日期范围: ${startDate || '2024-01-01'} - ${endDate || '今天'}`);
    
    // 获取目标用户列表
    let targetUsers = [];
    if (userIds && userIds.length > 0) {
      const placeholders = userIds.map(() => '?').join(',');
      targetUsers = db.prepare(`
        SELECT id, username, email FROM users 
        WHERE id IN (${placeholders}) AND role != 'super_admin'
      `).all(...userIds);
    } else {
      targetUsers = db.prepare('SELECT id, username, email FROM users WHERE role != \'super_admin\'').all();
    }
    
    if (targetUsers.length === 0) {
      return res.json({ success: false, message: '没有找到可采集的用户' });
    }
    
    const targetPlatforms = platforms && platforms.length > 0 
      ? platforms 
      : ['linkhaitao', 'partnermatic', 'linkbux', 'rewardoo'];
    const results = [];
    let totalPlatforms = 0;
    let successPlatforms = 0;
    let failedPlatforms = 0;
    
    // 遍历每个用户（注意：串行处理，避免并发请求触发速率限制）
    for (let userIndex = 0; userIndex < targetUsers.length; userIndex++) {
      const user = targetUsers[userIndex];
      const userResult = {
        userId: user.id,
        username: user.username || user.email,
        platforms: {}
      };
      
      console.log(`\n${'='.repeat(60)}`);
      console.log(`📊 [${userIndex + 1}/${targetUsers.length}] 处理用户: ${user.username || user.email}`);
      console.log('='.repeat(60));
      
      // 获取该用户的平台账号
      const accounts = db.prepare('SELECT * FROM platform_accounts WHERE user_id = ?').all(user.id);
      
      for (const platform of targetPlatforms) {
        const account = accounts.find(a => a.platform === platform);
        
        if (!account) {
          // 未配置账号，跳过但不计入失败统计
          userResult.platforms[platform] = { success: false, error: '未配置账号', skipped: true };
          continue;
        }
        
        // 只有配置了账号的平台才计入总数
        totalPlatforms++;
        
        console.log(`  🔄 开始采集平台: ${platform}...`);
        
        try {
          // 🔥 直接复用用户的采集函数
          const mockReq = {
            user: { id: user.id },
            body: { 
              platformAccountId: account.id, 
              startDate: startDate || '2024-01-01', 
              endDate: endDate || new Date().toISOString().split('T')[0]
            }
          };
          
          let collectionResult = null;
          
          // 使用 Promise 包装，因为采集函数通过 res.json() 返回结果
          const result = await new Promise(async (resolve) => {
            const mockRes = {
              json: (data) => {
                resolve(data);
                return mockRes; // 返回 mockRes 以支持链式调用
              }
            };
            
            try {
              // 根据平台调用对应的采集函数（注意：这些函数是 async 的）
              if (platform === 'linkhaitao') {
                await collectLHOrders(mockReq, mockRes, account, mockReq.body.startDate, mockReq.body.endDate);
              } else if (platform === 'partnermatic') {
                await collectPMOrders(mockReq, mockRes, account, mockReq.body.startDate, mockReq.body.endDate);
              } else if (platform === 'linkbux') {
                await collectLBOrders(mockReq, mockRes, account, mockReq.body.startDate, mockReq.body.endDate);
              } else if (platform === 'rewardoo') {
                await collectRWOrders(mockReq, mockRes, account, mockReq.body.startDate, mockReq.body.endDate);
              } else {
                resolve({ success: false, message: '不支持的平台' });
              }
            } catch (error) {
              resolve({ success: false, message: error.message });
            }
          });
          
          collectionResult = result;
          
          console.log(`📊 [批量采集] ${user.username || user.email} - ${platform} 返回结果:`, JSON.stringify(collectionResult).substring(0, 200));
          
          if (collectionResult && collectionResult.success) {
            // 采集函数返回的数据结构：
            // { success: true, message: "采集完成：新增X条，跳过Y条", data: { total, stats: { new, updated, skipped } } }
            const ordersCount = collectionResult.data?.stats?.new || 0; // 只统计新增的订单
            const totalProcessed = collectionResult.data?.total || 0; // 总处理数量
            
            userResult.platforms[platform] = { success: true, orders: ordersCount };
            successPlatforms++;
            console.log(`  ✅ ${platform}: 新增 ${ordersCount} 条订单（总处理 ${totalProcessed} 条）`);
          } else {
            userResult.platforms[platform] = { 
              success: false, 
              error: collectionResult?.message || '采集失败' 
            };
            failedPlatforms++;
            console.log(`  ❌ ${platform}: ${collectionResult?.message || '采集失败'}`);
          }
          
          // ⏱️ 关键：每个平台采集后延迟2秒，避免触发速率限制
          if (platform === 'linkhaitao') {
            console.log(`  ⏱️ 延迟 2 秒，避免触发 LinkHaitao API 速率限制...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
          } else {
            // 其他平台延迟1秒
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
          
        } catch (error) {
          userResult.platforms[platform] = { success: false, error: error.message };
          failedPlatforms++;
          console.error(`  ❌ ${platform}: ${error.message}`);
          
          // 即使出错也要延迟，避免连续失败请求触发封禁
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
      
      results.push(userResult);
      
      // 每个用户处理完后，额外延迟1秒
      if (userIndex < targetUsers.length - 1) {
        console.log(`\n⏳ 等待 1 秒后继续下一个用户...\n`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    console.log(`🎉 批量采集完成: 成功 ${successPlatforms}/${totalPlatforms} 平台`);
    
    res.json({
      success: true,
      data: {
        totalPlatforms,
        successPlatforms,
        failedPlatforms,
        details: results
      }
    });
    
  } catch (error) {
    console.error('批量采集平台数据错误:', error);
    res.json({ success: false, message: '批量采集失败: ' + error.message });
  }
});

/**
 * API: 获取用户数据采集状态
 * GET /api/super-admin/collection-status
 */
app.get('/api/super-admin/collection-status', authenticateToken, requireSuperAdmin, (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const hasStartDate = !!startDate;
    const hasEndDate = !!endDate;
    
    // 获取所有用户
    const users = db.prepare("SELECT id, username, email FROM users WHERE role != 'super_admin' ORDER BY id").all();
    
    console.log(`📊 [数据采集状态API] 找到 ${users.length} 个用户`);
    
    const statusList = users.map(user => {
      // 获取 Google Sheets 最新采集时间（直接在数据库层面计算时间差，避免时区问题）
      const latestSheet = db.prepare(`
        SELECT 
          MAX(updated_at) as last_update,
          (julianday('now') - julianday(MAX(updated_at))) * 24 as hours_ago
        FROM google_ads_data 
        WHERE user_id = ? AND updated_at IS NOT NULL
      `).get(user.id);
      
      // 解析 Google Sheets 最新采集时间
      let sheetLastUpdate = null;
      let sheetHoursAgo = null;
      if (latestSheet?.last_update) {
        const timeStr = latestSheet.last_update;
        // 使用数据库计算的小时数（更准确，避免时区问题）
        sheetHoursAgo = latestSheet.hours_ago !== null ? latestSheet.hours_ago : null;
        
        // 同时解析时间字符串用于返回
        let isoTimeStr = timeStr;
        if (timeStr.includes(' ') && !timeStr.includes('T')) {
          isoTimeStr = timeStr.replace(' ', 'T');
        }
        sheetLastUpdate = new Date(isoTimeStr);
        
        // 如果数据库计算失败，使用 JavaScript 计算作为后备
        if (sheetHoursAgo === null && !isNaN(sheetLastUpdate.getTime())) {
          sheetHoursAgo = (Date.now() - sheetLastUpdate.getTime()) / (1000 * 60 * 60);
        }
        
        // 调试日志
        if (user.id <= 4 || (sheetHoursAgo && sheetHoursAgo > 1)) {
          console.log(`  📊 用户 ${user.id} (${user.username}) Google Sheets 时间: ${timeStr}, ${sheetHoursAgo?.toFixed(2)}小时前`);
        }
      }
      const sheetStatus = sheetHoursAgo === null ? 'never' : (sheetHoursAgo <= 24 ? 'fresh' : 'outdated');
      
      // 获取平台订单最新采集时间（优先使用collected_at，这是最准确的采集时间）
      // 直接在数据库层面计算时间差，避免时区问题
      const latestOrder = db.prepare(`
        SELECT 
          MAX(COALESCE(collected_at, created_at, updated_at)) as last_update,
          (julianday('now') - julianday(MAX(COALESCE(collected_at, created_at, updated_at)))) * 24 as hours_ago
        FROM orders 
        WHERE user_id = ? 
          AND (collected_at IS NOT NULL OR created_at IS NOT NULL OR updated_at IS NOT NULL)
      `).get(user.id);
      
      // 解析平台订单最新采集时间
      let orderLastUpdate = null;
      let orderHoursAgo = null;
      
      if (latestOrder?.last_update) {
        const timeStr = latestOrder.last_update;
        // 使用数据库计算的小时数（更准确，避免时区问题）
        orderHoursAgo = latestOrder.hours_ago !== null ? latestOrder.hours_ago : null;
        
        // 同时解析时间字符串用于返回
        let isoTimeStr = timeStr;
        if (timeStr.includes(' ') && !timeStr.includes('T')) {
          isoTimeStr = timeStr.replace(' ', 'T');
        }
        orderLastUpdate = new Date(isoTimeStr);
        
        // 如果数据库计算失败，使用 JavaScript 计算作为后备
        if (orderHoursAgo === null && !isNaN(orderLastUpdate.getTime())) {
          orderHoursAgo = (Date.now() - orderLastUpdate.getTime()) / (1000 * 60 * 60);
        }
        
        // 调试日志
        if (user.id <= 4 || (orderHoursAgo && orderHoursAgo > 1)) {
          console.log(`  📊 用户 ${user.id} (${user.username}) 订单采集时间: ${timeStr}, ${orderHoursAgo?.toFixed(2)}小时前`);
        }
      }
      const orderStatus = orderHoursAgo === null ? 'never' : (orderHoursAgo <= 24 ? 'fresh' : 'outdated');
      
      // 获取平台账号数量
      const platformCountResult = db.prepare('SELECT COUNT(*) as count FROM platform_accounts WHERE user_id = ?').get(user.id);
      const platformCount = platformCountResult ? (platformCountResult.count || 0) : 0;
      
      // 获取商家数据（用于统计表格）
      const merchants = [];
      try {
        // 获取订单数据
        let merchantSummaryQuery = `
        SELECT 
            o.merchant_id,
            o.merchant_name,
            COUNT(DISTINCT o.id) as order_count,
            SUM(CASE WHEN UPPER(TRIM(o.status)) != 'REJECTED' THEN o.commission ELSE 0 END) as total_commission,
            SUM(o.order_amount) as total_amount
          FROM orders o
          WHERE o.user_id = ?
        `;
        const merchantSummaryParams = [user.id];
        if (hasStartDate) {
          merchantSummaryQuery += ' AND date(o.order_date) >= date(?)';
          merchantSummaryParams.push(startDate);
        }
        if (hasEndDate) {
          merchantSummaryQuery += ' AND date(o.order_date) <= date(?)';
          merchantSummaryParams.push(endDate);
        }
        merchantSummaryQuery += `
          GROUP BY o.merchant_id, o.merchant_name
          ORDER BY total_commission DESC
          LIMIT 10
        `;
        const merchantSummary = db.prepare(merchantSummaryQuery).all(...merchantSummaryParams);
        
        console.log(`  📊 用户 ${user.id} (${user.username}) 找到 ${merchantSummary.length} 个商家`);
        
        // 为每个商家获取广告数据
        merchantSummary.forEach(m => {
          const merchantId = m.merchant_id;
          const merchantName = m.merchant_name;
          
          // 获取该商家的广告数据（预算和成本）
          let adDataQuery = `
          SELECT 
              SUM(campaign_budget) as total_budget,
              SUM(cost) as total_cost
            FROM google_ads_data
            WHERE user_id = ? AND merchant_id = ?
          `;
          const adDataParams = [user.id, merchantId];
          if (hasStartDate) {
            adDataQuery += ' AND date(date) >= date(?)';
            adDataParams.push(startDate);
          }
          if (hasEndDate) {
            adDataQuery += ' AND date(date) <= date(?)';
            adDataParams.push(endDate);
          }
          const adData = db.prepare(adDataQuery).get(...adDataParams);
          
          // 单独获取去重后的广告系列名称
          let campaignNamesQuery = `
            SELECT GROUP_CONCAT(campaign_name, ', ') as campaign_names
            FROM (
              SELECT DISTINCT campaign_name 
              FROM google_ads_data 
              WHERE user_id = ? AND merchant_id = ?
          `;
          const campaignNameParams = [user.id, merchantId];
          if (hasStartDate) {
            campaignNamesQuery += ' AND date(date) >= date(?)';
            campaignNameParams.push(startDate);
          }
          if (hasEndDate) {
            campaignNamesQuery += ' AND date(date) <= date(?)';
            campaignNameParams.push(endDate);
          }
          campaignNamesQuery += `
            )
          `;
          const campaignNamesResult = db.prepare(campaignNamesQuery).get(...campaignNameParams);
          
          const budget = parseFloat(adData?.total_budget) || 0;
          const cost = parseFloat(adData?.total_cost) || 0;
          const commission = parseFloat(m.total_commission) || 0;
          const campaignNames = campaignNamesResult?.campaign_names || '';
          
          // 计算 ROI: (commission - cost) / cost，如果 cost = 0 则返回 -999999
          let roi = -999999;
          if (cost > 0) {
            roi = (commission - cost) / cost;
          }
          
          merchants.push({
            merchantId: merchantId,
            merchantName: merchantName,
            orderCount: m.order_count,
            commission: commission,
            totalAmount: parseFloat(m.total_amount) || 0,
            budget: budget,
            cost: cost,
            roi: roi,
            campaignNames: campaignNames
          });
        });
        
        console.log(`  ✅ 用户 ${user.id} 返回 ${merchants.length} 个商家数据`);
      } catch (error) {
        console.error(`  ❌ 获取用户 ${user.id} 商家数据错误:`, error);
      }
      
      return {
        userId: user.id,
        username: user.username || user.email,
        email: user.email,
        googleSheets: {
          status: sheetStatus,
          lastUpdate: sheetLastUpdate ? sheetLastUpdate.toISOString() : null,
          hoursAgo: sheetHoursAgo
        },
        platformOrders: {
          status: orderStatus,
          lastUpdate: orderLastUpdate ? orderLastUpdate.toISOString() : null,
          hoursAgo: orderHoursAgo
        },
        platformCount: platformCount,
        merchants: merchants
      };
    });
    
    console.log(`✅ [数据采集状态API] 返回 ${statusList.length} 个用户的状态数据`);
    
    res.json({
      success: true,
      data: statusList
    });
  } catch (error) {
    console.error('❌ [数据采集状态API] 获取采集状态错误:', error);
    res.json({ success: false, message: '获取失败: ' + error.message });
  }
});

/**
 * PartnerMatic 登录获取 auth_token
 */
async function loginPartnerMatic(accountName, accountPassword) {
  try {
    const response = await axios.post(
      'https://api.partnermatic.com/auth/sign_in',
      {
        appId: 32,
        req: {
          header: {
            token: ''
          },
          fields: [],
          attributes: {},
          filter: {
            platform_code: '',
            account: accountName,
            password: accountPassword
          }
        }
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.data && response.data.code === '0' && response.data.data && response.data.data.auth_token) {
      return {
        success: true,
        auth_token: response.data.data.auth_token
      };
    } else {
      return {
        success: false,
        message: response.data?.message || '登录失败'
      };
    }
  } catch (error) {
    console.error('PartnerMatic 登录错误:', error.message);
    return {
      success: false,
      message: error.response?.data?.message || error.message
    };
  }
}

/**
 * 调用 PartnerMatic Payment Summary API
 */
async function callPMPaymentSummary(apiToken) {
  try {
    if (!apiToken || apiToken.trim() === '') {
      return {
        success: false,
        message: 'API Token 为空或无效'
      };
    }

    // 构建请求体 - 确保格式与浏览器中一致
    const requestBody = {
      appId: 32,
      req: {
        header: {
          token: apiToken.trim()
        },
        fields: [],
        attributes: {},
        filter: {}
      }
    };

    console.log('📤 [PM Payment Summary] 调用API');
    console.log('   Token长度:', apiToken.length);
    console.log('   Token前10字符:', apiToken.substring(0, 10));
    console.log('   请求体:', JSON.stringify(requestBody).replace(apiToken, '***TOKEN***'));

    const response = await axios.post(
      'https://api.partnermatic.com/payment/summary',
      requestBody,
      {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 30000
      }
    );

    console.log('📥 [PM Payment Summary] API响应');
    console.log('   Code:', response.data?.code);
    console.log('   Message:', response.data?.message);
    console.log('   响应数据:', JSON.stringify(response.data).substring(0, 300));

    if (response.data && response.data.code === '0') {
      return {
        success: true,
        data: response.data.data || {}
      };
    } else {
      // 尝试多种方式获取错误信息
      let errorMsg = response.data?.message || 
                     response.data?.data?.message || 
                     response.data?.data?.errors?.[0]?.detail ||
                     response.data?.data?.errors?.[0]?.title ||
                     response.data?.error || 
                     'API调用失败';
      
      // 如果是 TOKEN_ERROR，提供更详细的说明
      if (errorMsg === 'TOKEN_ERROR' || response.data?.code === 20068) {
        errorMsg = 'TOKEN_ERROR: Payment API 需要登录后的 auth_token，当前使用的是无效的 api_token。系统会自动尝试登录获取 auth_token（需要账号密码）。';
      }
      
      console.error('❌ [PM Payment Summary] API返回错误:', errorMsg);
      console.error('   错误代码:', response.data?.code);
      console.error('   完整响应:', JSON.stringify(response.data));
      return {
        success: false,
        message: errorMsg
      };
    }
  } catch (error) {
    console.error('❌ [PM Payment Summary] 请求异常:', error.message);
    // 如果错误响应有详细信息，也记录
    if (error.response) {
      console.error('   状态码:', error.response.status);
      console.error('   错误响应:', JSON.stringify(error.response.data));
      return {
        success: false,
        message: error.response.data?.message || 
                 error.response.data?.data?.message || 
                 error.response.data?.error || 
                 `HTTP ${error.response.status}: ${error.message}`
      };
    }
    return {
      success: false,
      message: error.message || '网络请求失败'
    };
  }
}

/**
 * 调用 PartnerMatic Payment History API
 */
async function callPMPaymentHistory(apiToken, page = 1, pageSize = 10) {
  try {
    const response = await axios.post(
      'https://api.partnermatic.com/payment/history',
      {
        appId: 32,
        req: {
          header: {
            token: apiToken
          },
          fields: [],
          attributes: {},
          filter: {
            sort_field: '',
            sort_order: '',
            export: 0
          },
          page: {
            number: page,
            size: pageSize
          }
        }
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.data && response.data.code === '0') {
      return {
        success: true,
        data: response.data.data || {}
      };
    } else {
      return {
        success: false,
        message: response.data?.message || 'API调用失败'
      };
    }
  } catch (error) {
    console.error('调用PM Payment History API错误:', error.message);
    return {
      success: false,
      message: error.message
    };
  }
}

/**
 * API: 获取提现管理汇总数据
 * GET /api/super-admin/withdrawal/summary
 */
app.get('/api/super-admin/withdrawal/summary', authenticateToken, requireSuperAdmin, auditLog('view_withdrawal_summary'), async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    // 获取所有账号（包括 PartnerMatic 和 LinkBux）
    const accounts = db.prepare(`
      SELECT 
        pa.id,
        pa.platform,
        pa.account_name,
        pa.affiliate_name,
        pa.api_token,
        u.id as user_id,
        u.username,
        u.email
      FROM platform_accounts pa
      INNER JOIN users u ON pa.user_id = u.id
      WHERE pa.platform IN ('partnermatic', 'linkbux', 'rewardoo')
      ORDER BY u.username, pa.account_name
    `).all();

    if (accounts.length === 0) {
      return res.json({
        success: true,
        data: {
          totals: {
            availableToWithdraw: 0,
            processingAmount: 0,
            withdrawnAmount: 0
          },
          accounts: []
        }
      });
    }

    // 计算总计
    let totalAvailable = 0;
    let totalProcessing = 0;
    let totalWithdrawn = 0;
    
    const accountData = [];

    for (const account of accounts) {
      let available = 0;
      let processing = 0;
      let withdrawn = 0;

      if (account.platform === 'linkbux') {
        // LinkBux: 使用 Payment API 直接获取数据
        if (account.api_token) {
          try {
            // 始终查询所有历史数据
            const summary = await getLinkBuxWithdrawalSummary(
              account.api_token,
              '2020-01-01',
              new Date().toISOString().split('T')[0]
            );
            
            // 可提现金额：不受日期范围限制
            available = summary.withdrawable;
            processing = 0; // LinkBux 没有 processing 状态
            
            // 已提现金额：根据日期范围筛选
            if (startDate || endDate) {
              const filteredHistory = summary.history.filter(h => {
                if (!h.paid_date) return false;
                const paidDate = new Date(h.paid_date);
                if (startDate && paidDate < new Date(startDate)) return false;
                if (endDate && paidDate > new Date(endDate + 'T23:59:59')) return false;
                return true;
              });
              withdrawn = filteredHistory.reduce((sum, h) => sum + h.amount, 0);
            } else {
              withdrawn = summary.withdrawn;
            }
            
            console.log(`📊 LinkBux 账号 ${account.account_name}: 可提现 $${available.toFixed(2)}, 已提现 $${withdrawn.toFixed(2)}`);
          } catch (error) {
            console.error(`❌ 获取 LinkBux 账号 ${account.account_name} 数据失败:`, error.message);
          }
        }
      } else if (account.platform === 'rewardoo') {
        // Rewardoo: 可提现金额 = 提现后余额 + 新增已批准佣金
        if (account.api_token) {
          try {
            // 计算可提现金额（提现后余额 + 新增佣金）
            available = await calculateRewardooAvailableBalance(account.api_token, account.id, db);
            
            // 2. 从 Payment API 获取已提现金额
            const summary = await getRewardooWithdrawalSummary(
              account.api_token,
              '2020-01-01',
              new Date().toISOString().split('T')[0]
            );
            
            processing = summary.processing;
            
            // 已提现金额：根据日期范围筛选
            if (startDate || endDate) {
              const filteredHistory = summary.history.filter(h => {
                if (!h.paid_date) return false;
                const paidDate = new Date(h.paid_date);
                if (startDate && paidDate < new Date(startDate)) return false;
                if (endDate && paidDate > new Date(endDate + 'T23:59:59')) return false;
                return true;
              });
              withdrawn = filteredHistory.reduce((sum, h) => sum + h.amount, 0);
            } else {
              withdrawn = summary.withdrawn;
            }
            
            console.log(`📊 Rewardoo 账号 ${account.account_name}: 可提现 $${available.toFixed(2)}, 已提现 $${withdrawn.toFixed(2)}`);
          } catch (error) {
            console.error(`❌ 获取 Rewardoo 账号 ${account.account_name} 数据失败:`, error.message);
            // 即使失败也继续，不阻塞其他账号
            available = 0;
            processing = 0;
            withdrawn = 0;
          }
        }
      } else if (account.platform === 'partnermatic') {
        // PartnerMatic: 使用现有的基于订单表的逻辑
        // 1. 可提现金额：从数据库读取
        const availableResult = db.prepare(`
          SELECT COALESCE(SUM(commission), 0) as amount
          FROM orders
          WHERE platform_account_id = ?
            AND status = 'Approved'
            AND settlement_date IS NOT NULL
            AND paid_date IS NULL
        `).get(account.id);
        
        available = parseFloat(availableResult.amount || 0);

        // 2. 提现中金额：从 withdrawal_requests 表读取 processing 状态
        const processingResult = db.prepare(`
          SELECT COALESCE(SUM(o.commission), 0) as amount, COUNT(*) as count
          FROM orders o
          INNER JOIN withdrawal_requests wr ON o.withdrawal_request_id = wr.id
          WHERE o.platform_account_id = ?
            AND wr.status = 'processing'
        `).get(account.id);

        processing = parseFloat(processingResult.amount || 0);

        // 3. 已支付金额：从 Payment Summary API 获取（必须提供日期范围）
        if (account.api_token) {
          try {
            const url = 'https://api.partnermatic.com/api/payment_summary';
            
            // Payment Summary API 要求必须提供日期范围
            const paidDateBegin = startDate || '2020-01-01';
            const paidDateEnd = endDate || new Date().toISOString().split('T')[0];
            
            const requestBody = {
              source: 'partnermatic',
              token: account.api_token,
              paidDateBegin,
              paidDateEnd
            };
            
            const response = await axios.post(url, requestBody, {
              headers: { 'Content-Type': 'application/json' },
              timeout: 10000
            });
            
            if ((response.data.code === 0 || response.data.code === '0') && response.data.data) {
              const payments = response.data.data.list || [];
              withdrawn = payments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
              console.log(`📊 PartnerMatic 账号 ${account.account_name}: ${payments.length} 条提现记录, 总计 ${withdrawn.toFixed(2)}`);
            }
          } catch (error) {
            console.error(`❌ 获取 PartnerMatic 账号 ${account.account_name} Payment Summary 失败:`, error.message);
          }
        }
      }

      totalAvailable += available;
      totalProcessing += processing;
      totalWithdrawn += withdrawn;

      totalAvailable += available;
      totalProcessing += processing;
      totalWithdrawn += withdrawn;

      accountData.push({
        accountId: account.id,
        platform: account.platform,
        accountName: account.account_name,
        affiliateName: account.affiliate_name,
        userId: account.user_id,
        username: account.username,
        email: account.email,
        availableToWithdraw: available,
        processingAmount: processing,
        withdrawnAmount: withdrawn
      });
    }

    res.json({
      success: true,
      data: {
        totals: {
          availableToWithdraw: totalAvailable,
          processingAmount: totalProcessing,
          withdrawnAmount: totalWithdrawn
        },
        accounts: accountData
      }
    });
  } catch (error) {
    console.error('获取提现汇总数据错误:', error);
    res.json({ success: false, message: '获取失败: ' + error.message });
  }
});

/**
 * API: 获取提现历史记录（简化版 - 按账号分组）
 * GET /api/super-admin/withdrawal/payment-history
 */
app.get('/api/super-admin/withdrawal/payment-history', authenticateToken, requireSuperAdmin, auditLog('view_payment_history'), async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    // 获取所有账号（包括 PartnerMatic 和 LinkBux）
    const accounts = db.prepare(`
      SELECT 
        pa.id,
        pa.platform,
        pa.account_name,
        pa.affiliate_name,
        pa.api_token,
        u.username,
        u.email
      FROM platform_accounts pa
      INNER JOIN users u ON pa.user_id = u.id
      WHERE pa.platform IN ('partnermatic', 'linkbux', 'rewardoo')
        AND pa.api_token IS NOT NULL
        AND pa.api_token != ''
      ORDER BY u.username, pa.account_name
    `).all();
    
    // 为每个账号调用 Payment Summary API
    const accountPayments = [];
    
    for (const account of accounts) {
      let availableAmount = 0;
      let payments = [];
      let totalAmount = 0;

      try {
        if (account.platform === 'linkbux') {
          // LinkBux: 始终查询所有历史数据，然后根据 paid_date 筛选
          const summary = await getLinkBuxWithdrawalSummary(
            account.api_token,
            '2020-01-01',
            new Date().toISOString().split('T')[0]
          );
          
          // 可提现金额不受日期范围限制
          availableAmount = summary.withdrawable;
          
          // 根据 paid_date 筛选提现历史
          let filteredHistory = summary.history;
          if (startDate || endDate) {
            filteredHistory = summary.history.filter(h => {
              if (!h.paid_date) return false;
              const paidDate = new Date(h.paid_date);
              if (startDate && paidDate < new Date(startDate)) return false;
              if (endDate && paidDate > new Date(endDate + 'T23:59:59')) return false;
              return true;
            });
          }
          
          totalAmount = filteredHistory.reduce((sum, h) => sum + h.amount, 0);
          
          // 转换 LinkBux 提现历史格式
          payments = filteredHistory.map(h => ({
            payment_id: h.payment_id || '-',
            request_date: null,
            paid_date: h.paid_date,
            amount: h.amount,
            status: 'Paid',
            payment_type: 'LinkBux',
            payment_details: `${h.records.length} 条结算记录`
          }));
          
        } else if (account.platform === 'rewardoo') {
          // Rewardoo: 可提现金额 = 提现后余额 + 新增已批准佣金
          const summary = await getRewardooWithdrawalSummary(
            account.api_token,
            '2020-01-01',
            new Date().toISOString().split('T')[0]
          );
          
          // 计算可提现金额（提现后余额 + 新增佣金）
          availableAmount = await calculateRewardooAvailableBalance(account.api_token, account.id, db);
          
          // 根据 paid_date 筛选提现历史
          let filteredHistory = summary.history;
          if (startDate || endDate) {
            filteredHistory = summary.history.filter(h => {
              if (!h.paid_date) return false;
              const paidDate = new Date(h.paid_date);
              if (startDate && paidDate < new Date(startDate)) return false;
              if (endDate && paidDate > new Date(endDate + 'T23:59:59')) return false;
              return true;
            });
          }
          
          totalAmount = filteredHistory.reduce((sum, h) => sum + h.amount, 0);
          
          // 转换 Rewardoo 提现历史格式
          payments = filteredHistory.map(h => ({
            payment_id: h.payment_id || '-',
            request_date: h.withdrawal_time,
            paid_date: h.paid_date,
            amount: h.amount,
            status: h.status || 'Paid',
            payment_type: 'Rewardoo',
            payment_details: h.bank_name ? `${h.bank_name} - ${h.recipient}` : h.recipient
          }));
          
        } else if (account.platform === 'partnermatic') {
          // PartnerMatic: 使用现有逻辑
          // 1. 获取可提现金额（从数据库）
          const availableResult = db.prepare(`
            SELECT COALESCE(SUM(commission), 0) as amount
            FROM orders
            WHERE platform_account_id = ?
              AND status = 'Approved'
              AND settlement_date IS NOT NULL
              AND paid_date IS NULL
          `).get(account.id);
          
          availableAmount = parseFloat(availableResult.amount || 0);
          
          // 2. 获取提现历史（从 Payment Summary API）
          const url = 'https://api.partnermatic.com/api/payment_summary';
          
          // Payment Summary API 要求必须提供日期范围
          const paidDateBegin = startDate || '2020-01-01';
          const paidDateEnd = endDate || new Date().toISOString().split('T')[0];
          
          const requestBody = {
            source: 'partnermatic',
            token: account.api_token,
            paidDateBegin,
            paidDateEnd
          };
          
          const response = await axios.post(url, requestBody, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000
          });
          
          if ((response.data.code === 0 || response.data.code === '0') && response.data.data) {
            const pmPayments = response.data.data.list || [];
            totalAmount = pmPayments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
            
            payments = pmPayments.map(p => ({
              payment_id: p.payment_id,
              request_date: p.request_date,
              paid_date: p.paid_date,
              amount: parseFloat(p.amount || 0),
              status: p.status || 'Paid',
              payment_type: p.payment_type || 'Bank',
              payment_details: p.payment_details
            }));
          }
        }
        
        // 添加账号到列表
        accountPayments.push({
          account_id: account.id,
          platform: account.platform,
          account_name: account.account_name,
          affiliate_name: account.affiliate_name,
          username: account.username,
          email: account.email,
          available_amount: availableAmount,
          total_amount: totalAmount,
          payment_count: payments.length,
          payments: payments
        });
        
      } catch (error) {
        console.error(`获取账号 ${account.account_name} 提现历史失败:`, error.message);
        // 即使 API 失败，也添加账号（只显示可提现金额）
        accountPayments.push({
          account_id: account.id,
          platform: account.platform,
          account_name: account.account_name,
          affiliate_name: account.affiliate_name,
          username: account.username,
          email: account.email,
          available_amount: 0,
          total_amount: 0,
          payment_count: 0,
          payments: []
        });
      }
    }
    
    res.json({
      success: true,
      data: {
        accountPayments: accountPayments,
        total_accounts: accountPayments.length
      }
    });
  } catch (error) {
    console.error('获取提现历史记录错误:', error);
    res.json({ success: false, message: '获取失败: ' + error.message });
  }
});

/**
 * API: 快速更新 settlement 字段（从 raw_data 提取）
 * POST /api/super-admin/withdrawal/quick-update
 */
app.post('/api/super-admin/withdrawal/quick-update', authenticateToken, requireSuperAdmin, auditLog('quick_update_settlement'), async (req, res) => {
  try {
    console.log('⚡ 快速更新 settlement 字段（从 raw_data）...');
    
    // 获取所有 PM 账号
    const accounts = db.prepare(`
      SELECT pa.id, pa.account_name, u.username
      FROM platform_accounts pa
      INNER JOIN users u ON pa.user_id = u.id
      WHERE pa.platform = 'partnermatic'
      ORDER BY u.username, pa.account_name
    `).all();
    
    if (accounts.length === 0) {
      return res.json({
        success: false,
        message: '没有找到 PartnerMatic 账号'
      });
    }
    
    console.log(`📋 找到 ${accounts.length} 个 PM 账号`);
    
    let totalProcessed = 0;
    let totalUpdated = 0;
    const accountResults = [];
    
    // 准备更新语句
    const updateStmt = db.prepare(`
      UPDATE orders 
      SET settlement_id = ?,
          settlement_date = ?,
          paid_date = ?,
          payment_id = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    
    // 处理每个账号
    for (const account of accounts) {
      console.log(`\n📦 处理账号: ${account.account_name} (${account.username})`);
      
      // 获取该账号的所有订单
      const orders = db.prepare(`
        SELECT id, order_id, raw_data, settlement_date, paid_date
        FROM orders
        WHERE platform_account_id = ?
      `).all(account.id);
      
      console.log(`  找到 ${orders.length} 条订单`);
      
      let accountUpdated = 0;
      let accountProcessed = 0;
      
      for (const order of orders) {
        try {
          // 解析 raw_data
          const rawData = JSON.parse(order.raw_data);
          
          // 检查是否需要更新
          const needsUpdate = 
            (rawData.settlement_id && !order.settlement_date) ||
            (rawData.settlement_date && !order.settlement_date) ||
            (rawData.paid_date && !order.paid_date) ||
            (rawData.payment_id && !order.payment_id);
          
          if (needsUpdate) {
            // 从 raw_data 提取字段
            const settlementId = rawData.settlement_id || null;
            const settlementDate = rawData.settlement_date || null;
            const paidDate = rawData.paid_date || null;
            const paymentId = rawData.payment_id || null;
            
            // 更新数据库
            const result = updateStmt.run(
              settlementId,
              settlementDate,
              paidDate,
              paymentId,
              order.id
            );
            
            if (result.changes > 0) {
              accountUpdated++;
            }
          }
          
          accountProcessed++;
        } catch (error) {
          console.error(`  ❌ 处理订单 ${order.order_id} 失败:`, error.message);
        }
      }
      
      totalProcessed += accountProcessed;
      totalUpdated += accountUpdated;
      
      // 计算更新后的可提现金额
      const available = db.prepare(`
        SELECT COALESCE(SUM(commission), 0) as amount
        FROM orders
        WHERE platform_account_id = ?
          AND status = 'Approved'
          AND settlement_date IS NOT NULL
          AND paid_date IS NULL
      `).get(account.id);
      
      console.log(`  ✅ 处理 ${accountProcessed} 条, 更新 ${accountUpdated} 条`);
      console.log(`  💰 可提现: $${available.amount.toFixed(2)}`);
      
      accountResults.push({
        accountName: account.account_name,
        username: account.username,
        processed: accountProcessed,
        updated: accountUpdated,
        available_amount: available.amount  // 改为下划线命名
      });
    }
    
    console.log(`\n✅ 更新完成！总计处理 ${totalProcessed} 条订单, 更新 ${totalUpdated} 条`);
    
    // 生成详细的结果消息
    let detailMessage = `快速更新完成！\n\n`;
    detailMessage += `总计: 处理 ${totalProcessed} 条订单, 更新 ${totalUpdated} 条\n\n`;
    detailMessage += `账号明细:\n`;
    accountResults.forEach(result => {
      detailMessage += `- ${result.accountName} (${result.username}): 更新 ${result.updated} 条, 可提现 $${result.available_amount.toFixed(2)}\n`;
    });
    
    res.json({
      success: true,
      message: detailMessage,
      data: {
        totalProcessed,
        totalUpdated,
        accounts: accountResults
      }
    });
  } catch (error) {
    console.error('快速更新失败:', error);
    res.json({ success: false, message: '更新失败: ' + error.message });
  }
});

/**
 * API: 同步 PM 订单数据（更新 settlement_date 和 paid_date）
 * POST /api/super-admin/withdrawal/sync-pm-orders
 */
app.post('/api/super-admin/withdrawal/sync-pm-orders', authenticateToken, requireSuperAdmin, auditLog('sync_pm_orders'), async (req, res) => {
  try {
    console.log('🔄 开始同步 PM 订单数据...');
    
    // 获取所有 PM 账号
    const accounts = db.prepare(`
      SELECT pa.*, u.username 
      FROM platform_accounts pa
      INNER JOIN users u ON pa.user_id = u.id
      WHERE pa.platform = 'partnermatic'
        AND pa.api_token IS NOT NULL
      ORDER BY u.username, pa.account_name
    `).all();
    
    if (accounts.length === 0) {
      return res.json({
        success: false,
        message: '没有找到 PartnerMatic 账号'
      });
    }
    
    console.log(`📋 找到 ${accounts.length} 个 PM 账号`);
    
    let totalUpdated = 0;
    let totalProcessed = 0;
    const accountResults = [];
    
    // 同步每个账号
    for (const account of accounts) {
      console.log(`\n📦 处理账号: ${account.account_name} (${account.username})`);
      
      // 先检查数据库中是否有订单
      const dbOrderCount = db.prepare(`
        SELECT COUNT(*) as count FROM orders WHERE platform_account_id = ?
      `).get(account.id);
      
      console.log(`  📊 数据库中有 ${dbOrderCount.count} 条订单`);
      
      if (dbOrderCount.count === 0) {
        console.log(`  ⚠️  跳过：该账号没有订单数据，请先采集订单`);
        accountResults.push({
          accountName: account.account_name,
          username: account.username,
          processed: 0,
          updated: 0,
          message: '没有订单数据，请先采集'
        });
        continue;
      }
      
      let accountUpdated = 0;
      let accountProcessed = 0;
      let page = 1;
      let hasMore = true;
      let apiOrderCount = 0;
      
      while (hasMore) {
        try {
          // 调用 Transaction API（和数据采集使用相同的 API）
          const url = 'https://api.partnermatic.com/api/transaction';
          
          // 使用最近1年的日期范围，避免数据量过大
          const endDate = new Date();
          const startDate = new Date();
          startDate.setFullYear(endDate.getFullYear() - 1);
          
          const requestBody = {
            source: 'partnermatic',
            token: account.api_token,
            dataScope: 'user',
            beginDate: startDate.toISOString().split('T')[0],
            endDate: endDate.toISOString().split('T')[0],
            curPage: page,
            perPage: 100
          };
          
          console.log(`  📡 调用 API 第 ${page} 页...`);
          console.log(`  📅 日期范围: ${requestBody.beginDate} ~ ${requestBody.endDate}`);
          
          const response = await axios.post(url, requestBody, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000
          });
          
          console.log(`  📥 API 响应 code: ${response.data.code}`);
          
          if (response.data.code === '0' && response.data.data) {
            const data = response.data.data;
            const orders = data.list || [];
            const total = data.total || 0;
            const totalPages = Math.ceil(total / 100);
            apiOrderCount += orders.length;
            
            console.log(`  📄 第 ${page} 页: ${orders.length} 条订单 (总计 ${total} 条)`);
            
            if (orders.length === 0) {
              if (total === 0) {
                console.log(`  ℹ️  该账号在此日期范围内没有订单`);
              }
              hasMore = false;
              break;
            }
            
            // 更新数据库
            const updateStmt = db.prepare(`
              UPDATE orders 
              SET settlement_id = ?,
                  settlement_date = ?,
                  paid_date = ?,
                  payment_id = ?,
                  updated_at = CURRENT_TIMESTAMP
              WHERE platform_account_id = ? 
                AND order_id = ?
            `);
            
            for (const order of orders) {
              try {
                const result = updateStmt.run(
                  order.settlement_id || null,
                  order.settlement_date || null,
                  order.paid_date || null,
                  order.payment_id || null,
                  account.id,
                  order.order_id
                );
                
                if (result.changes > 0) {
                  accountUpdated++;
                }
                accountProcessed++;
              } catch (err) {
                console.error(`    ❌ 更新订单 ${order.order_id} 失败:`, err.message);
              }
            }
            
            // 检查是否还有更多页
            if (page >= totalPages) {
              hasMore = false;
            } else {
              page++;
              // 延迟避免 API 限制
              await new Promise(resolve => setTimeout(resolve, 500));
            }
          } else {
            console.error(`  ❌ API 返回错误:`);
            console.error(`     code: ${response.data.code}`);
            console.error(`     message: ${response.data.message || 'N/A'}`);
            console.error(`     完整响应:`, JSON.stringify(response.data));
            hasMore = false;
          }
        } catch (error) {
          console.error(`  ❌ API 调用失败:`, error.message);
          if (error.response) {
            console.error(`     HTTP 状态: ${error.response.status}`);
            console.error(`     响应数据:`, error.response.data);
          }
          hasMore = false;
        }
      }
      
      totalUpdated += accountUpdated;
      totalProcessed += accountProcessed;
      
      console.log(`  📊 API 返回 ${apiOrderCount} 条订单`);
      console.log(`  ✅ 完成: 处理 ${accountProcessed} 条, 更新 ${accountUpdated} 条`);
      
      if (accountProcessed === 0 && dbOrderCount.count > 0) {
        console.log(`  ⚠️  警告: 数据库有 ${dbOrderCount.count} 条订单，但 API 返回 0 条`);
      }
      
      accountResults.push({
        accountName: account.account_name,
        username: account.username,
        processed: accountProcessed,
        updated: accountUpdated,
        dbOrders: dbOrderCount.count,
        apiOrders: apiOrderCount
      });
    }
    
    console.log(`\n✅ 同步完成！总计处理 ${totalProcessed} 条订单, 更新 ${totalUpdated} 条`);
    
    // 生成详细的结果消息
    let detailMessage = `同步完成！\n\n`;
    detailMessage += `总计: 处理 ${totalProcessed} 条订单, 更新 ${totalUpdated} 条\n\n`;
    detailMessage += `账号明细:\n`;
    accountResults.forEach(acc => {
      detailMessage += `- ${acc.accountName}: `;
      if (acc.message) {
        detailMessage += acc.message;
      } else {
        detailMessage += `DB ${acc.dbOrders} 条, API ${acc.apiOrders} 条, 更新 ${acc.updated} 条`;
      }
      detailMessage += `\n`;
    });
    
    res.json({
      success: true,
      message: detailMessage,
      data: {
        totalAccounts: accounts.length,
        totalProcessed,
        totalUpdated,
        accounts: accountResults
      }
    });
    
  } catch (error) {
    console.error('❌ 同步失败:', error);
    res.json({
      success: false,
      message: '同步失败: ' + error.message
    });
  }
});


/**
 * API: 获取提现历史记录（汇总）
 * GET /api/super-admin/withdrawal/history
 */
app.get('/api/super-admin/withdrawal/history', authenticateToken, requireSuperAdmin, auditLog('view_withdrawal_history'), async (req, res) => {
  try {
    const { page = 1, pageSize = 20, platform, userId } = req.query;
    const pageNum = parseInt(page);
    const size = parseInt(pageSize);

    // 获取符合条件的账号
    let query = `
      SELECT 
        pa.id,
        pa.platform,
        pa.account_name,
        pa.affiliate_name,
        pa.api_token,
        u.id as user_id,
        u.username,
        u.email
      FROM platform_accounts pa
      INNER JOIN users u ON pa.user_id = u.id
      WHERE pa.platform = 'partnermatic' AND pa.api_token IS NOT NULL AND pa.api_token != ''
    `;
    const params = [];

    if (platform) {
      query += ' AND pa.platform = ?';
      params.push(platform);
    }
    if (userId) {
      query += ' AND u.id = ?';
      params.push(userId);
    }

    query += ' ORDER BY u.username, pa.account_name';

    const accounts = db.prepare(query).all(...params);

    if (accounts.length === 0) {
      return res.json({
        success: true,
        data: {
          total: 0,
          page: pageNum,
          pageSize: size,
          totalPage: 0,
          list: []
        }
      });
    }

    // 获取所有账号的历史记录
    const allHistory = [];
    const BATCH_SIZE = 3; // 降低并发，避免频率限制

    for (let i = 0; i < accounts.length; i += BATCH_SIZE) {
      const batch = accounts.slice(i, i + BATCH_SIZE);
      const promises = batch.map(async (account) => {
        try {
          // 获取该账号的所有历史记录（可能需要分页）
          const result = await callPMPaymentHistory(account.api_token, 1, 100);
          if (result.success && result.data && result.data.list) {
            return result.data.list.map(item => ({
              ...item,
              accountId: account.id,
              platform: account.platform,
              accountName: account.account_name,
              affiliateName: account.affiliate_name,
              userId: account.user_id,
              username: account.username,
              email: account.email
            }));
          }
          return [];
        } catch (error) {
          console.error(`获取账号 ${account.account_name} 历史记录失败:`, error);
          return [];
        }
      });

      const results = await Promise.all(promises);
      allHistory.push(...results.flat());
    }

    // 按支付日期倒序排序
    allHistory.sort((a, b) => {
      const dateA = new Date(a.paymentTime || a.createdAt || 0);
      const dateB = new Date(b.paymentTime || b.createdAt || 0);
      return dateB - dateA;
    });

    // 分页
    const total = allHistory.length;
    const totalPage = Math.ceil(total / size);
    const start = (pageNum - 1) * size;
    const end = start + size;
    const paginatedList = allHistory.slice(start, end);

    res.json({
      success: true,
      data: {
        total,
        page: pageNum,
        pageSize: size,
        totalPage,
        list: paginatedList
      }
    });
  } catch (error) {
    console.error('获取提现历史记录错误:', error);
    res.json({ success: false, message: '获取失败: ' + error.message });
  }
});

/**
 * API: 获取按账号分组的提现历史（从数据库读取）
 * GET /api/super-admin/withdrawal/by-account
 */
app.get('/api/super-admin/withdrawal/by-account', authenticateToken, requireSuperAdmin, auditLog('view_withdrawal_by_account'), async (req, res) => {
  try {
    const { startDate, endDate, accountId, paymentMethod } = req.query;
    
    // 获取所有 PartnerMatic 账号
    let accountQuery = `
      SELECT 
        pa.id,
        pa.platform,
        pa.account_name,
        pa.affiliate_name,
        u.id as user_id,
        u.username,
        u.email
      FROM platform_accounts pa
      INNER JOIN users u ON pa.user_id = u.id
      WHERE pa.platform = 'partnermatic'
    `;
    const accountParams = [];
    
    if (accountId && accountId !== 'all') {
      accountQuery += ' AND pa.id = ?';
      accountParams.push(parseInt(accountId));
    }
    
    accountQuery += ' ORDER BY u.username, pa.account_name';
    
    const accounts = db.prepare(accountQuery).all(...accountParams);
    
    if (accounts.length === 0) {
      return res.json({
        success: true,
        data: {
          accounts: []
        }
      });
    }
    
    // 为每个账号获取提现历史
    const accountsWithWithdrawals = [];
    
    for (const account of accounts) {
      // 构建订单查询
      let orderQuery = `
        SELECT 
          o.id,
          o.order_id,
          o.merchant_name,
          o.commission,
          o.settlement_id,
          o.settlement_date,
          o.payment_id,
          o.paid_date,
          o.status,
          u.username,
          u.email
        FROM orders o
        INNER JOIN users u ON o.user_id = u.id
        WHERE o.platform_account_id = ?
          AND o.status = 'Approved'
          AND o.settlement_date IS NOT NULL
      `;
      const orderParams = [account.id];
      
      // 日期筛选
      if (startDate) {
        orderQuery += ' AND o.settlement_date >= ?';
        orderParams.push(startDate);
      }
      if (endDate) {
        orderQuery += ' AND o.settlement_date <= ?';
        orderParams.push(endDate);
      }
      
      orderQuery += ' ORDER BY o.settlement_date DESC, o.paid_date DESC';
      
      const withdrawals = db.prepare(orderQuery).all(...orderParams);
      
      // 计算该账号的统计数据
      const availableToWithdraw = withdrawals
        .filter(w => !w.paid_date)
        .reduce((sum, w) => sum + w.commission, 0);
      
      const withdrawnAmount = withdrawals
        .filter(w => w.paid_date)
        .reduce((sum, w) => sum + w.commission, 0);
      
      accountsWithWithdrawals.push({
        accountId: account.id,
        platform: account.platform,
        accountName: account.account_name,
        affiliateName: account.affiliate_name,
        userId: account.user_id,
        username: account.username,
        email: account.email,
        availableToWithdraw,
        withdrawnAmount,
        withdrawals: withdrawals
      });
    }
    
    res.json({
      success: true,
      data: {
        accounts: accountsWithWithdrawals
      }
    });
  } catch (error) {
    console.error('获取按账号分组的提现历史错误:', error);
    res.json({ success: false, message: '获取失败: ' + error.message });
  }
});

/**
 * API: 获取单个账号的提现详情
 * GET /api/super-admin/withdrawal/account/:accountId
 */
app.get('/api/super-admin/withdrawal/account/:accountId', authenticateToken, requireSuperAdmin, auditLog('view_account_withdrawal'), async (req, res) => {
  try {
    const accountId = parseInt(req.params.accountId);

    const account = db.prepare(`
      SELECT 
        pa.id,
        pa.platform,
        pa.account_name,
        pa.affiliate_name,
        pa.api_token,
        u.id as user_id,
        u.username,
        u.email
      FROM platform_accounts pa
      INNER JOIN users u ON pa.user_id = u.id
      WHERE pa.id = ?
    `).get(accountId);

    if (!account) {
      return res.json({
        success: false,
        message: '账号不存在'
      });
    }

    if (!account.api_token && !account.account_password) {
      return res.json({
        success: false,
        message: '账号未配置API Token或密码'
      });
    }

    // 获取 token（先尝试 api_token，失败则登录获取 auth_token）
    let token = account.api_token;
    let summaryResult = await callPMPaymentSummary(token);
    
    if ((!summaryResult.success || !token) && account.account_password) {
      console.log(`🔄 账号 ${account.account_name}: 尝试登录获取 auth_token...`);
      try {
        const password = decryptPassword(account.account_password);
        const loginResult = await loginPartnerMatic(account.account_name, password);
        if (loginResult.success) {
          token = loginResult.auth_token;
          summaryResult = await callPMPaymentSummary(token);
        }
      } catch (loginError) {
        console.error(`登录失败: ${loginError.message}`);
      }
    }
    
    // 获取历史记录
    const historyResult = await callPMPaymentHistory(token, 1, 50);

    res.json({
      success: true,
      data: {
        account: {
          id: account.id,
          platform: account.platform,
          accountName: account.account_name,
          affiliateName: account.affiliate_name,
          userId: account.user_id,
          username: account.username,
          email: account.email
        },
        summary: summaryResult.success ? summaryResult.data : null,
        history: historyResult.success ? historyResult.data : null,
        error: summaryResult.success && historyResult.success ? null : 
               (summaryResult.message || historyResult.message || '获取数据失败')
      }
    });
  } catch (error) {
    console.error('获取账号提现详情错误:', error);
    res.json({ success: false, message: '获取失败: ' + error.message });
  }
});

// 静态文件服务 - 放在所有API路由之后
app.use(express.static('public'));

// 启动服务器
app.listen(PORT, () => {
  console.log('\n🚀 多用户SaaS系统启动成功！');
  console.log('='.repeat(60));
  console.log(`📡 服务地址: http://localhost:${PORT}`);
  console.log(`🔗 打开浏览器访问: http://localhost:${PORT}`);
  console.log('='.repeat(60));
  console.log('\n💡 提示: 按 Ctrl+C 停止服务器\n');
});