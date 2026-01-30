const Database = require('better-sqlite3');
const db = new Database('./data.db');

console.log('\n📊 调试广告数据查询\n');

const userId = 2; // 用户ID 2 (cjiu)
const startDate = '2025-10-22';
const endDate = '2025-10-28';

// 模拟后端的查询
const adsQuery = `
  SELECT
    merchant_id,
    LOWER(affiliate_name) as affiliate_name,
    GROUP_CONCAT(DISTINCT campaign_name) as campaign_names,
    MAX(campaign_budget) as total_budget,
    MAX(currency) as currency,
    SUM(impressions) as total_impressions,
    SUM(clicks) as total_clicks,
    SUM(CASE WHEN currency = 'CNY' THEN cost / 7.15 ELSE cost END) as total_cost
  FROM google_ads_data
  WHERE user_id = ? 
    AND campaign_name IS NOT NULL 
    AND campaign_name != ''
    AND date >= ?
    AND date <= ?
  GROUP BY merchant_id, LOWER(affiliate_name)
`;

const results = db.prepare(adsQuery).all(userId, startDate, endDate);

console.log(`找到 ${results.length} 个商家\n`);

// 查找merchant_id = 103599的数据
const target = results.find(r => r.merchant_id === '103599');

if (target) {
  console.log('merchant_id = 103599 的汇总数据:');
  console.log(JSON.stringify(target, null, 2));
} else {
  console.log('❌ 未找到 merchant_id = 103599');
}

// 显示前3个结果
console.log('\n前3个结果:');
results.slice(0, 3).forEach((r, idx) => {
  console.log(`\n${idx + 1}. merchant_id: ${r.merchant_id}`);
  console.log(`   campaign_names: ${r.campaign_names}`);
  console.log(`   预算: ${r.total_budget} ${r.currency}`);
  console.log(`   展示/点击: ${r.total_impressions}/${r.total_clicks}`);
  console.log(`   总广告费: ${r.total_cost.toFixed(2)}`);
});

db.close();

