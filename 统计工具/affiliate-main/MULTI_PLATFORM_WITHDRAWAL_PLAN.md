# 多平台提现管理实施方案

## 当前状况

### ✅ 已支持平台：PartnerMatic (3个账号)
- **API 支持**：
  - Transaction V3 API：获取订单状态、settlement_date、paid_date
  - Payment Summary API：获取提现历史记录
- **数据完整性**：100%
- **可提现金额**：$4,906.38

### ❌ 待支持平台

#### 1. LinkHaitao (2个账号)
- **账号**：dhdir, infosphere
- **订单数量**：3,108 条
- **总佣金**：$21,844.70
- **问题**：
  - ❌ 订单数据中没有 settlement_date 和 paid_date
  - ❌ API 中未发现提现相关接口
- **可用 API**：
  - `api2.php?c=report&a=performance` - 佣金汇总数据
  - `api2.php?c=report&a=transactionDetail` - 订单详情

#### 2. LinkBux (2个账号)
- **账号**：dailypulse, mariettejama
- **订单数量**：6,541 条
- **总佣金**：$30,846.84
- **问题**：同 LinkHaitao

#### 3. Rewardoo (2个账号)
- **账号**：muddlarrymqwjs@gmail.com, jayetinsley681991lvk@gmail.com
- **订单数量**：937 条
- **总佣金**：$3,896.71
- **问题**：同 LinkHaitao

---

## 解决方案

### 方案 A：API 调研 + 数据补全（推荐）

#### 步骤 1：调研各平台 API
为每个平台调研是否有提现相关的 API：

**LinkHaitao**：
- [ ] 查看官方 API 文档
- [ ] 测试是否有 payment/withdrawal 相关接口
- [ ] 检查 transactionDetail API 返回的字段是否包含结算信息

**LinkBux**：
- [ ] 查看官方 API 文档
- [ ] 测试可用的 API 端点

**Rewardoo**：
- [ ] 查看官方 API 文档
- [ ] 测试可用的 API 端点

#### 步骤 2：数据字段映射
根据各平台的 API 响应，映射到统一的数据模型：

```javascript
// 统一的订单数据模型
{
  order_id: string,
  status: 'Pending' | 'Approved' | 'Rejected',
  commission: number,
  settlement_date: string | null,  // 结算日期
  paid_date: string | null,        // 支付日期
  settlement_id: string | null,    // 结算批次ID
  payment_id: string | null        // 支付ID
}
```

#### 步骤 3：创建同步脚本
为每个平台创建类似 `sync-living001-orders.js` 的同步脚本：
- `sync-linkhaitao-orders.js`
- `sync-linkbux-orders.js`
- `sync-rewardoo-orders.js`

#### 步骤 4：修改后端 API
修改 `server-v2.js` 中的提现管理 API，支持多平台：

```javascript
// 根据平台类型调用不同的 API
if (account.platform === 'partnermatic') {
  // 使用 Payment Summary API
} else if (account.platform === 'linkhaitao') {
  // 使用 LinkHaitao 的提现 API（如果有）
} else if (account.platform === 'linkbux') {
  // 使用 LinkBux 的提现 API（如果有）
} else if (account.platform === 'rewardoo') {
  // 使用 Rewardoo 的提现 API（如果有）
}
```

---

### 方案 B：手动数据管理（临时方案）

如果某些平台没有提现相关的 API，可以采用手动管理方式：

#### 1. 创建提现记录管理界面
在超级管理员后台添加"手动添加提现记录"功能：
- 选择账号
- 输入提现日期
- 输入提现金额
- 上传提现凭证（可选）

#### 2. 数据库设计
使用现有的 `withdrawal_history` 表：
```sql
CREATE TABLE withdrawal_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform_account_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  request_date TEXT,
  paid_date TEXT,
  payment_id TEXT,
  status TEXT DEFAULT 'Paid',
  payment_type TEXT DEFAULT 'Manual',
  notes TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

#### 3. 可提现金额计算
对于没有 API 的平台，可提现金额 = 数据库中的 Approved 订单总额 - 已手动记录的提现总额

---

### 方案 C：混合方案（最灵活）

结合方案 A 和 B：
- 有 API 的平台：自动同步
- 无 API 的平台：手动管理
- 前端统一展示

---

## 实施优先级

### 第一阶段：调研（1-2天）
1. 调研 LinkHaitao API 文档
2. 调研 LinkBux API 文档
3. 调研 Rewardoo API 文档
4. 确定每个平台的技术方案

### 第二阶段：开发（3-5天）
1. 为有 API 的平台开发同步脚本
2. 为无 API 的平台开发手动管理界面
3. 修改后端 API 支持多平台
4. 前端适配多平台展示

### 第三阶段：测试（1-2天）
1. 测试各平台数据同步
2. 测试提现管理功能
3. 验证数据准确性

---

## 下一步行动

### 立即可做：
1. **测试 LinkHaitao transactionDetail API**
   - 查看返回的订单详情中是否包含结算/支付信息
   - 如果有，可以用来补全 settlement_date 和 paid_date

2. **查看平台后台**
   - 登录各平台后台，查看是否有提现记录页面
   - 记录提现记录的数据结构

3. **联系平台技术支持**
   - 询问是否有提现相关的 API
   - 获取 API 文档

### 需要你的决策：
1. 是否需要立即支持所有平台？还是先完善 PartnerMatic？
2. 对于没有 API 的平台，是否接受手动管理方式？
3. 是否有各平台的 API 文档或技术支持联系方式？

---

## 技术债务

如果采用手动管理方式，需要注意：
- 数据一致性：手动录入可能出错
- 维护成本：每次提现都需要手动操作
- 可扩展性：账号增多后工作量增大

建议：优先调研 API 支持情况，尽量实现自动化。
