/**
 * 超级管理员创建脚本
 * 用法: node scripts/create-super-admin.js
 */

const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const readline = require('readline');

// 创建readline接口用于交互输入
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Promise化readline.question
function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

// 验证邮箱格式
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// 验证密码强度
function isValidPassword(password) {
  // 至少8位，包含字母和数字
  return password.length >= 8 && /[a-zA-Z]/.test(password) && /[0-9]/.test(password);
}

async function createSuperAdmin() {
  const db = new Database('./data.db');
  
  console.log('\n🔐 超级管理员创建工具\n');
  console.log('⚠️  警告: 此脚本将创建具有最高权限的超级管理员账号\n');

  try {
    // 1. 检查现有超管数量
    const existingAdmins = db.prepare(`
      SELECT COUNT(*) as count FROM users WHERE role = 'super_admin'
    `).get();

    if (existingAdmins.count >= 3) {
      console.error('❌ 错误: 已达到超级管理员数量上限（最多3个）');
      console.log('\n现有超级管理员:');
      const admins = db.prepare(`
        SELECT id, username, email, created_at 
        FROM users 
        WHERE role = 'super_admin'
      `).all();
      admins.forEach(admin => {
        console.log(`   - ${admin.username} (${admin.email}) - 创建于 ${admin.created_at}`);
      });
      db.close();
      rl.close();
      process.exit(1);
    }

    console.log(`ℹ️  当前超级管理员数量: ${existingAdmins.count}/3\n`);

    // 2. 收集信息
    let email, username, password;

    // 输入邮箱
    while (true) {
      email = await question('📧 请输入超级管理员邮箱: ');
      if (!email) {
        console.log('❌ 邮箱不能为空\n');
        continue;
      }
      if (!isValidEmail(email)) {
        console.log('❌ 邮箱格式不正确\n');
        continue;
      }

      // 检查邮箱是否已存在
      const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      if (existingUser) {
        console.log('❌ 该邮箱已被使用\n');
        continue;
      }
      break;
    }

    // 输入用户名
    while (true) {
      username = await question('👤 请输入用户名: ');
      if (!username) {
        console.log('❌ 用户名不能为空\n');
        continue;
      }
      if (username.length < 3) {
        console.log('❌ 用户名至少3个字符\n');
        continue;
      }
      break;
    }

    // 输入密码
    while (true) {
      password = await question('🔑 请输入密码（至少8位，包含字母和数字）: ');
      if (!password) {
        console.log('❌ 密码不能为空\n');
        continue;
      }
      if (!isValidPassword(password)) {
        console.log('❌ 密码强度不够: 至少8位，必须包含字母和数字\n');
        continue;
      }

      const confirmPassword = await question('🔑 请再次输入密码确认: ');
      if (password !== confirmPassword) {
        console.log('❌ 两次密码不一致\n');
        continue;
      }
      break;
    }

    // 3. 确认创建
    console.log('\n📋 请确认以下信息:');
    console.log(`   邮箱: ${email}`);
    console.log(`   用户名: ${username}`);
    console.log(`   角色: 超级管理员 (super_admin)`);
    
    const confirm = await question('\n✅ 确认创建? (输入 yes 确认): ');
    if (confirm.toLowerCase() !== 'yes') {
      console.log('\n❌ 已取消创建');
      db.close();
      rl.close();
      process.exit(0);
    }

    // 4. 创建超管账号
    console.log('\n⏳ 正在创建超级管理员...\n');

    // 加密密码
    const hashedPassword = await bcrypt.hash(password, 10);

    // 插入数据库
    const result = db.prepare(`
      INSERT INTO users (username, email, password_hash, role, is_active, created_at)
      VALUES (?, ?, ?, 'super_admin', 1, datetime('now'))
    `).run(username, email, hashedPassword);

    if (result.changes > 0) {
      console.log('✅ 超级管理员创建成功！\n');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('📧 邮箱:', email);
      console.log('👤 用户名:', username);
      console.log('🔑 密码: (请妥善保管)');
      console.log('👑 角色: 超级管理员');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('\n⚠️  重要提示:');
      console.log('   1. 请立即修改并妥善保管密码');
      console.log('   2. 不要与他人共享超管账号');
      console.log('   3. 所有超管操作都会被审计记录');
      console.log('   4. 建议启用双因素认证（未来版本）\n');

      // 记录到日志文件
      const fs = require('fs');
      const logEntry = `[${new Date().toISOString()}] 创建超级管理员: ${username} (${email})\n`;
      fs.appendFileSync('admin-creation.log', logEntry);
      console.log('📝 已记录到 admin-creation.log\n');
    } else {
      console.error('❌ 创建失败: 数据库写入错误');
    }

  } catch (error) {
    console.error('\n❌ 发生错误:', error.message);
  } finally {
    db.close();
    rl.close();
  }
}

// 执行脚本
createSuperAdmin();

