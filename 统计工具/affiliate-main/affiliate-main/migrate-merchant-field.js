// 迁移 merchant_code 数据到 merchant_id 字段，然后删除旧字段
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data.db'));

console.log('\n=== 🔄 迁移merchant_code到merchant_id ===\n');

// 1. 检查表结构
const schema = db.prepare('PRAGMA table_info(google_ads_data)').all();
const hasMerchantCode = schema.some(col => col.name === 'merchant_code');
const hasMerchantId = schema.some(col => col.name === 'merchant_id');

console.log(`merchant_code字段存在: ${hasMerchantCode ? '✅ 是' : '❌ 否'}`);
console.log(`merchant_id字段存在: ${hasMerchantId ? '✅ 是' : '❌ 否'}\n`);

if (!hasMerchantCode) {
  console.log('✅ merchant_code字段已不存在，无需迁移\n');
  db.close();
  process.exit(0);
}

if (!hasMerchantId) {
  console.log('❌ merchant_id字段不存在，请先运行服务器初始化数据库\n');
  db.close();
  process.exit(1);
}

// 2. 迁移数据
console.log('开始迁移数据...');

const updateStmt = db.prepare(`
  UPDATE google_ads_data
  SET merchant_id = merchant_code
  WHERE merchant_code IS NOT NULL AND merchant_id IS NULL
`);

const result = updateStmt.run();
console.log(`✅ 成功迁移 ${result.changes} 条数据\n`);

// 3. 创建新表（不含merchant_code字段）
console.log('创建新表结构（不含merchant_code）...');

db.exec(`
  CREATE TABLE google_ads_data_new (
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

// 4. 复制数据到新表
console.log('复制数据到新表...');

db.exec(`
  INSERT INTO google_ads_data_new
  SELECT id, user_id, sheet_id, date, campaign_name, affiliate_name, merchant_id,
         campaign_budget, currency, impressions, clicks, cost, created_at, updated_at
  FROM google_ads_data
`);

// 5. 删除旧表，重命名新表
console.log('替换旧表...');

db.exec(`DROP TABLE google_ads_data`);
db.exec(`ALTER TABLE google_ads_data_new RENAME TO google_ads_data`);

// 6. 重建索引
console.log('重建索引...');

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_google_ads_data_user_id ON google_ads_data(user_id);
  CREATE INDEX IF NOT EXISTS idx_google_ads_data_date ON google_ads_data(date);
  CREATE INDEX IF NOT EXISTS idx_google_ads_data_affiliate ON google_ads_data(affiliate_name);
  CREATE INDEX IF NOT EXISTS idx_google_ads_data_merchant ON google_ads_data(merchant_id);
`);

// 7. 验证结果
console.log('\n【验证结果】');
const newSchema = db.prepare('PRAGMA table_info(google_ads_data)').all();
const stillHasMerchantCode = newSchema.some(col => col.name === 'merchant_code');
const stillHasMerchantId = newSchema.some(col => col.name === 'merchant_id');

console.log(`merchant_code字段存在: ${stillHasMerchantCode ? '❌ 是（异常）' : '✅ 否'}`);
console.log(`merchant_id字段存在: ${stillHasMerchantId ? '✅ 是' : '❌ 否（异常）'}\n`);

// 查看数据
const sampleData = db.prepare('SELECT id, campaign_name, affiliate_name, merchant_id FROM google_ads_data LIMIT 5').all();
console.log('【数据示例】');
console.table(sampleData.map(r => ({
  id: r.id,
  campaign_name: r.campaign_name?.substring(0, 35) + '...',
  affiliate: r.affiliate_name,
  merchant: r.merchant_id
})));

console.log('\n=== ✅ 迁移完成 ===\n');

db.close();
