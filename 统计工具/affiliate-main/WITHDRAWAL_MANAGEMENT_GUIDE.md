# 提现管理功能设计文档

## 功能概述

提现管理功能允许用户查看、申请和管理他们的佣金提现。系统会自动计算可提现金额，并跟踪提现状态。

## 数据库设计

### 1. withdrawal_requests 表（提现申请）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键 |
| user_id | INTEGER | 用户ID |
| platform_account_id | INTEGER | 平台账号ID |
| amount | REAL | 提现金额 |
| currency | VARCHAR(10) | 货币类型（默认USD） |
| status | VARCHAR(50) | 状态：pending, processing, completed, failed, cancelled |
| payment_method | VARCHAR(50) | 支付方式：paypal, bank_transfer等 |
| payment_account | TEXT | 支付账号信息（加密） |
| platform_payment_id | VARCHAR(255) | 平台支付ID |
| platform_settlement_id | VARCHAR(255) | 平台结算ID |
| requested_at | DATETIME | 申请时间 |
| processed_at | DATETIME | 处理时间 |
| completed_at | DATETIME | 完成时间 |
| note | TEXT | 备注 |
| error_message | TEXT | 错误信息 |

### 2. withdrawal_history 表（提现历史）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键 |
| withdrawal_request_id | INTEGER | 提现申请ID |
| from_status | VARCHAR(50) | 原状态 |
| to_status | VARCHAR(50) | 新状态 |
| changed_by | INTEGER | 操作人ID |
| change_reason | TEXT | 变更原因 |
| created_at | DATETIME | 创建时间 |

### 3. orders 表（新增字段）

| 字段 | 类型 | 说明 |
|------|------|------|
| payment_id | VARCHAR(255) | 支付ID（从Transaction V3 API） |
| settlement_id | VARCHAR(255) | 结算ID（从Transaction V3 API） |
| settlement_date | DATETIME | 结算日期（佣金批准日期） |
| paid_date | DATETIME | 支付日期（实际支付日期） |
| withdrawal_request_id | INTEGER | 关联的提现申请ID |

## 提现逻辑

### 可提现金额计算

```
可提现金额 = 已批准佣金 - 已提现金额 - 提现中金额

其中：
- 已批准佣金 = SUM(commission) WHERE status = 'Approved' AND settlement_date IS NOT NULL
- 已提现金额 = SUM(amount) WHERE status = 'completed'
- 提现中金额 = SUM(amount) WHERE status IN ('pending', 'processing')
```

### 提现状态流转

```
pending (待处理)
  ↓
processing (处理中)
  ↓
completed (已完成) / failed (失败) / cancelled (已取消)
```

## API 接口设计

### 1. 获取提现概览
```
GET /api/withdrawal/summary
```

响应：
```json
{
  "success": true,
  "data": {
    "totalCommission": 10000.00,      // 总佣金
    "approvedCommission": 8000.00,    // 已批准佣金
    "pendingCommission": 2000.00,     // 待审核佣金
    "withdrawnAmount": 5000.00,       // 已提现金额
    "processingAmount": 1000.00,      // 提现中金额
    "availableToWithdraw": 2000.00,   // 可提现金额
    "currency": "USD"
  }
}
```

### 2. 获取提现历史
```
GET /api/withdrawal/history?page=1&pageSize=20&status=all
```

响应：
```json
{
  "success": true,
  "data": {
    "total": 100,
    "page": 1,
    "pageSize": 20,
    "list": [
      {
        "id": 1,
        "amount": 1000.00,
        "currency": "USD",
        "status": "completed",
        "payment_method": "paypal",
        "requested_at": "2026-01-01 10:00:00",
        "completed_at": "2026-01-03 15:30:00",
        "platform_account_name": "living001",
        "platform": "partnermatic"
      }
    ]
  }
}
```

### 3. 创建提现申请
```
POST /api/withdrawal/request
```

请求体：
```json
{
  "platform_account_id": 1,
  "amount": 1000.00,
  "payment_method": "paypal",
  "payment_account": "user@example.com",
  "note": "提现备注"
}
```

