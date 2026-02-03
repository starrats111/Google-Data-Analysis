# [平台名称] API 文档模板

复制此文件并重命名为对应的平台名称，然后填写具体内容。

## 基本信息
- 平台代码: `[如: rw, cg, lh, pb, lb, pm, bsh, cf]`
- 平台全称: `[平台完整名称]`
- API 版本: `[版本号，如果有]`
- 文档日期: `[最后更新日期]`

## 认证方式

### Token 传递方式
- [ ] 通过 URL 参数传递（如: `?token=xxx`）
- [ ] 通过请求头传递（如: `Authorization: Bearer xxx`）
- [ ] 通过请求体传递（如: POST body 中的 `token` 字段）

### Token 获取方式
[说明如何获取 Token，例如：在平台后台的 API 设置页面获取]

## API 端点

### 1. 订单/佣金查询 API

**端点信息：**
- URL: `[完整的 API URL]`
- 方法: `[GET/POST]`
- 描述: `[API 的用途说明]`

**请求参数：**
| 参数名 | 类型 | 必需 | 说明 | 示例 |
|--------|------|------|------|------|
| begin_date | string | 是 | 开始日期 | 2026-01-01 |
| end_date | string | 是 | 结束日期 | 2026-01-31 |
| token | string | 是 | API Token | xxx |
| page | int | 否 | 页码（如果支持分页） | 1 |
| limit | int | 否 | 每页数量 | 100 |
| status | string | 否 | 订单状态筛选 | all/pending/approved/rejected |

**请求示例：**
```bash
curl -X GET "https://api.example.com/orders?begin_date=2026-01-01&end_date=2026-01-31&token=xxx"
```

**响应格式：**

成功响应（200）：
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "orders": [
      {
        "order_id": "12345",
        "transaction_id": "TXN-12345",
        "commission": 10.50,
        "commission_amount": 10.50,
        "cashback": 10.50,
        "amount": 100.00,
        "order_amount": 100.00,
        "sale_amount": 100.00,
        "status": "approved",
        "date": "2026-01-01",
        "transaction_time": "2026-01-01 10:00:00",
        "merchant": "Merchant Name",
        "merchant_name": "Merchant Name",
        "mcid": "merchant_code"
      }
    ],
    "total": 100,
    "page": 1,
    "total_page": 10
  }
}
```

错误响应：
```json
{
  "code": 400,
  "message": "Invalid token",
  "data": null
}
```

## 字段映射说明

### 关键字段名称
| 系统字段 | API 字段名（可能的值） | 说明 |
|----------|----------------------|------|
| 订单ID | `order_id`, `transaction_id`, `id` | 订单唯一标识 |
| 佣金 | `commission`, `commission_amount`, `cashback`, `sale_comm` | 佣金金额 |
| 订单金额 | `amount`, `order_amount`, `sale_amount` | 订单总金额 |
| 状态 | `status` | 订单状态 |
| 日期 | `date`, `transaction_time`, `order_time` | 订单日期 |
| 商户 | `merchant`, `merchant_name`, `advertiser_name`, `mcid` | 商户名称 |

### 状态值说明
| API 状态值 | 系统映射 | 说明 |
|-----------|---------|------|
| `approved` | approved | 已确认/已付 |
| `pending` | pending | 待处理 |
| `rejected` | rejected | 拒付 |
| `expired` | rejected | 过期（计入拒付） |
| `effective` | approved | 有效（计入已付） |
| `untreated` | pending | 未处理 |

## 分页说明

- [ ] 支持分页
  - 分页参数: `[page, limit]` 或 `[offset, limit]`
  - 最大每页数量: `[如: 1000]`
  - 如何判断是否还有下一页: `[如: 返回 total_page 字段]`

- [ ] 不支持分页
  - 单次请求最大返回数量: `[如: 10000]`

## 日期范围限制

- 最大查询范围: `[如: 90天]`
- 日期格式: `YYYY-MM-DD` 或 `YYYY-MM-DD HH:MM:SS`
- 时区: `[如: UTC+8 北京时间]`

## 重复订单处理

- [ ] API 可能返回重复订单
  - 重复原因: `[如: 分页重叠、状态更新等]`
  - 处理方式: `[如: 按订单ID去重，佣金求和]`

- [ ] API 不会返回重复订单

## 特殊注意事项

1. **佣金计算方式**
   - [ ] 单个订单只有一个佣金值
   - [ ] 同一订单可能有多个佣金记录（需要求和）

2. **状态变化**
   - [ ] 订单状态会随时间变化（pending → approved/rejected）
   - [ ] 订单状态不会变化

3. **其他说明**
   - [任何其他需要注意的事项]

## 测试用例

### 测试 1: 查询单日数据
```
日期范围: 2026-01-01 到 2026-01-01
预期结果: 返回该日期的所有订单
```

### 测试 2: 查询多日数据
```
日期范围: 2026-01-01 到 2026-01-31
预期结果: 返回该范围内的所有订单
```

## 参考链接

- API 官方文档: `[如果有官方文档链接]`
- 平台后台: `[平台后台地址]`

