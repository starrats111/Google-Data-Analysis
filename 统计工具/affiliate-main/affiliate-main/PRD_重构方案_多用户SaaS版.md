# 产品需求文档 (PRD) - 重构版
## 联盟营销数据分析平台 - 多用户SaaS版

---

## 📊 项目概要

| 项目信息 | 详情 |
|---------|------|
| **项目名称** | AffiliateMetrics (联盟营销数据分析平台) |
| **版本** | v2.0 (完全重构) |
| **目标用户** | 20-50人的联盟营销团队 |
| **技术栈** | Next.js + Node.js + PostgreSQL + Redis |
| **部署方式** | Vercel + Vercel Postgres + Upstash Redis |
| **核心价值** | 自动化数据采集，统一ROI分析 |

---

## 🎯 核心需求优先级

```
P0 (必须有) 🔴
  ├─ 用户注册/登录 (JWT认证)
  ├─ 联盟账号管理 (加密存储)
  ├─ 数据自动采集任务 (定时 + 手动触发)
  └─ 基础ROI报表展示

P1 (重要) 🟡
  ├─ Google Sheets配置
  ├─ 数据导出Excel
  ├─ 任务执行日志
  └─ 邮件通知

P2 (优化) 🟢
  ├─ ROI告警规则
  ├─ 数据可视化图表
  ├─ 团队协作功能
  └─ API开放接口
```

---

## 🏗️ 系统架构设计

### 1. 技术栈详细方案

```
┌─────────────────────────────────────────────────────┐
│                   前端层 (Frontend)                   │
│  Next.js 14 (App Router) + TypeScript + Tailwind    │
│  + Ant Design / shadcn/ui                            │
│  + React Query (数据管理) + Zustand (状态管理)       │
└──────────────────────┬──────────────────────────────┘
                       │ tRPC / REST API
┌──────────────────────▼──────────────────────────────┐
│              API层 (Next.js API Routes)              │
│  /api/auth    - 认证授权                              │
│  /api/accounts - 账号管理                             │
│  /api/tasks   - 任务管理                              │
│  /api/reports - 报表查询                              │
└──────────────────────┬──────────────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        │              │              │
┌───────▼────────┐ ┌──▼──────────┐ ┌▼───────────────┐
│  认证服务       │ │ 数据采集引擎 │ │ 报表计算引擎   │
│  NextAuth.js   │ │ Bull Queue   │ │ SQL + Cache    │
└───────┬────────┘ └──┬──────────┘ └┬───────────────┘
        │             │              │
┌───────▼─────────────▼──────────────▼───────────────┐
│           Vercel Postgres (Neon/Supabase)          │
│  - users  - accounts  - tasks  - metrics           │
└────────────────────┬────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────┐
│  Upstash Redis (任务队列 + 缓存) + R2/S3 (文件存储) │
└─────────────────────────────────────────────────────┘
```

### 2. 为什么选择这个方案？

#### ✅ Next.js 14 (App Router)
- **全栈框架**: 前后端一体，减少开发复杂度
- **Vercel原生支持**: 零配置部署
- **SSR + ISR**: 首屏快 + SEO友好
- **API Routes**: 内置后端API能力
- **Server Actions**: 简化表单提交

#### ✅ Vercel Postgres (Neon)
- **Serverless**: 按使用量计费，节省成本
- **自动扩展**: 支持并发连接池
- **备份恢复**: 自动快照
- **免费额度**: 足够50人团队使用

#### ✅ Upstash Redis
- **Serverless Redis**: 无需维护
- **Bull Queue**: 任务队列(数据采集异步执行)
- **低延迟缓存**: 报表查询加速

#### ⚠️ 关键限制
- Vercel函数**最大执行时间10秒**(Hobby), 60秒(Pro)
- 数据采集任务必须异步化 → 使用队列 + Webhook回调

---

## 📐 数据库设计

