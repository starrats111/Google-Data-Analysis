// LinkBux Payment API 工具函数
const axios = require('axios');

/**
 * 获取 LinkBux Payment Details
 * @param {string} apiToken - API Token
 * @param {string} beginDate - 开始日期 (YYYY-MM-DD)
 * @param {string} endDate - 结束日期 (YYYY-MM-DD)
 * @returns {Promise<Array>} 结算记录数组
 */
async function fetchLinkBuxPaymentDetails(apiToken, beginDate, endDate) {
  const url = 'https://www.linkbux.com/api.php';
  const params = {
    mod: 'settlement',
    gn: 'merchant_commission',
    token: apiToken,
    begin_date: beginDate,
    end_date: endDate
  };

  try {
    const response = await axios.get(url, { params, timeout: 30000 });
    
    if (response.data.status.code !== 0) {
      throw new Error(`LinkBux API Error: ${response.data.status.msg}`);
    }

    return response.data.data || [];
  } catch (error) {
    if (error.response) {
      throw new Error(`LinkBux API Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
}

/**
 * 计算 LinkBux 可提现金额
 * @param {Array} settlements - 结算记录数组
 * @returns {number} 可提现金额
 */
function calculateWithdrawable(settlements) {
  return settlements
    .filter(s => s.settlement_date && !s.paid_date)
    .reduce((sum, s) => sum + parseFloat(s.sale_comm || 0), 0);
}

/**
 * 计算 LinkBux 已提现金额
 * @param {Array} settlements - 结算记录数组
 * @returns {number} 已提现金额
 */
function calculateWithdrawn(settlements) {
  return settlements
    .filter(s => s.paid_date)
    .reduce((sum, s) => sum + parseFloat(s.sale_comm || 0), 0);
}

/**
 * 获取 LinkBux 提现历史（按 payment_id 分组）
 * @param {Array} settlements - 结算记录数组
 * @returns {Array} 提现历史数组
 */
function getWithdrawalHistory(settlements) {
  const paidSettlements = settlements.filter(s => s.paid_date);
  
  // 按 payment_id 分组
  const groups = {};
  
  paidSettlements.forEach(s => {
    const key = s.payment_id || s.paid_date;
    if (!groups[key]) {
      groups[key] = {
        payment_id: s.payment_id,
        paid_date: s.paid_date,
        amount: 0,
        records: []
      };
    }
    groups[key].amount += parseFloat(s.sale_comm || 0);
    groups[key].records.push({
      merchant_name: s.merchant_name,
      mcid: s.mcid,
      commission: parseFloat(s.sale_comm || 0),
      settlement_date: s.settlement_date,
      settlement_uuid: s.settlement_uuid
    });
  });

  return Object.values(groups).sort((a, b) => {
    return new Date(b.paid_date) - new Date(a.paid_date);
  });
}

/**
 * 获取 LinkBux 完整的提现摘要（支持长时间范围，自动分批查询）
 * @param {string} apiToken - API Token
 * @param {string} beginDate - 开始日期 (YYYY-MM-DD)，默认从 2020-01-01
 * @param {string} endDate - 结束日期 (YYYY-MM-DD)，默认到今天
 * @returns {Promise<Object>} 提现摘要
 */
async function getLinkBuxWithdrawalSummary(apiToken, beginDate = null, endDate = null) {
  // 默认查询从 2020 年到现在的所有数据
  if (!beginDate) {
    beginDate = '2020-01-01';
  }
  if (!endDate) {
    endDate = new Date().toISOString().split('T')[0];
  }

  // LinkBux API 限制：查询时间跨度不能超过 62 天
  // 需要分批查询
  const allSettlements = [];
  const start = new Date(beginDate);
  const end = new Date(endDate);
  const maxDays = 60; // 使用 60 天以确保不超过限制

  let currentStart = new Date(start);
  
  while (currentStart < end) {
    const currentEnd = new Date(currentStart);
    currentEnd.setDate(currentEnd.getDate() + maxDays);
    
    // 不超过结束日期
    if (currentEnd > end) {
      currentEnd.setTime(end.getTime());
    }

    try {
      const settlements = await fetchLinkBuxPaymentDetails(
        apiToken,
        currentStart.toISOString().split('T')[0],
        currentEnd.toISOString().split('T')[0]
      );
      
      allSettlements.push(...settlements);
      console.log(`  📅 查询 ${currentStart.toISOString().split('T')[0]} 到 ${currentEnd.toISOString().split('T')[0]}: ${settlements.length} 条记录`);
    } catch (error) {
      console.error(`  ❌ 查询 ${currentStart.toISOString().split('T')[0]} 到 ${currentEnd.toISOString().split('T')[0]} 失败:`, error.message);
    }

    // 移动到下一个时间段
    currentStart.setDate(currentStart.getDate() + maxDays + 1);
  }

  console.log(`  ✅ 总共查询到 ${allSettlements.length} 条结算记录`);

  return {
    withdrawable: calculateWithdrawable(allSettlements),
    withdrawn: calculateWithdrawn(allSettlements),
    pending: 0, // LinkBux 没有 pending 状态
    total: allSettlements.reduce((sum, s) => sum + parseFloat(s.sale_comm || 0), 0),
    history: getWithdrawalHistory(allSettlements),
    settlements: allSettlements
  };
}

module.exports = {
  fetchLinkBuxPaymentDetails,
  calculateWithdrawable,
  calculateWithdrawn,
  getWithdrawalHistory,
  getLinkBuxWithdrawalSummary
};
