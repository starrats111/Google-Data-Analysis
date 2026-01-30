/**
 * 超级管理员管理脚本
 * 用法: node scripts/manage-super-admin.js
 * 
 * 功能：
 * - 查看所有超级管理员
 * - 检查数据依赖
 * - 降级操作（带确认）
 * - 删除操作（带确认）
 * - 完整的日志记录
 */

const Database = require('better-sqlite3');
const path = require('path');
const readline = require('readline');
const fs = require('fs');

// 数据库路径配置（与 db.js 保持一致）
// 检测是否在 Railway 环境：检查 /app/data 目录是否存在，或 NODE_ENV=production
function getDatabasePath() {
  const isProduction = process.env.NODE_ENV === 'production';
  const railwayPath = '/app/data/data.db';
  const localPath = path.join(__dirname, '..', 'data.db');
  
  // 如果在生产环境，优先使用 Railway 路径
  if (isProduction) {
    return railwayPath;
  }
  
  // 检查 Railway 路径是否存在（即使 NODE_ENV 不是 production，也可能在 Railway 上）
  if (fs.existsSync(railwayPath)) {
    return railwayPath;
  }
  
  // 否则使用本地路径
  return localPath;
}

const DB_PATH = getDatabasePath();

// 日志文件路径
const LOG_FILE = path.join(__dirname, 'super-admin-management.log');

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