### ER模型图
```
┌─────────────┐       ┌──────────────────┐       ┌─────────────┐
│   users     │1────n │ affiliate_accounts│n────1 │  platforms  │
│             │       │                  │       │             │
│ id          │       │ id               │       │ id          │
│ email       │       │ user_id (FK)     │       │ name (LH)   │
│ password    │       │ platform_id (FK) │       │ api_config  │
│ created_at  │       │ username_enc     │       │             │
└─────────────┘       │ password_enc     │       └─────────────┘
                      │ token_enc        │
                      │ is_active        │
                      └──────────────────┘
                               │
                               │1
                               │
                               │n
                      ┌────────▼─────────┐
                      │  data_tasks      │
                      │                  │
                      │ id               │
                      │ user_id (FK)     │
                      │ account_id (FK)  │
                      │ task_type        │◄─── [google_sheets, affiliate_api]
                      │ schedule_cron    │
                      │ config_json      │
                      │ status           │
                      │ last_run_at      │
                      └──────────────────┘
                               │
                               │1
                               │
                               │n
                      ┌────────▼─────────┐
                      │  task_logs       │
                      │                  │
                      │ id               │
                      │ task_id (FK)     │
                      │ status           │◄─── [pending,running,success,failed]
                      │ started_at       │
                      │ completed_at     │
                      │ error_message    │
                      │ rows_fetched     │
                      └──────────────────┘
                               │
                               │1
                               │
                               │n
                      ┌────────▼─────────┐
                      │  metrics_data    │
                      │                  │
                      │ id               │
                      │ user_id (FK)     │
                      │ account_id (FK)  │
                      │ date             │
                      │ merchant_id      │
                      │ impressions      │
                      │ clicks           │
                      │ cost             │
                      │ commission       │
                      │ orders           │
                      │ currency         │
                      │ created_at       │
                      └──────────────────┘
```

### 核心表结构 (SQL)

