# Rewardoo API配置问题解决方案

## 问题描述

在同步Rewardoo平台数据时，出现以下错误：
```
同步失败: [RW TransactionDetails API] API端点不存在(404)。当前使用的API URL: 未配置
```

## 问题原因分析

### 根本原因
1. **配置合并问题**：当账号备注中配置了空的`rewardoo_api_url`（空字符串`""`）时，会覆盖默认的API配置
2. **空字符串处理**：空字符串`""`在Python中是falsy值，但在某些情况下可能没有被正确处理
3. **错误消息不准确**：当base_url未配置时，错误消息显示"未配置"，但没有显示实际使用的默认API URL

### 问题流程
1. 用户在账号备注中配置了`{"rewardoo_api_url": ""}`（空字符串）
2. `ApiConfigService.get_account_api_config()`合并配置时，空字符串覆盖了默认配置
3. `RewardooService`接收到空字符串作为base_url
4. 虽然`base_url or BASE_URL`应该能处理，但在某些边界情况下可能失效
5. 最终导致API URL不正确，返回404错误

## 解决方案

### 修复内容

#### 1. 配置合并优化 (`api_config_service.py`)
```python
# 合并配置（自定义配置覆盖默认配置）
# 但是，如果custom_config中的base_url是空字符串或None，应该使用默认值
merged_config = {**default_config, **custom_config}

# 如果合并后的base_url是空字符串或None，使用默认值
if not merged_config.get("base_url") and default_config.get("base_url"):
    merged_config["base_url"] = default_config["base_url"]
```

#### 2. 平台数据同步优化 (`platform_data_sync.py`)
```python
api_base_url = api_config.get("base_url")

# 如果base_url是空字符串，转换为None，让RewardooService使用默认值
if api_base_url == "":
    api_base_url = None
```

#### 3. Rewardoo服务优化 (`rewardoo_service.py`)
```python
# 如果base_url是None或空字符串，使用默认值
self.base_url = (base_url.strip() if base_url and base_url.strip() else None) or BASE_URL
```

#### 4. 错误消息优化 (`api_config_service.py`)
```python
# 如果base_url是空字符串或None，显示默认配置或"未配置"
if not current_base_url:
    # 尝试获取默认配置
    platform_code = account.platform.platform_code if account.platform else None
    default_config = ApiConfigService.get_platform_config(platform_code)
    current_base_url = default_config.get("base_url", "未配置")
```

## 使用方法

### 方法1：使用默认API URL（推荐）
如果Rewardoo账号使用默认的API地址，**不需要**在账号备注中配置API URL，系统会自动使用默认配置：
```
https://api.rewardoo.com/api
```

### 方法2：配置自定义API URL
如果Rewardoo有多个渠道，需要在账号备注中配置正确的API URL：

1. 打开"平台账号"页面
2. 点击账号的"编辑"按钮
3. 在"备注"字段中输入JSON配置：
```json
{
  "rewardoo_api_url": "https://正确的API地址/api",
  "rewardoo_token": "your_token_here"
}
```

或者使用简写：
```json
{
  "rw_api_url": "https://正确的API地址/api",
  "rw_token": "your_token_here"
}
```

### 方法3：在同步对话框中配置
1. 点击"同步数据"按钮
2. 在"API Token"字段输入Token
3. 系统会自动使用默认API URL或账号备注中配置的URL

## 验证修复

### 检查配置
```bash
# 查看日志，确认使用的API URL
tail -f ~/Google-Data-Analysis/backend/logs/app.log | grep "RW同步"
```

应该看到类似以下日志：
```
[RW同步] 使用默认API配置
[RW Service] 初始化，base_url=https://api.rewardoo.com/api, transaction_api=https://api.rewardoo.com/api/transaction_details
```

### 测试同步
1. 在"平台账号"页面选择Rewardoo账号
2. 点击"同步数据"
3. 选择日期范围
4. 输入API Token
5. 点击"开始同步"

如果仍然出现404错误，请检查：
1. API Token是否正确
2. 日期范围内是否有数据
3. 是否需要配置自定义API URL

## 相关文件

- `backend/app/services/api_config_service.py` - API配置管理
- `backend/app/services/platform_data_sync.py` - 平台数据同步
- `backend/app/services/rewardoo_service.py` - Rewardoo API服务
- `backend/app/services/collabglow_service.py` - CollabGlow服务（已同步修复）

## 注意事项

1. **不要配置空的API URL**：如果不需要自定义API URL，不要在账号备注中配置`rewardoo_api_url`字段，或确保值不为空字符串
2. **默认配置**：Rewardoo的默认API URL是`https://api.rewardoo.com/api`，如果这个地址不正确，需要在账号备注中配置正确的地址
3. **多渠道支持**：如果Rewardoo有多个渠道（如不同地区的API），每个账号可以配置不同的API URL

## 后续优化建议

1. 在前端添加API URL配置字段，避免用户手动编辑JSON
2. 添加API URL验证功能，在配置时检查URL是否可访问
3. 添加API端点自动检测功能，自动尝试不同的API端点

