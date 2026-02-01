# 平台API配置文档

本文档提供所有支持的联盟平台的API配置说明。

## 目录
- [Rewardoo (RW)](#rewardoo-rw)
- [CollabGlow (CG)](#collabglow-cg)
- [LinkHaitao (LH)](#linkhaitao-lh)

---

## Rewardoo (RW)

### 平台说明
Rewardoo是一个联盟营销平台，支持多个渠道，每个渠道可能有不同的API端点。

### API配置

#### 默认配置
- **API基础URL**: `https://api.rewardoo.com/api`
- **TransactionDetails API**: `https://api.rewardoo.com/api/transaction_details`
- **CommissionDetails API**: `https://api.rewardoo.com/api/commission_details`

#### 多渠道支持
如果Rewardoo有多个渠道，每个渠道可能有不同的API地址：

**渠道1示例**:
```json
{
  "api_token": "your_token_here",
  "rewardoo_api_url": "https://api-channel1.rewardoo.com/api"
}
```

**渠道2示例**:
```json
{
  "api_token": "your_token_here",
  "rewardoo_api_url": "https://api-channel2.rewardoo.com/api"
}
```

#### 如何获取API配置
1. 登录Rewardoo平台后台
2. 进入"API设置"或"开发者设置"
3. 查看API文档，确认：
   - API基础URL
   - TransactionDetails API端点
   - 你的API Token

#### 常见问题
- **404错误**: API端点不存在，请检查API URL是否正确
- **401错误**: Token无效或已过期
- **超时**: 网络问题或API服务器响应慢

---

## CollabGlow (CG)

### 平台说明
CollabGlow是一个联盟营销平台，提供多个API端点用于不同的数据获取需求。

### API配置

#### 默认配置
- **API基础URL**: `https://api.collabglow.com/api`
- **Transaction API V3**: `https://api.collabglow.com/api/transaction/v3` (推荐，核心API)
- **Transaction API**: `https://api.collabglow.com/api/transaction`
- **Commission Validation API**: `https://api.collabglow.com/api/commission_validation`
- **Commission Details API**: `https://api.collabglow.com/api/commission_details`
- **Payment Summary API**: `https://api.collabglow.com/api/payment_summary`

#### API端点说明

1. **Transaction API V3** (推荐)
   - 用途: 获取订单数和佣金金额（核心API）
   - 超时设置: 60秒
   - 重试机制: 自动重试3次

2. **Commission Validation API**
   - 用途: 验证佣金是否有效、是否通过（仅状态）
   - 超时设置: 60秒
   - 重试机制: 自动重试3次

3. **Commission Details API**
   - 用途: 获取单笔订单佣金明细（拆到SKU/action）
   - 超时设置: 60秒

4. **Payment Summary API**
   - 用途: 汇总到账金额（付款数据）
   - 超时设置: 60秒

#### 如何获取API配置
1. 登录CollabGlow平台后台
2. 进入"API设置"或"开发者中心"
3. 查看API文档，确认：
   - API基础URL
   - 你的API Token
   - 各API端点的具体路径

#### 常见问题
- **超时错误**: API响应时间超过60秒，系统会自动重试3次
- **401错误**: Token无效或已过期
- **网络错误**: 检查网络连接或联系CollabGlow技术支持

---

## LinkHaitao (LH)

### 平台说明
LinkHaitao是一个联盟营销平台。

### API配置

#### 默认配置
- **API基础URL**: `https://www.linkhaitao.com`
- **Performance API**: `https://www.linkhaitao.com/api2.php?c=report&a=performance`
- **Transaction Detail API**: `https://www.linkhaitao.com/api2.php?c=report&a=transactionDetail`

#### 如何获取API配置
1. 登录LinkHaitao平台后台
2. 进入"API设置"
3. 查看API文档，确认：
   - API基础URL
   - 你的API Token或密钥

#### 常见问题
- **401错误**: Token无效或已过期
- **网络错误**: 检查网络连接

---

## 通用配置方法

### 方法1: 在账号备注中配置（推荐）

编辑账号，在"备注"字段中添加JSON配置：

```json
{
  "api_token": "your_token_here",
  "rewardoo_api_url": "https://api.rewardoo.com/api",
  "collabglow_api_url": "https://api.collabglow.com/api"
}
```

### 方法2: 在同步对话框中配置

在同步数据时，直接在对话框中输入：
- API Token
- API URL（如果平台支持多渠道）

### 支持的配置字段

#### Rewardoo
- `rewardoo_token` 或 `rw_token` 或 `api_token`: API Token
- `rewardoo_api_url` 或 `rw_api_url` 或 `api_url`: API基础URL

#### CollabGlow
- `collabglow_token` 或 `cg_token` 或 `api_token`: API Token
- `collabglow_api_url` 或 `cg_api_url`: API基础URL（如果支持）

#### LinkHaitao
- `linkhaitao_token` 或 `lh_token` 或 `api_token`: API Token

---

## 测试API连接

### 使用"测试连接"功能
1. 打开同步数据对话框
2. 输入API Token和API URL（如果需要）
3. 点击"测试连接"按钮
4. 查看测试结果

### 手动测试（使用curl）

#### Rewardoo
```bash
curl -X POST https://api.rewardoo.com/api/transaction_details \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "token": "YOUR_TOKEN",
    "begin_date": "2026-01-01",
    "end_date": "2026-01-31"
  }'
```

#### CollabGlow
```bash
curl -X POST https://api.collabglow.com/api/transaction/v3 \
  -H "Content-Type: application/json" \
  -d '{
    "source": "collabglow",
    "token": "YOUR_TOKEN",
    "beginDate": "2026-01-01",
    "endDate": "2026-01-31"
  }'
```

---

## 错误代码说明

| 错误代码 | 说明 | 解决方法 |
|---------|------|---------|
| 404 | API端点不存在 | 检查API URL是否正确，确认端点路径 |
| 401 | 未授权 | 检查Token是否正确，是否已过期 |
| 403 | 禁止访问 | 检查Token权限，联系平台技术支持 |
| 500 | 服务器错误 | 联系平台技术支持 |
| 超时 | 请求超时 | 系统会自动重试，如果持续失败，检查网络或联系技术支持 |

---

## 获取帮助

如果遇到问题：
1. 查看本文档的"常见问题"部分
2. 检查API配置是否正确
3. 使用"测试连接"功能验证配置
4. 查看后端日志获取详细错误信息
5. 联系平台技术支持获取最新的API文档

---

## 更新日志

- 2026-01-31: 初始版本，包含Rewardoo、CollabGlow、LinkHaitao配置说明




