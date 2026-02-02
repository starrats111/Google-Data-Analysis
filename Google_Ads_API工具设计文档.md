# Google Ads API 工具设计文档

## 1. 工具概述

### 1.1 工具名称
**Google Ads 数据分析与管理平台**

### 1.2 工具目的
开发一个综合性的 Google Ads 数据分析和管理平台，用于：
- 自动化同步多个 MCC 账号下的 Google Ads 数据
- 整合和分析广告数据，生成业务报告
- 为数字营销代理公司提供统一的数据管理解决方案
- 支持多员工、多客户账号的数据同步和分析

### 1.3 目标用户
- 数字营销代理公司的内部员工（10名员工，员工ID：1-10）
- 公司管理层（经理角色，用于查看所有员工的汇总报告）

### 1.4 业务价值
- 提高数据同步效率，减少手动操作
- 统一管理多个客户账号的广告数据
- 提供实时数据分析和报告
- 支持业务决策和客户服务

---

## 2. 系统架构

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                    前端界面 (React)                      │
│  - 数据总览、平台数据、收益分析、MCC管理、账号管理      │
└──────────────────────┬──────────────────────────────────┘
                       │ HTTPS/API
┌──────────────────────▼──────────────────────────────────┐
│              后端服务 (FastAPI/Python)                   │
│  - RESTful API                                          │
│  - 数据同步服务                                         │
│  - 数据分析服务                                         │
└──────────────────────┬──────────────────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        │              │              │
┌───────▼──────┐ ┌────▼────┐ ┌──────▼──────┐
│  数据库      │ │Google Ads│ │ 其他平台API │
│ (SQLite/    │ │   API    │ │ (CollabGlow,│
│ PostgreSQL) │ │          │ │ Rewardoo等) │
└──────────────┘ └──────────┘ └─────────────┘
```

### 2.2 技术栈

**前端：**
- React.js
- Ant Design UI 组件库
- Axios (HTTP 客户端)

**后端：**
- FastAPI (Python Web 框架)
- SQLAlchemy (ORM)
- Google Ads API Python 客户端库

**数据库：**
- SQLite（生产环境）
- 存储广告数据、账号信息、分析结果、用户数据等

---

## 3. 核心功能模块

### 3.1 MCC 账号管理模块

**功能描述：**
- 管理多个 Google Ads MCC 账号
- 存储 MCC 账号的 API 凭证（Client ID, Client Secret, Refresh Token）
- 支持手动同步和自动同步

**API 使用：**
- 使用 Google Ads API 获取 MCC 下的客户账号列表
- 查询每个客户账号的广告系列数据

**数据流程：**
```
用户添加MCC账号 → 配置API凭证 → 系统验证凭证 → 
保存到数据库 → 支持后续数据同步
```

### 3.2 数据同步模块

**功能描述：**
- 自动同步多个 MCC 账号下的广告数据
- 支持按日期范围同步
- 处理配额限制和错误重试

**API 使用：**
- `GoogleAdsService.Search()`: 查询广告系列数据
- `CustomerService`: 获取客户账号列表
- 查询字段：广告系列ID、名称、费用、展示、点击、CPC等

**同步流程：**
```
1. 获取MCC下的所有客户账号
2. 对每个客户账号：
   a. 构建查询语句（按日期筛选）
   b. 调用GoogleAdsService.Search()
   c. 解析返回数据
   d. 保存到数据库