```sql
-- 1. 用户表
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(100),
  role VARCHAR(20) DEFAULT 'user', -- user, admin
  is_active BOOLEAN DEFAULT true,
  email_verified BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_users_email ON users(email);

-- 2. 平台配置表 (预置数据)
CREATE TABLE platforms (
  id VARCHAR(20) PRIMARY KEY, -- 'LH', 'PM', 'LB', 'RW'
  name VARCHAR(100) NOT NULL,
  display_name VARCHAR(100),
  api_base_url VARCHAR(255),
  auth_type VARCHAR(50), -- 'token', 'cookie', 'oauth2'
  icon_url VARCHAR(255),
  is_enabled BOOLEAN DEFAULT true,
  config_schema JSONB -- API配置的JSON Schema
);

-- 3. 联盟账号表 (加密存储)
CREATE TABLE affiliate_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform_id VARCHAR(20) NOT NULL REFERENCES platforms(id),
  account_name VARCHAR(100), -- 用户自定义别名
  username_encrypted TEXT NOT NULL, -- AES加密
  password_encrypted TEXT, -- AES加密
  token_encrypted TEXT, -- 存储API token
  cookies_encrypted TEXT,
  is_active BOOLEAN DEFAULT true,
  last_validated_at TIMESTAMP, -- 最后验证时间
  validation_status VARCHAR(20), -- 'valid', 'invalid', 'unknown'
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, platform_id, account_name)
);
CREATE INDEX idx_accounts_user ON affiliate_accounts(user_id);

-- 4. Google Sheets配置表
CREATE TABLE google_sheets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sheet_name VARCHAR(200), -- 用户自定义名称
  sheet_url TEXT NOT NULL,
  sheet_id VARCHAR(100), -- 从URL提取
  range VARCHAR(50) DEFAULT 'A1:W500',
  mcc_account VARCHAR(100), -- 对应的Google Ads账号
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 5. 数据采集任务表
CREATE TABLE data_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID REFERENCES affiliate_accounts(id) ON DELETE SET NULL,
  sheet_id UUID REFERENCES google_sheets(id) ON DELETE SET NULL,
  task_type VARCHAR(50) NOT NULL, -- 'affiliate_api', 'google_sheets'
  task_name VARCHAR(200),
  schedule_type VARCHAR(20) DEFAULT 'manual', -- 'manual', 'cron', 'daily'
  schedule_cron VARCHAR(100), -- '0 8 * * *'
  date_range_days INT DEFAULT 7, -- 查询最近N天
  config JSONB, -- 额外配置
  is_active BOOLEAN DEFAULT true,
  status VARCHAR(20) DEFAULT 'idle', -- 'idle', 'running', 'paused'
  last_run_at TIMESTAMP,
  next_run_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_tasks_user ON data_tasks(user_id);
CREATE INDEX idx_tasks_next_run ON data_tasks(next_run_at) WHERE is_active = true;

-- 6. 任务执行日志表
CREATE TABLE task_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES data_tasks(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL, -- 'pending','running','success','failed'
  started_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,
  duration_ms INT,
  rows_fetched INT DEFAULT 0,
  rows_inserted INT DEFAULT 0,
  error_message TEXT,
  error_stack TEXT,
  metadata JSONB -- 额外信息
);
CREATE INDEX idx_logs_task ON task_logs(task_id, created_at DESC);

-- 7. 指标数据表 (核心数据)
CREATE TABLE metrics_data (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID REFERENCES affiliate_accounts(id) ON DELETE SET NULL,
  sheet_id UUID REFERENCES google_sheets(id) ON DELETE SET NULL,

  -- 维度字段
  date DATE NOT NULL,
  platform VARCHAR(20), -- 'LH', 'PM', etc.
  merchant_id VARCHAR(100), -- 商家MID
  campaign VARCHAR(255), -- 广告系列
  country VARCHAR(10), -- 国家代码

  -- 指标字段
  impressions BIGINT DEFAULT 0,
  ad_clicks BIGINT DEFAULT 0,
  affiliate_clicks BIGINT DEFAULT 0,
  cost DECIMAL(12,2) DEFAULT 0,
  commission DECIMAL(12,2) DEFAULT 0,
  commission_pending DECIMAL(12,2) DEFAULT 0,
  commission_rejected DECIMAL(12,2) DEFAULT 0,
  orders INT DEFAULT 0,
  currency VARCHAR(3) DEFAULT 'USD',

  -- 计算字段 (可用虚拟列或触发器)
  cpc DECIMAL(8,4) GENERATED ALWAYS AS (
    CASE WHEN ad_clicks > 0 THEN cost / ad_clicks ELSE 0 END
  ) STORED,
  epc DECIMAL(8,4) GENERATED ALWAYS AS (
    CASE WHEN ad_clicks > 0 THEN commission / ad_clicks ELSE 0 END
  ) STORED,
  roi DECIMAL(8,4) GENERATED ALWAYS AS (
    CASE WHEN cost > 0 THEN (commission - cost) / cost ELSE 0 END
  ) STORED,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  -- 联合唯一约束(防止重复数据)
  UNIQUE(user_id, account_id, date, merchant_id, campaign)
);
CREATE INDEX idx_metrics_user_date ON metrics_data(user_id, date DESC);
CREATE INDEX idx_metrics_roi ON metrics_data(roi) WHERE roi < 0; -- 快速查询亏损数据

-- 8. 系统配置表
CREATE TABLE system_config (
  key VARCHAR(100) PRIMARY KEY,
  value JSONB NOT NULL,
  description TEXT,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 插入平台预置数据
INSERT INTO platforms (id, name, display_name, api_base_url, auth_type) VALUES
  ('LH', 'LinkHaitao', '链海淘', 'https://www.linkhaitao.com/api2.php', 'token'),
  ('PM', 'PartnerMatic', 'PartnerMatic', 'https://api.partnermatic.com', 'token'),
  ('LB', 'LinkBux', 'LinkBux', 'https://www.linkbux.com/api.php', 'cookie'),
  ('RW', 'Rewardoo', 'Rewardoo', 'https://www.rewardoo.com', 'cookie');
```

---

## 🔐 安全设计

### 1. 凭证加密方案

```typescript
// lib/crypto.ts
import crypto from 'crypto';

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY; // 32字节密钥
const ALGORITHM = 'aes-256-gcm';

export function encrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY, 'hex'), iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  // 格式: iv:authTag:encryptedData
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

export function decrypt(encryptedText: string): string {
  const [ivHex, authTagHex, encrypted] = encryptedText.split(':');

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    Buffer.from(ENCRYPTION_KEY, 'hex'),
    Buffer.from(ivHex, 'hex')
  );

  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
```

### 2. 环境变量配置

