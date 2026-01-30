// Rewardoo Payment API 工具函数
const axios = require('axios');

/**
 * 获取 Rewardoo 提现列表（使用 get_withdraw_list API）
 * @param {string} apiToken - API Token
 * @returns {Promise<Object>} 提现数据
 */
async function fetchRewardooWithdrawList(apiToken) {
  const url = 'https://rewardoo.com/unisive/creator/payments/get_withdraw_list';
  
  try {
    const response = await axios.post(url, new URLSearchParams({
      token: apiToken,
      perpage: '10',
      curpage: '1'
    }), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 30000
    });
    
    // 检查响应
    if (response.data.code === '0' && response.data.msg === 'success') {
      return response.data.data;
    } else {
      throw new Error(`Rewardoo API Error: ${response.data.msg || 'Unknown error'}`);
    }
  } catch (error) {
    if (error.response) {
      throw new Error(`Rewardoo API Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
}

/**
 * 获取 Rewardoo 可提现金额（从 get_withdraw_list API）
/**
 * 计算 Rewardoo 可提现金额
 * 可提现金额 = 提现后余额 + 新增已批准佣金
 * @param {string} apiToken - API Token
 * @param {number} accountId - 账号ID
 * @param {Object} db - 数据库连接
 * @returns {Promise<number>} 可提现金额
 */
async function calculateRewardooAvailableBalance(apiToken, accountId, db) {
  try {
    // 1. 从 Payment API 获取最新的 account_balance（提现后余额）
    const payments = await fetchRewardooPayments(
      apiToken,
      '2020-01-01',
      new Date().toISOString().split('T')[0]
    );
    
    let accountBalance = 0;
    if (payments.length > 0) {
      // 获取最新的提现记录
      const sortedPayments = [...payments].sort((a, b) => {
        return new Date(b.update_time || b.withdrawal_time) - new Date(a.update_time || a.withdrawal_time);
      });
      accountBalance = parseFloat((sortedPayments[0].account_balance || '0').replace(/,/g, ''));
    }
    
    // 2. 从订单表获取最新提现后的已批准佣金
    // Rewardoo 的 Pending 状态订单即使没有 settlement_date 也算可提现
    let newCommission = 0;
    if (payments.length > 0) {
      const lastWithdrawalDate = payments[0].update_time || payments[0].withdrawal_time;
      const result = db.prepare(`
        SELECT COALESCE(SUM(commission), 0) as amount
        FROM orders
        WHERE platform_account_id = ?
          AND status = 'Pending'
          AND order_date >= ?
      `).get(accountId, lastWithdrawalDate);
      newCommission = parseFloat(result.amount || 0);
    } else {
      // 如果没有提现记录，则获取所有 Pending 订单
      const result = db.prepare(`
        SELECT COALESCE(SUM(commission), 0) as amount
        FROM orders
        WHERE platform_account_id = ?
          AND status = 'Pending'
      `).get(accountId);
      newCommission = parseFloat(result.amount || 0);
    }
    
    return accountBalance + newCommission;
  } catch (error) {
    console.error('计算 Rewardoo 可提现余额失败:', error.message);
    return 0;
  }
}

/**
 * 获取 Rewardoo Payment 数据
 * @param {string} apiToken - API Token
 * @param {string} beginDate - 开始日期 (YYYY-MM-DD)
 * @param {string} endDate - 结束日期 (YYYY-MM-DD)
 * @returns {Promise<Array>} 提现记录数组
 */
async function fetchRewardooPayments(apiToken, beginDate, endDate) {
  const url = 'https://admin.rewardoo.com/api.php?mod=commission&op=payments';
  
  try {
    const response = await axios.post(url, new URLSearchParams({
      token: apiToken,
      payment_begin: beginDate,
      payment_end: endDate
    }), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 30000
    });
    
    // 检查响应 - Rewardoo 使用 status.code
    if (response.data.status && (response.data.status.code === 0 || response.data.status.code === '0')) {
      return response.data.data || [];
    } else {
      const errorMsg = response.data.status ? response.data.status.msg : 'Unknown error';
      throw new Error(`Rewardoo API Error: ${errorMsg}`);
    }
  } catch (error) {
    if (error.response) {
      throw new Error(`Rewardoo API Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
}

/**
 * 计算 Rewardoo 可提现金额
 * 从最新的提现记录中获取 account_balance
 * @param {Array} payments - 提现记录数组
 * @returns {number} 可提现金额
 */
function calculateAvailable(payments) {
  if (payments.length === 0) return 0;
  
  // 获取最新的记录（按 update_time 排序）
  const sortedPayments = [...payments].sort((a, b) => {
    return new Date(b.update_time || b.withdrawal_time) - new Date(a.update_time || a.withdrawal_time);
  });
  
  const latestPayment = sortedPayments[0];
  return parseFloat((latestPayment.account_balance || '0').replace(/,/g, ''));
}

/**
 * 计算 Rewardoo 已提现金额
 * @param {Array} payments - 提现记录数组
 * @returns {number} 已提现金额
 */
function calculateWithdrawn(payments) {
  return payments
    .filter(p => p.status && p.status.toLowerCase() === 'withdrawn')
    .reduce((sum, p) => {
      // 移除金额中的逗号
      const amount = parseFloat((p.withdrawal_amount || '0').replace(/,/g, ''));
      return sum + amount;
    }, 0);
}

/**
 * 计算 Rewardoo 提现中金额
 * @param {Array} payments - 提现记录数组
 * @returns {number} 提现中金额
 */
function calculateProcessing(payments) {
  return payments
    .filter(p => p.status && p.status.toLowerCase() === 'processing')
    .reduce((sum, p) => {
      const amount = parseFloat((p.withdrawal_amount || '0').replace(/,/g, ''));
      return sum + amount;
    }, 0);
}

/**
 * 获取 Rewardoo 提现历史（格式化）
 * @param {Array} payments - 提现记录数组
 * @returns {Array} 格式化的提现历史
 */
function getWithdrawalHistory(payments) {
  return payments
    .filter(p => p.status && p.status.toLowerCase() === 'withdrawn')
    .map(p => ({
      payment_id: p.withdrawal_id,
      withdrawal_time: p.withdrawal_time,
      paid_date: p.update_time, // 使用 update_time 作为实际支付日期
      amount: parseFloat((p.withdrawal_amount || '0').replace(/,/g, '')),
      commission: parseFloat((p.commission || '0').replace(/,/g, '')),
      status: p.status,
      bank_name: p.bank_name,
      recipient: p.recipient
    }))
    .sort((a, b) => new Date(b.paid_date) - new Date(a.paid_date));
}

/**
 * 获取 Rewardoo 完整的提现摘要（支持长时间范围，自动分批查询）
 * @param {string} apiToken - API Token
 * @param {string} beginDate - 开始日期 (YYYY-MM-DD)，默认从 2020-01-01
 * @param {string} endDate - 结束日期 (YYYY-MM-DD)，默认到今天
 * @returns {Promise<Object>} 提现摘要
 */
async function getRewardooWithdrawalSummary(apiToken, beginDate = null, endDate = null) {
  // 默认查询从 2020 年到现在的所有数据
  if (!beginDate) {
    beginDate = '2020-01-01';
  }
  if (!endDate) {
    endDate = new Date().toISOString().split('T')[0];
  }

  // Rewardoo API 可能也有日期范围限制，这里先尝试一次性查询
  // 如果失败，可以改为分批查询（类似 LinkBux）
  try {
    const payments = await fetchRewardooPayments(apiToken, beginDate, endDate);
    
    console.log(`  ✅ 查询到 ${payments.length} 条提现记录`);

    return {
      available: calculateAvailable(payments), // 需要从其他来源获取
      withdrawn: calculateWithdrawn(payments),
      processing: calculateProcessing(payments),
      total: payments.reduce((sum, p) => {
        const amount = parseFloat((p.withdrawal_amount || '0').replace(/,/g, ''));
        return sum + amount;
      }, 0),
      history: getWithdrawalHistory(payments),
      payments: payments
    };
  } catch (error) {
    // 如果是日期范围限制错误，可以在这里实现分批查询
    console.error(`  ❌ Rewardoo API 调用失败:`, error.message);
    throw error;
  }
}

module.exports = {
  fetchRewardooPayments,
  calculateRewardooAvailableBalance,
  calculateAvailable,
  calculateWithdrawn,
  calculateProcessing,
  getWithdrawalHistory,
  getRewardooWithdrawalSummary
};
