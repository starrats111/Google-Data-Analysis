const Database = require('better-sqlite3');
const db = new Database('./data.db');

console.log('\n📊 查找用户和广告数据\n');

// 查找所有用户
const users = db.prepare('SELECT id, username, email FROM users').all();
console.log('所有用户:');
users.forEach(u => {
  console.log(`  ID ${u.id}: ${u.username} (${u.email})`);
});

// 查找有广告数据的用户
const adsUsers = db.prepare(`
  SELECT DISTINCT user_id, COUNT(*) as count
  FROM google_ads_data
  GROUP BY user_id
`).all();

console.log('\n有广告数据的用户:');
adsUsers.forEach(u => {
  const user = users.find(usr => usr.id === u.user_id);
  console.log(`  用户ID ${u.user_id} (${user ? user.username : '未知'}): ${u.count} 条记录`);
});

db.close();

