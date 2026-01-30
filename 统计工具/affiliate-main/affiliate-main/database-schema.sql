-- 多用户SaaS系统数据库设计
-- 数据库: affiliate_saas

-- 1. 用户表
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,  -- bcrypt加密
  username VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_active BOOLEAN DEFAULT true
);

-- 2. 平台账号配置表
CREATE TABLE platform_accounts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  platform VARCHAR(50) NOT NULL,  -- 'linkhaitao', 'partnermatic' 等
  account_name VARCHAR(255) NOT NULL,  -- 平台登录用户名
  account_password TEXT NOT NULL,  -- 简单加密存储
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, platform, account_name)
);

-- 3. 平台Token缓存表
CREATE TABLE platform_tokens (
  id SERIAL PRIMARY KEY,
  platform_account_id INTEGER REFERENCES platform_accounts(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  expire_time TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. 订单数据表
CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  platform_account_id INTEGER REFERENCES platform_accounts(id) ON DELETE CASCADE,

  -- 订单基本信息
  order_id VARCHAR(255) NOT NULL,
  merchant_id VARCHAR(100),
  merchant_name VARCHAR(255),

  -- 金额信息
  order_amount DECIMAL(10, 2),
  commission DECIMAL(10, 2),
  status VARCHAR(50),  -- 'Pending', 'Confirmed', 'Paid', 'Rejected'

  -- 时间信息
  order_date TIMESTAMP,
  confirm_date TIMESTAMP,

  -- 原始数据（JSON格式保存完整信息）
  raw_data JSONB,

  -- 记录信息
  collected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(platform_account_id, order_id)
);

-- 5. 采集任务记录表
CREATE TABLE collection_jobs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  platform_account_id INTEGER REFERENCES platform_accounts(id) ON DELETE CASCADE,

  start_date DATE NOT NULL,
  end_date DATE NOT NULL,

  status VARCHAR(50) DEFAULT 'pending',  -- 'pending', 'running', 'completed', 'failed'
  total_orders INTEGER DEFAULT 0,
  total_amount DECIMAL(10, 2) DEFAULT 0,
  total_commission DECIMAL(10, 2) DEFAULT 0,

  error_message TEXT,

  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引提升查询性能
CREATE INDEX idx_orders_user_id ON orders(user_id);
CREATE INDEX idx_orders_platform_account_id ON orders(platform_account_id);
CREATE INDEX idx_orders_order_date ON orders(order_date);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_platform_accounts_user_id ON platform_accounts(user_id);
CREATE INDEX idx_collection_jobs_user_id ON collection_jobs(user_id);

-- 添加更新时间自动触发器函数
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- 为需要的表添加更新时间触发器
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_platform_accounts_updated_at BEFORE UPDATE ON platform_accounts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_platform_tokens_updated_at BEFORE UPDATE ON platform_tokens
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
