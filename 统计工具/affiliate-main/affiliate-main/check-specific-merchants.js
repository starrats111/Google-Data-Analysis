const Database = require('better-sqlite3');
const db = new Database('./data.db');

console.log('\n📊 检查特定商家的广告数据\n');

const userId = 2; // cjiu用户
const merchants = ['96470', '73900', '77235']; // 图中的三个商家

merchants.forEach(merchantId => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`商家 ID: ${merchantId}`);
  console.log('='.repeat(60));
  
  const data = db.prepare(`
    SELECT date, campaign_name, campaign_budget, currency, impressions, clicks, cost
    FROM google_ads_data
    WHERE user_id = ? AND merchant_id = ?
    ORDER BY date DESC
    LIMIT 20
  `).all(userId, merchantId);
  
  if (data.length === 0) {
    console.log('❌ 没有找到数据');
    return;
  }
  
  console.log(`找到 ${data.length} 条记录\n`);
  
  data.forEach((row, idx) => {
    console.log(`${idx + 1}. ${row.date} - ${row.campaign_name}`);
    console.log(`   预算: ${row.campaign_budget} ${row.currency}`);
    console.log(`   展示/点击: ${row.impressions}/${row.clicks}`);
    console.log(`   费用: ${row.cost} ${row.currency}\n`);
  });
  
  // 计算10/23-10/28的汇总
  const summary = db.prepare(`
    SELECT 
      MAX(campaign_budget) as total_budget,
      MAX(currency) as currency,
      SUM(impressions) as total_impressions,
      SUM(clicks) as total_clicks,
      SUM(CASE WHEN currency = 'CNY' THEN cost / 7.15 ELSE cost END) as total_cost
    FROM google_ads_data
    WHERE user_id = ? 
      AND merchant_id = ?
      AND date >= '2025-10-23'
      AND date <= '2025-10-28'
  `).get(userId, merchantId);
  
  console.log('10/23-10/28 汇总:');
  console.log(`  预算: ${summary.total_budget || 0} ${summary.currency || 'N/A'}`);
  console.log(`  总展示: ${summary.total_impressions || 0}`);
  console.log(`  总点击: ${summary.total_clicks || 0}`);
  console.log(`  总费用: $${(summary.total_cost || 0).toFixed(2)}`);
});

db.close();

