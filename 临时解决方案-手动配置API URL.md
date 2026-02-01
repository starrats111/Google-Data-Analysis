# 临时解决方案：手动在备注中配置 API URL

如果前端字段仍然没有显示，你可以直接在"备注"字段中手动配置 API URL。

## 配置方法

1. 打开"编辑账号"对话框
2. 在"备注"字段中，输入以下 JSON 格式的配置：

```json
{
  "api_token": "你的API Token",
  "rewardoo_api_url": "https://api.rewardoo.com/api"
}
```

## 示例

如果你的备注字段当前是：
```json
{"api_token": "41df7906743fceacaa16ca25abfa1ce4"}
```

修改为：
```json
{
  "api_token": "41df7906743fceacaa16ca25abfa1ce4",
  "rewardoo_api_url": "https://api.rewardoo.com/api"
}
```

或者如果该渠道使用不同的 API 地址：
```json
{
  "api_token": "41df7906743fceacaa16ca25abfa1ce4",
  "rewardoo_api_url": "https://api-channel1.rewardoo.com/api"
}
```

## 支持的字段名

后端支持以下字段名（按优先级）：
- `rewardoo_api_url`（推荐）
- `rw_api_url`
- `api_url`
- `rewardoo_base_url`
- `rw_base_url`

## 注意事项

1. JSON 格式必须正确（使用双引号）
2. 确保没有语法错误
3. 保存后，同步时会自动使用配置的 API URL


