# 联盟营销数据采集系统 - 完整技术文档

**版本**: v2.1  
**最后更新**: 2024年  
**技术栈**: Node.js + Express + SQLite + Vanilla JavaScript

---

## 📋 目录

1. [API 详细文档](#api-详细文档)
2. [数据库设计文档](#数据库设计文档)
3. [前端开发文档](#前端开发文档)
4. [开发指南](#开发指南)
5. [配置说明](#配置说明)
6. [错误处理](#错误处理)
7. [安全说明](#安全说明)
8. [性能优化](#性能优化)
9. [测试指南](#测试指南)

---

## API 详细文档

### 基础信息

- **Base URL**: `http://localhost:3000/api`
- **认证方式**: Bearer Token (JWT)
- **Content-Type**: `application/json`
- **字符编码**: UTF-8

### 认证相关 API

#### 1. 用户注册

**端点**: `POST /api/auth/register`

**描述**: 用户注册，需要邀请码

**请求头**: 无需认证

**请求体**:
```json
{
  "username": "string",      // 必填，用户名
  "email": "string",         // 必填，邮箱地址
  "password": "string",       // 必填，密码（至少6位）
  "invitation_code": "string" // 必填，邀请码
}
```

**响应示例**:
```json
{
  "success": true,
  "message": "注册成功，请等待管理员审核",
  "data": {
    "user": {
      "id": 1,
      "email": "user@example.com",
      "username": "testuser",
      "approval_status": "pending"
    }
  }
}
```

**错误响应**:
```json
{
  "success": false,
  "message": "邀请码无效或已失效"
}
```

**状态码**:
- `200`: 成功
- `400`: 参数错误
- `409`: 邮箱已存在

**业务规则**:
- 邀请码必须存在且有效
- 邀请码未过期
- 邀请码使用次数未达上限
- 邮箱唯一性检查
- 注册后状态为 `pending`，需管理员审核

---

#### 2. 用户登录

**端点**: `POST /api/auth/login`

**描述**: 用户登录，获取JWT Token

**请求头**: 无需认证

**请求体**:
```json
{
  "email": "string",    // 必填，邮箱地址
  "password": "string"  // 必填，密码
}
```

**响应示例**:
```json
{
  "success": true,
  "message": "登录成功",
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": 1,
      "email": "user@example.com",
      "username": "testuser",
      "role": "user"
    }
  }
}
```

**错误响应**:
```json
{
  "success": false,
  "message": "账号正在审核中，请等待管理员审核通过"
}
```

**状态码**:
- `200`: 成功
- `401`: 认证失败
- `403`: 账号被禁用或审核未通过

**业务规则**:
- 检查用户审核状态（pending/rejected 无法登录）
- 检查账号是否被禁用
- Token有效期7天
- Token包含用户ID、邮箱、用户名、角色信息

---

#### 3. 获取当前用户信息

**端点**: `GET /api/auth/me`

**描述**: 获取当前登录用户信息

**请求头**:
```
Authorization: Bearer {token}
```

**响应示例**:
```json
{
  "success": true,
  "data": {
    "id": 1,
    "email": "user@example.com",
    "username": "testuser",
    "role": "user",
    "created_at": "2024-01-01T00:00:00.000Z"
  }
}
```

**状态码**:
- `200`: 成功
- `401`: Token无效或过期

---

### 用户管理 API

#### 4. 更新用户资料

**端点**: `PUT /api/user/profile`

**描述**: 更新用户名或密码

**请求头**:
```
Authorization: Bearer {token}
```

**请求体**:
```json
{
  "username": "string",        // 可选，新用户名
  "currentPassword": "string", // 修改密码时必填
  "newPassword": "string"      // 可选，新密码（至少6位）
}
```

**响应示例**:
```json
{
  "success": true,
  "message": "资料更新成功"
}
```

**业务规则**:
- 修改密码必须提供当前密码
- 新密码至少6位
- 用户名和密码可单独更新

---

### 平台账号管理 API

#### 5. 添加平台账号

**端点**: `POST /api/platform-accounts`

**描述**: 添加平台账号配置

**请求头**:
```
Authorization: Bearer {token}
```

**请求体**:
```json
{
  "platform": "string",        // 必填，平台名称: linkhaitao, partnermatic, linkbux, rewardoo
  "accountName": "string",     // 必填，平台登录用户名
  "accountPassword": "string", // 可选，平台登录密码（某些平台需要）
  "apiToken": "string",        // 可选，API Token（LinkBux、Rewardoo等使用）
  "affiliateName": "string"    // 可选，联盟序号，如 "LH1", "PM1", "LB1"
}
```

**响应示例**:
```json
{
  "success": true,
  "message": "平台账号添加成功",
  "data": {
    "id": 1,
    "platform": "linkhaitao",
    "account_name": "testuser",
    "affiliate_name": "LH1"
  }
}
```

**业务规则**:
- 同一用户同一平台同一账号名唯一
- 密码使用AES-256-CBC加密存储
- LinkBux、Rewardoo、LinkHaitao、PartnerMatic可使用API Token，无需密码

---

#### 6. 获取平台账号列表

**端点**: `GET /api/platform-accounts`

**描述**: 获取当前用户的所有平台账号

**请求头**:
```
Authorization: Bearer {token}
```

**响应示例**:
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "platform": "linkhaitao",
      "account_name": "testuser",
      "affiliate_name": "LH1",
      "is_active": 1,
      "created_at": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

---

#### 7. 删除平台账号

**端点**: `DELETE /api/platform-accounts/:id`

**描述**: 删除指定的平台账号

**请求头**:
```
Authorization: Bearer {token}
```

**路径参数**:
- `id`: 平台账号ID

**响应示例**:
```json
{
  "success": true,
  "message": "平台账号删除成功"
}
```

**业务规则**:
- 只能删除自己的账号
- 级联删除相关的token和订单数据（由数据库外键约束处理）

---

### 数据采集 API

#### 8. 采集平台订单数据

**端点**: `POST /api/collect-orders`

**描述**: 采集指定平台账号的订单数据

**请求头**:
```
Authorization: Bearer {token}
```

**请求体**:
```json
{
  "platformAccountId": "number", // 必填，平台账号ID
  "startDate": "string",         // 必填，开始日期，格式: YYYY-MM-DD
  "endDate": "string"           // 必填，结束日期，格式: YYYY-MM-DD
}
```

**响应示例**:
```json
{
  "success": true,
  "message": "采集完成",
  "data": {
    "orders": [...],
    "stats": {
      "new": 100,      // 新增订单数
      "updated": 10,   // 更新订单数
      "skipped": 5,   // 跳过订单数（已存在）
      "deleted": 0     // 删除订单数
    },
    "totalOrders": 110,
    "totalAmount": 10000.00,
    "totalCommission": 500.00
  }
}
```

**业务规则**:
- 检查日期范围限制（各平台不同）
- 检查历史数据限制（36个月）
- 自动分割超过限制的日期范围
- 处理API频率限制（自动重试）
- 支持分页请求（处理大量数据）

**平台限制**:

| 平台 | 单次查询最大天数 | 历史数据限制 | 请求间隔 |
|------|----------------|------------|---------|
| LinkHaitao | 31天 | 36个月 | 16秒 |
| PartnerMatic | 62天 | 无限制 | 2秒 |
| LinkBux | 62天 | 36个月 | 2秒 |
| Rewardoo | 62天 | 无限制 | 2秒 |

---

#### 9. 采集Google Sheets广告数据

**端点**: `POST /api/collect-google-sheets`

**描述**: 从Google Sheets采集广告数据

**请求头**:
```
Authorization: Bearer {token}
```

**请求体**:
```json
{
  "sheetId": "number"  // 必填，Google Sheets配置ID
}
```

**响应示例**:
```json
{
  "success": true,
  "message": "采集完成",
  "data": {
    "totalRows": 100,
    "newRows": 80,
    "updatedRows": 20,
    "errors": []
  }
}
```

**业务规则**:
- 解析Google Sheets URL
- 读取指定工作表
- 识别表头和数据行
- 提取merchant_id（从campaign_name）
- 提取affiliate_name（从campaign_name或表格名称）
- 货币转换（CNY → USD，汇率7.13）
- 去重处理（基于sheet_id + date + campaign_name）

---

### 数据查询 API

#### 10. 查询订单列表

**端点**: `GET /api/orders`

**描述**: 查询订单列表，支持分页和筛选

**请求头**:
```
Authorization: Bearer {token}
```

**查询参数**:
- `startDate` (可选): 开始日期，格式: YYYY-MM-DD
- `endDate` (可选): 结束日期，格式: YYYY-MM-DD
- `platformAccountId` (可选): 平台账号ID
- `status` (可选): 订单状态，如: APPROVED, PENDING, REJECTED
- `page` (可选): 页码，默认: 1
- `pageSize` (可选): 每页数量，默认: 20

**响应示例**:
```json
{
  "success": true,
  "data": {
    "orders": [
      {
        "id": 1,
        "order_id": "12345",
        "merchant_id": "merchant_001",
        "merchant_name": "Test Merchant",
        "order_amount": 100.00,
        "commission": 10.00,
        "status": "APPROVED",
        "order_date": "2024-01-01T00:00:00.000Z"
      }
    ],
    "pagination": {
      "page": 1,
      "pageSize": 20,
      "total": 100,
      "totalPages": 5
    }
  }
}
```

---

#### 11. 获取统计数据

**端点**: `GET /api/stats`

**描述**: 获取订单统计数据

**请求头**:
```
Authorization: Bearer {token}
```

**查询参数**:
- `startDate` (可选): 开始日期
- `endDate` (可选): 结束日期
- `platformAccountId` (可选): 平台账号ID
- `status` (可选): 订单状态

**响应示例**:
```json
{
  "success": true,
  "data": {
    "totalOrders": 100,
    "totalAmount": 10000.00,
    "totalCommission": 500.00,
    "confirmedCommission": 400.00,
    "pendingCommission": 100.00,
    "rejectedCommission": 0.00
  }
}
```

---

#### 12. 获取商家汇总数据

**端点**: `GET /api/merchant-summary`

**描述**: 获取商家汇总数据（包含订单和广告数据）

**请求头**:
```
Authorization: Bearer {token}
```

**查询参数**:
- `startDate` (可选): 开始日期
- `endDate` (可选): 结束日期
- `platformAccountIds` (可选): 平台账号ID列表，逗号分隔，如: "1,2,3"
- `showStatus` (可选): 状态筛选，可选值: all, active, paused

**响应示例**:
```json
{
  "success": true,
  "data": [
    {
      "merchant_id": "merchant_001",
      "merchant_name": "Test Merchant",
      "merchant_slug": "test-merchant",
      "affiliate_name": "lh1",
      "campaign_names": "Campaign 1, Campaign 2",
      "total_budget": 1000.00,
      "total_impressions": 10000,
      "total_clicks": 500,
      "total_cost": 200.00,
      "order_count": 50,
      "total_commission": 500.00,
      "cr": 10.0,
      "epc": 1.00,
      "cpc": 0.40,
      "roi": 2.50,
      "status": "active",
      "optimization_suggestion": {
        "suggestion": "建议增加预算",
        "confidence": "高",
        "reason": "ROI优秀，趋势上升",
        "budget_increase": 20
      }
    }
  ]
}
```

**业务规则**:
- 合并订单数据和广告数据
- 按 merchant_id + affiliate_name 分组
- 计算指标: CR, EPC, CPC, ROI
- 状态判断: 最近一天预算/展示/点击全为0 → 暂停
- 生成AI操作建议

**指标计算**:
- `CR` (转化率) = (订单数 / 点击) × 100
- `EPC` (每次点击收益) = 总佣金 / 点击
- `CPC` (每次点击成本) = 广告费 / 点击
- `ROI` (投资回报率) = 总佣金 / 广告费

---

#### 13. 获取广告系列每日详情

**端点**: `GET /api/campaign-daily-details`

**描述**: 获取指定广告系列的每日详细数据

**请求头**:
```
Authorization: Bearer {token}
```

**查询参数**:
- `merchantId` (必填): 商家ID
- `campaignName` (可选): 广告系列名称
- `affiliateName` (可选): 联盟序号
- `startDate` (可选): 开始日期
- `endDate` (可选): 结束日期

**响应示例**:
```json
{
  "success": true,
  "data": [
    {
      "date": "2024-01-01",
      "campaign_name": "Campaign 1",
      "budget": 100.00,
      "impressions": 1000,
      "clicks": 50,
      "cost": 20.00,
      "orders": 5,
      "commission": 50.00
    }
  ]
}
```

---

#### 14. 获取Google Ads数据

**端点**: `GET /api/google-ads-data`

**描述**: 获取Google Ads数据

**请求头**:
```
Authorization: Bearer {token}
```

**查询参数**:
- `startDate` (可选): 开始日期
- `endDate` (可选): 结束日期
- `sheetId` (可选): Google Sheets ID

**响应示例**:
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "date": "2024-01-01",
      "campaign_name": "Campaign 1",
      "affiliate_name": "lh1",
      "merchant_id": "merchant_001",
      "campaign_budget": 100.00,
      "impressions": 1000,
      "clicks": 50,
      "cost": 20.00,
      "currency": "USD"
    }
  ]
}
```

---

#### 15. 获取热门推荐广告系列

**端点**: `GET /api/top-ads-ranking`

**描述**: 获取ROI > 3的优质广告系列Top 10

**请求头**:
```
Authorization: Bearer {token}
```

**查询参数**:
- `range` (可选): 时间范围，可选值: yesterday, last7days, last30days, custom
- `startDate` (可选): 自定义开始日期（range=custom时必填）
- `endDate` (可选): 自定义结束日期（range=custom时必填）

**响应示例**:
```json
{
  "success": true,
  "data": {
    "dateRange": "2024-01-01 至 2024-01-07",
    "ranking": [
      {
        "rank": 1,
        "campaign_name": "Campaign 1",
        "merchant_id": "merchant_001",
        "affiliate_name": "lh1",
        "roi": 5.2,
        "total_commission": 520.00,
        "total_cost": 100.00,
        "total_clicks": 500,
        "order_count": 50
      }
    ]
  }
}
```

---

### Google Sheets 管理 API

#### 16. 添加Google Sheets

**端点**: `POST /api/google-sheets`

**描述**: 添加Google Sheets配置

**请求头**:
```
Authorization: Bearer {token}
```

**请求体**:
```json
{
  "sheetName": "string",     // 必填，表格名称
  "sheetUrl": "string",      // 必填，表格URL
  "description": "string"    // 可选，备注
}
```

**响应示例**:
```json
{
  "success": true,
  "message": "Google表格添加成功",
  "data": {
    "id": 1,
    "sheet_name": "12月广告数据",
    "sheet_url": "https://docs.google.com/spreadsheets/d/...",
    "sheet_id": "abc123..."
  }
}
```

**业务规则**:
- 从URL中提取Sheet ID
- 验证URL格式
- 表格必须设置为"任何人可查看"

---

#### 17. 获取Google Sheets列表

**端点**: `GET /api/google-sheets`

**描述**: 获取当前用户的所有Google Sheets配置

**请求头**:
```
Authorization: Bearer {token}
```

**响应示例**:
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "sheet_name": "12月广告数据",
      "sheet_url": "https://docs.google.com/spreadsheets/d/...",
      "description": "Google Ads搜索广告数据",
      "is_active": 1
    }
  ]
}
```

---

#### 18. 删除Google Sheets

**端点**: `DELETE /api/google-sheets/:id`

**描述**: 删除指定的Google Sheets配置

**请求头**:
```
Authorization: Bearer {token}
```

**路径参数**:
- `id`: Google Sheets配置ID

**响应示例**:
```json
{
  "success": true,
  "message": "Google表格删除成功"
}
```

---

### 数据导出 API

#### 19. 导出商家汇总数据

**端点**: `POST /api/export/merchant-summary`

**描述**: 导出商家汇总数据为Excel文件

**请求头**:
```
Authorization: Bearer {token}
```

**请求体**:
```json
{
  "startDate": "string",         // 可选，开始日期
  "endDate": "string",           // 可选，结束日期
  "platformAccountIds": "string" // 可选，平台账号ID列表，逗号分隔
}
```

**响应**: Excel文件流

**Content-Type**: `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`

**业务规则**:
- 使用ExcelJS库生成Excel文件
- 包含所有商家汇总数据
- 包含多个工作表（汇总、详情等）

---

### 超级管理员 API

#### 20. 获取用户列表

**端点**: `GET /api/super-admin/users`

**描述**: 获取用户列表（分页、搜索）

**请求头**:
```
Authorization: Bearer {token}
```

**权限**: 需要超级管理员角色

**查询参数**:
- `page` (可选): 页码，默认: 1
- `pageSize` (可选): 每页数量，默认: 20
- `search` (可选): 搜索关键词（用户名、邮箱）

**响应示例**:
```json
{
  "success": true,
  "data": {
    "users": [
      {
        "id": 1,
        "username": "testuser",
        "email": "user@example.com",
        "role": "user",
        "approval_status": "approved",
        "is_active": 1,
        "created_at": "2024-01-01T00:00:00.000Z"
      }
    ],
    "pagination": {
      "page": 1,
      "pageSize": 20,
      "total": 100,
      "totalPages": 5
    }
  }
}
```

---

#### 21. 审核用户

**端点**: `PUT /api/super-admin/users/:id/approve`

**描述**: 审核通过用户

**请求头**:
```
Authorization: Bearer {token}
```

**权限**: 需要超级管理员角色

**路径参数**:
- `id`: 用户ID

**响应示例**:
```json
{
  "success": true,
  "message": "用户审核通过"
}
```

**审计日志**: 自动记录操作日志

---

#### 22. 批量审核用户

**端点**: `POST /api/super-admin/users/batch-approve`

**描述**: 批量审核用户

**请求头**:
```
Authorization: Bearer {token}
```

**权限**: 需要超级管理员角色

**请求体**:
```json
{
  "user_ids": [1, 2, 3],  // 必填，用户ID数组
  "action": "approve"     // 必填，操作类型: approve 或 reject
}
```

**响应示例**:
```json
{
  "success": true,
  "message": "批量审核完成",
  "data": {
    "successCount": 3,
    "failCount": 0
  }
}
```

---

#### 23. 创建邀请码

**端点**: `POST /api/super-admin/invitation-codes`

**描述**: 创建邀请码

**请求头**:
```
Authorization: Bearer {token}
```

**权限**: 需要超级管理员角色

**请求体**:
```json
{
  "max_uses": 1,          // 可选，最大使用次数，默认: 1
  "expires_at": "string", // 可选，过期时间，格式: YYYY-MM-DD HH:mm:ss
  "role": "user"          // 可选，角色，默认: user
}
```

**响应示例**:
```json
{
  "success": true,
  "message": "邀请码创建成功",
  "data": {
    "id": 1,
    "code": "INV-ABC123XYZ",
    "max_uses": 1,
    "expires_at": null
  }
}
```

**业务规则**:
- 自动生成唯一邀请码
- 记录创建者信息
- 支持设置过期时间
- 支持设置使用次数限制

---

#### 24. 获取审计日志

**端点**: `GET /api/super-admin/audit-logs`

**描述**: 获取审计日志列表

**请求头**:
```
Authorization: Bearer {token}
```

**权限**: 需要超级管理员角色

**查询参数**:
- `page` (可选): 页码，默认: 1
- `pageSize` (可选): 每页数量，默认: 50
- `action` (可选): 操作类型筛选
- `startDate` (可选): 开始日期
- `endDate` (可选): 结束日期

**响应示例**:
```json
{
  "success": true,
  "data": {
    "logs": [
      {
        "id": 1,
        "admin_id": 1,
        "admin_username": "admin",
        "action": "create_user",
        "target_user_id": 2,
        "target_username": "testuser",
        "request_path": "/api/super-admin/users",
        "request_method": "POST",
        "ip_address": "127.0.0.1",
        "details": "{\"username\":\"testuser\"}",
        "execution_time": 150,
        "created_at": "2024-01-01T00:00:00.000Z"
      }
    ],
    "pagination": {
      "page": 1,
      "pageSize": 50,
      "total": 1000,
      "totalPages": 20
    }
  }
}
```

---

#### 25. 批量采集Google Sheets

**端点**: `POST /api/super-admin/batch-collect-sheets`

**描述**: 批量采集多个用户的Google Sheets

**请求头**:
```
Authorization: Bearer {token}
```

**权限**: 需要超级管理员角色

**请求体**:
```json
{
  "userIds": [1, 2, 3],    // 必填，用户ID数组
  "onlyOutdated": true     // 可选，仅采集过期数据，默认: false
}
```

**响应示例**:
```json
{
  "success": true,
  "message": "批量采集任务已启动",
  "data": {
    "taskId": "task_123",
    "totalUsers": 3,
    "status": "running"
  }
}
```

---

#### 26. 批量采集平台订单

**端点**: `POST /api/super-admin/batch-collect-platforms`

**描述**: 批量采集多个用户的平台订单数据

**请求头**:
```
Authorization: Bearer {token}
```

**权限**: 需要超级管理员角色

**请求体**:
```json
{
  "userIds": [1, 2, 3],        // 必填，用户ID数组
  "platforms": ["linkhaitao"], // 可选，平台列表
  "onlyOutdated": true,        // 可选，仅采集过期数据
  "startDate": "string",       // 可选，开始日期
  "endDate": "string"          // 可选，结束日期
}
```

**响应示例**:
```json
{
  "success": true,
  "message": "批量采集任务已启动",
  "data": {
    "taskId": "task_456",
    "totalUsers": 3,
    "status": "running"
  }
}
```

---

## 数据库设计文档

### ER图

```
┌─────────────┐
│    users    │
├─────────────┤
│ id (PK)     │
│ email (UK)  │
│ password    │
│ username    │
│ role        │
│ approval    │
│ invitation  │
└──────┬──────┘
       │
       │ 1:N
       │
┌──────▼──────────────┐      ┌──────────────────┐
│ platform_accounts   │      │ invitation_codes  │
├─────────────────────┤      ├──────────────────┤
│ id (PK)             │      │ id (PK)           │
│ user_id (FK)        │      │ code (UK)        │
│ platform            │      │ created_by (FK)   │
│ account_name        │      │ max_uses          │
│ password (encrypted) │      │ used_count        │
│ api_token           │      │ expires_at        │
│ affiliate_name      │      └──────────────────┘
└──────┬──────────────┘
       │
       │ 1:N
       │
┌──────▼──────────────┐      ┌──────────────────┐
│ platform_tokens     │      │ orders            │
├─────────────────────┤      ├──────────────────┤
│ id (PK)             │      │ id (PK)           │
│ account_id (FK)     │      │ user_id (FK)      │
│ token               │      │ account_id (FK)   │
│ expire_time         │      │ order_id          │
└─────────────────────┘      │ merchant_id       │
                             │ merchant_name     │
                             │ order_amount      │
                             │ commission        │
                             │ status            │
                             │ order_date        │
                             └──────────────────┘

┌──────────────────┐          ┌──────────────────┐
│ google_sheets    │          │ google_ads_data  │
├──────────────────┤          ├──────────────────┤
│ id (PK)          │          │ id (PK)          │
│ user_id (FK)     │          │ user_id (FK)     │
│ sheet_name       │          │ sheet_id (FK)    │
│ sheet_url        │          │ date             │
│ sheet_id         │          │ campaign_name    │
└──────┬───────────┘          │ affiliate_name   │
       │                      │ merchant_id     │
       │ 1:N                  │ budget           │
       │                      │ impressions      │
       └──────────────────────► clicks            │
                              │ cost             │
                              │ lost_is_budget   │
                              │ lost_is_rank     │
                              └──────────────────┘

┌──────────────────┐          ┌──────────────────┐
│ audit_logs       │          │ campaign_analysis│
├──────────────────┤          ├──────────────────┤
│ id (PK)          │          │ id (PK)          │
│ admin_id (FK)    │          │ user_id (FK)     │
│ action           │          │ merchant_id      │
│ target_user_id   │          │ affiliate_name   │
│ request_path     │          │ campaign_name    │
│ details          │          │ suggestion       │
│ execution_time   │          │ confidence       │
└──────────────────┘          │ metrics          │
                              └──────────────────┘
```

### 表结构详细说明

#### users 表

| 字段名 | 类型 | 约束 | 说明 |
|--------|------|------|------|
| id | INTEGER | PRIMARY KEY, AUTOINCREMENT | 用户ID |
| email | TEXT | UNIQUE, NOT NULL | 邮箱地址 |
| password_hash | TEXT | NOT NULL | 密码哈希（bcrypt） |
| username | TEXT | NOT NULL | 用户名 |
| role | TEXT | DEFAULT 'user' | 角色: user, super_admin |
| approval_status | TEXT | DEFAULT 'pending' | 审核状态: pending, approved, rejected |
| invitation_code_id | INTEGER | | 注册时使用的邀请码ID |
| api_token | TEXT | | API Token（可选） |
| is_active | INTEGER | DEFAULT 1 | 是否激活: 1=是, 0=否 |
| created_at | DATETIME | DEFAULT CURRENT_TIMESTAMP | 创建时间 |
| updated_at | DATETIME | DEFAULT CURRENT_TIMESTAMP | 更新时间 |

**索引**:
- `idx_users_email`: email (UNIQUE)
- `idx_users_role`: role
- `idx_users_approval_status`: approval_status
- `idx_users_invitation_code_id`: invitation_code_id

---

#### platform_accounts 表

| 字段名 | 类型 | 约束 | 说明 |
|--------|------|------|------|
| id | INTEGER | PRIMARY KEY, AUTOINCREMENT | 账号ID |
| user_id | INTEGER | NOT NULL, FK → users.id | 用户ID |
| platform | TEXT | NOT NULL | 平台名称 |
| account_name | TEXT | NOT NULL | 平台登录用户名 |
| account_password | TEXT | | 平台登录密码（AES加密） |
| api_token | TEXT | | API Token |
| affiliate_name | TEXT | | 联盟序号，如 LH1, PM1 |
| is_active | INTEGER | DEFAULT 1 | 是否激活 |
| created_at | DATETIME | DEFAULT CURRENT_TIMESTAMP | 创建时间 |
| updated_at | DATETIME | DEFAULT CURRENT_TIMESTAMP | 更新时间 |

**唯一约束**: (user_id, platform, account_name)

**索引**:
- `idx_platform_accounts_user_id`: user_id
- `idx_platform_accounts_affiliate`: affiliate_name

---

#### orders 表

| 字段名 | 类型 | 约束 | 说明 |
|--------|------|------|------|
| id | INTEGER | PRIMARY KEY, AUTOINCREMENT | 订单ID |
| user_id | INTEGER | NOT NULL, FK → users.id | 用户ID |
| platform_account_id | INTEGER | NOT NULL, FK → platform_accounts.id | 平台账号ID |
| order_id | TEXT | NOT NULL | 平台订单ID |
| merchant_id | TEXT | | 商家ID |
| merchant_name | TEXT | | 商家名称 |
| merchant_slug | TEXT | | 商家Slug |
| order_amount | REAL | | 订单金额 |
| commission | REAL | | 佣金金额 |
| status | TEXT | | 订单状态 |
| order_date | DATETIME | | 订单日期 |
| confirm_date | DATETIME | | 确认日期 |
| raw_data | TEXT | | 原始数据（JSON） |
| collected_at | DATETIME | DEFAULT CURRENT_TIMESTAMP | 采集时间 |
| created_at | DATETIME | DEFAULT CURRENT_TIMESTAMP | 创建时间 |
| updated_at | DATETIME | | 更新时间 |

**唯一约束**: (platform_account_id, order_id)

**索引**:
- `idx_orders_user_id`: user_id
- `idx_orders_platform_account_id`: platform_account_id
- `idx_orders_order_date`: order_date
- `idx_orders_status`: status

---

#### google_ads_data 表

| 字段名 | 类型 | 约束 | 说明 |
|--------|------|------|------|
| id | INTEGER | PRIMARY KEY, AUTOINCREMENT | 数据ID |
| user_id | INTEGER | NOT NULL, FK → users.id | 用户ID |
| sheet_id | INTEGER | NOT NULL, FK → google_sheets.id | Google Sheets ID |
| date | DATE | NOT NULL | 日期 |
| campaign_name | TEXT | | 广告系列名称 |
| affiliate_name | TEXT | | 联盟序号 |
| merchant_id | TEXT | | 商家ID |
| merchant_slug | TEXT | | 商家Slug |
| campaign_budget | REAL | | 广告预算 |
| currency | TEXT | | 货币单位 |
| impressions | INTEGER | | 展示次数 |
| clicks | INTEGER | | 点击次数 |
| cost | REAL | | 广告费用（USD） |
| lost_impression_share_budget | REAL | DEFAULT 0 | 因预算丢失的展示份额 |
| lost_impression_share_rank | REAL | DEFAULT 0 | 因评级丢失的展示份额 |
| created_at | DATETIME | DEFAULT CURRENT_TIMESTAMP | 创建时间 |
| updated_at | DATETIME | DEFAULT CURRENT_TIMESTAMP | 更新时间 |

**唯一约束**: (sheet_id, date, campaign_name)

**索引**:
- `idx_google_ads_data_user_id`: user_id
- `idx_google_ads_data_date`: date
- `idx_google_ads_data_affiliate`: affiliate_name
- `idx_google_ads_data_merchant`: merchant_id

---

### 数据库迁移系统

系统使用Migration系统管理数据库结构变更。

**Migration文件命名规则**: `{序号}_{描述}.js`

**Migration文件结构**:
```javascript
module.exports = {
  up: (db) => {
    // 执行迁移
  },
  down: (db) => {
    // 回滚迁移
  }
};
```

**已执行的Migration**:
- 0001: 基线Schema
- 0002: 添加API Token字段
- 0003: 使密码字段可为空
- 0005: 添加affiliate_name到orders表
- 0006: 添加merchant_slug到google_ads_data
- 0007: 添加用户角色
- 0008: 创建审计日志表
- 0009: 添加邀请码和用户审核功能
- 0010: 添加丢失展示份额字段
- 0011: CNY转USD数据迁移
- 0012: 创建广告系列分析表

---

## 前端开发文档

### 项目结构

```
public/
├── index-v2.html      # 用户端页面
├── admin.html         # 超级管理员页面
├── app-v2.js          # 用户端JavaScript
├── admin.js           # 超级管理员JavaScript
├── style-v2.css       # 用户端样式
└── admin.css          # 超级管理员样式
```

### 核心功能模块

#### 1. 认证模块

**文件**: `app-v2.js`

**主要函数**:
- `handleLogin()`: 处理登录
- `handleRegister()`: 处理注册
- `loadUserProfile()`: 加载用户信息
- `logout()`: 退出登录

**Token管理**:
- 使用 `localStorage` 存储Token
- Token格式: `Bearer {token}`
- 自动在请求头中添加Token

**示例代码**:
```javascript
// 登录
async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value;
  const password = document.getElementById('loginPassword').value;
  
  const response = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  
  const result = await response.json();
  if (result.success) {
    localStorage.setItem('authToken', result.data.token);
    // 跳转到主页面
  }
}
```

---

#### 2. 平台账号管理模块

**主要函数**:
- `loadPlatformAccounts()`: 加载账号列表
- `renderAccountsList()`: 渲染账号列表
- `handleAddAccount()`: 处理添加账号
- `deleteAccount()`: 删除账号
- `toggleAccountSelection()`: 切换账号选择状态

**多选功能**:
- 支持选择多个账号进行批量操作
- 使用数组存储选中的账号ID

**示例代码**:
```javascript
let selectedAccountIds = [];

function toggleAccountSelection(accountId) {
  const index = selectedAccountIds.indexOf(accountId);
  if (index > -1) {
    selectedAccountIds.splice(index, 1);
  } else {
    selectedAccountIds.push(accountId);
  }
  updateSelectionUI();
}
```

---

#### 3. 数据采集模块

**主要函数**:
- `handleCollect()`: 处理数据采集请求
- `loadStats()`: 加载统计数据
- `loadMerchantSummary()`: 加载商家汇总数据

**采集流程**:
1. 用户选择账号和日期范围
2. 发送采集请求
3. 显示采集进度
4. 采集完成后刷新数据

**示例代码**:
```javascript
async function handleCollect(e) {
  e.preventDefault();
  
  if (selectedAccountIds.length === 0) {
    showMessage('collectStatus', '请至少选择一个平台账号', 'error');
    return;
  }
  
  const startDate = document.getElementById('startDate').value;
  const endDate = document.getElementById('endDate').value;
  
  // 为每个账号发送采集请求
  for (const accountId of selectedAccountIds) {
    const response = await fetch(`${API_BASE}/collect-orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({
        platformAccountId: accountId,
        startDate,
        endDate
      })
    });
    
    const result = await response.json();
    // 处理结果
  }
}
```

---

#### 4. 数据展示模块

**主要函数**:
- `renderMerchantTable()`: 渲染商家汇总表格
- `toggleRowExpansion()`: 切换行展开状态
- `loadCampaignDailyDetails()`: 加载每日详情

**表格功能**:
- 支持排序
- 支持筛选（状态筛选）
- 支持展开查看详情
- 支持导出Excel

**状态筛选逻辑**:
- `all`: 显示全部
- `active`: 仅显示活跃（最近一天有数据）
- `paused`: 仅显示暂停（最近一天无数据）

**示例代码**:
```javascript
function renderMerchantTable(data) {
  const tbody = document.getElementById('merchantTableBody');
  tbody.innerHTML = '';
  
  data.forEach((merchant, index) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${index + 1}</td>
      <td>${merchant.campaign_names}</td>
      <td>${merchant.merchant_id}</td>
      <td>$${formatCurrency(merchant.total_budget)}</td>
      <td>${formatNumber(merchant.total_impressions)}</td>
      <td>${formatNumber(merchant.total_clicks)}</td>
      <td>$${formatCurrency(merchant.total_cost)}</td>
      <td>${merchant.order_count}</td>
      <td>$${formatCurrency(merchant.total_commission)}</td>
      <td>${merchant.cr.toFixed(2)}%</td>
      <td>$${merchant.epc.toFixed(2)}</td>
      <td>$${merchant.cpc.toFixed(2)}</td>
      <td>${merchant.roi.toFixed(2)}x</td>
      <td>${getOptimizationSuggestion(merchant.optimization_suggestion)}</td>
    `;
    tbody.appendChild(row);
  });
}
```

---

#### 5. 工具函数

**格式化函数**:
- `formatCurrency(value)`: 格式化货币
- `formatNumber(value)`: 格式化数字
- `formatDate(date)`: 格式化日期
- `showMessage(elementId, message, type)`: 显示消息提示

**API请求函数**:
- `apiRequest(url, options)`: 统一的API请求函数，自动添加Token

**示例代码**:
```javascript
function formatCurrency(value) {
  if (!value) return '0.00';
  return parseFloat(value).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatNumber(value) {
  if (!value) return '0';
  return parseInt(value).toLocaleString();
}

async function apiRequest(url, options = {}) {
  const token = localStorage.getItem('authToken');
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    ...options.headers
  };
  
  const response = await fetch(`${API_BASE}${url}`, {
    ...options,
    headers
  });
  
  return await response.json();
}
```

---

### 样式系统

**CSS变量**:
```css
:root {
  --primary-color: #4285f4;
  --secondary-color: #34a853;
  --danger-color: #ea4335;
  --warning-color: #fbbc04;
  --text-primary: #202124;
  --text-secondary: #5f6368;
  --bg-primary: #ffffff;
  --bg-secondary: #f8f9fa;
  --border-color: #dadce0;
}
```

**响应式设计**:
- 使用媒体查询适配移动端
- 使用Flexbox和Grid布局
- 移动端优化表格显示

---

## 开发指南

### 环境要求

- **Node.js**: >= 20.0.0
- **npm**: >= 9.0.0
- **Python**: >= 3.8 (用于OCR验证码识别，可选)

### 项目设置

#### 1. 克隆项目

```bash
git clone <repository-url>
cd affiliate
```

#### 2. 安装依赖

```bash
npm install
```

#### 3. 配置环境变量

创建 `.env` 文件：

```env
# JWT密钥（至少32字符）
JWT_SECRET=your-super-secret-jwt-key-at-least-32-characters-long

# 加密密钥（32字符）
ENCRYPTION_KEY=your-32-character-encryption-key

# 服务器端口
PORT=3000

# 运行环境
NODE_ENV=development

# 超级管理员配置（可选）
ADMIN_EMAIL=admin@example.com
ADMIN_USERNAME=SuperAdmin
ADMIN_PASSWORD=Admin123456
```

**生成密钥**:
```bash
# 生成JWT密钥
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# 生成加密密钥
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

#### 4. 初始化数据库

数据库会在首次启动时自动初始化：

```bash
npm start
```

#### 5. 安装Python依赖（可选）

如果需要OCR验证码识别功能：

```bash
pip install ddddocr pillow
```

---

### 开发流程

#### 1. 启动开发服务器

```bash
npm start
```

服务器会在 `http://localhost:3000` 启动

#### 2. 代码结构

```
affiliate/
├── server-v2.js          # 主服务器文件
├── db.js                 # 数据库配置
├── utils.js              # 工具函数
├── migrate.js            # 数据库迁移管理
├── init-admin.js         # 初始化超级管理员
├── migrations/           # 数据库迁移文件
│   ├── 0001_baseline_schema.js
│   └── ...
├── public/               # 前端文件
│   ├── index-v2.html
│   ├── app-v2.js
│   └── style-v2.css
└── scripts/              # 工具脚本
    └── ...
```

#### 3. 添加新功能

**添加新API端点**:

1. 在 `server-v2.js` 中添加路由
2. 添加认证中间件（如需要）
3. 实现业务逻辑
4. 添加错误处理
5. 添加审计日志（超级管理员操作）

**示例**:
```javascript
app.post('/api/new-endpoint', authenticateToken, async (req, res) => {
  try {
    // 业务逻辑
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('错误:', error);
    res.json({ success: false, message: error.message });
  }
});
```

**添加数据库迁移**:

1. 在 `migrations/` 目录创建新文件
2. 命名格式: `{序号}_{描述}.js`
3. 实现 `up` 和 `down` 函数

**示例**:
```javascript
// migrations/0013_add_new_field.js
module.exports = {
  up: (db) => {
    db.prepare(`
      ALTER TABLE users ADD COLUMN new_field TEXT
    `).run();
  },
  down: (db) => {
    // 回滚逻辑
  }
};
```

---

### 代码规范

#### 1. 命名规范

- **变量**: camelCase，如 `userName`
- **常量**: UPPER_SNAKE_CASE，如 `MAX_RETRY_COUNT`
- **函数**: camelCase，如 `getUserData()`
- **类**: PascalCase，如 `UserManager`
- **文件**: kebab-case，如 `user-manager.js`

#### 2. 注释规范

```javascript
/**
 * 函数描述
 * @param {string} param1 - 参数1说明
 * @param {number} param2 - 参数2说明
 * @returns {Object} 返回值说明
 */
function exampleFunction(param1, param2) {
  // 实现
}
```

#### 3. 错误处理

```javascript
try {
  // 业务逻辑
} catch (error) {
  console.error('操作失败:', error);
  // 返回错误响应
  res.json({ success: false, message: error.message });
}
```

---

## 配置说明

### 环境变量

| 变量名 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| JWT_SECRET | string | 是 | - | JWT签名密钥 |
| ENCRYPTION_KEY | string | 是 | - | AES加密密钥（32字符） |
| PORT | number | 否 | 3000 | 服务器端口 |
| NODE_ENV | string | 否 | development | 运行环境 |
| ADMIN_EMAIL | string | 否 | admin@test.com | 超级管理员邮箱 |
| ADMIN_USERNAME | string | 否 | SuperAdmin | 超级管理员用户名 |
| ADMIN_PASSWORD | string | 否 | Admin123456 | 超级管理员密码 |

### 平台限制配置

在 `server-v2.js` 中的 `PLATFORM_LIMITS` 对象配置各平台的限制：

```javascript
const PLATFORM_LIMITS = {
  linkhaitao: {
    maxDaysPerRequest: 31,        // 单次查询最大天数
    maxHistoryMonths: 36,         // 历史数据限制（月）
    maxItemsPerPage: 40000,       // 单页最大条数
    requestInterval: 16000,       // 请求间隔（毫秒）
    // ...
  },
  // ...
};
```

---

## 错误处理

### 错误响应格式

所有API错误响应统一格式：

```json
{
  "success": false,
  "message": "错误描述信息"
}
```

### 常见错误码

| HTTP状态码 | 说明 | 处理方式 |
|-----------|------|---------|
| 200 | 成功 | 正常处理 |
| 400 | 参数错误 | 检查请求参数 |
| 401 | 未认证 | 重新登录获取Token |
| 403 | 无权限 | 检查用户角色 |
| 404 | 资源不存在 | 检查资源ID |
| 500 | 服务器错误 | 查看服务器日志 |

### 错误处理最佳实践

1. **统一错误格式**: 所有错误返回统一格式
2. **详细日志**: 记录详细错误信息到日志
3. **用户友好**: 错误消息对用户友好
4. **安全考虑**: 不暴露敏感信息

---

## 安全说明

### 认证和授权

1. **JWT Token**:
   - 有效期7天
   - 存储在localStorage
   - 每次请求自动添加到请求头

2. **密码加密**:
   - 用户密码: bcrypt（10轮salt）
   - 平台账号密码: AES-256-CBC

3. **角色权限**:
   - `user`: 普通用户
   - `super_admin`: 超级管理员

### 数据安全

1. **SQL注入防护**:
   - 使用参数化查询
   - 使用better-sqlite3的prepare方法

2. **XSS防护**:
   - 前端输出转义
   - 使用textContent而非innerHTML

3. **CSRF防护**:
   - 使用SameSite Cookie
   - Token验证

### 安全建议

1. **生产环境**:
   - 使用HTTPS
   - 修改默认密钥
   - 配置防火墙
   - 定期更新依赖

2. **数据库安全**:
   - 限制数据库文件权限
   - 定期备份
   - 使用环境变量存储敏感信息

---

## 性能优化

### 数据库优化

1. **索引优化**:
   - 为常用查询字段添加索引
   - 避免过多索引影响写入性能

2. **查询优化**:
   - 使用LIMIT限制结果集
   - 避免SELECT *
   - 使用JOIN替代多次查询

3. **连接池**:
   - SQLite使用连接池管理连接

### API优化

1. **分页**:
   - 所有列表API支持分页
   - 默认每页20条

2. **缓存**:
   - Token缓存（避免频繁登录）
   - 静态资源缓存

3. **异步处理**:
   - 使用async/await
   - 批量操作使用Promise.all

---

## 测试指南

### 单元测试

**示例**:
```javascript
// test/utils.test.js
const { hashPassword, verifyPassword } = require('../utils');

test('密码加密和验证', async () => {
  const password = 'test123';
  const hash = await hashPassword(password);
  const isValid = await verifyPassword(password, hash);
  expect(isValid).toBe(true);
});
```

### API测试

使用Postman或curl测试API：

```bash
# 登录
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"password123"}'

# 获取用户信息
curl -X GET http://localhost:3000/api/auth/me \
  -H "Authorization: Bearer {token}"
```

### 集成测试

测试完整业务流程：

1. 用户注册
2. 添加平台账号
3. 采集数据
4. 查询数据
5. 导出数据

---

## 附录

### A. 常用命令

```bash
# 启动服务器
npm start

# 启动旧版本
npm run start:v1

# 查看数据库
sqlite3 data.db

# 备份数据库
cp data.db data.db.backup

# 运行迁移
node migrate.js
```

### B. 调试技巧

1. **查看日志**:
   - 服务器日志: Console输出
   - 前端日志: 浏览器Console

2. **数据库调试**:
   ```bash
   sqlite3 data.db
   .tables
   SELECT * FROM users;
   ```

3. **API调试**:
   - 使用Postman测试API
   - 查看Network面板

### C. 常见问题

**Q: 数据库锁定错误**
A: 检查是否有其他进程占用数据库文件

**Q: Token过期**
A: 重新登录获取新Token

**Q: 采集失败**
A: 检查平台账号配置、网络连接、API限制

---

**文档版本**: 1.0  
**最后更新**: 2024年  
**维护者**: 项目开发团队

