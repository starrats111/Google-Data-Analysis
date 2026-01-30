// 查询平台账号的affiliate_name字段
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data.db'));

console.log('\n=== 📋 平台账号列表 ===\n');

const accounts = db.prepare(`
  SELECT id, user_id, platform, account_name, affiliate_name, created_at
  FROM platform_accounts
  ORDER BY id
`).all();

if (accounts.length === 0) {
  console.log('暂无平台账号');
} else {
  console.log(`共 ${accounts.length} 个平台账号:\n`);

  accounts.forEach((acc, index) => {
    console.log(`${index + 1}. [ID: ${acc.id}] ${acc.platform} - ${acc.account_name}`);
    console.log(`   联盟序号: ${acc.affiliate_name || '(未设置)'}`);
    console.log(`   用户ID: ${acc.user_id}`);
    console.log(`   创建时间: ${acc.created_at}`);
    console.log('');
  });

  // 统计
  const withAffiliate = accounts.filter(a => a.affiliate_name).length;
  const withoutAffiliate = accounts.length - withAffiliate;

  console.log('📊 统计:');
  console.log(`   ✅ 已设置联盟序号: ${withAffiliate} 个`);
  console.log(`   ⚠️  未设置联盟序号: ${withoutAffiliate} 个`);
}

db.close();
console.log('\n=== ✅ 查询完成 ===\n');
