const Database = require('better-sqlite3');
const db = new Database('./data.db', { readonly: true });

try {
  console.log('\n📊 快速检查广告数据\n');
  
  // 检查merchant_id=77235 (第3条，预算显示$0.00)
  const m77235 = db.prepare(`
    SELECT date, campaign_budget, currency, cost
    FROM google_ads_data
    WHERE user_id = 2 AND merchant_id = '77235'
    AND date >= '2025-10-23' AND date <= '2025-10-28'
  `).all();
  
  console.log('商家77235 (10/23-10/28):');
  if (m77235.length > 0) {
    m77235.forEach(r => console.log(`  ${r.date}: 预算=${r.campaign_budget} ${r.currency}, 费用=${r.cost}`));
  } else {
    console.log('  ❌ 没有数据');
  }
  
  // 检查merchant_id=96470 (第1条，广告费$0.49)
  const m96470 = db.prepare(`
    SELECT date, campaign_budget, currency, impressions, clicks, cost
    FROM google_ads_data
    WHERE user_id = 2 AND merchant_id = '96470'
    ORDER BY date DESC
    LIMIT 10
  `).all();
  
  console.log('\n商家96470 (最近10条):');
  if (m96470.length > 0) {
    m96470.forEach(r => console.log(`  ${r.date}: 预算=${r.campaign_budget}, 展示/点击=${r.impressions}/${r.clicks}, 费用=${r.cost}`));
  } else {
    console.log('  ❌ 没有数据');
  }
  
} catch (err) {
  console.error('Error:', err.message);
} finally {
  db.close();
}

