// 检查特定广告系列的广告费数据
const { db } = require('./db');

// 从命令行参数获取查询条件
const args = process.argv.slice(2);
const merchantId = args[0] || '133';
const campaignName = args[1] || '088-Ih1-Gilt-US-1028-133';
const startDate = args[2] || null; // 格式: YYYY-MM-DD
const endDate = args[3] || null;

console.log('🔍 查询广告费数据...\n');
console.log(`商家ID: ${merchantId}`);
console.log(`广告系列: ${campaignName}`);
if (startDate) console.log(`开始日期: ${startDate}`);
if (endDate) console.log(`结束日期: ${endDate}`);
console.log('');

// 构建查询
let query = `
  SELECT 
    date,
    user_id,
    affiliate_name,
    campaign_name,
    cost,
    impressions,
    clicks,
    currency
  FROM google_ads_data
  WHERE merchant_id = ? 
    AND campaign_name LIKE ?
`;

const params = [merchantId, `%${campaignName}%`];

if (startDate) {
  query += ' AND date >= ?';
  params.push(startDate);
}

if (endDate) {
  query += ' AND date <= ?';
  params.push(endDate);
}

query += ' ORDER BY date DESC, user_id';

const rows = db.prepare(query).all(...params);

console.log(`📊 找到 ${rows.length} 条记录\n`);

if (rows.length === 0) {
  console.log('❌ 没有找到匹配的数据');
  process.exit(0);
}

// 按日期分组统计
const dateStats = {};
let totalCost = 0;
let totalImpressions = 0;
let totalClicks = 0;

rows.forEach(row => {
  const date = row.date;
  if (!dateStats[date]) {
    dateStats[date] = {
      cost: 0,
      impressions: 0,
      clicks: 0,
      count: 0
    };
  }
  dateStats[date].cost += parseFloat(row.cost || 0);
  dateStats[date].impressions += parseInt(row.impressions || 0);
  dateStats[date].clicks += parseInt(row.clicks || 0);
  dateStats[date].count += 1;
  
  totalCost += parseFloat(row.cost || 0);
  totalImpressions += parseInt(row.impressions || 0);
  totalClicks += parseInt(row.clicks || 0);
});

// 显示按日期统计
console.log('📅 按日期统计:');
console.log('─'.repeat(80));
console.log(`${'日期'.padEnd(12)} ${'广告费'.padEnd(12)} ${'展示'.padEnd(12)} ${'点击'.padEnd(12)} ${'记录数'.padEnd(10)}`);
console.log('─'.repeat(80));

Object.keys(dateStats).sort().reverse().forEach(date => {
  const stats = dateStats[date];
  console.log(
    `${date.padEnd(12)} $${stats.cost.toFixed(2).padEnd(11)} ${stats.impressions.toLocaleString().padEnd(12)} ${stats.clicks.toLocaleString().padEnd(12)} ${stats.count.toString().padEnd(10)}`
  );
});

console.log('─'.repeat(80));
console.log(`${'总计'.padEnd(12)} $${totalCost.toFixed(2).padEnd(11)} ${totalImpressions.toLocaleString().padEnd(12)} ${totalClicks.toLocaleString().padEnd(12)} ${rows.length.toString().padEnd(10)}`);
console.log('');

// 显示详细记录（最近10条）
console.log('📋 最近10条详细记录:');
console.log('─'.repeat(100));
rows.slice(0, 10).forEach((row, index) => {
  console.log(`${index + 1}. 日期: ${row.date}, 用户ID: ${row.user_id}, 联盟: ${row.affiliate_name || 'N/A'}, 广告费: $${parseFloat(row.cost || 0).toFixed(2)}, 展示: ${row.impressions}, 点击: ${row.clicks}`);
});

if (rows.length > 10) {
  console.log(`... 还有 ${rows.length - 10} 条记录`);
}

console.log('');

// 检查是否有其他日期范围的数据
if (startDate || endDate) {
  console.log('🔍 检查所有日期的数据（不限制日期范围）...');
  const allQuery = `
    SELECT 
      MIN(date) as min_date,
      MAX(date) as max_date,
      COUNT(*) as total_count,
      SUM(cost) as total_cost_all
    FROM google_ads_data
    WHERE merchant_id = ? 
      AND campaign_name LIKE ?
  `;
  const allStats = db.prepare(allQuery).get(merchantId, `%${campaignName}%`);
  
  if (allStats) {
    console.log(`📊 所有日期范围: ${allStats.min_date} 至 ${allStats.max_date}`);
    console.log(`📊 总记录数: ${allStats.total_count}`);
    console.log(`📊 总广告费: $${parseFloat(allStats.total_cost_all || 0).toFixed(2)}`);
    
    if (startDate || endDate) {
      const filteredCost = totalCost;
      const allCost = parseFloat(allStats.total_cost_all || 0);
      const diff = allCost - filteredCost;
      console.log(`\n⚠️  当前日期范围(${startDate || '开始'} 至 ${endDate || '结束'})的广告费: $${filteredCost.toFixed(2)}`);
      console.log(`⚠️  所有日期的总广告费: $${allCost.toFixed(2)}`);
      console.log(`⚠️  差异: $${diff.toFixed(2)}`);
    }
  }
}

db.close();

