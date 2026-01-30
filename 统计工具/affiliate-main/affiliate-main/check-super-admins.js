/**
 * 查看所有超级管理员账号
 */

const Database = require('better-sqlite3');
const db = new Database('./data.db');

try {
  console.log('\n========== 超级管理员账号列表 ==========\n');
  
  const admins = db.prepare(`
    SELECT id, username, email, created_at 
    FROM users 
    WHERE role = 'super_admin'
    ORDER BY created_at ASC
  `).all();
  
  if (admins.length === 0) {
    console.log('❌ 没有找到超级管理员账号');
    console.log('\n请运行以下命令创建超管账号:');
    console.log('   node scripts/create-super-admin.js\n');
  } else {
    console.log(`找到 ${admins.length} 个超级管理员账号:\n`);
    
    admins.forEach((admin, index) => {
      console.log(`${index + 1}. 账号信息:`);
      console.log(`   ID: ${admin.id}`);
      console.log(`   用户名: ${admin.username}`);
      console.log(`   邮箱: ${admin.email}`);
      console.log(`   创建时间: ${admin.created_at}`);
      console.log('');
    });
    
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('⚠️  注意: 此脚本只显示账号信息，不显示密码');
    console.log('如果忘记密码，请联系系统管理员重置\n');
  }
  
} catch (error) {
  console.error('❌ 查询失败:', error.message);
  process.exit(1);
} finally {
  db.close();
}

