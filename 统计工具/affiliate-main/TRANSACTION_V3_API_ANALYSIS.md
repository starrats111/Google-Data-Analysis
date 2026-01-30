# PartnerMatic Transaction V3 API 分析报告

## API 基本信息

- **端点**: `https://api.partnermatic.com/api/transaction_v3`
- **方法**: POST
- **认证**: 使用 `token` (api_token)

## 请求参数

```json
{
  "source": "partnermatic",
  "token": "你的API Token",
  "beginDate": "2026-01-16",
  "endDate": "2026-01-23",
  "curPage": 1,
  "perPage": 50
}
```

### 参数说明

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| source | string | 是 | 固定值 "partnermatic" |
| token | string | 是 | API Token (从数据库获取) |
| beginDate | string | 是 | 开始日期 (YYYY-MM-DD) |
| endDate | string | 是 | 结束日期 (YYYY-MM-DD) |
| curPage | number | 是 | 当前页码 (从1开始) |
| perPage | number | 是 | 每页记录数 |

## 响应格式

### 成功响应

```json
{
  "code": "0",
  "message": "success",
  "data": {
    "total": 25,
    "curPage": 1,
    "totalPage": 1,
    "hasNext": false,
    "list": [
      {
        "oid": "订单唯一ID",
        "mid": "商家ID",
        "mcid": "商家代码",
        "merchant_name": "商家名称",
        "offer_type": "CPS",
        "order_id": "订单号",
        "ori_order_time": 1768444329,
        "order_time": "2026-01-15 10:32:09",
        "uid": "用户ID",
        "click_ref": "点击引用",
        "items": [
          {
            "partnermatic_id": "PM内部ID",
            "skuid": "SKU ID",
            "sale_amount": "1199.99",
            "sale_comm": "38.4",
            "status": "Pending",
            "prod_id": "产品ID",
            "order_unit": "1",
            "comm_rate": "40.001",
            "validation_date": "",
            "note": "",
            "payment_id": "0",
            "settlement_id": "",
            "settlement_date": "",
            "paid_date": ""
          }
        ]
      }
    ]
  }
}
```

## 数据结构详解

### 订单级别字段

| 字段 | 类型 | 说明 |
|------|------|------|
| oid | string | 订单唯一标识符 |
| mid | string | 商家ID |
| mcid | string | 商家代码 |
| merchant_name | string | 商家名称 |
| offer_type | string | 优惠类型 (如 "CPS") |
| order_id | string | 订单号 |
| ori_order_time | number | 原始订单时间戳 |
| order_time | string | 订单时间 (格式化) |
| uid | string | 用户ID |
| click_ref | string | 点击引用 |
| items | array | 订单项目列表 |

### 订单项目字段 (items)

| 字段 | 类型 | 说明 |
|------|------|------|
| partnermatic_id | string | PartnerMatic内部ID |
| skuid | string | SKU唯一标识 |
| sale_amount | string | 销售金额 |
| sale_comm | string | 佣金金额 |
| status | string | 状态 (Pending/Approved/Rejected) |
| prod_id | string | 产品ID |
| order_unit | string | 订单数量 |
| comm_rate | string | 佣金比例 |
| validation_date | string | 验证日期 |
| note | string | 备注 |
| payment_id | string | 支付ID (0表示未支付) |
| settlement_id | string | 结算ID |
| settlement_date | string | 结算日期 |
| paid_date | string | 支付日期 |

## 与原始 Transaction API 的对比

### Transaction API (原始)
- 端点: `/api/transaction`
- 参数: 使用 `dataScope: 'user'`
- 数据结构: 类似但可能有细微差异

### Transaction V3 API (新版)
- 端点: `/api/transaction_v3`
- 参数: 不需要 `dataScope`
- 数据结构: 更详细的订单项目信息
- 优势: 
  - 提供更详细的订单项目信息
  - 包含 `settlement_id` 和 `settlement_date` 字段
  - 更清晰的分页信息 (`hasNext`)

## 测试结果

### 测试1: 最近7天 (2026-01-16 至 2026-01-23)
- ✅ 成功返回 25 条订单记录
- 总佣金: 约 $500+
- 主要商家: Fanatec, Vooglam, Sanatoriums

### 测试2: 最近30天 (2025-12-24 至 2026-01-23)
- ✅ 成功返回数据
- 包含更多历史订单

### 测试3: 2024年12月 (2024-12-01 至 2024-12-31)
- ✅ API调用成功
- 返回 0 条记录 (该时间段无数据)

## 使用建议

1. **优先使用 Transaction V3 API**
   - 数据更详细
   - 包含结算信息
   - 更好的分页支持

2. **日期范围建议**
   - 建议每次查询不超过 90 天
   - 使用分页获取大量数据

3. **状态字段**
   - `Pending`: 待验证
   - `Approved`: 已批准
   - `Rejected`: 已拒绝

4. **佣金计算**
   - 使用 `sale_comm` 字段作为佣金金额
   - `comm_rate` 是佣金比例 (百分比 * 1000)

## 集成到系统

### 建议的数据采集流程

1. 使用 Transaction V3 API 获取订单数据
2. 按 `oid` 去重 (订单唯一ID)
3. 遍历 `items` 数组处理每个订单项
4. 根据 `status` 字段判断订单状态
5. 使用 `payment_id` 判断是否已支付
6. 使用 `settlement_date` 和 `paid_date` 追踪结算状态

### 数据库映射

```javascript
// 订单表
{
  order_id: item.oid,
  merchant_name: order.merchant_name,
  order_time: order.order_time,
  sale_amount: item.sale_amount,
  commission: item.sale_comm,
  status: item.status,
  payment_id: item.payment_id,
  settlement_date: item.settlement_date,
  paid_date: item.paid_date
}
```

## 示例代码

```javascript
const axios = require('axios');

async function fetchTransactionV3(token, startDate, endDate, page = 1, perPage = 50) {
  const response = await axios.post(
    'https://api.partnermatic.com/api/transaction_v3',
    {
      source: 'partnermatic',
      token: token,
      beginDate: startDate,
      endDate: endDate,
      curPage: page,
      perPage: perPage
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 30000
    }
  );

  if (response.data.code === '0') {
    return response.data.data;
  } else {
    throw new Error(`API Error: ${response.data.message}`);
  }
}

// 使用示例
const data = await fetchTransactionV3(
  'your_token_here',
  '2026-01-01',
  '2026-01-31',
  1,
  50
);

console.log(`总记录数: ${data.total}`);
console.log(`当前页: ${data.curPage}/${data.totalPage}`);
console.log(`订单数: ${data.list.length}`);
```

## 注意事项

1. **认证**: 必须使用有效的 API Token
2. **日期格式**: 必须使用 YYYY-MM-DD 格式
3. **分页**: 从第 1 页开始，不是第 0 页
4. **错误处理**: code 为 "0" 表示成功，其他值表示错误
5. **订单项目**: 一个订单可能包含多个 items，需要分别处理

## 下一步

1. 更新 `server-v2.js` 中的数据采集逻辑，使用 Transaction V3 API
2. 添加对 `settlement_date` 和 `paid_date` 的支持
3. 优化分页逻辑，使用 `hasNext` 字段判断是否有下一页
4. 添加错误重试机制
