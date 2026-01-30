const Database = require('better-sqlite3');
const db = new Database('./data.db', { readonly: true });

console.log('\n🔍 分析日期范围导致的预算NULL问题\n');

const userId = 2;
const startDate = '2025-10-23';
const endDate = '2025-10-28';

// 查询这些预算为0的商家
const merchantIds = ['96470', '77235', '148605'];

merchantIds.forEach(mid => {
  console.log(`${'='.repeat(70)}`);
  console.log(`商家 ${mid}:`);
  console.log('='.repeat(70));
  
  // 1. 查看所有历史数据
  const allData = db.prepare(`
    SELECT date, campaign_name, campaign_budget, currency
    FROM google_ads_data
    WHERE user_id = ? AND merchant_id = ?
    ORDER BY date DESC
  `).all(userId, mid);
  
  console.log(`\n📊 该商家的所有历史数据 (共${allData.length}条):`);
  if (allData.length > 0) {
    allData.forEach(r => {
      const inRange = r.date >= startDate && r.date <= endDate ? '✅' : '❌';
      console.log(`  ${inRange} ${r.date}: 预算=${r.campaign_budget} ${r.currency || ''}`);
    });
  }
  
  // 2. 查询日期范围内的数据
  const rangeData = db.prepare(`
    SELECT date, campaign_name, campaign_budget, currency
    FROM google_ads_data
    WHERE user_id = ? AND merchant_id = ?
      AND date >= ? AND date <= ?
    ORDER BY date DESC
  `).all(userId, mid, startDate, endDate);
  
  console.log(`\n📅 日期范围内的数据 (${startDate} ~ ${endDate}):`);
  if (rangeData.length > 0) {
    console.log(`  找到 ${rangeData.length} 条记录`);
    rangeData.forEach(r => {
      console.log(`  ${r.date}: 预算=${r.campaign_budget} ${r.currency || ''}`);
    });
  } else {
    console.log(`  ❌ 该日期范围内没有数据！`);
  }
  
  // 3. 模拟查询逻辑
  const summary = db.prepare(`
    SELECT
      MAX(campaign_budget) as total_budget,
      MAX(currency) as currency
    FROM google_ads_data
    WHERE user_id = ? AND merchant_id = ?
      AND date >= ? AND date <= ?
  `).get(userId, mid, startDate, endDate);
  
  console.log(`\n📊 MAX(campaign_budget) 结果:`);
  console.log(`  total_budget: ${summary.total_budget === null ? 'NULL' : summary.total_budget}`);
  console.log(`  currency: ${summary.currency === null ? 'NULL' : summary.currency}`);
  console.log();
});

// 查看广告系列名称中的日期
console.log('\n' + '='.repeat(70));
console.log('📌 从广告系列名称提取创建日期:');
console.log('='.repeat(70));

const campaigns = db.prepare(`
  SELECT DISTINCT merchant_id, campaign_name, MIN(date) as first_date, MAX(date) as last_date
  FROM google_ads_data
  WHERE user_id = ? AND merchant_id IN ('96470', '77235', '148605')
  GROUP BY merchant_id, campaign_name
`).all(userId);

campaigns.forEach(c => {
  // 从广告系列名称提取日期 (格式: xxx-1028-xxx)
  const match = c.campaign_name.match(/-(\d{4})-/);
  const campaignDate = match ? match[1] : 'N/A';
  const inRange = c.first_date >= startDate && c.first_date <= endDate ? '✅' : '❌';
  
  console.log(`\n${inRange} 商家${c.merchant_id}: ${c.campaign_name}`);
  console.log(`  广告系列日期标识: ${campaignDate}`);
  console.log(`  数据库最早日期: ${c.first_date}`);
  console.log(`  数据库最晚日期: ${c.last_date}`);
});

db.close();
console.log('\n✅ 分析完成\n');

