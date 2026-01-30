/**
 * 自动初始化超级管理员
 * 服务器启动时自动运行
 */

const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const { runPendingMigrations } = require('./migrate');

async function initAdmin() {
  // 先运行数据库迁移,确保表结构存在
  console.log('🔧 检查数据库结构...');
  try {
    runPendingMigrations();
  } catch (error) {
    console.error('❌ 数据库迁移失败:', error.message);
    return;
  }

  // 使用与 db.js 相同的路径逻辑
  const DB_PATH = process.env.NODE_ENV === 'production' 
    ? path.join('/app/data', 'data.db')  // Railway Volume 路径
    : path.join(__dirname, 'data.db');   // 本地开发路径
  
  console.log('📂 数据库路径:', DB_PATH);
  const db = new Database(DB_PATH);

  try {
    // 检查是否已有超级管理员
    const existingAdmin = db.prepare(`
      SELECT COUNT(*) as count FROM users WHERE role = 'super_admin'
    `).get();

    if (existingAdmin.count > 0) {
      console.log('✅ 超级管理员已存在');
      return;
    }

    // 从环境变量读取或使用默认值
    const email = process.env.ADMIN_EMAIL || 'admin@test.com';
    const username = process.env.ADMIN_USERNAME || 'SuperAdmin';
    const password = process.env.ADMIN_PASSWORD || 'Admin123456';

    console.log('\n🔧 检测到没有超级管理员，开始创建...');

    // 加密密码
    const hashedPassword = await bcrypt.hash(password, 10);

    // 创建超级管理员
    db.prepare(`
      INSERT INTO users (username, email, password_hash, role, is_active, created_at)
      VALUES (?, ?, ?, 'super_admin', 1, datetime('now'))
    `).run(username, email, hashedPassword);

    console.log('\n✅ 超级管理员创建成功！');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📧 邮箱:', email);
    console.log('👤 用户名:', username);
    console.log('🔑 密码:', password);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('⚠️  请登录后立即修改密码！\n');

  } catch (error) {
    console.error('❌ 初始化超管失败:', error.message);
  } finally {
    db.close();
  }
}

module.exports = initAdmin;

// 如果直接运行此文件
if (require.main === module) {
  initAdmin().catch(console.error);
}

