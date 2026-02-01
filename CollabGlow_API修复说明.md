# CollabGlow Transaction API 修复说明

## 问题分析

根据您提供的 CollabGlow Transaction API 文档，发现了以下问题：

1. **API端点错误**：代码默认使用 `/transaction/v3`，但API文档显示正确端点是 `/transaction`
2. **字段名不匹配**：API返回的是camelCase格式（如 `orderTime`, `saleAmount`, `saleComm`），但代码没有正确处理这些字段
3. **错误码处理**：需要更好地处理API返回的错误码（1000, 1001, 1002, 1006, 10001）

## 已修复的问题

### 1. 修改默认API端点
- **文件**：`backend/app/services/collabglow_service.py`
- **修改**：将 `get_transactions()` 和 `sync_transactions()` 方法的默认参数从 `use_v3=True` 改为 `use_v3=False`
- **影响**：现在默认使用 `/transaction` 端点，符合API文档

### 2. 增强字段解析
- **文件**：`backend/app/services/collabglow_service.py`
- **修改**：更新 `extract_transaction_data()` 方法，支持camelCase和snake_case两种格式
- **支持的字段**：
  - `collabgrowId` / `collabgrow_id` → `transaction_id`
  - `orderTime` (timestamp) → `transaction_time` (转换为日期字符串)
  - `saleAmount` / `sale_amount` → `order_amount`
  - `saleComm` / `sale_comm` → `commission_amount`
  - `merchantName` / `merchant_name` → `merchant`
  - `orderId` / `order_id` → `order_id`
  - `settlementDate` / `settlement_date` → `settlement_date`

### 3. 改进错误处理
- **文件**：`backend/app/services/collabglow_service.py`
- **修改**：增强错误码处理，支持字符串和整数格式，并提供友好的错误信息
- **错误码映射**：
  - 1000: Publisher does not exist (发布者不存在)
  - 1001: Invalid token (Token无效)
  - 1002: Call frequency too high (调用频率过高)
  - 1006: Query time span cannot exceed 62 days (查询时间跨度不能超过62天)
  - 10001: Missing required parameters or incorrect format (缺少必需参数或格式错误)

### 4. 更新API端点检测优先级
- **文件**：`backend/app/services/api_endpoint_detector.py`
- **修改**：将 `/transaction` 放在 `/transaction/v3` 之前，优先尝试标准端点

### 5. 增强日志记录
- **文件**：`backend/app/services/collabglow_service.py`
- **修改**：添加更详细的日志，包括API URL和请求Payload，便于调试

## 测试建议

1. **测试连接**：
   - 在平台账号同步对话框中点击"测试连接"
   - 确认能够成功连接并获取数据

2. **检查Token**：
   - 确认Token正确：`916a0dbbfe6c3e7fb19fb5ee119b82a2`
   - 确认Token在CollabGlow平台后台有效

3. **检查日期范围**：
   - API文档说明：数据查询仅支持从2023/1/1开始的日期
   - 确保选择的日期范围在有效范围内

4. **检查API响应**：
   - 查看后端日志，确认API返回的数据格式
   - 如果返回0条记录，检查：
     - Token是否正确
     - 该日期范围内是否有数据
     - 在CollabGlow平台手动检查该日期范围

## 如果仍然无法获取数据

1. **检查后端日志**：
   - 查看 `backend/logs/` 目录下的日志文件
   - 查找 `[Transaction API]` 相关的日志信息

2. **手动测试API**：
   使用curl命令测试API：
   ```bash
   curl --location --request POST 'https://api.collabglow.com/api/transaction' \
   --header 'Content-Type: application/json' \
   --data-raw '{
     "source": "collabglow",
     "token": "916a0dbbfe6c3e7fb19fb5ee119b82a2",
     "beginDate": "2025-06-01",
     "endDate": "2025-06-05",
     "curPage": 1,
     "perPage": 20
   }'
   ```

3. **检查网络连接**：
   - 确认服务器能够访问 `https://api.collabglow.com`
   - 检查是否有防火墙或代理限制

4. **联系CollabGlow技术支持**：
   - 如果Token和日期范围都正确，但API返回错误，可能需要联系CollabGlow技术支持

## 其他平台

如果其他平台也有类似问题，请检查：
1. API端点是否正确
2. 字段名是否匹配（camelCase vs snake_case）
3. 错误处理是否完善
4. Token和日期范围是否正确

