/**
 * Migration: 添加丢失展示份额字段
 * 添加两个新字段到 google_ads_data 表：
 * - lost_impression_share_budget: 因预算而减少的展示份额
 * - lost_impression_share_rank: 因评级减少的展示份额
 */

module.exports = {
  up: (db) => {
    console.log('🔄 开始添加丢失展示份额字段...');
    
    try {
      // 添加因预算而减少的展示份额字段
      db.prepare(`
        ALTER TABLE google_ads_data 
        ADD COLUMN lost_impression_share_budget REAL DEFAULT 0
      `).run();
      console.log('✅ 已添加 lost_impression_share_budget 字段');
      
      // 添加因评级减少的展示份额字段
      db.prepare(`
        ALTER TABLE google_ads_data 
        ADD COLUMN lost_impression_share_rank REAL DEFAULT 0
      `).run();
      console.log('✅ 已添加 lost_impression_share_rank 字段');
      
      console.log('✅ 迁移完成：丢失展示份额字段已添加');
    } catch (error) {
      console.error('❌ 迁移失败:', error.message);
      // 如果字段已存在，忽略错误
      if (error.message.includes('duplicate column') || error.message.includes('already exists')) {
        console.log('⚠️  字段可能已存在，跳过');
      } else {
        throw error;
      }
    }
  },
  
  down: (db) => {
    console.log('🔄 开始回滚：删除丢失展示份额字段...');
    
    try {
      // SQLite不支持直接删除列，需要重建表
      db.exec(`
        CREATE TABLE google_ads_data_backup AS SELECT
          id, user_id, sheet_id, date, campaign_name, affiliate_name, merchant_id, merchant_slug,
          campaign_budget, currency, impressions, clicks, cost,
          created_at, updated_at
        FROM google_ads_data
      `);
      
      db.prepare(`DROP TABLE google_ads_data`).run();
      db.prepare(`ALTER TABLE google_ads_data_backup RENAME TO google_ads_data`).run();
      
      // 重建索引
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_google_ads_data_user_id ON google_ads_data(user_id);
        CREATE INDEX IF NOT EXISTS idx_google_ads_data_date ON google_ads_data(date);
        CREATE INDEX IF NOT EXISTS idx_google_ads_data_affiliate ON google_ads_data(affiliate_name);
        CREATE INDEX IF NOT EXISTS idx_google_ads_data_merchant ON google_ads_data(merchant_id);
      `).run();
      
      console.log('✅ 回滚成功');
    } catch (error) {
      console.error('❌ 回滚失败:', error.message);
      throw error;
    }
  }
};