3. 处理错误和重试
4. 返回同步结果
```

**数据存储：**
- 广告系列基本信息（ID、名称、日期）
- 广告指标（费用、展示、点击、CPC）
- 平台匹配信息（从广告系列名提取）

### 3.3 平台数据整合模块

**功能描述：**
- 整合多个联盟平台的数据，包括：
  - **CollabGlow (CG)** - 主要联盟平台
  - **Rewardoo (RW)** - 主要联盟平台
  - **LinkHaitao (LH)** - 主要联盟平台
  - **其他平台** - LB、PM、BSH、CF 等
- 统一数据格式和存储
- 支持按平台、日期、商家聚合

**数据来源：**
- Google Ads API（广告费用数据）
- 各联盟平台 API（佣金数据）
- 手动录入数据（拒付佣金、手动费用、手动佣金）

### 3.4 数据分析模块

**功能描述：**
- 按日期、平台、商家聚合数据
- 计算净利润、拒付率等指标
- 生成汇总报告和明细报告

**分析维度：**
- 按日期分析
- 按平台分析
- 按商家分析
- 按员工分析（经理视图）

### 3.5 费用管理模块

**功能描述：**
- 管理广告费用数据
- 支持手动上传费用（MCC级别、平台级别）
- 支持手动上传佣金
- 清理重复费用数据

**功能特性：**
- MCC 费用详情查看
- 平台费用明细（按日期细分）
- 手动费用覆盖 API 费用
- 费用与佣金匹配计算

---

## 4. Google Ads API 使用详情

### 4.1 API 调用场景

#### 场景 1: 获取客户账号列表
```python
# 使用 CustomerService 或 CustomerClient 查询
query = """
    SELECT
        customer_client.id,
        customer_client.manager
    FROM customer_client
    WHERE customer_client.manager = false
"""
```

#### 场景 2: 查询广告系列数据
```python
# 使用 GoogleAdsService.Search()
query = """
    SELECT
        campaign.id,
        campaign.name,
        campaign_budget.amount_micros,
        metrics.cost_micros,
        metrics.impressions,
        metrics.clicks,
        metrics.average_cpc,
        metrics.search_budget_lost_impression_share,
        metrics.search_rank_lost_impression_share
    FROM campaign
    WHERE segments.date = '2026-02-01'
    AND campaign.status != 'REMOVED'
"""
```

### 4.2 API 调用频率

**当前使用情况：**
- 同步频率：每天一次（同步前一天的数据，因为当天数据可能不完整）
- MCC 账号数量：10 个（每个员工对应一个 MCC 账号）
- 每个 MCC 账号：平均 10-50 个客户账号（根据实际业务情况）
- 每个客户账号：平均 10-30 个广告系列
- 预计每日 API 操作：约 5,000-15,000 次
  - 获取客户账号列表：10-50 次/MCC × 10 MCC = 100-500 次
  - 查询广告系列数据：10-30 次/客户账号 × 10-50 客户账号/MCC × 10 MCC = 1,000-15,000 次
  - 总计：约 1,100-15,500 次/天

**为什么需要 Standard Access：**
- Explorer Access（2,880 次/天）无法满足需求
- 需要同步多个 MCC 账号的数据
- 需要支持业务增长（客户账号数量增加）

### 4.3 错误处理机制

**已实现的错误处理：**
1. **配额耗尽（429）错误**
   - 自动重试（指数退避：5秒、10秒、20秒）
   - 显示准确的等待时间
   - 返回部分同步结果

2. **客户账号未启用错误**
   - 自动跳过未启用的账号
   - 继续处理其他账号
   - 记录警告日志

3. **网络错误**
   - 自动重试机制
   - 详细的错误日志

4. **请求限流**
   - 在请求之间添加延迟（1秒）
   - 避免触发速率限制

### 4.4 数据安全

**安全措施：**
1. API 凭证加密存储
2. 用户认证和授权
3. 数据库访问控制
4. HTTPS 传输加密

---

## 5. 数据模型设计

### 5.1 核心数据表

**google_mcc_accounts（MCC账号表）**
- id, mcc_id, mcc_name, email
- client_id, client_secret, refresh_token（加密存储）
- is_active, user_id

**google_ads_api_data（广告数据表）**
- id, mcc_id, user_id, campaign_id, campaign_name
- date, cost, impressions, clicks, cpc
- extracted_platform_code（从广告系列名提取）

**platform_data（平台数据汇总表）**
- id, user_id, affiliate_account_id, platform_id
- date, orders, commission, rejected_commission
- order_amount, gmv

**expense_adjustments（费用调整表）**
- id, user_id, platform_id, date
- rejected_commission, manual_cost, manual_commission

**mcc_cost_adjustments（MCC费用调整表）**
- id, user_id, mcc_id, date
- manual_cost

### 5.2 数据关系

```
User (用户)
  ├── GoogleMccAccount (MCC账号)
  │     └── GoogleAdsApiData (广告数据)
  ├── AffiliateAccount (联盟账号)
  │     └── PlatformData (平台数据)
  └── ExpenseAdjustment (费用调整)
