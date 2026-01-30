// 完整显示数据库所有表结构和记录
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data.db'));

console.log('\n' + '='.repeat(80));
console.log('📊 数据库完整结构和数据');
console.log('='.repeat(80) + '\n');

// 获取所有表
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();

console.log(`数据库中共有 ${tables.length} 个表\n`);

tables.forEach((table, index) => {
  const tableName = table.name;

  console.log('\n' + '━'.repeat(80));
  console.log(`表 ${index + 1}/${tables.length}: ${tableName}`);
  console.log('━'.repeat(80));

  // 1. 显示表结构
  console.log('\n【表结构】');
  const schema = db.prepare(`PRAGMA table_info(${tableName})`).all();
  console.table(schema.map(col => ({
    序号: col.cid,
    字段名: col.name,
    类型: col.type,
    必填: col.notnull ? '是' : '否',
    默认值: col.dflt_value || '(无)',
    主键: col.pk ? '是' : '否'
  })));

  // 2. 统计记录数
  const count = db.prepare(`SELECT COUNT(*) as count FROM ${tableName}`).get();
  console.log(`\n【记录数】: ${count.count} 条`);

  // 3. 显示数据
  if (count.count > 0) {
    // 根据表的大小决定显示多少条
    const limit = count.count > 10 ? 10 : count.count;

    console.log(`\n【数据预览】（显示最新 ${limit} 条）`);

    try {
      // 尝试按 id 或 created_at 排序
      let orderBy = 'id';
      if (schema.some(col => col.name === 'created_at')) {
        orderBy = 'created_at';
      }

      const data = db.prepare(`SELECT * FROM ${tableName} ORDER BY ${orderBy} DESC LIMIT ${limit}`).all();

      if (data.length > 0) {
        // 根据表名特殊处理显示
        if (tableName === 'users') {
          // 用户表：隐藏密码
          console.table(data.map(r => ({
            id: r.id,
            email: r.email,
            username: r.username,
            is_active: r.is_active,
            created_at: r.created_at
          })));
        } else if (tableName === 'platform_accounts') {
          // 平台账号表：隐藏密码
          console.table(data.map(r => ({
            id: r.id,
            user_id: r.user_id,
            platform: r.platform,
            account_name: r.account_name,
            is_active: r.is_active,
            created_at: r.created_at
          })));
        } else if (tableName === 'orders') {
          // 订单表：简化显示
          console.table(data.map(r => ({
            id: r.id,
            user_id: r.user_id,
            order_id: r.order_id,
            merchant_name: r.merchant_name,
            order_amount: r.order_amount,
            commission: r.commission,
            status: r.status,
            order_date: r.order_date
          })));
        } else if (tableName === 'google_ads_data') {
          // Google广告数据：重点显示新字段
          console.table(data.map(r => ({
            id: r.id,
            date: r.date,
            campaign_name: r.campaign_name?.substring(0, 30) + '...',
            affiliate: r.affiliate_name,
            merchant: r.merchant_id,
            impressions: r.impressions,
            clicks: r.clicks,
            cost: r.cost
          })));
        } else {
          // 其他表：完整显示
          console.table(data);
        }
      }
    } catch (error) {
      console.log(`   ⚠️  无法读取数据: ${error.message}`);
    }

    if (count.count > limit) {
      console.log(`   ... 还有 ${count.count - limit} 条数据未显示`);
    }
  } else {
    console.log('\n   (暂无数据)');
  }
});

// 汇总统计
console.log('\n\n' + '='.repeat(80));
console.log('📈 数据汇总统计');
console.log('='.repeat(80) + '\n');

const summary = {};
tables.forEach(table => {
  const count = db.prepare(`SELECT COUNT(*) as count FROM ${table.name}`).get();
  summary[table.name] = count.count;
});

console.table(Object.entries(summary).map(([table, count]) => ({
  表名: table,
  记录数: count
})));

// 关键业务数据统计
console.log('\n【业务数据统计】\n');

try {
  // 用户统计
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
  console.log(`👥 用户数: ${userCount.count}`);

  // 平台账号统计
  const accountCount = db.prepare('SELECT COUNT(*) as count FROM platform_accounts').get();
  console.log(`🔑 平台账号数: ${accountCount.count}`);

  // 订单统计
  const orderStats = db.prepare(`
    SELECT
      COUNT(*) as total_orders,
      SUM(order_amount) as total_amount,
      SUM(commission) as total_commission
    FROM orders
  `).get();
  console.log(`📦 订单总数: ${orderStats.total_orders}`);
  console.log(`💰 订单总金额: $${orderStats.total_amount || 0}`);
  console.log(`💵 佣金总额: $${orderStats.total_commission || 0}`);

  // Google Sheets统计
  const sheetCount = db.prepare('SELECT COUNT(*) as count FROM google_sheets').get();
  console.log(`\n📊 Google表格数: ${sheetCount.count}`);

  // Google Ads数据统计
  const adsStats = db.prepare(`
    SELECT
      COUNT(*) as total_rows,
      COUNT(DISTINCT date) as unique_dates,
      COUNT(DISTINCT affiliate_name) as unique_affiliates,
      COUNT(DISTINCT merchant_id) as unique_merchants,
      SUM(impressions) as total_impressions,
      SUM(clicks) as total_clicks,
      SUM(cost) as total_cost
    FROM google_ads_data
  `).get();
  console.log(`📈 Google Ads数据行数: ${adsStats.total_rows}`);
  console.log(`   - 日期数: ${adsStats.unique_dates}`);
  console.log(`   - 联盟数: ${adsStats.unique_affiliates}`);
  console.log(`   - 商家数: ${adsStats.unique_merchants}`);
  console.log(`   - 总展示: ${adsStats.total_impressions || 0}`);
  console.log(`   - 总点击: ${adsStats.total_clicks || 0}`);
  console.log(`   - 总花费: $${adsStats.total_cost || 0}`);
} catch (error) {
  console.log(`⚠️  统计数据时出错: ${error.message}`);
}

console.log('\n' + '='.repeat(80));
console.log('✅ 数据库查看完成');
console.log('='.repeat(80) + '\n');

db.close();
