/**
 * Migration: 创建审计日志表
 * 用于记录超级管理员的所有操作
 */

module.exports = {
  up: (db) => {
    console.log('⬆️  执行迁移: 创建 audit_logs 表');

    // 1. 创建审计日志表
    db.prepare(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        
        -- 操作者信息
        admin_id INTEGER NOT NULL,
        admin_username TEXT NOT NULL,
        
        -- 操作信息
        action TEXT NOT NULL,
        target_user_id INTEGER,
        target_username TEXT,
        
        -- 请求详情
        request_path TEXT,
        request_method TEXT,
        ip_address TEXT,
        
        -- 附加信息
        details TEXT,
        execution_time INTEGER,
        
        -- 时间戳
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        
        FOREIGN KEY (admin_id) REFERENCES users(id)
      )
    `).run();

    // 2. 创建索引
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_audit_admin 
      ON audit_logs(admin_id)
    `).run();

    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_audit_action 
      ON audit_logs(action)
    `).run();

    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_audit_date 
      ON audit_logs(created_at)
    `).run();

    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_audit_target_user 
      ON audit_logs(target_user_id)
    `).run();

    console.log('✅ 迁移成功: audit_logs 表已创建');
  },

  down: (db) => {
    console.log('⬇️  回滚迁移: 删除 audit_logs 表');
    
    db.prepare(`DROP TABLE IF EXISTS audit_logs`).run();

    console.log('✅ 回滚成功');
  }
};

