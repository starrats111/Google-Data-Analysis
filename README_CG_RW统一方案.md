# CG（CollabGlow）+ RW（Rewardoo）统一方案

## 一、总体结论

**两个平台都遵循同一套数据模型：**

- **订单 & 拒付判断 → Transaction 级 API**
- **拒付原因 / 佣金拆分 → Commission 级 API**
- **对账 → Summary / Payment API（仅核对，不参与分析）**

## 二、6个核心指标

系统每天稳定产出6个核心指标，且不重算、不漏算、不被拒付误导：

1. **总订单数** - `COUNT(transaction_id)`
2. **已确认订单数** - `COUNT(transaction_id) WHERE status = 'approved'`
3. **总佣金（已确认）** - `SUM(commission_amount) WHERE status = 'approved'`
4. **拒付订单数** - `COUNT(transaction_id) WHERE status IN ('rejected','declined','reversed')`
5. **拒付佣金** - `SUM(commission_amount) WHERE status IN ('rejected','declined','reversed')`
6. **拒付率** - `拒付订单数 / 总订单数`

## 三、平台API对照

### CG（CollabGlow）平台

| 目的 | CG API |
|------|--------|
| 订单 / 佣金 / 拒付 | **Transaction API / Transaction API V3** |
| 拒付原因 | **Commission Details API** |
| 月度对账 | Payment / Summary API |

**字段映射：**
- `transaction_id` → `action_id` / `transaction_id`
- `order_amount` → `sale_amount`
- `commission_amount` → `commission`
- `status` → `approved` / `locked` / `reversed`（reversed = 拒付）

### RW（Rewardoo）平台

| 目的 | RW API |
|------|--------|
| 订单 / 佣金 / 拒付 | **TransactionDetails API**（核心） |
| 拒付原因 | **CommissionDetails API**（辅助） |
| 月度对账 | Payment / Summary API |

**必须用到的字段：**
- `transaction_id` - 交易ID（用于去重）
- `transaction_time` - 交易时间
- `merchant` - 商户
- `order_amount` - 订单金额
- `commission_amount` - 佣金金额
- `status` - 状态（关键：approved, rejected, declined）

## 四、统一状态映射

| 统一状态 | RW | CG |
|---------|----|----|
| approved | approved | approved / locked |
| pending | pending | pending |
| rejected | rejected / declined | reversed |

## 五、统一数据模型

数据库表 `platform_data` 存储以下字段：

```sql
-- 核心指标1-3：订单和佣金
orders              INTEGER  -- 总订单数
approved_orders      INTEGER  -- 已确认订单数
commission           REAL     -- 总佣金（已确认）

-- 核心指标4-5：拒付数据
rejected_orders      INTEGER  -- 拒付订单数
rejected_commission  REAL     -- 拒付佣金

-- 核心指标6：拒付率（计算字段，不存储）
-- rejected_rate = rejected_orders / orders

-- 辅助字段
order_amount         REAL     -- 订单总金额（用于对账）
order_details        TEXT     -- 订单详情JSON（包含transaction_id用于去重）
```

## 六、关键防坑规则

### ❌ 错误做法

- 用 CommissionSummary 算拒付
- 用佣金 = 0 判断拒付
- 每天全量拉，不做去重
- 用 Payment / Summary API 算拒付（那是财务口径，不是广告口径）

### ✅ 正确做法

- **永远用 status 字段判断拒付**
- **transaction_id 做唯一键去重**
- **按 transaction_time 增量拉取**
- **使用 Transaction 级 API 进行统计**

## 七、使用方法

### 1. 数据库迁移

首先运行迁移脚本添加新字段：

```bash
cd backend
python scripts/add_rejected_fields_to_platform_data.py
```

### 2. 同步数据

#### CollabGlow平台

1. 进入"平台账号"页面
2. 选择CollabGlow账号
3. 点击"同步数据"
4. 选择日期范围
5. 输入API Token（或使用账号备注中配置的token）
6. 点击"开始同步"

系统会自动：
- 优先使用 Transaction API（核心API）
- 如果失败，回退到 Commission Validation API
- 使用统一服务计算6个核心指标
- 按日期聚合并保存到数据库

#### Rewardoo平台

1. 进入"平台账号"页面
2. 选择Rewardoo账号
3. 点击"同步数据"
4. 选择日期范围
5. 输入API Token（或使用账号备注中配置的token）
6. 点击"开始同步"

系统会自动：
- 使用 TransactionDetails API（核心API）
- 使用统一服务计算6个核心指标
- 按日期聚合并保存到数据库

### 3. 查看数据

同步完成后，可以在以下页面查看6个核心指标：

- **平台每日数据** - 查看每日的订单数、佣金、拒付数据
- **我的收益** - 查看汇总的收益数据（包含拒付信息）

## 八、代码结构

### 核心服务

1. **UnifiedPlatformService** (`backend/app/services/unified_platform_service.py`)
   - 统一状态映射
   - 6个核心指标计算
   - 按日期聚合数据

2. **CollabGlowService** (`backend/app/services/collabglow_service.py`)
   - Transaction API（核心）
   - Commission Details API（辅助）
   - Commission Validation API（状态验证）

3. **RewardooService** (`backend/app/services/rewardoo_service.py`)
   - TransactionDetails API（核心）
   - CommissionDetails API（辅助）

4. **PlatformDataSyncService** (`backend/app/services/platform_data_sync.py`)
   - 统一的数据同步逻辑
   - 支持CG和RW平台
   - 自动使用统一服务计算指标

### 数据模型

- **PlatformData** (`backend/app/models/platform_data.py`)
  - 包含6个核心指标字段
  - 支持拒付数据存储

## 九、扩展其他平台

如果需要在其他平台（如CJ、Impact、Partnerize）使用此方案：

1. 创建平台服务类（参考 `RewardooService`）
2. 实现 Transaction 级 API 方法
3. 在 `PlatformDataSyncService` 中添加平台识别逻辑
4. 使用 `UnifiedPlatformService` 计算指标

所有平台都遵循统一的数据模型和状态映射，确保数据一致性。

## 十、注意事项

1. **API端点配置**：根据实际API文档调整 `RewardooService` 和 `CollabGlowService` 中的API端点URL

2. **Token配置**：可以在账号编辑页面的"备注"字段中配置API Token，格式：
   ```json
   {
     "collabglow_token": "your_token",
     "rewardoo_token": "your_token",
     "api_token": "通用token"
   }
   ```

3. **日期范围**：单次查询最大62天，系统会自动分段查询

4. **去重机制**：使用 `transaction_id` 作为唯一键，确保不重算

5. **状态判断**：永远使用 `status` 字段判断拒付，不要用佣金金额是否为0