```bash
# .env.local
DATABASE_URL=postgres://...
REDIS_URL=redis://...

# 加密密钥 (生产环境必须妥善保管)
ENCRYPTION_KEY=64位十六进制字符串

# NextAuth配置
NEXTAUTH_URL=https://yourdomain.com
NEXTAUTH_SECRET=随机密钥

# Google API
GOOGLE_API_KEY=你的密钥

# 邮件服务
SMTP_HOST=smtp.resend.com
SMTP_USER=...
SMTP_PASS=...
```

### 3. 权限控制

```typescript
// middleware/auth.ts
import { getServerSession } from 'next-auth';

export async function requireAuth(req: NextRequest) {
  const session = await getServerSession();
  if (!session) {
    return new Response('Unauthorized', { status: 401 });
  }
  return session.user;
}

// middleware/ownership.ts
export async function checkResourceOwnership(
  userId: string,
  resourceId: string,
  resourceType: 'account' | 'task' | 'sheet'
) {
  // 验证资源是否属于该用户
  const query = {
    account: 'SELECT 1 FROM affiliate_accounts WHERE id = $1 AND user_id = $2',
    task: 'SELECT 1 FROM data_tasks WHERE id = $1 AND user_id = $2',
    sheet: 'SELECT 1 FROM google_sheets WHERE id = $1 AND user_id = $2',
  };

  const result = await db.query(query[resourceType], [resourceId, userId]);
  return result.rowCount > 0;
}
```

---

## ⚙️ 数据采集任务系统设计

### 1. 任务队列架构

```typescript
// lib/queue.ts
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';

const connection = new Redis(process.env.REDIS_URL);

// 创建任务队列
export const dataQueue = new Queue('data-collection', { connection });

// 任务类型定义
export enum TaskType {
  FETCH_AFFILIATE_DATA = 'fetch_affiliate_data',
  FETCH_GOOGLE_SHEETS = 'fetch_google_sheets',
  CALCULATE_METRICS = 'calculate_metrics',
}

// 添加任务到队列
export async function addDataTask(
  taskId: string,
  taskType: TaskType,
  payload: any
) {
  return await dataQueue.add(taskType, {
    taskId,
    ...payload,
  }, {
    attempts: 3, // 失败重试3次
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: 100, // 保留最近100条成功记录
    removeOnFail: 500,
  });
}
```

### 2. Worker进程 (独立部署)

⚠️ **重要**: Vercel不支持长时间运行的Worker，需要部署到其他平台

**方案A: Railway / Render (推荐)**
```yaml
# railway.toml
[build]
builder = "NIXPACKS"

[deploy]
startCommand = "node workers/data-collector.js"
restartPolicyType = "ON_FAILURE"
```

**方案B: Vercel Cron + 短任务**
```typescript
// app/api/cron/trigger-tasks/route.ts
export const runtime = 'edge';
export const maxDuration = 10; // 最大10秒

export async function GET(request: Request) {
  // 验证Cron Secret
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  // 只触发任务，不执行实际采集
  const pendingTasks = await getPendingTasks();

  for (const task of pendingTasks) {
    await addDataTask(task.id, TaskType.FETCH_AFFILIATE_DATA, task);
  }

  return Response.json({ triggered: pendingTasks.length });
}
```

### 3. 数据采集Worker实现

```typescript
// workers/data-collector.ts
import { Worker } from 'bullmq';
import { fetchLinkHaitaoData } from './scrapers/linkhaitao';
import { fetchPartnerMaticData } from './scrapers/partnermatic';

const worker = new Worker('data-collection', async (job) => {
  const { taskId, taskType, config } = job.data;

  // 更新任务日志为运行中
  await updateTaskLog(taskId, { status: 'running', started_at: new Date() });

  try {
    let result;

    switch (taskType) {
      case TaskType.FETCH_AFFILIATE_DATA:
        result = await fetchAffiliateData(config);
        break;
      case TaskType.FETCH_GOOGLE_SHEETS:
        result = await fetchGoogleSheets(config);
        break;
      default:
        throw new Error(`Unknown task type: ${taskType}`);
    }

    // 数据入库
    await saveMetricsData(result);

    // 更新任务日志为成功
    await updateTaskLog(taskId, {
      status: 'success',
      completed_at: new Date(),
      rows_fetched: result.length,
    });

    return result;

  } catch (error) {
    await updateTaskLog(taskId, {
      status: 'failed',
      completed_at: new Date(),
      error_message: error.message,
      error_stack: error.stack,
    });
    throw error;
  }
}, { connection });

worker.on('completed', (job) => {
  console.log(`Task ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`Task ${job.id} failed:`, err);
});
```

### 4. 联盟平台数据采集器

```typescript
// workers/scrapers/linkhaitao.ts
import axios from 'axios';
import crypto from 'crypto';