```

---

## 6. 用户界面设计

### 6.1 主要页面

1. **数据总览**
   - 显示关键指标汇总
   - 图表展示趋势

2. **平台每日数据**
   - 按平台显示数据
   - 支持明细和汇总视图
   - 按商家聚合数据

3. **我的收益**
   - 显示佣金、费用、净利润
   - 支持手动录入拒付佣金和费用
   - 费用详情页面（按MCC和平台）

4. **MCC账号管理**
   - 添加/编辑/删除 MCC 账号
   - 配置 API 凭证
   - 手动同步数据

5. **平台账号管理**
   - 管理联盟平台账号
   - 配置平台 API Token
   - 同步平台数据

### 6.2 用户权限

**员工（Employee）：**
- 员工ID：1-10（每个员工有唯一ID）
- 只能查看和管理自己的数据
- 可以同步自己的 MCC 账号数据
- 可以录入自己的费用和佣金
- 可以管理自己的联盟平台账号

**经理（Manager）：**
- 默认经理用户名：wenjun123
- 可以查看所有员工的数据
- 可以管理所有 MCC 账号
- 可以查看汇总报告
- 可以查看所有平台的聚合数据

---

## 7. 数据流程示例

### 7.1 数据同步流程

```
1. 用户触发同步（手动或定时任务）
   ↓
2. 系统获取MCC账号配置
   ↓
3. 使用Google Ads API获取客户账号列表
   ↓
4. 对每个客户账号：
   a. 构建查询（日期范围）
   b. 调用API获取广告系列数据
   c. 解析数据
   d. 从广告系列名提取平台信息
   e. 保存到数据库
   ↓
5. 聚合数据到平台数据表
   ↓
6. 返回同步结果
```

### 7.2 数据分析流程

```
1. 用户选择日期范围
   ↓
2. 系统查询数据库：
   - 从platform_data获取佣金数据
   - 从google_ads_api_data获取费用数据
   - 从expense_adjustments获取调整数据
   ↓
3. 数据聚合：
   - 按平台聚合
   - 按日期聚合
   - 按商家聚合
   ↓
4. 计算指标：
   - 净利润 = 佣金 - 拒付佣金 - 费用
   - 拒付率 = 拒付佣金 / 总佣金
   ↓
