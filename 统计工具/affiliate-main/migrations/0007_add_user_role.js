/**
 * Migration: 添加用户角色字段
 * 用于支持超级管理员功能
 */

module.exports = {
  up: (db) => {
    console.log('⬆️  执行迁移: 添加 role 字段到 users 表');

    // 1. 添加role字段到users表
    db.prepare(`
      ALTER TABLE users 
      ADD COLUMN role TEXT DEFAULT 'user'
    `).run();

    // 2. 更新现有用户的role为'user'
    db.prepare(`
      UPDATE users 
      SET role = 'user' 
      WHERE role IS NULL OR role = ''
    `).run();

    // 3. 创建索引以提高查询性能
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_users_role 
      ON users(role)
    `).run();

    console.log('✅ 迁移成功: role 字段已添加到 users 表');
  },

  down: (db) => {
    console.log('⬇️  回滚迁移: 移除 users 表的 role 字段');
    
    // SQLite不支持DROP COLUMN，需要重建表
    db.prepare(`
      CREATE TABLE users_backup AS SELECT
        id, username, email, password, api_token, 
        is_active, created_at, updated_at
      FROM users
    `).run();

    db.prepare(`DROP TABLE users`).run();
    db.prepare(`ALTER TABLE users_backup RENAME TO users`).run();

    // 重建索引
    db.prepare(`
      CREATE UNIQUE INDEX idx_users_email 
      ON users(email)
    `).run();

    db.prepare(`
      CREATE UNIQUE INDEX idx_users_api_token 
      ON users(api_token)
    `).run();

    console.log('✅ 回滚成功');
  }
};

