-- ============================================================
-- 露出功能数据库迁移脚本
-- 在现有 google_analysis.db 中新增表
-- 执行: sqlite3 google_analysis.db < scripts/migrate_luchu.sql
-- ============================================================

-- 1. 露出网站配置表
CREATE TABLE IF NOT EXISTS luchu_websites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  owner_id INTEGER REFERENCES users(id),
  github_repo TEXT NOT NULL,
  data_path TEXT DEFAULT 'js/articles',
  has_products INTEGER DEFAULT 1,
  site_url TEXT,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. 露出文章表
CREATE TABLE IF NOT EXISTS luchu_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  website_id INTEGER REFERENCES luchu_websites(id),
  author_id INTEGER REFERENCES users(id),
  
  title TEXT NOT NULL,
  slug TEXT,
  category TEXT,
  category_name TEXT,
  excerpt TEXT,
  content TEXT,
  
  images TEXT,      -- JSON: {"hero":{...}, "content":[...]}
  products TEXT,    -- JSON数组
  
  merchant_url TEXT,
  tracking_link TEXT,
  brand_name TEXT,
  brand_keyword TEXT,
  keyword_count INTEGER DEFAULT 10,
  
  -- 目标国家/语言（本地化）
  target_country TEXT DEFAULT 'US',
  target_language TEXT DEFAULT 'en-US',
  
  status TEXT DEFAULT 'draft',  -- draft/pending/approved/rejected/ready/published
  
  publish_date DATE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  published_at DATETIME,
  
  version INTEGER DEFAULT 1
);

-- 3. 文章版本历史表
CREATE TABLE IF NOT EXISTS luchu_article_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER REFERENCES luchu_articles(id),
  version_number INTEGER NOT NULL,
  title TEXT,
  content TEXT,
  images TEXT,
  products TEXT,
  changed_by INTEGER REFERENCES users(id),
  change_type TEXT,      -- create/edit/review_reject
  change_reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 4. 审核记录表
CREATE TABLE IF NOT EXISTS luchu_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER REFERENCES luchu_articles(id),
  reviewer_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL,  -- approved/rejected
  comment TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 5. 发布日志表
CREATE TABLE IF NOT EXISTS luchu_publish_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER REFERENCES luchu_articles(id),
  website_id INTEGER REFERENCES luchu_websites(id),
  operator_id INTEGER REFERENCES users(id),
  commit_sha TEXT,
  file_path TEXT,
  status TEXT,           -- success/failed
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 6. 图片检测记录表
CREATE TABLE IF NOT EXISTS luchu_image_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER REFERENCES luchu_articles(id),
  image_type TEXT NOT NULL,  -- hero/content_1/content_2/content_3/content_4
  url TEXT NOT NULL,
  local_path TEXT,
  status TEXT DEFAULT 'unchecked',  -- valid/invalid/local/unchecked
  http_status INTEGER,
  last_check DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 7. 图片告警表
CREATE TABLE IF NOT EXISTS luchu_image_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER REFERENCES luchu_articles(id),
  website_id INTEGER REFERENCES luchu_websites(id),
  user_id INTEGER REFERENCES users(id),
  image_type TEXT NOT NULL,
  url TEXT NOT NULL,
  alert_type TEXT NOT NULL,
  is_resolved INTEGER DEFAULT 0,
  resolved_at DATETIME,
  resolved_by INTEGER REFERENCES users(id),
  resolve_method TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 8. 提示词模板表
CREATE TABLE IF NOT EXISTS luchu_prompt_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  website_id INTEGER,
  category TEXT,
  has_products INTEGER DEFAULT 1,
  template_content TEXT NOT NULL,
  is_default INTEGER DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 9. 平台通知表
CREATE TABLE IF NOT EXISTS luchu_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  related_type TEXT,
  related_id INTEGER,
  is_read INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 10. 爬取缓存表
CREATE TABLE IF NOT EXISTS luchu_crawl_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  url_hash TEXT NOT NULL,
  crawl_data TEXT,
  images TEXT,
  expires_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 11. 操作日志表
CREATE TABLE IF NOT EXISTS luchu_operation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id INTEGER,
  details TEXT,
  ip_address TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_luchu_articles_status ON luchu_articles(status);
