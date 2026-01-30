// Migration 0002: add_api_token_field
// 为platform_accounts表添加api_token字段，用于存储平台API token（如LinkBux）

/**
 * 向上迁移 - 应用此migration
 */
function up(db) {
  console.log('  添加api_token字段到platform_accounts表...');

  // 添加api_token字段
  db.exec(`
    ALTER TABLE platform_accounts
    ADD COLUMN api_token TEXT
  `);

  console.log('  ✅ api_token字段添加完成');
}

/**
 * 向下迁移 - 回滚此migration
 */
function down(db) {
  console.log('  移除api_token字段...');

  // SQLite不支持直接删除列，需要重建表
  db.exec(`
    -- 创建临时表
    CREATE TABLE platform_accounts_temp AS
    SELECT id, user_id, platform, account_name, account_password, affiliate_name,
           is_active, created_at, updated_at
    FROM platform_accounts;

    -- 删除原表
    DROP TABLE platform_accounts;

    -- 重建原表（不包含api_token）
    CREATE TABLE platform_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      platform TEXT NOT NULL,
      account_name TEXT NOT NULL,
      account_password TEXT NOT NULL,
      affiliate_name TEXT,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, platform, account_name)
    );

    -- 恢复数据
    INSERT INTO platform_accounts
    SELECT * FROM platform_accounts_temp;

    -- 删除临时表
    DROP TABLE platform_accounts_temp;
  `);

  console.log('  ✅ api_token字段移除完成');
}

module.exports = { up, down };
