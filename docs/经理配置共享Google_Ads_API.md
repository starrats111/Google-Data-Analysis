# 经理配置共享Google Ads API - 详细步骤

## 📋 目的

配置共享的Google Ads API信息后，员工添加MCC账号时只需要：
- MCC账号ID
- 刷新令牌（Refresh Token）

**不需要**填写：
- 客户端ID（Client ID）
- 客户端密钥（Client Secret）
- 开发者令牌（Developer Token）

---

## 🚀 配置步骤

### 方法一：使用 `.env` 文件（推荐）

#### 第1步：创建 `.env` 文件

在 `backend` 文件夹下创建 `.env` 文件：

```bash
# Windows
cd backend
notepad .env

# Linux/Mac
cd backend
nano .env
```

#### 第2步：填写配置信息

复制以下内容到 `.env` 文件，并替换为你的实际值：

```env
# Google Ads API 共享配置
GOOGLE_ADS_SHARED_CLIENT_ID=你的客户端ID
GOOGLE_ADS_SHARED_CLIENT_SECRET=你的客户端密钥
GOOGLE_ADS_SHARED_DEVELOPER_TOKEN=你的开发者令牌
```

**示例：**
```env
GOOGLE_ADS_SHARED_CLIENT_ID=123456789-abcdefghijklmnop.apps.googleusercontent.com
GOOGLE_ADS_SHARED_CLIENT_SECRET=GOCSPX-abcdefghijklmnopqrstuvwxyz
GOOGLE_ADS_SHARED_DEVELOPER_TOKEN=abcdefghijklmnopqrstuvwxyz
```

#### 第3步：保存文件

保存 `.env` 文件（确保文件在 `backend` 文件夹下）

#### 第4步：重启后端服务

**本地开发：**
```bash
# 停止当前运行的后端（Ctrl+C）
# 重新启动
cd backend
python -m uvicorn app.main:app --reload
```

**服务器部署：**
```bash
# 停止后端服务
pkill -f uvicorn

# 重新启动（使用nohup或systemd）
cd ~/Google-Data-Analysis/backend
nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 > backend.log 2>&1 &
```

---

### 方法二：使用环境变量（服务器推荐）

#### 在服务器上设置环境变量

**临时设置（重启后失效）：**
```bash
export GOOGLE_ADS_SHARED_CLIENT_ID="你的客户端ID"
export GOOGLE_ADS_SHARED_CLIENT_SECRET="你的客户端密钥"
export GOOGLE_ADS_SHARED_DEVELOPER_TOKEN="你的开发者令牌"
```

**永久设置（推荐）：**

1. 编辑 `~/.bashrc` 或 `~/.profile`：
   ```bash
   nano ~/.bashrc
   ```

2. 添加以下内容：
   ```bash
   export GOOGLE_ADS_SHARED_CLIENT_ID="你的客户端ID"
   export GOOGLE_ADS_SHARED_CLIENT_SECRET="你的客户端密钥"
   export GOOGLE_ADS_SHARED_DEVELOPER_TOKEN="你的开发者令牌"
   ```

3. 保存并重新加载：
   ```bash
   source ~/.bashrc
   ```

4. 重启后端服务

---

### 方法三：使用 systemd 服务（生产环境推荐）

如果使用 systemd 管理后端服务：

1. 编辑服务文件：
   ```bash
   sudo nano /etc/systemd/system/google-analysis-backend.service
   ```

2. 在 `[Service]` 部分添加环境变量：
   ```ini
   [Service]
   Environment="GOOGLE_ADS_SHARED_CLIENT_ID=你的客户端ID"
   Environment="GOOGLE_ADS_SHARED_CLIENT_SECRET=你的客户端密钥"
   Environment="GOOGLE_ADS_SHARED_DEVELOPER_TOKEN=你的开发者令牌"
   ```

3. 重新加载并重启：
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl restart google-analysis-backend
   ```

---

## ✅ 验证配置

### 方法1：检查后端日志

重启后端后，查看日志确认没有错误：
```bash
tail -f backend.log
```

### 方法2：测试API

```bash
# 需要先登录获取token
curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:8000/api/mcc/shared-config
```

应该返回：
```json
{
  "has_shared_client_id": true,
  "has_shared_client_secret": true,
  "has_shared_developer_token": true,
  "need_refresh_token_only": true
}
```

### 方法3：前端测试

1. 登录系统
2. 进入"MCC账号"页面
3. 点击"添加MCC账号"
4. 如果只显示以下字段，说明配置成功：
   - MCC账号ID
   - 刷新令牌
   - 账号名称（可选）
   - 邮箱（可选）

---

## 📝 需要的信息从哪里获取？

### 1. 客户端ID 和 客户端密钥

从 **Google Cloud Console** 获取：
1. 访问：https://console.cloud.google.com/
2. 选择你的项目
3. 进入 **API和服务** → **凭据**
4. 找到你的 **OAuth 2.0 客户端ID**
5. 点击查看详情，复制：
   - **客户端ID**（Client ID）
   - **客户端密钥**（Client Secret）

### 2. 开发者令牌

从 **Google Ads API 中心** 获取：
1. 访问：https://ads.google.com/aw/apicenter
2. 登录你的Google Ads账号
3. 在 **开发者令牌** 部分，复制你的令牌

---

## ⚠️ 注意事项

1. **安全性**：
   - `.env` 文件包含敏感信息，**不要**提交到Git
   - 确保 `.env` 文件在 `.gitignore` 中

2. **权限**：
   - 确保 `.env` 文件权限正确（Linux: `chmod 600 .env`）

3. **格式**：
   - 不要有引号（除非值中包含空格）
   - 不要有多余的空格
   - 每行一个配置项

4. **重启**：
   - 修改配置后**必须重启后端**才能生效

---

## 🔧 故障排除

### 问题1：配置不生效

**解决方案：**
- 确认 `.env` 文件在 `backend` 文件夹下
- 确认没有拼写错误
- 重启后端服务
- 检查后端日志是否有错误

### 问题2：员工还是需要填写完整信息

**解决方案：**
- 检查环境变量是否正确设置
- 测试API：`/api/mcc/shared-config`
- 确认前端已刷新（清除缓存）

### 问题3：后端启动失败

**解决方案：**
- 检查 `.env` 文件格式是否正确
- 查看后端日志：`tail -f backend.log`
- 确认没有语法错误

---

## 📞 需要帮助？

如果遇到问题：
1. 查看后端日志：`tail -f backend.log`
2. 测试配置API：`/api/mcc/shared-config`
3. 检查 `.env` 文件格式