export async function fetchLinkHaitaoData(config: {
  token: string;
  startDate: string;
  endDate: string;
}) {
  const { token, startDate, endDate } = config;

  // 生成签名
  const sign = generateSign(`m_id${startDate}${endDate}12000`);

  const response = await axios.post(
    'https://www.linkhaitao.com/api2.php?c=report&a=performance',
    new URLSearchParams({
      sign,
      group_by: 'm_id',
      start_date: startDate,
      end_date: endDate,
      page: '1',
      page_size: '2000',
      export: '0',
    }),
    {
      headers: {
        'Lh-Authorization': token,
      },
    }
  );

  if (response.data.error_no !== 'lh_suc') {
    throw new Error(`LH API Error: ${response.data.error_info}`);
  }

  // 转换为标准格式
  return response.data.payload.info.map((item: any) => ({
    merchant_id: item.mcid,
    impressions: 0,
    ad_clicks: parseInt(item.click_num),
    affiliate_clicks: parseInt(item.click_num),
    cost: 0,
    commission: parseFloat(item.cps_total_aff.replace(/,/g, '')),
    orders: parseInt(item.cps_total_order),
    currency: 'USD',
    platform: 'LH',
    date: endDate,
  }));
}

function generateSign(data: string): string {
  const salt = process.env.LH_SALT || 'TSf03xGHykY';
  return crypto.createHash('md5').update(data + salt).digest('hex');
}
```

### 5. 定时任务调度

```typescript
// lib/scheduler.ts
import cron from 'node-cron';

// 每小时检查需要执行的任务
cron.schedule('0 * * * *', async () => {
  const tasks = await db.query(`
    SELECT * FROM data_tasks
    WHERE is_active = true
    AND status = 'idle'
    AND next_run_at <= NOW()
  `);

  for (const task of tasks.rows) {
    await addDataTask(task.id, task.task_type, {
      accountId: task.account_id,
      dateRangeDays: task.date_range_days,
    });

    // 更新下次执行时间
    await updateNextRunTime(task.id, task.schedule_cron);
  }
});
```

---

## 📡 API接口设计

### REST API规范

```typescript
// 1. 用户认证
POST   /api/auth/register          // 注册
POST   /api/auth/login             // 登录
POST   /api/auth/logout            // 登出
GET    /api/auth/session           // 获取当前会话

// 2. 联盟账号管理
GET    /api/accounts               // 获取账号列表
POST   /api/accounts               // 添加账号
PUT    /api/accounts/:id           // 更新账号
DELETE /api/accounts/:id           // 删除账号
POST   /api/accounts/:id/validate  // 验证账号有效性

// 3. Google Sheets配置
GET    /api/sheets                 // 获取配置列表
POST   /api/sheets                 // 添加配置
PUT    /api/sheets/:id             // 更新配置
DELETE /api/sheets/:id             // 删除配置

// 4. 数据采集任务
GET    /api/tasks                  // 获取任务列表
POST   /api/tasks                  // 创建任务
PUT    /api/tasks/:id              // 更新任务
DELETE /api/tasks/:id              // 删除任务
POST   /api/tasks/:id/run          // 手动触发任务
GET    /api/tasks/:id/logs         // 获取任务日志

// 5. 数据报表
GET    /api/reports/metrics        // 获取指标数据
POST   /api/reports/export         // 导出Excel
GET    /api/reports/summary        // 获取汇总统计
```

### 请求/响应示例

```typescript
// POST /api/accounts - 添加联盟账号
Request:
{
  "platform": "LH",
  "accountName": "LinkHaitao主账号",
  "username": "your_email@example.com",
  "password": "your_password",
  "token": "optional_if_already_have"
}

