# MCC同步配置说明

## 配置要求

为了确保MCC同步功能正常工作，需要满足以下三个要求：

### 1. MCC账号状态为"激活"

**检查方法：**
- 运行脚本：`python scripts/setup_mcc_requirements.py`
- 或在系统中查看MCC账号管理页面，确保账号状态为"激活"

**自动修复：**
- 脚本会自动激活所有停用的MCC账号

### 2. 系统配置了Developer Token

**配置位置：**
- 文件：`backend/.env`
- 配置项：`GOOGLE_ADS_SHARED_DEVELOPER_TOKEN`

**配置步骤：**
1. 打开 `backend/.env` 文件
2. 找到 `GOOGLE_ADS_SHARED_DEVELOPER_TOKEN=` 这一行
3. 在等号后面填入你的Google Ads Developer Token
4. 保存文件
5. 重启后端服务

**获取Developer Token：**
- 登录 Google Ads API 控制台
- 申请或查看你的 Developer Token
- 注意：Developer Token 需要经过 Google 审核才能使用

**检查方法：**
```bash
cd backend
python scripts/setup_mcc_requirements.py
```

### 3. MCC ID格式正确（10位数字）

**格式要求：**
- MCC ID去掉横线后必须是10位数字
- 例如：`123-456-7890` 或 `1234567890` 都是有效的（去掉横线后是10位）

**检查方法：**
- 运行脚本：`python scripts/setup_mcc_requirements.py`
- 脚本会检查所有MCC账号的ID格式

**修复方法：**
- 如果MCC ID格式不正确，请在系统中编辑MCC账号，修改为正确的10位数字格式

## 快速检查脚本

运行以下命令检查所有配置：

```bash
cd backend
python scripts/setup_mcc_requirements.py
```

这个脚本会：
1. 检查Developer Token配置
2. 自动激活停用的MCC账号
3. 验证MCC ID格式
4. 检查API配置完整性
5. 提供详细的修复建议

## 诊断特定用户的MCC同步问题

如果某个用户的MCC同步失败，可以运行诊断脚本：

```bash
cd backend
python scripts/diagnose_wj03_mcc_sync.py
```

（将 `wj03` 替换为实际的用户名）

## 常见问题

### Q: Developer Token在哪里获取？
A: 需要在 Google Ads API 控制台申请。访问 https://ads.google.com/aw/apicenter 申请 Developer Token。

### Q: MCC ID格式错误怎么办？
A: 在MCC账号管理页面编辑账号，将MCC ID修改为10位数字格式（可以带横线，但去掉横线后必须是10位数字）。

### Q: 如何检查MCC账号是否已激活？
A: 运行 `python scripts/setup_mcc_requirements.py`，脚本会自动激活停用的账号。

### Q: 配置完成后需要重启服务吗？
A: 是的，修改 `.env` 文件后需要重启后端服务才能生效。

## 相关脚本

- `scripts/setup_mcc_requirements.py` - 配置检查和自动修复
- `scripts/check_mcc_config.py` - 详细配置检查
- `scripts/diagnose_wj03_mcc_sync.py` - 用户MCC同步问题诊断
- `scripts/test_mcc_sync.py` - 测试MCC同步功能


















