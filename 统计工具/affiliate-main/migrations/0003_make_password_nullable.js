// Migration 0003: make_password_nullable
// 修改platform_accounts表，允许account_password为NULL（用于LinkBux等API Token认证的平台）

/**
 * 向上迁移 - 应用此migration
 */
function up(db) {
  console.log('  修改platform_accounts表，允许account_password为NULL...');

  // SQLite不支持直接ALTER COLUMN，需要重建表
  db.exec(`
    -- 创建临时表（新schema）
    CREATE TABLE platform_accounts_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      platform TEXT NOT NULL,
      account_name TEXT NOT NULL,
      account_password TEXT,
      affiliate_name TEXT,
      api_token TEXT,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, platform, account_name)
    );

    -- 复制数据
    INSERT INTO platform_accounts_new (id, user_id, platform, account_name, account_password, affiliate_name, api_token, is_active, created_at, updated_at)
    SELECT id, user_id, platform, account_name, account_password, affiliate_name, api_token, is_active, created_at, updated_at
    FROM platform_accounts;

    -- 删除旧表
    DROP TABLE platform_accounts;

    -- 重命名新表
    ALTER TABLE platform_accounts_new RENAME TO platform_accounts;

    -- 重建索引
    CREATE INDEX IF NOT EXISTS idx_platform_accounts_user_id ON platform_accounts(user_id);
    CREATE INDEX IF NOT EXISTS idx_platform_accounts_affiliate ON platform_accounts(affiliate_name);
  `);

  console.log('  ✅ account_password字段已修改为可为NULL');
}

/**
 * 向下迁移 - 回滚此migration
 */
function down(db) {
  console.log('  回滚account_password字段修改...');

  // 回滚：恢复NOT NULL约束
  db.exec(`
    -- 创建临时表（旧schema）
    CREATE TABLE platform_accounts_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      platform TEXT NOT NULL,
      account_name TEXT NOT NULL,
      account_password TEXT NOT NULL,
      affiliate_name TEXT,
      api_token TEXT,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, platform, account_name)
    );

    -- 复制数据（只复制account_password不为NULL的记录）
    INSERT INTO platform_accounts_new (id, user_id, platform, account_name, account_password, affiliate_name, api_token, is_active, created_at, updated_at)
    SELECT id, user_id, platform, account_name, account_password, affiliate_name, api_token, is_active, created_at, updated_at
    FROM platform_accounts
    WHERE account_password IS NOT NULL;

    -- 删除旧表
    DROP TABLE platform_accounts;

    -- 重命名新表
    ALTER TABLE platform_accounts_new RENAME TO platform_accounts;

    -- 重建索引
    CREATE INDEX IF NOT EXISTS idx_platform_accounts_user_id ON platform_accounts(user_id);
    CREATE INDEX IF NOT EXISTS idx_platform_accounts_affiliate ON platform_accounts(affiliate_name);
  `);

  console.log('  ✅ account_password字段已回滚为NOT NULL');
}

module.exports = { up, down };