Response:
{
  "success": true,
  "data": {
    "id": "uuid",
    "platform": "LH",
    "accountName": "LinkHaitao主账号",
    "validationStatus": "valid",
    "createdAt": "2025-01-15T08:00:00Z"
  }
}

// POST /api/tasks - 创建数据采集任务
Request:
{
  "taskName": "每日佣金采集",
  "taskType": "affiliate_api",
  "accountId": "uuid",
  "scheduleType": "daily",
  "scheduleCron": "0 8 * * *",
  "dateRangeDays": 7,
  "config": {
    "fetchCommission": true,
    "fetchClicks": true
  }
}

Response:
{
  "success": true,
  "data": {
    "id": "uuid",
    "status": "idle",
    "nextRunAt": "2025-01-16T08:00:00Z"
  }
}

// GET /api/reports/metrics - 查询指标数据
Query Params:
  - startDate: 2025-01-01
  - endDate: 2025-01-15
  - platform: LH (可选)
  - merchantId: xxxx (可选)

Response:
{
  "success": true,
  "data": {
    "metrics": [
      {
        "date": "2025-01-15",
        "platform": "LH",
        "merchantId": "amazon",
        "campaign": "US-LH-amazon",
        "impressions": 10000,
        "adClicks": 500,
        "cost": 250.00,
        "commission": 380.00,
        "orders": 25,
        "cpc": 0.50,
        "epc": 0.76,
        "roi": 0.52
      }
    ],
    "summary": {
      "totalCost": 1250.00,
      "totalCommission": 1890.00,
      "avgROI": 0.51,
      "totalOrders": 125
    }
  }
}
```

---

## 🎨 前端页面设计

### 页面结构

```
/app
├── (auth)
│   ├── login/page.tsx          # 登录页
│   ├── register/page.tsx       # 注册页
│   └── layout.tsx              # 认证布局
├── (dashboard)                  # 需要登录
│   ├── layout.tsx              # Dashboard布局(侧边栏)
│   ├── page.tsx                # 首页(数据概览)
│   ├── accounts/
│   │   ├── page.tsx            # 账号列表
│   │   └── [id]/page.tsx       # 账号详情
│   ├── sheets/
│   │   └── page.tsx            # Google Sheets配置
│   ├── tasks/
│   │   ├── page.tsx            # 任务列表
│   │   ├── new/page.tsx        # 创建任务
│   │   └── [id]/page.tsx       # 任务详情+日志
│   └── reports/
│       ├── page.tsx            # 数据报表
│       └── analytics/page.tsx  # 数据分析
└── api/                         # API Routes
    ├── auth/[...nextauth]/route.ts
    ├── accounts/route.ts
    └── ...
```

### 关键UI组件

```tsx
// components/DataTable.tsx - 数据报表表格
import { Table, Tag } from 'antd';

export function MetricsTable({ data }) {
  const columns = [
    { title: '日期', dataIndex: 'date', sorter: true },
    { title: '平台', dataIndex: 'platform' },
    { title: '商家ID', dataIndex: 'merchantId' },
    { title: '广告系列', dataIndex: 'campaign' },
    { title: '点击', dataIndex: 'adClicks', align: 'right' },
    { title: '费用', dataIndex: 'cost', render: (v) => `$${v.toFixed(2)}` },
    { title: '佣金', dataIndex: 'commission', render: (v) => `$${v.toFixed(2)}` },
    {
      title: 'ROI',
      dataIndex: 'roi',
      render: (roi) => (
        <Tag color={roi < 0 ? 'red' : 'green'}>
          {(roi * 100).toFixed(2)}%
        </Tag>
      ),
      sorter: (a, b) => a.roi - b.roi,
    },
  ];

  return (
    <Table
      columns={columns}
      dataSource={data}
      pagination={{ pageSize: 50 }}
      scroll={{ x: 1200 }}
    />
  );
}

