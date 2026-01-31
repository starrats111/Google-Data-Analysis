# 8个平台统一数据库 + Python 实现级设计方案

## 一、最终交付目标

### 首页 / 汇总页

1. **订单数** - `COUNT(*) FROM affiliate_transactions`
2. **交易金额（GMV）** - `SUM(order_amount) FROM affiliate_transactions`
3. **佣金（Approved）** - `SUM(commission_amount) WHERE status = 'approved'`
4. **❗拒付佣金（Rejected）** - `SUM(commission_amount) WHERE status = 'rejected'`

### 点击「拒付佣金」→ 跳转拒付详情页

显示：
- 订单级明细
- 拒付原因
- 商家 / 平台 / 时间

## 二、统一数据库设计

### 1️⃣ 交易主表（最重要）

```sql
CREATE TABLE affiliate_transactions (
    id BIGSERIAL PRIMARY KEY,
    platform VARCHAR(32) NOT NULL,      -- CG / RW / Linkhaitao / ...
    merchant VARCHAR(128),
    transaction_id VARCHAR(128) NOT NULL,
    transaction_time TIMESTAMP NOT NULL,
    order_amount DECIMAL(12,2),          -- GMV
    commission_amount DECIMAL(12,2),     -- 原始佣金
    status VARCHAR(16) NOT NULL,          -- approved / pending / rejected
    raw_status VARCHAR(32),               -- 平台原始状态
    currency VARCHAR(8),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(platform, transaction_id)
);
```

**这个表解决什么：**
- ✅ 订单数
- ✅ 交易金额（GMV）
- ✅ 已确认佣金
- ✅ **❗拒付佣金（全部从这里算）**

### 2️⃣ 拒付详情表（点击用）

```sql
CREATE TABLE affiliate_rejections (
    id BIGSERIAL PRIMARY KEY,
    platform VARCHAR(32) NOT NULL,
    transaction_id VARCHAR(128) NOT NULL,
    commission_amount DECIMAL(12,2),
    reject_reason TEXT,
    reject_time TIMESTAMP,
    raw_payload JSONB,   -- 原始API返回，便于追责
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(platform, transaction_id)
);
```

**👉 只有 status = rejected 的交易才会进这张表**

## 三、8个平台 API → 表字段映射

### 统一状态映射（非常关键）

```python
STATUS_MAP = {
    # Approved
    "approved": "approved",
    "confirmed": "approved",
    "locked": "approved",
    "paid": "approved",
    
    # Pending
    "pending": "pending",
    "under_review": "pending",
    
    # Rejected
    "rejected": "rejected",
    "declined": "rejected",
    "reversed": "rejected",
    "invalid": "rejected",
    "adjusted": "rejected",
}
```

### 各平台 API 选型（定死）

| 平台 | 主 API | 拒付详情 API |
|------|--------|-------------|
| CG | Transaction / Action API | Commission Detail |
| RW | TransactionDetails API | CommissionDetails |
| Linkhaitao | Order / Transaction API | Commission Detail |
| PartnerBoost | Conversion API | Conversion Status |
| Linkbux | Transaction API | Detail API |
| Partnermatic | Transaction API | Commission Detail |
| BrandSparkHub | Conversion API | Review / Status |
| CreatorFlare | Earning API | Adjustment API |

## 四、Python 数据拉取 & 入库

### 1️⃣ 统一入库函数

```python
def normalize_and_save(tx, platform):
    raw_status = tx["status"]
    status = STATUS_MAP.get(raw_status, "pending")
    
    data = {
        "platform": platform,
        "merchant": tx.get("merchant"),
        "transaction_id": tx["transaction_id"],
        "transaction_time": tx["transaction_time"],
        "order_amount": tx.get("order_amount", 0),
        "commission_amount": tx.get("commission_amount", 0),
        "status": status,
        "raw_status": raw_status,
        "currency": tx.get("currency", "USD"),
    }
    
    upsert_affiliate_transaction(data)
    
    if status == "rejected":
        save_rejection_detail(tx, platform)
```

### 2️⃣ 拒付详情入库

```python
def save_rejection_detail(tx, platform):
    data = {
        "platform": platform,
        "transaction_id": tx["transaction_id"],
        "commission_amount": tx.get("commission_amount", 0),
        "reject_reason": tx.get("reject_reason"),
        "reject_time": tx.get("reject_time"),
        "raw_payload": tx,
    }
    
    upsert_rejection(data)
```

## 五、4个核心指标（SQL）

### 1️⃣ 订单数

```sql
SELECT COUNT(*) 
FROM affiliate_transactions
WHERE transaction_time BETWEEN :start AND :end;
```

### 2️⃣ 交易金额（GMV）

