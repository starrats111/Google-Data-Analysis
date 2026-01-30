# 联盟营销数据采集系统 - 完整项目架构分析文档

**项目名称**: 联盟营销数据采集系统 - 多用户SaaS版  
**版本**: v2.1  
**技术栈**: Node.js + Express + SQLite + Vanilla JavaScript  
**生成时间**: 2024年

---

## 📋 目录

1. [项目概述](#项目概述)
2. [API 端点完整列表](#api-端点完整列表)
3. [数据库表结构](#数据库表结构)
4. [前端页面和功能](#前端页面和功能)
5. [工具脚本用途](#工具脚本用途)
6. [项目架构图](#项目架构图)
7. [数据流图](#数据流图)

---

## 项目概述

这是一个多用户SaaS版本的联盟营销数据采集和分析系统，主要功能包括：

- **多平台订单数据采集**: 支持 LinkHaitao、PartnerMatic、LinkBux、Rewardoo 等平台
- **Google Ads 数据采集**: 从 Google Sheets 采集广告数据
- **数据汇总与分析**: 商家汇总、广告系列分析、ROI计算
- **多用户管理**: 用户注册、审核、权限管理
- **超级管理员功能**: 用户管理、数据统计、批量操作

---

## API 端点完整列表

### 🔐 认证相关 (3个)

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| POST | `/api/auth/register` | 用户注册（需要邀请码） | 公开 |
| POST | `/api/auth/login` | 用户登录 | 公开 |
| GET | `/api/auth/me` | 获取当前用户信息 | 需要认证 |

### 👤 用户管理 (1个)

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| PUT | `/api/user/profile` | 更新用户资料（用户名、密码） | 需要认证 |

### 🔑 平台账号管理 (3个)

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| POST | `/api/platform-accounts` | 添加平台账号 | 需要认证 |
| GET | `/api/platform-accounts` | 获取平台账号列表 | 需要认证 |
| DELETE | `/api/platform-accounts/:id` | 删除平台账号 | 需要认证 |

### 📥 数据采集 (2个)

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| POST | `/api/collect-orders` | 采集平台订单数据 | 需要认证 |
| POST | `/api/collect-google-sheets` | 采集 Google Sheets 广告数据 | 需要认证 |

### 📊 数据查询 (6个)

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| GET | `/api/orders` | 查询订单列表（支持分页、筛选） | 需要认证 |
| GET | `/api/stats` | 获取统计数据 | 需要认证 |
| GET | `/api/merchant-summary` | 获取商家汇总数据（包含广告数据） | 需要认证 |
| GET | `/api/campaign-daily-details` | 获取广告系列每日详情 | 需要认证 |
| GET | `/api/google-ads-data` | 获取 Google Ads 数据 | 需要认证 |
| GET | `/api/top-ads-ranking` | 获取热门推荐广告系列 Top 10 | 需要认证 |

### 📄 Google Sheets 管理 (3个)

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| POST | `/api/google-sheets` | 添加 Google Sheets | 需要认证 |
| GET | `/api/google-sheets` | 获取 Google Sheets 列表 | 需要认证 |
| DELETE | `/api/google-sheets/:id` | 删除 Google Sheets | 需要认证 |

### 📥 数据导出 (1个)

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| POST | `/api/export/merchant-summary` | 导出商家汇总数据为 Excel | 需要认证 |

### 👑 超级管理员 - 用户管理 (12个)

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| GET | `/api/super-admin/users` | 获取用户列表（分页、搜索） | 超级管理员 |
| GET | `/api/super-admin/users/analytics` | 获取用户分析数据 | 超级管理员 |
| GET | `/api/super-admin/users/:id` | 获取用户详情 | 超级管理员 |
| GET | `/api/super-admin/users/:id/accounts` | 获取用户平台账号列表 | 超级管理员 |
| GET | `/api/super-admin/users/:id/orders` | 获取用户订单列表 | 超级管理员 |
| GET | `/api/super-admin/users/:id/ads-data` | 获取用户广告数据 | 超级管理员 |
| GET | `/api/super-admin/users/:id/summary` | 获取用户汇总数据 | 超级管理员 |
| POST | `/api/super-admin/users` | 创建用户 | 超级管理员 |
| PUT | `/api/super-admin/users/:id` | 更新用户信息 | 超级管理员 |
| DELETE | `/api/super-admin/users/:id` | 删除用户 | 超级管理员 |
| PUT | `/api/super-admin/users/:id/approve` | 审核通过用户 | 超级管理员 |
| PUT | `/api/super-admin/users/:id/reject` | 审核拒绝用户 | 超级管理员 |
| POST | `/api/super-admin/users/batch-approve` | 批量审核用户 | 超级管理员 |
| POST | `/api/super-admin/users/batch-update` | 批量更新用户 | 超级管理员 |
| POST | `/api/super-admin/users/batch-delete` | 批量删除用户 | 超级管理员 |
| POST | `/api/super-admin/users/batch-export` | 批量导出用户数据 | 超级管理员 |
| POST | `/api/super-admin/export/user-summary/:userId` | 导出指定用户汇总数据 | 超级管理员 |

### 🎫 超级管理员 - 邀请码管理 (3个)

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| POST | `/api/super-admin/invitation-codes` | 创建邀请码 | 超级管理员 |
| GET | `/api/super-admin/invitation-codes` | 获取邀请码列表 | 超级管理员 |
| DELETE | `/api/super-admin/invitation-codes/:id` | 删除邀请码 | 超级管理员 |

### 📋 超级管理员 - 审计日志 (1个)

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| GET | `/api/super-admin/audit-logs` | 获取审计日志（分页、筛选） | 超级管理员 |

### 📈 超级管理员 - 平台统计 (4个)

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| GET | `/api/super-admin/platform-stats` | 获取平台统计数据 | 超级管理员 |
| POST | `/api/super-admin/export/platform-stats` | 导出平台统计数据 | 超级管理员 |
| GET | `/api/super-admin/platform-summary` | 获取平台汇总数据 | 超级管理员 |
| GET | `/api/super-admin/platform-merchant-analysis` | 获取平台商家分析数据 | 超级管理员 |
| POST | `/api/super-admin/export/platform-merchant-analysis` | 导出平台商家分析数据 | 超级管理员 |

### 🔄 超级管理员 - 批量数据采集 (3个)

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| POST | `/api/super-admin/batch-collect-sheets` | 批量采集 Google Sheets | 超级管理员 |
| POST | `/api/super-admin/batch-collect-platforms` | 批量采集平台订单 | 超级管理员 |
| GET | `/api/super-admin/collection-status` | 获取采集任务状态 | 超级管理员 |

**总计**: 48个 API 端点

---

## 数据库表结构

### 核心表结构

#### 1. users (用户表)
```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  username TEXT NOT NULL,
  role TEXT DEFAULT 'user',              -- 'user' 或 'super_admin'
  approval_status TEXT DEFAULT 'pending', -- 'pending', 'approved', 'rejected'
  invitation_code_id INTEGER,             -- 注册时使用的邀请码ID
  api_token TEXT,                        -- API Token（可选）
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_active INTEGER DEFAULT 1
)
```

**索引**:
- `idx_users_email`: email (UNIQUE)
- `idx_users_role`: role
- `idx_users_approval_status`: approval_status
- `idx_users_invitation_code_id`: invitation_code_id

#### 2. platform_accounts (平台账号配置表)
```sql
CREATE TABLE platform_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  platform TEXT NOT NULL,                -- 'linkhaitao', 'partnermatic', 'linkbux', 'rewardoo'
  account_name TEXT NOT NULL,
  account_password TEXT,                  -- AES加密存储（可为空，某些平台使用API Token）
  api_token TEXT,                        -- API Token（LinkBux、Rewardoo等使用）
  affiliate_name TEXT,                   -- 联盟序号，如 'LH1', 'PM1', 'LB1'
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, platform, account_name)
)
```

**索引**:
- `idx_platform_accounts_user_id`: user_id
- `idx_platform_accounts_affiliate`: affiliate_name

#### 3. platform_tokens (平台Token缓存表)
```sql
CREATE TABLE platform_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform_account_id INTEGER NOT NULL,
  token TEXT NOT NULL,
  expire_time DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (platform_account_id) REFERENCES platform_accounts(id) ON DELETE CASCADE
)
```

#### 4. orders (订单数据表)
```sql
CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  platform_account_id INTEGER NOT NULL,
  order_id TEXT NOT NULL,
  merchant_id TEXT,
  merchant_name TEXT,
  merchant_slug TEXT,
  order_amount REAL,
  commission REAL,
  status TEXT,                           -- 'Pending', 'Approved', 'Rejected', 'Paid'
  order_date DATETIME,
  confirm_date DATETIME,
  raw_data TEXT,                         -- JSON格式的原始数据
  collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (platform_account_id) REFERENCES platform_accounts(id) ON DELETE CASCADE,
  UNIQUE(platform_account_id, order_id)
)
```

**索引**:
- `idx_orders_user_id`: user_id
- `idx_orders_platform_account_id`: platform_account_id
- `idx_orders_order_date`: order_date
- `idx_orders_status`: status

#### 5. collection_jobs (采集任务记录表)
```sql
CREATE TABLE collection_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  platform_account_id INTEGER NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status TEXT DEFAULT 'pending',         -- 'pending', 'running', 'completed', 'failed'
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
```

**索引**:
- `idx_collection_jobs_user_id`: user_id

#### 6. google_sheets (Google表格配置表)
```sql
CREATE TABLE google_sheets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  sheet_name TEXT NOT NULL,
  sheet_url TEXT NOT NULL,
  sheet_id TEXT NOT NULL,                -- 从URL提取的Sheet ID
  description TEXT,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
)
```

**索引**:
- `idx_google_sheets_user_id`: user_id

#### 7. google_ads_data (Google广告数据表)
```sql
CREATE TABLE google_ads_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  sheet_id INTEGER NOT NULL,
  date DATE NOT NULL,
  campaign_name TEXT,
  affiliate_name TEXT,
  merchant_id TEXT,
  merchant_slug TEXT,
  campaign_budget REAL,
  currency TEXT,
  impressions INTEGER,
  clicks INTEGER,
  cost REAL,                             -- 统一存储为USD（CNY按汇率7.13转换）
  lost_impression_share_budget REAL DEFAULT 0,  -- 因预算而减少的展示份额
  lost_impression_share_rank REAL DEFAULT 0,    -- 因评级减少的展示份额
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (sheet_id) REFERENCES google_sheets(id) ON DELETE CASCADE,
  UNIQUE(sheet_id, date, campaign_name)
)
```

**索引**:
- `idx_google_ads_data_user_id`: user_id
- `idx_google_ads_data_date`: date
- `idx_google_ads_data_affiliate`: affiliate_name
- `idx_google_ads_data_merchant`: merchant_id

#### 8. invitation_codes (邀请码表)
```sql
CREATE TABLE invitation_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  created_by INTEGER NOT NULL,
  max_uses INTEGER DEFAULT 1,
  used_count INTEGER DEFAULT 0,
  expires_at DATETIME,
  role TEXT DEFAULT 'user',
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
)
```

**索引**:
- `idx_invitation_codes_code`: code (UNIQUE)
- `idx_invitation_codes_created_by`: created_by

#### 9. audit_logs (审计日志表)
```sql
CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER NOT NULL,
  admin_username TEXT NOT NULL,
  action TEXT NOT NULL,                  -- 操作类型，如 'create_user', 'delete_user'
  target_user_id INTEGER,
  target_username TEXT,
  request_path TEXT,
  request_method TEXT,
  ip_address TEXT,
  details TEXT,                          -- JSON格式的详细信息
  execution_time INTEGER,                -- 执行时间（毫秒）
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (admin_id) REFERENCES users(id)
)
```

**索引**:
- `idx_audit_admin`: admin_id
- `idx_audit_action`: action
- `idx_audit_date`: created_at
- `idx_audit_target_user`: target_user_id

#### 10. campaign_analysis (广告系列分析结果表)
```sql
CREATE TABLE campaign_analysis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  merchant_id TEXT NOT NULL,
  affiliate_name TEXT NOT NULL,
  campaign_name TEXT,
  date_range_start TEXT NOT NULL,
  date_range_end TEXT NOT NULL,
  analysis_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  suggestion TEXT NOT NULL,              -- 操作建议，如 '建议增加预算', '建议暂停'
  confidence TEXT NOT NULL,              -- 信心度，如 '高', '中', '低'
  reason TEXT,
  budget_increase INTEGER,               -- 建议增加的预算百分比
  metrics TEXT,                          -- JSON格式的详细指标
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
)
```

**索引**:
- `idx_campaign_analysis_user_id`: user_id
- `idx_campaign_analysis_merchant`: (user_id, merchant_id, affiliate_name)
- `idx_campaign_analysis_date_range`: (date_range_start, date_range_end)
- `idx_campaign_analysis_analysis_date`: analysis_date

#### 11. db_schema_versions (数据库版本追踪表)
```sql
CREATE TABLE db_schema_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER UNIQUE NOT NULL,
  name TEXT NOT NULL,
  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  checksum TEXT
)
```

### 数据库迁移历史

| 版本 | 文件名 | 描述 |
|------|--------|------|
| 0001 | `0001_baseline_schema.js` | 基线Schema，创建所有核心表 |
| 0002 | `0002_add_api_token_field.js` | 添加API Token字段到platform_accounts |
| 0003 | `0003_make_password_nullable.js` | 使platform_accounts.password可为空 |
| 0005 | `0005_add_affiliate_name_to_orders.js` | 添加affiliate_name到orders表 |
| 0006 | `0006_add_merchant_slug_to_google_ads_data.js` | 添加merchant_slug到google_ads_data |
| 0007 | `0007_add_user_role.js` | 添加role字段到users表 |
| 0008 | `0008_create_audit_logs.js` | 创建audit_logs表 |
| 0009 | `0009_add_invitation_codes_and_user_approval.js` | 创建invitation_codes表，添加用户审核功能 |
| 0010 | `0010_add_lost_impression_share.js` | 添加丢失展示份额字段到google_ads_data |
| 0011 | `0011_convert_cny_to_usd.js` | 将CNY转换为USD的数据迁移 |
| 0012 | `0012_create_campaign_analysis.js` | 创建campaign_analysis表 |

---

## 前端页面和功能

### 1. 用户端页面 (`index-v2.html`)

#### 页面结构
- **认证区域** (`authSection`): 登录/注册表单
- **主应用区域** (`appSection`): 数据管理界面

#### 主要功能模块

##### 1.1 用户认证
- **登录功能**: 邮箱+密码登录
- **注册功能**: 用户名+邮箱+密码+邀请码注册
- **Token管理**: 使用localStorage存储JWT token
- **自动跳转**: 超级管理员自动跳转到admin页面

##### 1.2 平台账号管理
- **账号列表展示**: 显示所有已添加的平台账号
- **多选功能**: 支持选择多个账号进行批量操作
- **添加账号**: 
  - 支持平台: LinkHaitao, PartnerMatic, LinkBux, Rewardoo
  - 支持密码或API Token两种认证方式
  - 可设置联盟序号（affiliate_name）
- **删除账号**: 删除不需要的平台账号

##### 1.3 Google表格管理
- **表格列表**: 显示所有已添加的Google Sheets
- **添加表格**: 输入表格名称、URL、备注
- **删除表格**: 删除不需要的表格

##### 1.4 数据采集
- **订单采集**: 
  - 选择日期范围
  - 选择平台账号（支持多选）
  - 显示采集进度和结果
- **Google Sheets采集**: 
  - 选择要采集的表格
  - 自动解析表格数据

##### 1.5 数据展示
- **统计卡片**: 显示订单总数、总预算、总佣金
- **商家汇总表格**: 
  - 显示广告系列、商家ID、预算、展示、点击、广告费
  - 显示订单数、总佣金、CR、EPC、CPC、ROI
  - **状态筛选**: 全部/仅活跃/仅暂停（基于最近一天数据）
  - **操作建议**: 显示AI分析的操作建议
  - **展开详情**: 可展开查看每日数据
- **导出功能**: 导出商家汇总数据为Excel

##### 1.6 推荐榜单
- **Top 10 广告系列**: 显示ROI > 3的优质广告系列
- **时间范围选择**: 昨天/最近7天/最近30天/自定义
- **刷新功能**: 手动刷新榜单数据

### 2. 超级管理员页面 (`admin.html`)

#### 页面结构
- **侧边栏导航**: 仪表板、用户管理、平台统计、邀请码管理、审计日志、数据采集
- **主内容区**: 根据导航显示不同页面

#### 主要功能模块

##### 2.1 仪表板
- **功能快捷入口**: 快速访问各个功能模块
- **系统概览**: 显示系统基本统计信息

##### 2.2 用户管理
- **用户列表**: 
  - 分页显示
  - 搜索功能
  - 筛选功能（按状态、角色）
- **用户操作**:
  - 创建用户
  - 编辑用户
  - 删除用户
  - 审核用户（通过/拒绝）
  - 批量操作（批量审核、批量更新、批量删除、批量导出）
- **用户详情**: 
  - 查看用户基本信息
  - 查看用户平台账号
  - 查看用户订单
  - 查看用户广告数据
  - 查看用户汇总数据
  - 导出用户数据

##### 2.3 平台统计
- **平台汇总数据**: 显示所有平台的数据统计
- **商家分析**: 显示平台商家分析数据
- **导出功能**: 导出统计数据为Excel

##### 2.4 邀请码管理
- **邀请码列表**: 显示所有邀请码及其使用情况
- **创建邀请码**: 
  - 设置最大使用次数
  - 设置过期时间
  - 设置角色
- **删除邀请码**: 删除不需要的邀请码

##### 2.5 审计日志
- **日志列表**: 显示所有管理员操作记录
- **筛选功能**: 按操作类型、日期范围筛选
- **分页显示**: 支持分页查看

##### 2.6 数据采集
- **批量采集Google Sheets**: 选择用户，批量采集其Google Sheets
- **批量采集平台订单**: 选择用户和平台，批量采集订单数据
- **采集状态**: 查看采集任务状态

### 3. 前端JavaScript (`app-v2.js`)

#### 主要功能函数

##### 3.1 认证相关
- `handleLogin()`: 处理登录
- `handleRegister()`: 处理注册
- `loadUserProfile()`: 加载用户信息
- `logout()`: 退出登录

##### 3.2 平台账号管理
- `loadPlatformAccounts()`: 加载平台账号列表
- `renderAccountsList()`: 渲染账号列表
- `toggleAccountSelection()`: 切换账号选择状态
- `selectAllAccounts()`: 全选账号
- `deselectAllAccounts()`: 取消全选
- `handleAddAccount()`: 处理添加账号
- `deleteAccount()`: 删除账号

##### 3.3 Google Sheets管理
- `loadGoogleSheets()`: 加载Google Sheets列表
- `renderGoogleSheetsList()`: 渲染Google Sheets列表
- `handleAddGoogleSheet()`: 处理添加Google Sheet
- `deleteGoogleSheet()`: 删除Google Sheet

##### 3.4 数据采集
- `handleCollect()`: 处理数据采集请求
- `loadStats()`: 加载统计数据
- `loadMerchantSummary()`: 加载商家汇总数据
- `handleStatusFilterChange()`: 处理状态筛选变化

##### 3.5 数据展示
- `renderMerchantTable()`: 渲染商家汇总表格
- `toggleRowExpansion()`: 切换行展开状态
- `loadCampaignDailyDetails()`: 加载广告系列每日详情
- `getOptimizationSuggestion()`: 获取操作建议显示文本

##### 3.6 推荐榜单
- `loadTopAdsRanking()`: 加载Top 10广告系列
- `handleRankingRangeChange()`: 处理时间范围变化
- `renderRankingList()`: 渲染榜单列表

##### 3.7 导出功能
- `exportMerchantSummary()`: 导出商家汇总数据

##### 3.8 工具函数
- `showMessage()`: 显示消息提示
- `formatCurrency()`: 格式化货币
- `formatNumber()`: 格式化数字
- `formatDate()`: 格式化日期
- `apiRequest()`: 统一的API请求函数

### 4. 前端样式 (`style-v2.css`)

- **响应式设计**: 支持桌面和移动端
- **现代化UI**: 使用CSS变量、渐变、阴影等现代样式
- **交互效果**: 按钮悬停、表格行高亮、模态框动画等

---

## 工具脚本用途

### 数据库相关

| 文件名 | 用途 |
|--------|------|
| `db.js` | 数据库连接和初始化，使用better-sqlite3 |
| `migrate.js` | 数据库迁移管理工具，执行migrations目录下的迁移脚本 |
| `init-admin.js` | 自动初始化超级管理员账号（服务器启动时运行） |

### 数据采集相关

| 文件名 | 用途 |
|--------|------|
| `test-linkhaitao.js` | 测试LinkHaitao平台API连接和数据采集 |
| `test-linkhaitao-full.js` | 完整测试LinkHaitao平台数据采集流程 |
| `test-with-token.js` | 测试使用Token的API请求 |
| `test-transaction-detail.js` | 测试交易详情API |
| `test-lh-api-diagnosis.js` | LinkHaitao API诊断工具 |

### 数据检查和诊断

| 文件名 | 用途 |
|--------|------|
| `check-db.js` | 检查数据库结构和数据 |
| `check-accounts.js` | 检查平台账号配置 |
| `check-ad-cost.js` | 检查广告费用数据 |
| `check-all-dates.js` | 检查所有日期数据 |
| `check-specific-merchants.js` | 检查特定商家数据 |
| `check-super-admins.js` | 检查超级管理员账号 |
| `debug-ad-query.js` | 调试广告查询 |
| `diagnose-pm-merchant.js` | 诊断PartnerMatic商家数据问题 |
| `analyze-date-issue.js` | 分析日期相关问题 |
| `analyze-google-sheet.js` | 分析Google表格数据 |

### 数据修复和迁移

| 文件名 | 用途 |
|--------|------|
| `migrate-merchant-field.js` | 迁移商家字段数据 |
| `fix-pm-merchant-id.js` | 修复PartnerMatic商家ID |
| `update-campaign-fields.js` | 更新广告系列字段 |
| `show-all-db.js` | 显示所有数据库内容（调试用） |

### 数据清理

| 文件名 | 用途 |
|--------|------|
| `clear-all-data.js` | 清空所有数据（危险操作） |
| `clean-and-test.js` | 清理并测试数据 |

### 用户管理

| 文件名 | 用途 |
|--------|------|
| `find-user-id.js` | 查找用户ID |
| `scripts/create-super-admin.js` | 创建超级管理员脚本 |
| `scripts/manage-super-admin.js` | 管理超级管理员脚本 |

### 其他工具

| 文件名 | 用途 |
|--------|------|
| `quick-check.js` | 快速检查工具 |
| `test-sign.js` | 测试签名生成 |
| `test-sign.py` | Python版本的签名测试 |
| `captcha-solver.js` | 验证码识别工具（如果使用） |
| `ocr_solver.py` | OCR验证码识别（Python） |

---

## 项目架构图

```
┌─────────────────────────────────────────────────────────────┐
│                        前端层 (Frontend)                      │
├─────────────────────────────────────────────────────────────┤
│  index-v2.html  │  admin.html  │  app-v2.js  │  style-v2.css │
│  (用户端)        │  (超管端)     │  (前端逻辑)  │  (样式)        │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ HTTP/HTTPS
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      API层 (Express Server)                   │
├─────────────────────────────────────────────────────────────┤
│  server-v2.js (8939行)                                       │
│  ├── 认证中间件 (JWT)                                         │
│  ├── 权限检查 (requireSuperAdmin)                            │
│  ├── 审计日志中间件 (auditLog)                                │
│  └── 48个API端点                                              │
└─────────────────────────────────────────────────────────────┘
                              │
                              │
┌─────────────────────────────────────────────────────────────┐
│                    业务逻辑层 (Business Logic)                 │
├─────────────────────────────────────────────────────────────┤
│  utils.js                                                    │
│  ├── 密码加密/解密 (AES-256-CBC)                              │
│  ├── 密码哈希 (bcrypt)                                        │
│  ├── JWT生成/验证                                             │
│  └── 签名生成 (LinkHaitao)                                   │
└─────────────────────────────────────────────────────────────┘
                              │
                              │
┌─────────────────────────────────────────────────────────────┐
│                     数据访问层 (Data Access)                   │
├─────────────────────────────────────────────────────────────┤
│  db.js                                                       │
│  ├── SQLite数据库连接                                         │
│  └── 数据库初始化                                             │
│                                                              │
│  migrate.js                                                  │
│  └── 数据库迁移管理                                           │
└─────────────────────────────────────────────────────────────┘
                              │
                              │
┌─────────────────────────────────────────────────────────────┐
│                     数据存储层 (Database)                      │
├─────────────────────────────────────────────────────────────┤
│  SQLite (data.db)                                            │
│  ├── users                                                   │
│  ├── platform_accounts                                       │
│  ├── platform_tokens                                        │
│  ├── orders                                                 │
│  ├── collection_jobs                                        │
│  ├── google_sheets                                          │
│  ├── google_ads_data                                        │
│  ├── invitation_codes                                       │
│  ├── audit_logs                                             │
│  └── campaign_analysis                                      │
└─────────────────────────────────────────────────────────────┘
                              │
                              │
┌─────────────────────────────────────────────────────────────┐
│                   外部服务集成 (External APIs)                 │
├─────────────────────────────────────────────────────────────┤
│  LinkHaitao API  │  PartnerMatic API  │  LinkBux API        │
│  Rewardoo API    │  Google Sheets API │  Google Ads API     │
└─────────────────────────────────────────────────────────────┘
```

---

## 数据流图

### 订单数据采集流程

```
用户选择平台账号和日期范围
        │
        ▼
前端发送 POST /api/collect-orders
        │
        ▼
后端验证Token和权限
        │
        ▼
根据平台类型调用对应的采集函数
        │
        ├── LinkHaitao → collectLinkHaitaoOrders()
        ├── PartnerMatic → collectPartnerMaticOrders()
        ├── LinkBux → collectLinkBuxOrders()
        └── Rewardoo → collectRewardooOrders()
        │
        ▼
调用平台API获取订单数据
        │
        ├── 登录获取Token（如需要）
        ├── 分页请求订单数据
        └── 处理API限制（请求间隔、日期范围等）
        │
        ▼
解析和清洗数据
        │
        ├── 提取订单ID、商家ID、金额、佣金等
        ├── 统一数据格式
        └── 处理时区和日期
        │
        ▼
保存到数据库 (orders表)
        │
        ├── 检查订单是否已存在（UNIQUE约束）
        ├── 插入新订单
        └── 更新采集任务状态
        │
        ▼
返回采集结果给前端
        │
        ├── 成功订单数
        ├── 失败订单数
        └── 错误信息（如有）
```

### Google Ads数据采集流程

```
用户添加Google Sheets URL
        │
        ▼
前端发送 POST /api/google-sheets
        │
        ▼
后端解析Sheet ID并保存配置
        │
        ▼
用户触发采集
        │
        ▼
前端发送 POST /api/collect-google-sheets
        │
        ▼
后端使用Google Sheets API读取数据
        │
        ├── 解析表格URL
        ├── 读取指定工作表
        └── 解析表头和数据行
        │
        ▼
数据清洗和转换
        │
        ├── 识别列（日期、广告系列、预算、展示、点击、费用等）
        ├── 提取merchant_id（从campaign_name）
        ├── 提取affiliate_name（从campaign_name或表格名称）
        ├── 货币转换（CNY → USD，汇率7.13）
        └── 日期格式化
        │
        ▼
保存到数据库 (google_ads_data表)
        │
        ├── 检查数据是否已存在（UNIQUE约束）
        ├── 插入新数据
        └── 更新数据（如已存在）
        │
        ▼
返回采集结果
```

### 商家汇总数据查询流程

```
用户选择日期范围和平台账号
        │
        ▼
前端发送 GET /api/merchant-summary
        │
        ▼
后端查询订单数据
        │
        ├── 按merchant_id + affiliate_name分组
        ├── 计算订单数、总金额、总佣金
        └── 按状态筛选（APPROVED, PENDING）
        │
        ▼
后端查询广告数据
        │
        ├── 按merchant_id + affiliate_name分组
        ├── 计算总预算、总展示、总点击、总费用
        └── 获取最近一天数据（用于状态判断）
        │
        ▼
判断广告状态（活跃/暂停）
        │
        ├── 查询最近一天（或结束日期）的数据
        ├── 如果预算=0 且 展示=0 且 点击=0 → 暂停
        └── 否则 → 活跃
        │
        ▼
合并订单和广告数据
        │
        ├── 使用 user_id + affiliate_name + merchant_id 作为键
        ├── 合并订单数据和广告数据
        └── 计算指标（CR, EPC, CPC, ROI）
        │
        ▼
生成操作建议（AI分析）
        │
        ├── 分析ROI、趋势、丢失展示份额等
        ├── 生成建议（增加预算/暂停/维持）
        └── 计算信心度
        │
        ▼
返回汇总数据给前端
        │
        ├── 商家列表
        ├── 订单数据
        ├── 广告数据
        ├── 计算指标
        └── 操作建议
```

---

## 关键技术点

### 1. 认证和授权
- **JWT Token**: 7天有效期
- **密码加密**: 用户密码使用bcrypt，平台账号密码使用AES-256-CBC
- **角色权限**: user 和 super_admin 两种角色
- **邀请码机制**: 注册需要邀请码，支持审核流程

### 2. 数据采集
- **多平台支持**: LinkHaitao、PartnerMatic、LinkBux、Rewardoo
- **API限制处理**: 请求间隔、日期范围限制、分页处理
- **错误处理**: 重试机制、错误日志记录
- **Token缓存**: 平台Token缓存，避免频繁登录

### 3. 数据分析
- **商家汇总**: 合并订单和广告数据
- **指标计算**: CR、EPC、CPC、ROI等
- **状态判断**: 基于最近一天数据判断广告是否暂停
- **AI建议**: 基于ROI、趋势、丢失展示份额等生成操作建议

### 4. 数据库设计
- **SQLite**: 轻量级数据库，适合中小型应用
- **Migration系统**: 版本化数据库迁移
- **索引优化**: 关键字段建立索引，提升查询性能
- **外键约束**: 保证数据完整性

### 5. 前端架构
- **Vanilla JavaScript**: 无框架，纯原生JS
- **模块化设计**: 功能函数分离
- **响应式设计**: 支持桌面和移动端
- **实时更新**: 使用fetch API进行数据交互

---

## 部署相关

### 环境变量
- `PORT`: 服务器端口（默认3000）
- `JWT_SECRET`: JWT密钥
- `ENCRYPTION_KEY`: 加密密钥（32字节）
- `ADMIN_EMAIL`: 超级管理员邮箱（可选）
- `ADMIN_USERNAME`: 超级管理员用户名（可选）
- `ADMIN_PASSWORD`: 超级管理员密码（可选）
- `NODE_ENV`: 环境变量（production/development）

### 部署文件
- `Dockerfile`: Docker容器配置
- `ecosystem.config.js`: PM2进程管理配置
- `railway.json`: Railway部署配置
- `nixpacks.toml`: Nixpacks构建配置
- `deploy.sh`: 部署脚本

---

## 总结

这是一个功能完整的多用户SaaS系统，包含：

- **48个API端点**: 覆盖认证、数据采集、查询、导出、管理等功能
- **11个数据库表**: 用户、订单、广告、配置等完整的数据模型
- **2个前端页面**: 用户端和超级管理员端
- **完善的工具脚本**: 数据检查、修复、测试等
- **Migration系统**: 版本化数据库迁移
- **多平台集成**: 支持4个联盟平台和Google Ads

系统设计合理，功能完整，适合作为联盟营销数据管理的SaaS平台。

---

**文档生成时间**: 2024年  
**文档版本**: 1.0  
**维护者**: 项目开发团队