// components/TaskCreator.tsx - 任务创建向导
export function TaskCreator() {
  const [step, setStep] = useState(1);

  return (
    <Steps current={step}>
      <Step title="选择账号" />
      <Step title="配置参数" />
      <Step title="设置调度" />
      <Step title="完成" />
    </Steps>
  );
}
```

---

## 📦 项目初始化脚手架

### 1. 创建Next.js项目

```bash
# 创建项目
npx create-next-app@latest affiliate-metrics \
  --typescript \
  --tailwind \
  --app \
  --src-dir \
  --import-alias "@/*"

cd affiliate-metrics

# 安装依赖
npm install \
  @prisma/client \
  next-auth \
  bullmq ioredis \
  axios \
  zod \
  react-query @tanstack/react-query \
  zustand \
  antd @ant-design/icons \
  date-fns \
  xlsx \
  nodemailer

npm install -D \
  prisma \
  @types/node \
  @types/nodemailer
```

### 2. 项目结构

```
affiliate-metrics/
├── src/
│   ├── app/                    # Next.js App Router
│   │   ├── (auth)/            # 认证页面组
│   │   ├── (dashboard)/       # Dashboard页面组
│   │   ├── api/               # API Routes
│   │   └── layout.tsx
│   ├── components/            # React组件
│   │   ├── ui/                # 基础UI组件
│   │   ├── forms/             # 表单组件
│   │   └── charts/            # 图表组件
│   ├── lib/                   # 工具函数
│   │   ├── db.ts              # 数据库连接
│   │   ├── crypto.ts          # 加密工具
│   │   ├── queue.ts           # 任务队列
│   │   └── auth.ts            # 认证工具
│   ├── workers/               # 后台Worker
│   │   ├── data-collector.ts
│   │   └── scrapers/
│   │       ├── linkhaitao.ts
│   │       ├── partnermatic.ts
│   │       └── google-sheets.ts
│   └── types/                 # TypeScript类型
├── prisma/
│   ├── schema.prisma          # Prisma Schema
│   └── migrations/
├── public/
├── .env.local
├── package.json
└── README.md
```

### 3. Prisma配置

```prisma
// prisma/schema.prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id            String    @id @default(uuid())
  email         String    @unique
  passwordHash  String    @map("password_hash")
  name          String?
  role          String    @default("user")
  isActive      Boolean   @default(true) @map("is_active")
  emailVerified Boolean   @default(false) @map("email_verified")
  createdAt     DateTime  @default(now()) @map("created_at")
  updatedAt     DateTime  @updatedAt @map("updated_at")

  accounts      AffiliateAccount[]
  sheets        GoogleSheet[]
  tasks         DataTask[]
  metrics       MetricsData[]

  @@map("users")
}

model AffiliateAccount {
  id                 String    @id @default(uuid())
  userId             String    @map("user_id")
  platformId         String    @map("platform_id")
  accountName        String?   @map("account_name")
  usernameEncrypted  String    @map("username_encrypted")
  passwordEncrypted  String?   @map("password_encrypted")
  tokenEncrypted     String?   @map("token_encrypted")
  isActive           Boolean   @default(true) @map("is_active")
  lastValidatedAt    DateTime? @map("last_validated_at")
  validationStatus   String?   @map("validation_status")
  createdAt          DateTime  @default(now()) @map("created_at")
  updatedAt          DateTime  @updatedAt @map("updated_at")

  user     User          @relation(fields: [userId], references: [id], onDelete: Cascade)
  platform Platform      @relation(fields: [platformId], references: [id])
  tasks    DataTask[]
  metrics  MetricsData[]

  @@unique([userId, platformId, accountName])
  @@map("affiliate_accounts")
}

// ... 其他模型定义
```

---

## 🚀 部署方案

### Vercel部署清单

```bash
# 1. 安装Vercel CLI
npm i -g vercel

# 2. 连接项目
vercel link

# 3. 配置环境变量
vercel env add DATABASE_URL
vercel env add REDIS_URL
vercel env add ENCRYPTION_KEY
vercel env add NEXTAUTH_SECRET

# 4. 部署
vercel --prod
```

### 数据库部署 (Neon.tech)

```bash
# 1. 注册 https://neon.tech
# 2. 创建项目 -> 获取连接字符串
# 3. 运行迁移
npx prisma migrate deploy

# 4. 生成Prisma Client
npx prisma generate
```

### Worker部署 (Railway.app)

```bash
# 1. 创建 railway.toml
[build]
builder = "NIXPACKS"

