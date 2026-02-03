# API 文档目录

本目录用于存放各平台的 API 文档。

## 文件命名规范

- `rewardoo_api.md` - Rewardoo 平台 API 文档
- `collabglow_api.md` - CollabGlow 平台 API 文档
- `linkhaitao_api.md` - LinkHaitao 平台 API 文档
- `partnerboost_api.md` - PartnerBoost 平台 API 文档
- `linkbux_api.md` - LinkBux 平台 API 文档
- `partnermatic_api.md` - PartnerMatic 平台 API 文档
- `brandsparkhub_api.md` - BrandSparkHub 平台 API 文档
- `creatorflare_api.md` - CreatorFlare 平台 API 文档

## 文档格式

使用 Markdown 格式编写，包含以下内容：

1. **API 端点信息**
   - 基础 URL
   - 端点路径
   - 请求方法（GET/POST）

2. **认证方式**
   - Token 传递方式
   - API Key 位置

3. **请求参数**
   - 必需参数
   - 可选参数
   - 参数格式说明

4. **响应格式**
   - 成功响应示例
   - 错误响应示例

5. **字段说明**
   - 订单ID字段名
   - 佣金字段名
   - 状态字段名
   - 日期字段名

6. **特殊说明**
   - 分页方式
   - 日期范围限制
   - 重复订单处理

## 示例模板

可以参考以下模板创建新的 API 文档：

```markdown
# [平台名称] API 文档

## 基本信息
- 平台代码: [如: rw, cg, lh]
- API 版本: [版本号]

## 认证
- 方式: Token
- 传递位置: [请求头/URL参数/请求体]

## 端点

### 1. 订单/佣金查询 API
- URL: `https://api.example.com/orders`
- 方法: GET
- 参数:
  - begin_date: YYYY-MM-DD (必需)
  - end_date: YYYY-MM-DD (必需)
  - token: string (必需)
  - page: int (可选)
  - limit: int (可选)

## 响应格式

### 成功响应
```json
{
  "code": 200,
  "data": {
    "orders": [
      {
        "order_id": "12345",
        "commission": 10.50,
        "amount": 100.00,
        "status": "approved",
        "date": "2026-01-01"
      }
    ]
  }
}
```

### 字段说明
- `order_id`: 订单ID（唯一标识）
- `commission`: 佣金金额
- `amount`: 订单金额
- `status`: 订单状态（approved/pending/rejected）
- `date`: 订单日期

## 注意事项
- 分页方式: [说明如何分页]
- 日期范围: [最大范围限制]
- 重复订单: [是否会出现重复，如何处理]
```

