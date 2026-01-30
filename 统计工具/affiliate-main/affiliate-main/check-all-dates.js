const Database = require('better-sqlite3');
const db = new Database('./data.db');

console.log('\n📊 检查merchant_id=103599的所有数据\n');

const allData = db.prepare(`
  SELECT date, campaign_name, campaign_budget, currency, impressions, clicks, cost
  FROM google_ads_data
  WHERE user_id = 2 AND merchant_id = '103599'
  ORDER BY date DESC
  LIMIT 20
`).all();

console.log(`总共 ${allData.length} 条记录\n`);

allData.forEach((row, idx) => {
  console.log(`${idx + 1}. ${row.date} - ${row.campaign_name}`);
  console.log(`   预算: ${row.campaign_budget} ${row.currency}, 展示/点击: ${row.impressions}/${row.clicks}, 费用: ${row.cost}`);
});

db.close();

