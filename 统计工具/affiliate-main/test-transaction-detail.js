// 测试订单明细接口
const axios = require('axios');
const crypto = require('crypto');

// ============ 配置区 ============
const CONFIG = {
  // 从登录获取的token
  token: 'U-70598376.e2adzPml5gRrHN4mnhZgU5_bZA3j3M_a6UsCsUdRaJaX6kTThYArr98Q_aM5vpsr2cb2v_aPXZbBA_aR4ivQfaI_bbh1ru56XtXAH11S8vA5W2h5wSlJDAM8y61zLVtKjCw6RUwHq5ubeLfcQOo4FZgG3iX7dRhus5Fu5jwg_c_c',

  // 查询日期范围
  startDate: '2025-10-06',
  endDate: '2025-10-12',

  // 分页参数
  page: 1,
  pageSize: 100, // 每页获取100条
};

// ============ 工具函数 ============
function generateSign(data) {
  const salt = 'TSf03xGHykY';
  return crypto.createHash('md5').update(data + salt, 'utf-8').digest('hex');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ 核心功能 ============

/**
 * 获取订单明细数据
 * @param {string} token - 登录token
 * @param {string} startDate - 开始日期 YYYY-MM-DD
 * @param {string} endDate - 结束日期 YYYY-MM-DD
 * @param {number} page - 页码
 * @param {number} pageSize - 每页数量
 */
async function fetchTransactionDetail(token, startDate, endDate, page = 1, pageSize = 100) {
  console.log(`\n📊 获取订单明细 (${startDate} ~ ${endDate}, 第${page}页)...\n`);

  try {
    const exportFlag = '0';

    // 计算sign: start_date + end_date + page + page_size + export
    const signData = `${startDate}${endDate}${page}${pageSize}${exportFlag}`;
    const sign = generateSign(signData);

    console.log('🔐 请求参数:');
    console.log(`    start_date: ${startDate}`);
    console.log(`    end_date: ${endDate}`);
    console.log(`    page: ${page}`);
    console.log(`    page_size: ${pageSize}`);
    console.log(`    sign: ${sign}`);

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

    // 检查响应
    const isSuccess = response.data.code === '0200' || response.data.msg === '成功';

    if (isSuccess && response.data.payload) {
      const payload = response.data.payload;
      const orders = payload.info || [];
      const total = payload.total || {};

      console.log(`✅ 获取成功！`);
      console.log(`\n📈 汇总信息:`);
      console.log(`    总订单数: ${total.items || 0}`);
      console.log(`    总订单金额: $${total.total_amount || '0'}`);
      console.log(`    总佣金: $${total.total_aff_ba || '0'}`);
      console.log(`    本页订单数: ${orders.length}`);

      if (orders.length === 0) {
        console.log('\n⚠️  该日期范围内没有订单');
        return { orders: [], total, hasMore: false };
      }

      // 打印前3条订单示例
      console.log(`\n📦 订单示例 (前3条):`);
      orders.slice(0, 3).forEach((order, index) => {
        console.log(`\n[${index + 1}] 订单ID: ${order.c_order_id}`);
        console.log(`    商家: ${order.sitename} (${order.m_id})`);
        console.log(`    商家编号: ${order.mcid}`);
        console.log(`    订单时间: ${order.date_ymd}`);
        console.log(`    订单金额: $${order.amount}`);
        console.log(`    佣金: $${order.total_cmsn}`);
        console.log(`    佣金率: ${order.rate}`);
        console.log(`    状态: ${order.status}`);
        console.log(`    标签: ${order.tag}`);
      });

      // 判断是否还有更多数据
      const totalItems = parseInt(total.items || '0');
      const hasMore = page * pageSize < totalItems;

      console.log(`\n📄 分页信息:`);
      console.log(`    当前页: ${page}`);
      console.log(`    每页数量: ${pageSize}`);
      console.log(`    总数据量: ${totalItems}`);
      console.log(`    是否还有更多: ${hasMore ? '是' : '否'}`);

      return { orders, total, hasMore, totalItems };
    } else {
      console.error('❌ 获取数据失败:', response.data.msg || response.data.code);
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

/**
 * 获取所有订单（自动分页）
 */
async function fetchAllTransactions(token, startDate, endDate, pageSize = 100) {
  console.log('🚀 开始获取所有订单数据...\n');
  console.log('=' .repeat(70));

  let allOrders = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const result = await fetchTransactionDetail(token, startDate, endDate, page, pageSize);

    if (!result) {
      console.error(`\n❌ 第${page}页获取失败，停止`);
      break;
    }

    allOrders = allOrders.concat(result.orders);
    hasMore = result.hasMore;

    if (hasMore) {
      console.log(`\n⏳ 等待1秒后获取下一页...`);
      await sleep(1000);
      page++;
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log(`✅ 所有数据获取完成！共 ${allOrders.length} 条订单\n`);

  return allOrders;
}

/**
 * 按商家汇总订单数据
 */
function summarizeByMerchant(orders) {
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

    // 按状态分类佣金
    if (order.status === 'Pending') {
      merchant.pendingCommission += commission;
    } else if (order.status === 'Confirmed' || order.status === 'Paid') {
      merchant.confirmedCommission += commission;
    } else if (order.status === 'Rejected' || order.status === 'Cancelled') {
      merchant.rejectedCommission += commission;
    }
  });

  return Array.from(merchantMap.values());
}

/**
 * 打印汇总报表
 */
function printSummaryReport(summary) {
  console.log('\n' + '='.repeat(70));
  console.log('📊 商家汇总报表\n');

  // 按总佣金排序
  summary.sort((a, b) => b.totalCommission - a.totalCommission);

  summary.forEach((merchant, index) => {
    console.log(`\n[${index + 1}] ${merchant.sitename} (${merchant.mcid})`);
    console.log(`    订单数: ${merchant.orderCount}`);
    console.log(`    订单总额: $${merchant.totalAmount.toFixed(2)}`);
    console.log(`    总佣金: $${merchant.totalCommission.toFixed(2)}`);
    console.log(`    └─ Pending: $${merchant.pendingCommission.toFixed(2)}`);
    console.log(`    └─ Confirmed: $${merchant.confirmedCommission.toFixed(2)}`);
    console.log(`    └─ Rejected: $${merchant.rejectedCommission.toFixed(2)}`);
  });

  console.log('\n' + '='.repeat(70));

  // 总计
  const totals = summary.reduce((acc, m) => ({
    orderCount: acc.orderCount + m.orderCount,
    totalAmount: acc.totalAmount + m.totalAmount,
    totalCommission: acc.totalCommission + m.totalCommission,
  }), { orderCount: 0, totalAmount: 0, totalCommission: 0 });

  console.log('\n💰 总计:');
  console.log(`    商家数: ${summary.length}`);
  console.log(`    订单总数: ${totals.orderCount}`);
  console.log(`    订单总额: $${totals.totalAmount.toFixed(2)}`);
  console.log(`    总佣金: $${totals.totalCommission.toFixed(2)}`);
}

// ============ 主程序 ============
async function main() {
  console.log('🚀 LinkHaitao 订单明细数据采集\n');
  console.log('=' .repeat(70));

  // 检查配置
  if (!CONFIG.token || CONFIG.token.includes('在这里填入')) {
    console.error('❌ 请先配置Token！');
    return;
  }

  console.log('\n📋 当前配置:');
  console.log(`    Token: ${CONFIG.token.substring(0, 30)}...`);
  console.log(`    日期范围: ${CONFIG.startDate} ~ ${CONFIG.endDate}`);
  console.log(`    分页大小: ${CONFIG.pageSize}`);

  console.log('\n💡 提示: 如果数据量大，自动分页会花费较长时间\n');
  console.log('=' .repeat(70));

  // 方式1: 获取单页数据（快速测试）
  console.log('\n【方式1】获取第一页数据 (快速测试):\n');
  const singlePageResult = await fetchTransactionDetail(
    CONFIG.token,
    CONFIG.startDate,
    CONFIG.endDate,
    CONFIG.page,
    CONFIG.pageSize
  );

  if (!singlePageResult) {
    console.error('\n❌ 数据获取失败');
    return;
  }

  // 如果数据很多，询问是否继续获取所有
  if (singlePageResult.hasMore) {
    console.log('\n⚠️  检测到还有更多数据');
    console.log(`    预计总页数: ${Math.ceil(singlePageResult.totalItems / CONFIG.pageSize)}`);
    console.log(`    预计总耗时: ${Math.ceil(singlePageResult.totalItems / CONFIG.pageSize)} 秒`);
    console.log('\n💡 如需获取所有数据，请修改代码启用方式2\n');
  }

  // 方式2: 获取所有数据（取消注释以启用）
  /*
  console.log('\n【方式2】获取所有订单数据:\n');
  const allOrders = await fetchAllTransactions(
    CONFIG.token,
    CONFIG.startDate,
    CONFIG.endDate,
    CONFIG.pageSize
  );

  if (allOrders.length > 0) {
    // 按商家汇总
    const summary = summarizeByMerchant(allOrders);
    printSummaryReport(summary);
  }
  */

  console.log('\n' + '='.repeat(70));
  console.log('✅ 测试完成！');
  console.log('\n💡 下一步: 将此功能集成到完整系统中');
}

main().catch(error => {
  console.error('💥 程序崩溃:', error);
  process.exit(1);
});
