// 检查数据库内容的脚本
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data.db'));

console.log('\n=== 📊 数据库表结构检查 ===\n');

// 1. 查看所有表
console.log('【所有表】');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
tables.forEach(t => console.log(`  - ${t.name}`));

// 2. 查看 google_sheets 表结构
console.log('\n【google_sheets 表结构】');
const sheetSchema = db.prepare("PRAGMA table_info(google_sheets)").all();
console.table(sheetSchema);

// 3. 查看 google_ads_data 表结构
console.log('\n【google_ads_data 表结构】');
const adsSchema = db.prepare("PRAGMA table_info(google_ads_data)").all();
console.table(adsSchema);

// 检查是否有新字段
const hasAffiliateField = adsSchema.some(col => col.name === 'affiliate_name');
const hasMerchantField = adsSchema.some(col => col.name === 'merchant_id');
console.log(`\n✓ 是否包含affiliate_name字段: ${hasAffiliateField ? '✅ 是' : '❌ 否'}`);
console.log(`✓ 是否包含merchant_id字段: ${hasMerchantField ? '✅ 是' : '❌ 否'}`);

// 4. 查看 google_sheets 表数据
console.log('\n【google_sheets 表数据】');
const sheets = db.prepare("SELECT * FROM google_sheets").all();
if (sheets.length > 0) {
  console.table(sheets);
  console.log(`✅ 共 ${sheets.length} 个表格配置`);
} else {
  console.log('⚠️  暂无数据');
}

// 5. 查看 google_ads_data 表数据
console.log('\n【google_ads_data 表数据（最近10条）】');
const adsData = db.prepare("SELECT id, date, campaign_name, affiliate_name, merchant_id, impressions, clicks, cost FROM google_ads_data ORDER BY date DESC LIMIT 10").all();
if (adsData.length > 0) {
  console.table(adsData);

  // 统计
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_rows,
      COUNT(DISTINCT date) as unique_dates,
      COUNT(DISTINCT campaign_name) as unique_campaigns,
      SUM(impressions) as total_impressions,
      SUM(clicks) as total_clicks,
      SUM(cost) as total_cost
    FROM google_ads_data
  `).get();

  console.log('\n【数据统计】');
  console.log(`  总记录数: ${stats.total_rows}`);
  console.log(`  日期数: ${stats.unique_dates}`);
  console.log(`  广告系列数: ${stats.unique_campaigns}`);
  console.log(`  总展示: ${stats.total_impressions}`);
  console.log(`  总点击: ${stats.total_clicks}`);
  console.log(`  总花费: $${stats.total_cost}`);
} else {
  console.log('⚠️  暂无数据');
}

// 6. 查看今日数据
console.log('\n【今日数据】');
const today = new Date().toISOString().split('T')[0];
const todayData = db.prepare("SELECT * FROM google_ads_data WHERE date = ?").all(today);
if (todayData.length > 0) {
  console.table(todayData);
} else {
  console.log(`⚠️  ${today} 暂无数据`);
}

db.close();
console.log('\n=== ✅ 检查完成 ===\n');