响应：
```json
{
  "success": true,
  "message": "提现申请已提交",
  "data": {
    "id": 123,
    "amount": 1000.00,
    "status": "pending",
    "requested_at": "2026-01-23 10:00:00"
  }
}
```

### 4. 取消提现申请
```
POST /api/withdrawal/:id/cancel
```

响应：
```json
{
  "success": true,
  "message": "提现申请已取消"
}
```

### 5. 获取提现详情
```
GET /api/withdrawal/:id
```

响应：
```json
{
  "success": true,
  "data": {
    "id": 1,
    "amount": 1000.00,
    "currency": "USD",
    "status": "completed",
    "payment_method": "paypal",
    "payment_account": "user@example.com",
    "requested_at": "2026-01-01 10:00:00",
    "processed_at": "2026-01-02 14:00:00",
    "completed_at": "2026-01-03 15:30:00",
    "note": "提现备注",
    "platform_account": {
      "id": 1,
      "account_name": "living001",
      "platform": "partnermatic"
    },
    "history": [
      {
        "from_status": null,
        "to_status": "pending",
        "created_at": "2026-01-01 10:00:00",
        "change_reason": "用户提交提现申请"
      },
      {
        "from_status": "pending",
        "to_status": "processing",
        "created_at": "2026-01-02 14:00:00",
        "change_reason": "开始处理提现"
      },
      {
        "from_status": "processing",
        "to_status": "completed",
        "created_at": "2026-01-03 15:30:00",
        "change_reason": "提现完成"
      }
    ]
  }
}
```

## 前端页面设计

### 1. 提现管理主页面

显示内容：
- 提现概览卡片（可提现金额、已提现金额、提现中金额）
- 提现历史列表（带筛选和分页）
- 创建提现申请按钮

### 2. 创建提现申请对话框

表单字段：
- 选择平台账号（下拉选择）
- 提现金额（输入框，显示可提现金额）
- 支付方式（下拉选择：PayPal, 银行转账等）
- 支付账号（输入框）
- 备注（可选）

验证规则：
- 提现金额必须 > 0
- 提现金额不能超过可提现金额
- 支付账号必填

### 3. 提现详情页面

显示内容：
- 提现基本信息
- 状态时间线
- 关联订单列表（可选）

## 权限控制

### 用户权限
- 查看自己的提现记录
- 创建提现申请
- 取消自己的待处理提现申请

### 管理员权限
- 查看所有用户的提现记录
- 处理提现申请（审核、完成、拒绝）
- 查看提现统计数据

## 通知机制

### 用户通知
- 提现申请已提交
- 提现申请已批准
- 提现已完成
- 提现失败（包含失败原因）

### 管理员通知
- 新的提现申请待处理
- 提现申请数量超过阈值

## 安全考虑

1. **金额验证**
   - 服务端验证提现金额
   - 防止重复提交
   - 检查账户余额

2. **支付信息加密**
   - 支付账号信息加密存储
   - 敏感信息脱敏显示

3. **操作日志**
   - 记录所有提现相关操作
   - 包含操作人、时间、IP地址

4. **防刷机制**
   - 限制提现频率
   - 最小提现金额限制
   - 单日提现次数限制

## 实施步骤

### Phase 1: 基础功能（当前）
- ✅ 数据库表创建
- ⏳ 后端 API 实现
- ⏳ 前端页面开发
- ⏳ 基本测试

### Phase 2: 增强功能
- 自动同步 Transaction V3 API 数据
- 提现申请审核流程
- 邮件通知
- 提现报表

### Phase 3: 高级功能
- 批量提现
- 自动提现（达到阈值自动申请）
- 提现手续费计算
- 多币种支持

## 测试计划

### 单元测试
- 可提现金额计算逻辑
- 提现状态流转
- 权限验证

### 集成测试
- API 接口测试
- 数据库操作测试
- 并发提现测试

### 用户测试
- 提现流程完整性
- 界面易用性
- 错误提示清晰度
