// Migration 0009: 添加邀请码表和用户审核状态字段
// 实现邀请码机制和用户审核功能

/**
 * 向上迁移 - 应用此migration
 */
function up(db) {
  console.log('  添加邀请码表和用户审核功能...');

  // 1. 创建邀请码表
  db.exec(`
    CREATE TABLE IF NOT EXISTS invitation_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      created_by INTEGER NOT NULL,
      max_uses INTEGER DEFAULT 1,
      used_count INTEGER DEFAULT 0,
      expires_at DATETIME,
      role TEXT DEFAULT 'user',
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // 2. 为用户表添加审核状态字段
  db.exec(`
    ALTER TABLE users ADD COLUMN approval_status TEXT DEFAULT 'pending'
  `);

  // 3. 为用户表添加邀请码字段（记录注册时使用的邀请码）
  // 注意：SQLite不支持在ALTER TABLE时直接添加外键约束
  db.exec(`
    ALTER TABLE users ADD COLUMN invitation_code_id INTEGER
  `);

  // 4. 创建索引
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_invitation_codes_code ON invitation_codes(code);
    CREATE INDEX IF NOT EXISTS idx_invitation_codes_created_by ON invitation_codes(created_by);
    CREATE INDEX IF NOT EXISTS idx_users_approval_status ON users(approval_status);
    CREATE INDEX IF NOT EXISTS idx_users_invitation_code_id ON users(invitation_code_id);
  `);

  // 5. 更新现有用户的审核状态为已通过（避免影响现有用户）
  db.exec(`
    UPDATE users SET approval_status = 'approved' WHERE approval_status IS NULL OR approval_status = ''
  `);

  // 6. 更新超级管理员的审核状态为已通过
  db.exec(`
    UPDATE users SET approval_status = 'approved' WHERE role = 'super_admin'
  `);

  console.log('  ✅ 邀请码表和用户审核功能添加完成');
}

/**
 * 向下迁移 - 回滚此migration
 */
function down(db) {
  console.log('  回滚邀请码表和用户审核功能...');

  // 删除索引
  db.exec(`
    DROP INDEX IF EXISTS idx_users_invitation_code_id;
    DROP INDEX IF EXISTS idx_users_approval_status;
    DROP INDEX IF EXISTS idx_invitation_codes_created_by;
    DROP INDEX IF EXISTS idx_invitation_codes_code;
  `);

  // 删除邀请码表
  db.exec(`
    DROP TABLE IF EXISTS invitation_codes
  `);

  // 注意：SQLite不支持直接删除列，这里只能标记为废弃
  // 实际删除需要在baseline schema中处理
  console.log('  ⚠️  注意：SQLite不支持直接删除列，approval_status和invitation_code_id字段保留');

  console.log('  ✅ 邀请码表和用户审核功能回滚完成');
}

module.exports = { up, down };

