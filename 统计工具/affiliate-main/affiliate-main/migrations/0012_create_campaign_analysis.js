/**
 * Migration: 创建广告系列分析结果表
 * 用于存储详细的分析指标和建议，便于后续追踪和优化
 */

module.exports = {
  up: (db) => {
    console.log('🔄 开始创建广告系列分析结果表...');
    
    try {
      // 创建分析结果表
      db.exec(`
        CREATE TABLE IF NOT EXISTS campaign_analysis (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          merchant_id TEXT NOT NULL,
          affiliate_name TEXT NOT NULL,
          campaign_name TEXT,
          date_range_start TEXT NOT NULL,
          date_range_end TEXT NOT NULL,
          analysis_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          
          -- 建议信息
          suggestion TEXT NOT NULL,
          confidence TEXT NOT NULL,
          reason TEXT,
          budget_increase INTEGER,
          
          -- 详细指标（JSON格式存储）
          metrics TEXT,
          
          -- 时间戳
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
      
      // 创建索引
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_campaign_analysis_user_id ON campaign_analysis(user_id);
        CREATE INDEX IF NOT EXISTS idx_campaign_analysis_merchant ON campaign_analysis(user_id, merchant_id, affiliate_name);
        CREATE INDEX IF NOT EXISTS idx_campaign_analysis_date_range ON campaign_analysis(date_range_start, date_range_end);
        CREATE INDEX IF NOT EXISTS idx_campaign_analysis_analysis_date ON campaign_analysis(analysis_date);
      `);
      
      console.log('✅ 迁移完成：广告系列分析结果表已创建');
    } catch (error) {
      console.error('❌ 迁移失败:', error.message);
      throw error;
    }
  },
  
  down: (db) => {
    console.log('🔄 开始回滚：删除广告系列分析结果表...');
    
    try {
      db.prepare(`DROP TABLE IF EXISTS campaign_analysis`).run();
      console.log('✅ 回滚成功');
    } catch (error) {
      console.error('❌ 回滚失败:', error.message);
      throw error;
    }
  }
};