```sql
SELECT SUM(order_amount)
FROM affiliate_transactions
WHERE transaction_time BETWEEN :start AND :end;
```

### 3️⃣ 已确认佣金

```sql
SELECT SUM(commission_amount)
FROM affiliate_transactions
WHERE status = 'approved'
AND transaction_time BETWEEN :start AND :end;
```

### 4️⃣ ❗拒付佣金（点击入口）

```sql
SELECT SUM(commission_amount)
FROM affiliate_transactions
WHERE status = 'rejected'
AND transaction_time BETWEEN :start AND :end;
```

## 六、点击「拒付佣金」→ 详情页 SQL

```sql
SELECT
    t.platform,
    t.merchant,
    t.transaction_id,
    t.transaction_time,
    t.order_amount,
    r.commission_amount,
    r.reject_reason,
    r.reject_time
FROM affiliate_transactions t
JOIN affiliate_rejections r
ON t.platform = r.platform
AND t.transaction_id = r.transaction_id
WHERE t.transaction_time BETWEEN :start AND :end
ORDER BY r.reject_time DESC;
```

**👉 这是前端点"拒付佣金"直接用的查询**

## 七、增量拉取规则（必须执行）

1. **只拉 transaction_time >= last_success_time - 3 days**
2. **platform + transaction_id 唯一约束**
3. **状态允许覆盖（pending → approved / rejected）**

**否则你一定会：**
- ❌ 重复订单
- ❌ 拒付翻倍
- ❌ 金额不稳定

## 八、使用方法

### 1. 数据库迁移

```bash
cd backend
python scripts/create_affiliate_transaction_tables.py
```

### 2. API端点

#### 获取4个核心指标

```http
GET /api/affiliate-transactions/summary?start_date=2024-01-01&end_date=2024-01-31&platform=CG
```

响应：
```json
{
  "total_orders": 1000,
  "gmv": 50000.00,
  "approved_commission": 5000.00,
  "rejected_commission": 500.00,
  "start_date": "2024-01-01",
  "end_date": "2024-01-31",
  "platform": "CG"
}
```

#### 获取拒付详情

```http
GET /api/affiliate-transactions/rejections?start_date=2024-01-01&end_date=2024-01-31&platform=CG
```

响应：
```json
[
  {
    "platform": "CG",
    "merchant": "Brand A",
    "transaction_id": "tx_123",
    "transaction_time": "2024-01-15T10:00:00Z",
    "order_amount": 100.00,
    "commission_amount": 10.00,
    "reject_reason": "Invalid order",
    "reject_time": "2024-01-16T10:00:00Z"
  }
]
```

### 3. 同步数据

使用 `UnifiedTransactionService` 进行数据同步：

```python
from app.services.unified_transaction_service import UnifiedTransactionService
from app.services.platform_factory import PlatformServiceFactory

# 创建平台服务
service = PlatformServiceFactory.create_service("CG", token="your_token")

# 获取交易数据
result = service.get_transactions("2024-01-01", "2024-01-31")
transactions = service.extract_transaction_data(result)

# 批量保存
unified_service = UnifiedTransactionService(db)
result = unified_service.batch_save_transactions(
    transactions,
    platform="CG",
    affiliate_account_id=1,
    user_id=1
)
```

## 九、代码结构

### 核心文件

1. **数据库模型**
   - `backend/app/models/affiliate_transaction.py` - 交易主表和拒付详情表

2. **统一服务**
   - `backend/app/services/unified_transaction_service.py` - 统一数据处理服务
   - `backend/app/services/platform_factory.py` - 平台服务工厂
   - `backend/app/services/platform_services_base.py` - 平台服务基类

3. **API端点**
   - `backend/app/api/affiliate_transactions.py` - 4个核心指标和拒付详情API

4. **数据库迁移**
   - `backend/scripts/create_affiliate_transaction_tables.py` - 创建表结构

## 十、这套方案为什么是「可交付级」

✅ **不依赖某个平台** - 统一数据模型，所有平台都遵循同一套规则
✅ **状态可回滚** - 状态允许覆盖（pending → approved / rejected）
✅ **拒付可追溯** - 拒付详情表存储原始数据，便于追责
✅ **支持 BI / 前端跳转** - 提供完整的API接口
✅ **Python + DB 原生友好** - 使用SQLAlchemy ORM，易于维护

## 十一、扩展新平台

要添加新平台，只需：

1. 创建平台服务类（继承 `PlatformServiceBase`）
2. 实现 `get_transactions()` 方法
3. 在 `PlatformServiceFactory` 中注册
4. 使用 `UnifiedTransactionService` 进行数据入库

所有平台都自动支持：
- 统一状态映射
- 自动去重
- 拒付详情存储
- 4个核心指标计算

