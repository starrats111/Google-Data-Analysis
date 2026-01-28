-- 多联盟账号功能数据库迁移脚本

-- 1. 创建联盟平台表
CREATE TABLE IF NOT EXISTS affiliate_platforms (
    id SERIAL PRIMARY KEY,
    platform_name VARCHAR(100) NOT NULL UNIQUE,
    platform_code VARCHAR(50) NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. 创建联盟账号表
CREATE TABLE IF NOT EXISTS affiliate_accounts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform_id INTEGER NOT NULL REFERENCES affiliate_platforms(id),
    account_name VARCHAR(100) NOT NULL,
    account_code VARCHAR(50),
    is_active BOOLEAN DEFAULT TRUE,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, platform_id, account_name)
);

-- 3. 为联盟账号表创建索引
CREATE INDEX IF NOT EXISTS idx_affiliate_accounts_user ON affiliate_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_affiliate_accounts_platform ON affiliate_accounts(platform_id);
CREATE INDEX IF NOT EXISTS idx_affiliate_accounts_active ON affiliate_accounts(is_active);

-- 4. 更新数据上传表，添加联盟账号关联
ALTER TABLE data_uploads 
ADD COLUMN IF NOT EXISTS affiliate_account_id INTEGER REFERENCES affiliate_accounts(id);

CREATE INDEX IF NOT EXISTS idx_data_uploads_account ON data_uploads(affiliate_account_id);

-- 5. 更新分析结果表，添加联盟账号关联
ALTER TABLE analysis_results 
ADD COLUMN IF NOT EXISTS affiliate_account_id INTEGER REFERENCES affiliate_accounts(id);

CREATE INDEX IF NOT EXISTS idx_analysis_results_account ON analysis_results(affiliate_account_id);

-- 6. 初始化联盟平台数据（示例）
INSERT INTO affiliate_platforms (platform_name, platform_code, description) VALUES
('Amazon Associates', 'amazon', 'Amazon联盟平台'),
('Commission Junction', 'cj', 'CJ联盟平台'),
('ShareASale', 'shareasale', 'ShareASale联盟平台'),
('Rakuten', 'rakuten', 'Rakuten联盟平台'),
('Impact', 'impact', 'Impact联盟平台'),
('Awin', 'awin', 'Awin联盟平台')
ON CONFLICT (platform_name) DO NOTHING;

-- 7. 创建视图：员工账号汇总（方便查询）
CREATE OR REPLACE VIEW employee_account_summary AS
SELECT 
    u.id AS user_id,
    u.username,
    u.employee_id,
    ap.id AS platform_id,
    ap.platform_name,
    COUNT(aa.id) AS account_count,
    COUNT(CASE WHEN aa.is_active = TRUE THEN 1 END) AS active_account_count
FROM users u
LEFT JOIN affiliate_accounts aa ON u.id = aa.user_id
LEFT JOIN affiliate_platforms ap ON aa.platform_id = ap.id
WHERE u.role = 'employee'
GROUP BY u.id, u.username, u.employee_id, ap.id, ap.platform_name;

-- 8. 创建视图：平台数据汇总（整个工作室）
CREATE OR REPLACE VIEW platform_summary AS
SELECT 
    ap.id AS platform_id,
    ap.platform_name,
    COUNT(DISTINCT aa.user_id) AS employee_count,
    COUNT(DISTINCT aa.id) AS total_account_count,
    COUNT(DISTINCT CASE WHEN aa.is_active = TRUE THEN aa.id END) AS active_account_count,
    COUNT(DISTINCT ar.id) AS analysis_count
FROM affiliate_platforms ap
LEFT JOIN affiliate_accounts aa ON ap.id = aa.platform_id
LEFT JOIN analysis_results ar ON aa.id = ar.affiliate_account_id
GROUP BY ap.id, ap.platform_name;

-- 注释说明
COMMENT ON TABLE affiliate_platforms IS '联盟平台表，存储所有可用的联盟平台信息';
COMMENT ON TABLE affiliate_accounts IS '联盟账号表，存储每个员工的联盟账号信息';
COMMENT ON COLUMN data_uploads.affiliate_account_id IS '关联的联盟账号ID（仅affiliate类型需要）';
COMMENT ON COLUMN analysis_results.affiliate_account_id IS '关联的联盟账号ID';