5. 返回结果给前端显示
```

---

## 8. 技术实现细节

### 8.1 Google Ads API 集成

**客户端配置：**
```python
client = GoogleAdsClient.load_from_dict({
    "developer_token": settings.google_ads_shared_developer_token,
    "client_id": mcc_account.client_id,
    "client_secret": mcc_account.client_secret,
    "refresh_token": mcc_account.refresh_token,
    "login_customer_id": mcc_customer_id,  # MCC的customer_id
    "use_proto_plus": True
})
```

**查询执行：**
```python
ga_service = client.get_service("GoogleAdsService")
response = ga_service.search(customer_id=customer_id, query=query)
```

### 8.2 平台匹配逻辑

**广告系列名格式：**
`序号-平台-商家-投放国家-投放时间（月份日期）-MID`

**示例：**
- `1-cg-merchant1-us-2026-02-01-mid123`
- `2-rw-merchant2-uk-2026-02-01-mid456`

**提取逻辑：**
- 使用正则表达式解析广告系列名
- 提取平台代码、商家ID、国家、日期、MID等信息
- 自动匹配到对应的平台和账号
- 将平台信息保存到 `AdCampaign` 表的 `platform_id` 和 `merchant_id` 字段

### 8.3 错误处理和重试

**重试策略：**
- 配额错误：指数退避（5秒、10秒、20秒）
- 网络错误：固定延迟重试
- 最大重试次数：3次

**错误分类：**
- 配额耗尽：停止同步，返回部分结果
- 账号未启用：跳过，继续处理
- 其他错误：记录日志，继续处理

---

## 9. 安全与合规

### 9.1 数据安全

1. **API 凭证加密**
   - 敏感信息加密存储
   - 传输使用 HTTPS

2. **用户认证**
   - JWT Token 认证
   - 基于角色的访问控制

3. **数据隔离**
   - 员工只能访问自己的数据
   - 数据库查询过滤用户ID

### 9.2 API 使用合规

1. **遵守 Google Ads API 政策**
   - 不违反 Google Ads 服务条款
   - 不进行恶意操作
   - 遵守速率限制

2. **数据使用**
   - 仅用于内部数据分析和报告
   - 不向第三方泄露数据
   - 遵守数据保护法规

---

## 10. 部署和运维

### 10.1 部署架构

**后端：**
- 部署在阿里云服务器（Linux）
- 使用 uvicorn 运行 FastAPI 应用
- 使用 nohup 保持后台运行
- 端口：8000
- 健康检查端点：/health
- API 文档：/docs

**前端：**
- 部署在 Cloudflare Pages
- 自动构建和部署
- 生产域名：https://google-data-analysis.top

**数据库：**
- SQLite（生产环境）
- 数据库文件：google_analysis.db

### 10.2 监控和日志

**日志记录：**
- API 调用日志
- 错误日志
- 同步操作日志

**监控指标：**
- API 调用成功率
- 数据同步完成率
- 配额使用情况

---

## 11. 未来扩展计划

### 11.1 功能扩展

1. **自动化报告**
   - 定时生成报告
   - 邮件发送报告

2. **数据可视化**
   - 更多图表类型
   - 交互式数据分析

3. **移动端支持**
   - 响应式设计
   - 移动端应用

### 11.2 性能优化

1. **数据缓存**
   - 缓存常用查询结果
   - 减少数据库查询

2. **异步处理**
   - 大数据量同步使用异步任务
   - 提高响应速度

---

## 12. 总结

### 12.1 工具价值

本工具为数字营销代理公司提供了一个统一的 Google Ads 数据管理平台，实现了：
- 自动化数据同步，减少手动操作
- 多平台数据整合，统一分析
- 实时数据查看，支持业务决策
- 费用和佣金管理，提高财务效率

### 12.2 API 使用需求

**当前需求：**
- 每天需要同步 10 个 MCC 账号的数据（每个员工一个 MCC）
- 每个 MCC 平均 10-50 个客户账号
- 每个客户账号平均 10-30 个广告系列
- 预计每日 API 操作：1,100-15,500 次
  - 获取客户账号列表：100-500 次
  - 查询广告系列数据：1,000-15,000 次

**为什么需要 Standard Access：**
- Explorer Access（2,880 次/天）无法满足需求
- 需要支持业务增长
- 需要稳定的生产环境访问

### 12.3 合规承诺

我们承诺：
- 严格遵守 Google Ads API 使用政策
- 仅用于内部数据管理和分析
- 不进行任何违反服务条款的操作
- 及时响应 Google 的审核和通知

---

## 附录

### A. 系统截图说明

（可以附上系统主要界面的截图）

### B. 技术文档

- API 文档：内部 API 接口文档
- 数据库设计：ER 图和表结构说明
- 部署文档：服务器部署和配置说明

### C. 联系方式

- 系统域名：https://google-data-analysis.top
- API 地址：https://google-data-analysis.top/api
- 后端服务器：阿里云服务器
- 前端部署：Cloudflare Pages

---

**文档版本：** 1.1  
**最后更新：** 2026-02-02  
**文档状态：** 用于 Google Ads API Standard Access 申请  
**系统信息：**
- 员工数量：10 名
- MCC 账号数量：10 个
- 支持的联盟平台：CollabGlow、Rewardoo、LinkHaitao 等
- 生产环境：阿里云服务器 + Cloudflare Pages
- 系统域名：https://google-data-analysis.top

