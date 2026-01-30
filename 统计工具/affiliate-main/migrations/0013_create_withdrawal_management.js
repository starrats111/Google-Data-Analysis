/**
 * 迁移：创建提现管理相关表
 * 
 * 功能：
 * 1. 创建提现记录表 (withdrawal_requests)
 * 2. 创建提现历史表 (withdrawal_history)
 * 3. 更新订单表，添加提现相关字段
 */

const Database = require('better-sqlite3');
const path = require('path');

function up(db) {
  console.log('开始迁移：创建提现管理表...');

  // 1. 创建提现记录表
  db.exec(`
    CREATE TABLE IF NOT EXISTS withdrawal_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      platform_account_id INTEGER NOT NULL,
      
      -- 提现金额信息
      amount REAL NOT NULL,                    -- 提现金额
      currency VARCHAR(10) DEFAULT 'USD',      -- 货币类型
      
      -- 提现状态
      status VARCHAR(50) DEFAULT 'pending',    -- pending, processing, completed, failed, cancelled
      
      -- 提现方式
      payment_method VARCHAR(50),              -- paypal, bank_transfer, etc.
      payment_account TEXT,                    -- 支付账号信息（加密存储）
      
      -- 平台信息
      platform_payment_id VARCHAR(255),        -- 平台支付ID
      platform_settlement_id VARCHAR(255),     -- 平台结算ID
      
      -- 时间信息
      requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      processed_at DATETIME,
      completed_at DATETIME,
      
      -- 备注和错误信息
      note TEXT,
      error_message TEXT,
      
      -- 审计信息
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (platform_account_id) REFERENCES platform_accounts(id) ON DELETE CASCADE
    )
  `);

  // 2. 创建提现历史表（用于记录所有状态变更）
  db.exec(`
    CREATE TABLE IF NOT EXISTS withdrawal_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      withdrawal_request_id INTEGER NOT NULL,
      
      -- 状态变更
      from_status VARCHAR(50),
      to_status VARCHAR(50) NOT NULL,
      
      -- 变更信息
      changed_by INTEGER,                      -- 操作人ID（系统或管理员）
      change_reason TEXT,
      
      -- 时间
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      
      FOREIGN KEY (withdrawal_request_id) REFERENCES withdrawal_requests(id) ON DELETE CASCADE,
      FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  // 3. 更新订单表，添加提现相关字段（检查列是否存在）
  const checkColumn = (tableName, columnName) => {
    const result = db.prepare(`
      SELECT COUNT(*) as count 
      FROM pragma_table_info('${tableName}') 
      WHERE name='${columnName}'
    `).get();
    return result.count > 0;
  };

  if (!checkColumn('orders', 'payment_id')) {
    db.exec(`ALTER TABLE orders ADD COLUMN payment_id VARCHAR(255);`);
    console.log('  ✓ 添加 payment_id 列');
  }

  if (!checkColumn('orders', 'settlement_id')) {
    db.exec(`ALTER TABLE orders ADD COLUMN settlement_id VARCHAR(255);`);
    console.log('  ✓ 添加 settlement_id 列');
  }

  if (!checkColumn('orders', 'settlement_date')) {
    db.exec(`ALTER TABLE orders ADD COLUMN settlement_date DATETIME;`);
    console.log('  ✓ 添加 settlement_date 列');
  }

  if (!checkColumn('orders', 'paid_date')) {
    db.exec(`ALTER TABLE orders ADD COLUMN paid_date DATETIME;`);
    console.log('  ✓ 添加 paid_date 列');
  }

  if (!checkColumn('orders', 'withdrawal_request_id')) {
    db.exec(`ALTER TABLE orders ADD COLUMN withdrawal_request_id INTEGER;`);
    console.log('  ✓ 添加 withdrawal_request_id 列');
  }

  // 4. 创建索引
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_user_id 
    ON withdrawal_requests(user_id);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_platform_account_id 
    ON withdrawal_requests(platform_account_id);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_status 
    ON withdrawal_requests(status);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_withdrawal_history_withdrawal_request_id 
    ON withdrawal_history(withdrawal_request_id);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_orders_payment_id 
    ON orders(payment_id);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_orders_settlement_id 
    ON orders(settlement_id);
  `);

  console.log('✅ 提现管理表创建完成');
}

function down(db) {
  console.log('回滚迁移：删除提现管理表...');

  db.exec('DROP TABLE IF EXISTS withdrawal_history');
  db.exec('DROP TABLE IF EXISTS withdrawal_requests');

  // 注意：SQLite 不支持 DROP COLUMN，所以我们不删除添加的列

  console.log('✅ 提现管理表已删除');
}

// 如果直接运行此文件
if (require.main === module) {
  const dbPath = path.join(__dirname, '..', 'data.db');  // 使用 data.db
  const db = new Database(dbPath);

  try {
    up(db);
    console.log('迁移成功！');
  } catch (error) {
    console.error('迁移失败:', error);
    process.exit(1);
  } finally {
    db.close();
  }
}

module.exports = { up, down };
