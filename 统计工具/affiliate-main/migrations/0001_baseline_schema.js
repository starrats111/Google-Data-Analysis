// Migration 0001: baseline_schema
// 基线Schema - 包含所有初始表结构

/**
 * 向上迁移 - 应用此migration
 */
function up(db) {
  console.log('  创建基线Schema...');

  // 用户表
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      username TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_active INTEGER DEFAULT 1
    )
  `);

  // 平台账号配置表
  db.exec(`
    CREATE TABLE IF NOT EXISTS platform_accounts (
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
    )
  `);

  // 平台Token缓存表
  db.exec(`
    CREATE TABLE IF NOT EXISTS platform_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform_account_id INTEGER NOT NULL,
      token TEXT NOT NULL,
      expire_time DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (platform_account_id) REFERENCES platform_accounts(id) ON DELETE CASCADE
    )
  `);

  // 订单数据表
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      platform_account_id INTEGER NOT NULL,
      order_id TEXT NOT NULL,
      merchant_id TEXT,
      merchant_name TEXT,
      merchant_slug TEXT,
      order_amount REAL,
      commission REAL,
      status TEXT,
      order_date DATETIME,
      confirm_date DATETIME,
      raw_data TEXT,
      collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (platform_account_id) REFERENCES platform_accounts(id) ON DELETE CASCADE,
      UNIQUE(platform_account_id, order_id)
    )
  `);

  // 采集任务记录表
  db.exec(`
    CREATE TABLE IF NOT EXISTS collection_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      platform_account_id INTEGER NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      status TEXT DEFAULT 'pending',
      total_orders INTEGER DEFAULT 0,
      total_amount REAL DEFAULT 0,
      total_commission REAL DEFAULT 0,
      error_message TEXT,
      started_at DATETIME,
      completed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (platform_account_id) REFERENCES platform_accounts(id) ON DELETE CASCADE
    )
  `);

  // Google表格配置表
  db.exec(`
    CREATE TABLE IF NOT EXISTS google_sheets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      sheet_name TEXT NOT NULL,
      sheet_url TEXT NOT NULL,
      sheet_id TEXT NOT NULL,
      description TEXT,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Google广告数据表
  db.exec(`
    CREATE TABLE IF NOT EXISTS google_ads_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      sheet_id INTEGER NOT NULL,
      date DATE NOT NULL,
      campaign_name TEXT,
      affiliate_name TEXT,
      merchant_id TEXT,
      campaign_budget REAL,
      currency TEXT,
      impressions INTEGER,
      clicks INTEGER,
      cost REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (sheet_id) REFERENCES google_sheets(id) ON DELETE CASCADE,
      UNIQUE(sheet_id, date, campaign_name)
    )
  `);

  // 创建索引
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
    CREATE INDEX IF NOT EXISTS idx_orders_platform_account_id ON orders(platform_account_id);
    CREATE INDEX IF NOT EXISTS idx_orders_order_date ON orders(order_date);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_platform_accounts_user_id ON platform_accounts(user_id);
    CREATE INDEX IF NOT EXISTS idx_platform_accounts_affiliate ON platform_accounts(affiliate_name);
    CREATE INDEX IF NOT EXISTS idx_collection_jobs_user_id ON collection_jobs(user_id);
    CREATE INDEX IF NOT EXISTS idx_google_sheets_user_id ON google_sheets(user_id);
    CREATE INDEX IF NOT EXISTS idx_google_ads_data_user_id ON google_ads_data(user_id);
    CREATE INDEX IF NOT EXISTS idx_google_ads_data_date ON google_ads_data(date);
    CREATE INDEX IF NOT EXISTS idx_google_ads_data_affiliate ON google_ads_data(affiliate_name);
    CREATE INDEX IF NOT EXISTS idx_google_ads_data_merchant ON google_ads_data(merchant_id);
  `);

  console.log('  ✅ 基线Schema创建完成');
}

/**
 * 向下迁移 - 回滚此migration
 */
function down(db) {
  console.log('  回滚基线Schema...');

  // 删除所有表（按依赖顺序倒序删除）
  const tables = [
    'google_ads_data',
    'google_sheets',
    'collection_jobs',
    'orders',
    'platform_tokens',
    'platform_accounts',
    'users'
  ];

  tables.forEach(table => {
    db.exec(`DROP TABLE IF EXISTS ${table}`);
  });

  console.log('  ✅ 基线Schema回滚完成');
}

module.exports = { up, down };
