// 更新已有数据的 affiliate_name 和 merchant_code 字段
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data.db'));

console.log('\n=== 🔄 更新Google Ads数据的联盟名称和商家编号 ===\n');

/**
 * 从广告系列名提取联盟名称和商家编号
 * 格式：596-pm1-Champion-US-0826-71017
 * 联盟名称：第1个-和第2个-之间 → pm1
 * 商家编号：最后一个-之后 → 71017
 */
function extractCampaignInfo(campaignName) {
  if (!campaignName) {
    return { affiliateName: '', merchantId: '' };
  }

  const parts = campaignName.split('-');

  // 联盟名称：第2个元素（索引1）
  const affiliateName = parts.length >= 2 ? parts[1] : '';

  // 商家编号：最后一个元素
  const merchantId = parts.length > 0 ? parts[parts.length - 1] : '';

  return { affiliateName, merchantId };
}

// 1. 查询所有需要更新的数据
const allData = db.prepare('SELECT id, campaign_name, affiliate_name, merchant_id FROM google_ads_data').all();

console.log(`📊 数据库中共有 ${allData.length} 条Google Ads数据`);

// 2. 统计需要更新的数据
const needsUpdate = allData.filter(row => !row.affiliate_name || !row.merchant_id);
console.log(`🔍 其中 ${needsUpdate.length} 条数据的新字段为空，需要更新\n`);

if (needsUpdate.length === 0) {
  console.log('✅ 所有数据的新字段都已填充，无需更新！\n');
  db.close();
  process.exit(0);
}

// 3. 准备更新语句
const updateStmt = db.prepare(`
  UPDATE google_ads_data
  SET affiliate_name = ?, merchant_id = ?
  WHERE id = ?
`);

// 4. 批量更新
console.log('开始更新...\n');
let successCount = 0;
let errorCount = 0;

needsUpdate.forEach((row, index) => {
  try {
    const { affiliateName, merchantId } = extractCampaignInfo(row.campaign_name);

    updateStmt.run(affiliateName, merchantId, row.id);
    successCount++;

    // 显示前5条示例
    if (index < 5) {
      console.log(`[${index + 1}] ${row.campaign_name}`);
      console.log(`    → 联盟名称: "${affiliateName}"  |  商家编号: "${merchantId}"`);
    }
  } catch (error) {
    console.error(`❌ 更新ID ${row.id} 失败:`, error.message);
    errorCount++;
  }
});

if (needsUpdate.length > 5) {
  console.log(`    ... (还有 ${needsUpdate.length - 5} 条)\n`);
} else {
  console.log('');
}

// 5. 验证更新结果
const afterUpdate = db.prepare('SELECT id, campaign_name, affiliate_name, merchant_id FROM google_ads_data WHERE id IN (SELECT id FROM google_ads_data ORDER BY id DESC LIMIT 5)').all();

console.log('【验证：最新5条数据】');
console.table(afterUpdate.map(r => ({
  id: r.id,
  campaign_name: r.campaign_name.substring(0, 35) + '...',
  affiliate: r.affiliate_name,
  merchant: r.merchant_id
})));

// 6. 汇总结果
console.log('\n=== ✅ 更新完成 ===\n');
console.log(`✅ 成功更新: ${successCount} 条`);
if (errorCount > 0) {
  console.log(`❌ 更新失败: ${errorCount} 条`);
}
console.log('\n💡 现在可以运行 `node check-db.js` 查看完整数据\n');

db.close();