[deploy]
startCommand = "node dist/workers/data-collector.js"

# 2. 连接GitHub仓库
# 3. 配置环境变量(与Vercel相同)
# 4. 自动部署
```

---

## 📊 开发排期

### Phase 1: 基础架构 (2周)
- [ ] Week 1
  - 项目初始化 + 数据库设计
  - 用户认证系统(NextAuth)
  - 基础UI布局
- [ ] Week 2
  - 联盟账号管理CRUD
  - 凭证加密/解密
  - Google Sheets配置

### Phase 2: 核心功能 (3周)
- [ ] Week 3
  - 任务队列系统搭建
  - LinkHaitao数据采集器
  - PartnerMatic数据采集器
- [ ] Week 4
  - LinkBux + Rewardoo采集器
  - Google Sheets采集器
  - 数据入库逻辑
- [ ] Week 5
  - 任务调度系统
  - 任务日志功能
  - Worker独立部署

### Phase 3: 报表分析 (2周)
- [ ] Week 6
  - 数据报表页面
  - ROI计算与展示
  - 数据筛选/排序
- [ ] Week 7
  - Excel导出功能
  - 数据可视化图表
  - 性能优化

### Phase 4: 上线准备 (1周)
- [ ] Week 8
  - 测试 + Bug修复
  - 文档编写
  - 生产环境部署

**总计: 8周 (2个月)**

---

## 💰 成本估算 (月费用)

| 服务 | 方案 | 费用 |
|-----|------|------|
| **Vercel** | Pro计划 | $20/月 |
| **Neon.tech** | Pro计划 | $19/月 |
| **Upstash Redis** | Pay-as-you-go | ~$5/月 |
| **Railway** | Hobby计划 | $5/月 |
| **域名** | .com | $12/年 |
| **Resend (邮件)** | 免费额度 | $0 |
| **合计** | | **~$50/月** |

50人团队按人均$10/月收费 → $500/月收入
**净利润**: $450/月

---

## 🎯 成功指标

### 技术指标
- [ ] 数据采集成功率 > 95%
- [ ] API响应时间 < 500ms (P95)
- [ ] 任务执行延迟 < 5分钟
- [ ] 系统可用性 > 99.5%

### 业务指标
- [ ] 用户注册转化率 > 60%
- [ ] 日活跃用户 > 70%
- [ ] 平均每用户配置3+账号
- [ ] 每日至少触发1次数据采集

---

## 🔧 后续优化方向

### P2功能 (V2.1)
- [ ] 多维度数据分析看板
- [ ] 自定义ROI告警规则
- [ ] Webhook通知集成(Slack/钉钉)
- [ ] 数据对比分析(同比/环比)

### P3功能 (V2.2)
- [ ] 团队协作(多用户共享账号)
- [ ] API开放平台
- [ ] 移动端适配
- [ ] AI辅助分析建议

---

## 📚 技术文档索引

### 必读文档
1. [Next.js 14 官方文档](https://nextjs.org/docs)
2. [Prisma ORM](https://www.prisma.io/docs)
3. [BullMQ 任务队列](https://docs.bullmq.io)
4. [NextAuth.js 认证](https://next-auth.js.org)
5. [Vercel 部署指南](https://vercel.com/docs)

### 联盟平台API
- LinkHaitao API (需要找对接人获取文档)
- PartnerMatic API
- Google Sheets API v4

---

## ✅ 下一步行动

### 立即开始
1. **决策确认**: 审阅本PRD,确认技术方案
2. **环境准备**:
   - 注册Vercel/Neon/Railway账号
   - 获取各平台API密钥
3. **项目初始化**:
   - 执行脚手架命令创建项目
   - 配置数据库和环境变量

### 我可以帮你
- [ ] 立即生成完整的项目脚手架代码
- [ ] 编写数据库迁移SQL
- [ ] 实现第一个数据采集器(LinkHaitao)
- [ ] 搭建基础认证系统

**你准备好开始了吗？我可以直接为你生成初始化代码！**

---

**文档版本**: v2.0
**最后更新**: 2025-10-12
**作者**: Claude + 你的团队
**状态**: 待审批 → 开发中