// 记录日志
function log(message, type = 'info') {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] [${type.toUpperCase()}] ${message}\n`;
  
  // 输出到控制台
  console.log(message);
  
  // 写入日志文件
  try {
    fs.appendFileSync(LOG_FILE, logEntry);
  } catch (error) {
    console.error('⚠️  日志写入失败:', error.message);
  }
}

// 格式化日期
function formatDate(dateString) {
  if (!dateString) return 'N/A';
  return new Date(dateString).toLocaleString('zh-CN');
}

// 查看所有超级管理员
function listSuperAdmins(db) {
  log('\n📋 查询所有超级管理员...\n');
  
  const admins = db.prepare(`
    SELECT 
      id, 
      username, 
      email, 
      role,
      is_active,
      created_at,
      updated_at
    FROM users 
    WHERE role = 'super_admin'
    ORDER BY created_at ASC
  `).all();

  if (admins.length === 0) {
    log('⚠️  未找到超级管理员', 'warn');
    return [];
  }

  log(`✅ 找到 ${admins.length} 个超级管理员:\n`);
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('ID      | 用户名          | 邮箱                    | 状态    | 创建时间');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  admins.forEach(admin => {
    const status = admin.is_active ? '✅ 激活' : '❌ 禁用';
    const username = (admin.username || 'N/A').padEnd(14);
    const email = (admin.email || 'N/A').padEnd(22);
    log(`${String(admin.id).padEnd(7)} | ${username} | ${email} | ${status} | ${formatDate(admin.created_at)}`);
  });
  
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  return admins;
}

// 检查用户数据依赖
function checkUserDependencies(db, userId) {
  log(`\n🔍 检查用户 ID ${userId} 的数据依赖...\n`);
  
  const stats = {
    platformAccounts: 0,
    orders: 0,
    adsData: 0,
    auditLogs: 0,
    invitationCodes: 0
  };

  try {
    // 检查平台账号
    const platformAccounts = db.prepare(`
      SELECT COUNT(*) as count FROM platform_accounts WHERE user_id = ?
    `).get(userId);
    stats.platformAccounts = platformAccounts?.count || 0;

    // 检查订单
    const orders = db.prepare(`
      SELECT COUNT(*) as count FROM orders WHERE user_id = ?
    `).get(userId);
    stats.orders = orders?.count || 0;

    // 检查广告数据（如果表存在）
    try {
      const adsData = db.prepare(`
        SELECT COUNT(*) as count FROM google_ads_data WHERE user_id = ?
      `).get(userId);
      stats.adsData = adsData?.count || 0;
    } catch (error) {
      // 表可能不存在，忽略
      stats.adsData = 0;
    }

    // 检查审计日志（作为管理员）
    try {
      const adminLogs = db.prepare(`
        SELECT COUNT(*) as count FROM audit_logs WHERE admin_id = ?
      `).get(userId);
      stats.auditLogs = adminLogs?.count || 0;
    } catch (error) {
      // 表可能不存在，忽略
      stats.auditLogs = 0;
    }

    // 检查邀请码（如果表存在）
    try {
      const invitationCodes = db.prepare(`
        SELECT COUNT(*) as count FROM invitation_codes WHERE created_by = ?
      `).get(userId);
      stats.invitationCodes = invitationCodes?.count || 0;
    } catch (error) {
      // 表可能不存在，忽略
      stats.invitationCodes = 0;
    }

    // 显示统计信息
    log('📊 数据依赖统计:');
    log(`   平台账号: ${stats.platformAccounts} 个`);
    log(`   订单记录: ${stats.orders} 条`);
    log(`   广告数据: ${stats.adsData} 条`);
    log(`   审计日志: ${stats.auditLogs} 条`);
    log(`   邀请码: ${stats.invitationCodes} 个`);
    
    const total = stats.platformAccounts + stats.orders + stats.adsData + stats.auditLogs + stats.invitationCodes;
    log(`   总计: ${total} 条相关数据\n`);

    if (total > 0) {
      log('⚠️  警告: 删除此用户将级联删除以上所有相关数据！', 'warn');
    }

    return stats;
  } catch (error) {
    log(`❌ 检查数据依赖时出错: ${error.message}`, 'error');
    return stats;
  }
}

// 获取用户详细信息
function getUserInfo(db, userId) {
  const user = db.prepare(`
    SELECT id, username, email, role, is_active, created_at, updated_at
    FROM users 
    WHERE id = ?
  `).get(userId);

  if (!user) {
    return null;
  }

  return user;
}

// 降级超级管理员
async function downgradeSuperAdmin(db, userId) {
  log(`\n⬇️  准备降级用户 ID ${userId}...\n`);

  // 获取用户信息
  const user = getUserInfo(db, userId);
  if (!user) {
    log(`❌ 用户 ID ${userId} 不存在`, 'error');
    return false;
  }

  if (user.role !== 'super_admin') {
    log(`⚠️  用户 ID ${userId} 不是超级管理员，当前角色: ${user.role}`, 'warn');
    return false;
  }

  // 显示用户信息
  log('📋 用户信息:');
  log(`   ID: ${user.id}`);
  log(`   用户名: ${user.username || 'N/A'}`);
  log(`   邮箱: ${user.email || 'N/A'}`);
  log(`   当前角色: ${user.role}`);
  log(`   状态: ${user.is_active ? '激活' : '禁用'}\n`);

  // 检查是否还有其他超级管理员
  const otherAdmins = db.prepare(`
    SELECT COUNT(*) as count FROM users WHERE role = 'super_admin' AND id != ?
  `).get(userId);

  if (otherAdmins.count === 0) {
    log('❌ 错误: 这是最后一个超级管理员，不能降级！', 'error');
    log('   请先创建另一个超级管理员，或直接删除此用户。\n');
    return false;
  }

  log(`ℹ️  系统中还有 ${otherAdmins.count} 个其他超级管理员\n`);

  // 确认操作
  log('⚠️  警告: 降级后该用户将失去超级管理员权限！');
  const confirm = await question('❓ 确认降级此用户? (输入 yes 确认): ');
  
  if (confirm.toLowerCase() !== 'yes') {
    log('❌ 已取消降级操作\n');
    return false;
  }

  // 执行降级
  try {
    const result = db.prepare(`
      UPDATE users 
      SET role = 'user', updated_at = datetime('now')
      WHERE id = ? AND role = 'super_admin'
    `).run(userId);

    if (result.changes > 0) {
      log(`✅ 用户 ID ${userId} 已成功降级为普通用户`, 'success');
      log(`📝 操作记录: ${user.username} (${user.email}) 从 super_admin 降级为 user\n`);
      return true;
    } else {
      log(`❌ 降级失败: 未找到匹配的用户或用户已不是超级管理员`, 'error');
      return false;
    }
  } catch (error) {
    log(`❌ 降级操作失败: ${error.message}`, 'error');
    return false;
  }
}

// 删除用户
async function deleteUser(db, userId) {
  log(`\n🗑️  准备删除用户 ID ${userId}...\n`);

  // 获取用户信息
  const user = getUserInfo(db, userId);
  if (!user) {
    log(`❌ 用户 ID ${userId} 不存在`, 'error');
    return false;
  }

  // 显示用户信息
  log('📋 用户信息:');
  log(`   ID: ${user.id}`);
  log(`   用户名: ${user.username || 'N/A'}`);
  log(`   邮箱: ${user.email || 'N/A'}`);
  log(`   角色: ${user.role}`);
  log(`   状态: ${user.is_active ? '激活' : '禁用'}\n`);

  // 检查数据依赖
  const stats = checkUserDependencies(db, userId);

  // 如果是超级管理员，检查是否还有其他超级管理员
  if (user.role === 'super_admin') {
    const otherAdmins = db.prepare(`
      SELECT COUNT(*) as count FROM users WHERE role = 'super_admin' AND id != ?
    `).get(userId);

    if (otherAdmins.count === 0) {
      log('❌ 错误: 这是最后一个超级管理员，不能删除！', 'error');
      log('   请先创建另一个超级管理员，或先降级此用户。\n');
      return false;
    }

    log(`ℹ️  系统中还有 ${otherAdmins.count} 个其他超级管理员\n`);
  }

  // 确认操作
  log('⚠️  严重警告: 删除用户将永久删除该用户及其所有相关数据！', 'warn');
  log('   包括: 平台账号、订单、广告数据等（级联删除）\n');
  
  const confirm1 = await question('❓ 确认删除此用户? (输入 yes 继续): ');
  if (confirm1.toLowerCase() !== 'yes') {
    log('❌ 已取消删除操作\n');
    return false;
  }

  // 二次确认
  const confirm2 = await question('❓ 最后确认: 输入 DELETE 确认删除: ');
  if (confirm2 !== 'DELETE') {
    log('❌ 已取消删除操作（需要输入 DELETE 才能确认）\n');
    return false;
  }

  // 执行删除
  try {
    // 记录删除前的信息（用于日志）
    const userInfo = {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      stats: stats
    };

    const result = db.prepare(`
      DELETE FROM users WHERE id = ?
    `).run(userId);

    if (result.changes > 0) {
      log(`✅ 用户 ID ${userId} 已成功删除`, 'success');
      log(`📝 删除记录: ${userInfo.username} (${userInfo.email})`);
      log(`   级联删除: ${stats.platformAccounts} 个平台账号, ${stats.orders} 条订单, ${stats.adsData} 条广告数据\n`);
      return true;
    } else {
      log(`❌ 删除失败: 未找到匹配的用户`, 'error');
      return false;
    }
  } catch (error) {
    log(`❌ 删除操作失败: ${error.message}`, 'error');
    if (error.message.includes('FOREIGN KEY constraint')) {
      log('   提示: 可能存在外键约束，请检查数据库结构', 'warn');
    }
    return false;
  }
}

// 主菜单
async function showMenu() {
  log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('🔐 超级管理员管理工具');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('1. 查看所有超级管理员');
  log('2. 检查用户数据依赖');
  log('3. 降级超级管理员（降级为普通用户）');
  log('4. 删除用户（先降级再删除，或直接删除）');
  log('5. 退出');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

// 主函数
async function main() {
  log('🚀 启动超级管理员管理工具...\n');
  log(`📁 数据库路径: ${DB_PATH}`);
  log(`📝 日志文件: ${LOG_FILE}`);
  log(`🌍 环境: ${process.env.NODE_ENV || 'development'}\n`);

  // 检查数据库文件是否存在
  if (!fs.existsSync(DB_PATH)) {
    log(`❌ 错误: 数据库文件不存在: ${DB_PATH}`, 'error');
    
    // 详细的诊断信息
    log('\n🔍 诊断信息:');
    const dirPath = path.dirname(DB_PATH);
    const dirExists = fs.existsSync(dirPath);
    log(`   目录 ${dirPath} ${dirExists ? '✅ 存在' : '❌ 不存在'}`);
    
    if (dirExists) {
      try {
        const files = fs.readdirSync(dirPath);
        log(`   目录内容: ${files.length > 0 ? files.join(', ') : '(空目录)'}`);
      } catch (error) {
        log(`   无法读取目录: ${error.message}`);
      }
    }
    
    log('\n💡 可能的解决方案:');
    log('   1. Railway 环境: 确认应用已成功启动并初始化数据库');
    log('   2. Railway 环境: 检查 Volume 是否已正确挂载');
    log('   3. 执行诊断命令: railway run bash');
    log('   4. 在容器内检查: ls -la /app/data');
    log('   5. 查看应用日志: railway logs\n');
    rl.close();
    process.exit(1);
  }

  let db;
  try {
    // 连接数据库
    db = new Database(DB_PATH);
    db.pragma('foreign_keys = ON');
    log('✅ 数据库连接成功\n');
  } catch (error) {
    log(`❌ 数据库连接失败: ${error.message}`, 'error');
    rl.close();
    process.exit(1);
  }

  try {
    while (true) {
      await showMenu();
      const choice = await question('请选择操作 (1-5): ');

      switch (choice.trim()) {
        case '1':
          listSuperAdmins(db);
          break;

        case '2': {
          const userIdInput = await question('请输入要检查的用户 ID: ');
          const userId = parseInt(userIdInput);
          if (isNaN(userId)) {
            log('❌ 无效的用户 ID\n');
            break;
          }
          checkUserDependencies(db, userId);
          break;
        }

        case '3': {
          const userIdInput = await question('请输入要降级的用户 ID: ');
          const userId = parseInt(userIdInput);
          if (isNaN(userId)) {
            log('❌ 无效的用户 ID\n');
            break;
          }
          await downgradeSuperAdmin(db, userId);
          break;
        }

        case '4': {
          const userIdInput = await question('请输入要删除的用户 ID: ');
          const userId = parseInt(userIdInput);
          if (isNaN(userId)) {
            log('❌ 无效的用户 ID\n');
            break;
          }
          await deleteUser(db, userId);
          break;
        }

        case '5':
          log('\n👋 退出管理工具\n');
          db.close();
          rl.close();
          process.exit(0);

        default:
          log('❌ 无效的选择，请输入 1-5\n');
      }

      // 等待用户按回车继续
      await question('\n按回车键继续...');
    }
  } catch (error) {
    log(`\n❌ 发生错误: ${error.message}`, 'error');
    log(`   堆栈: ${error.stack}\n`, 'error');
  } finally {
    if (db) {
      db.close();
    }
    rl.close();
  }
}

// 处理退出信号
process.on('SIGINT', () => {
  log('\n\n⚠️  收到退出信号，正在关闭...\n');
  rl.close();
  process.exit(0);
});

// 执行主函数
main().catch((error) => {
  console.error('❌ 致命错误:', error);
  process.exit(1);
});