CREATE INDEX IF NOT EXISTS idx_luchu_articles_website ON luchu_articles(website_id);
CREATE INDEX IF NOT EXISTS idx_luchu_articles_author ON luchu_articles(author_id);
CREATE INDEX IF NOT EXISTS idx_luchu_image_alerts_resolved ON luchu_image_alerts(is_resolved);
CREATE INDEX IF NOT EXISTS idx_luchu_notifications_user ON luchu_notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_luchu_crawl_cache_hash ON luchu_crawl_cache(url_hash);

-- ============================================================
-- 初始数据：9个网站配置
-- ============================================================

INSERT OR IGNORE INTO luchu_websites (id, name, domain, owner_id, github_repo, site_url) VALUES
(1, 'EverydayHaven', 'everydayhaven.top', (SELECT id FROM users WHERE username = 'wj01'), 'starrats111/EverydayHaven', 'https://everydayhaven.top'),
(2, 'Quiblo', 'quiblo.top', (SELECT id FROM users WHERE username = 'wj02'), 'starrats111/Quiblo', 'https://quiblo.top'),
(3, 'Kivanta', 'kivanta.top', (SELECT id FROM users WHERE username = 'wj03'), 'starrats111/Kivanta', 'https://kivanta.top'),
(4, 'NovaNest', 'novanest.one', (SELECT id FROM users WHERE username = 'wj04'), 'starrats111/NovaNest', 'https://novanest.one'),
(5, 'Zontri', 'zontri.top', (SELECT id FROM users WHERE username = 'wj05'), 'starrats111/Zontri', 'https://zontri.top'),
(6, 'AlluraHub', 'allurahub.top', (SELECT id FROM users WHERE username = 'wj06'), 'starrats111/AlluraHub', 'https://allurahub.top'),
(7, 'VitaHaven', 'vitahaven.click', (SELECT id FROM users WHERE username = 'wj07'), 'starrats111/VitaHaven', 'https://vitahaven.click'),
(9, 'BloomRoots', 'bloomroots.top', (SELECT id FROM users WHERE username = 'wj09'), 'starrats111/BloomRoots', 'https://bloomroots.top'),
(10, 'VitaSphere', 'vitasphere.top', (SELECT id FROM users WHERE username = 'wj10'), 'starrats111/VitaSphere', 'https://vitasphere.top');

-- 默认提示词模板
INSERT OR IGNORE INTO luchu_prompt_templates (id, name, description, has_products, template_content, is_default) VALUES
(1, '标准博客模板（含产品）', '适用于有产品列表的商家露出', 1, 
'你是一位专业的博客内容撰写者。请根据以下商家信息撰写一篇高质量的推广博客文章。

## 商家信息
[商家信息]

## 要求
1. 文章标题要吸引人，包含品牌名称
2. 品牌关键词"[品牌名称]"在正文中出现 [关键词次数] 次
3. 正文使用 HTML 格式，包含 <p>, <h2>, <h3>, <ul>, <li> 等标签
4. 在适当位置插入图片标记 [IMAGE_1], [IMAGE_2] 等
5. 包含产品推荐模块
6. 包含行动号召，引导点击追踪链接: [追踪链接]
7. 文章长度 800-1200 字

## 输出格式 (JSON)
{
  "title": "文章标题",
  "slug": "url-friendly-slug",
  "category": "分类代码",
  "categoryName": "分类名称",
  "excerpt": "文章摘要 (150字内)",
  "content": "<p>HTML正文...</p>",
  "products": [
    {"name": "产品名", "price": "$XX.XX", "description": "描述", "link": "追踪链接"}
  ],
  "keywordActualCount": 实际关键词次数
}', 1),

(2, '标准博客模板（无产品）', '适用于无产品列表的商家露出', 0,
'你是一位专业的博客内容撰写者。请根据以下商家信息撰写一篇高质量的推广博客文章。

## 商家信息
[商家信息]

## 要求
1. 文章标题要吸引人，包含品牌名称
2. 品牌关键词"[品牌名称]"在正文中出现 [关键词次数] 次
3. 正文使用 HTML 格式，包含 <p>, <h2>, <h3>, <ul>, <li> 等标签
4. 在适当位置插入图片标记 [IMAGE_1], [IMAGE_2] 等
5. 包含行动号召，引导点击追踪链接: [追踪链接]
6. 文章长度 800-1200 字

## 输出格式 (JSON)
{
  "title": "文章标题",
  "slug": "url-friendly-slug",
  "category": "分类代码",
  "categoryName": "分类名称",
  "excerpt": "文章摘要 (150字内)",
  "content": "<p>HTML正文...</p>",
  "keywordActualCount": 实际关键词次数
}', 0);

SELECT 'Migration completed successfully!' AS status;

