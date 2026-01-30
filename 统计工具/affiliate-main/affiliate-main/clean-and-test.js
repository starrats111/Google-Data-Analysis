// 清空错误数据并重新测试采集
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data.db'));

console.log('\n=== 🧹 清空错误数据并准备重新测试 ===\n');

// 1. 显示当前错误数据统计
const before = db.prepare('SELECT COUNT(*) as count FROM google_ads_data').get();
console.log(`📊 当前数据库中有 ${before.count} 条Google Ads数据`);

if (before.count > 0) {
  console.log('\n🗑️  正在清空错误数据...');
  db.prepare('DELETE FROM google_ads_data').run();
  console.log('✅ 已清空所有Google Ads数据');
}

// 2. 验证清空成功
const after = db.prepare('SELECT COUNT(*) as count FROM google_ads_data').get();
console.log(`\n📊 清空后数据量: ${after.count} 条\n`);

// 3. 查看配置的表格
const sheets = db.prepare('SELECT id, sheet_name, sheet_id FROM google_sheets').all();
console.log('📋 已配置的Google表格：');
sheets.forEach(sheet => {
  console.log(`   [${sheet.id}] ${sheet.sheet_name} (sheet_id: ${sheet.sheet_id})`);
});

console.log('\n💡 下一步：');
console.log('   1. 启动服务器: node server-v2.js');
console.log('   2. 打开浏览器: http://localhost:3000');
console.log('   3. 登录后在"Google表格管理"中点击"采集数据"');
console.log('   4. 采集完成后运行: node check-db.js 验证数据');

console.log('\n=== ✅ 准备完成 ===\n');

db.close();
