# Developer Token 配置指南

## 问题诊断

根据检查，`.env` 文件中存在 `GOOGLE_ADS_SHARED_DEVELOPER_TOKEN=` 配置项，但值为空。

## 配置步骤

### 方法1：直接编辑 .env 文件（推荐）

1. **打开文件**
   ```
   backend/.env
   ```

2. **找到配置行**
   ```
   GOOGLE_ADS_SHARED_DEVELOPER_TOKEN=
   ```

3. **填入Token值**
   ```
   GOOGLE_ADS_SHARED_DEVELOPER_TOKEN=你的实际Token值
   ```
   
   **重要提示：**
   - 不要在Token值前后加引号
   - 不要在等号前后加空格
   - Token值应该直接跟在等号后面
   
   **正确示例：**
   ```
   GOOGLE_ADS_SHARED_DEVELOPER_TOKEN=abc123xyz789
   ```
   
   **错误示例：**
   ```
   GOOGLE_ADS_SHARED_DEVELOPER_TOKEN = abc123xyz789  # 等号前后有空格
   GOOGLE_ADS_SHARED_DEVELOPER_TOKEN="abc123xyz789"  # 有引号
   GOOGLE_ADS_SHARED_DEVELOPER_TOKEN='abc123xyz789'  # 有引号
   ```

4. **保存文件**

5. **重启后端服务**
   - 修改 `.env` 文件后必须重启后端服务才能生效

### 方法2：使用修复脚本

运行交互式修复脚本：

```bash
cd backend
python scripts/fix_dev_token.py
```

脚本会：
1. 检查当前配置状态
2. 检查 `.env` 文件内容
3. 提示你输入Token值
4. 自动更新 `.env` 文件

### 方法3：使用命令行设置（临时）

如果只是临时测试，可以设置环境变量：

**Windows PowerShell:**
```powershell
$env:GOOGLE_ADS_SHARED_DEVELOPER_TOKEN="你的Token值"
```

**Windows CMD:**
```cmd
set GOOGLE_ADS_SHARED_DEVELOPER_TOKEN=你的Token值
```

**Linux/Mac:**
```bash
export GOOGLE_ADS_SHARED_DEVELOPER_TOKEN="你的Token值"
```

注意：这种方式只在当前终端会话有效，关闭终端后失效。

## 验证配置

配置完成后，运行以下命令验证：

```bash
cd backend
python scripts/check_dev_token.py
```

或者：

```bash
cd backend
python scripts/setup_mcc_requirements.py
```

如果显示 `[已配置]`，说明配置成功。

## 常见问题

### Q: 为什么配置了但检测不到？

**可能原因：**

1. **配置格式错误**
   - 检查是否有引号、空格等
   - 确保格式为：`GOOGLE_ADS_SHARED_DEVELOPER_TOKEN=值`（无空格，无引号）

2. **文件位置错误**
   - 确保 `.env` 文件在 `backend/` 目录下
   - 完整路径应该是：`backend/.env`

3. **未重启服务**
   - 修改 `.env` 文件后必须重启后端服务
   - 服务启动时会读取 `.env` 文件

4. **配置项名称错误**
   - 确保配置项名称完全正确：`GOOGLE_ADS_SHARED_DEVELOPER_TOKEN`
   - 大小写敏感

5. **文件编码问题**
   - 确保 `.env` 文件使用 UTF-8 编码保存

### Q: 如何获取 Developer Token？

1. 访问 [Google Ads API Center](https://ads.google.com/aw/apicenter)
2. 登录你的 Google Ads 账号
3. 申请或查看 Developer Token
4. 注意：Token 需要经过 Google 审核才能使用

### Q: Token 格式是什么样的？

Developer Token 通常是一串字母数字组合，长度不固定。例如：
- `abc123xyz789`
- `A1B2C3D4E5F6`

### Q: 配置后需要做什么？

1. **保存 `.env` 文件**
2. **重启后端服务**（重要！）
3. **验证配置**：运行 `python scripts/check_dev_token.py`

## 检查脚本

提供了多个检查脚本：

1. **`scripts/check_dev_token.py`** - 详细检查Token配置
2. **`scripts/setup_mcc_requirements.py`** - 检查所有MCC相关配置
3. **`scripts/fix_dev_token.py`** - 交互式修复Token配置

## 快速修复命令

如果Token值已知，可以快速修复：

```bash
cd backend
# 编辑 .env 文件，在 GOOGLE_ADS_SHARED_DEVELOPER_TOKEN= 后面填入Token
# 然后重启服务
```

或者使用脚本：

```bash
cd backend
python scripts/fix_dev_token.py
# 按提示输入Token值
```















