// Migration 11: convert_cny_to_usd
// 将数据库中所有CNY货币的广告数据转换为USD（汇率7.13）

function up(db) {
  console.log('  执行 convert_cny_to_usd...');
  
  const EXCHANGE_RATE = 7.13;
  
  // 查询所有CNY数据
  const cnyRecords = db.prepare(`
    SELECT id, campaign_budget, cost, currency 
    FROM google_ads_data 
    WHERE currency = 'CNY'
  `).all();
  
  console.log(`  找到 ${cnyRecords.length} 条CNY数据需要转换`);
  
  if (cnyRecords.length === 0) {
    console.log('  没有需要转换的数据');
    return;
  }
  
  // 批量更新
  const updateStmt = db.prepare(`
    UPDATE google_ads_data
    SET campaign_budget = ?,
        cost = ?,
        currency = 'USD'
    WHERE id = ?
  `);
  
  const updateMany = db.transaction((records) => {
    let updated = 0;
    for (const record of records) {
      const newBudget = record.campaign_budget / EXCHANGE_RATE;
      const newCost = record.cost / EXCHANGE_RATE;
      updateStmt.run(newBudget, newCost, record.id);
      updated++;
    }
    return updated;
  });
  
  const updatedCount = updateMany(cnyRecords);
  console.log(`  成功转换 ${updatedCount} 条记录从CNY到USD（汇率${EXCHANGE_RATE}）`);
}

function down(db) {
  console.log('  回滚 convert_cny_to_usd...');
  console.log('  警告：此操作无法完全回滚，因为无法区分原始CNY数据和已转换的USD数据');
  console.log('  如果需要回滚，请从备份恢复数据库');
}

module.exports = { up, down };

