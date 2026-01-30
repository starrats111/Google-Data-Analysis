# 在 Railway 上使用管理脚本的完整指南

## 📋 前提条件

1. **已安装 Railway CLI**
2. **已登录 Railway 账号**
3. **项目已部署到 Railway**

---

## 🚀 步骤 1: 安装 Railway CLI

### Windows (PowerShell)

```powershell
# 方法1: 使用 npm（推荐）
npm install -g @railway/cli

# 方法2: 使用安装脚本
iwr https://railway.app/install.sh | iex
```

### macOS / Linux

```bash
# 方法1: 使用 npm（推荐）
npm install -g @railway/cli

# 方法2: 使用安装脚本
curl -fsSL https://railway.app/install.sh | sh
```

### 验证安装

```bash
railway --version
# 应该显示版本号，例如: @railway/cli/2.x.x
```

---

## 🔐 步骤 2: 登录 Railway

```bash
railway login
```

这会打开浏览器，让你授权 Railway CLI 访问你的账号。

---

## 🔗 步骤 3: 链接到你的项目

### 方法 1: 在项目目录下链接（推荐）

```bash
# 1. 进入你的项目目录（本地）
cd D:\Code\affiliate

# 2. 链接到 Railway 项目
railway link
```

如果项目目录下有多个 Railway 项目，CLI 会提示你选择要链接的项目。

### 方法 2: 直接指定项目 ID

```bash
# 如果你知道项目 ID
railway link <project-id>
```

你可以在 Railway Web 控制台的 URL 中找到项目 ID：
```
https://railway.app/project/<project-id>
```

---

## ✅ 步骤 4: 验证连接

```bash
# 查看当前链接的项目信息
railway status
```

应该显示：
- 项目名称
- 服务名称
- 环境变量等

---

## 🎯 步骤 5: 执行管理脚本

### 方式 1: 直接运行脚本（推荐）

```bash
# 在项目目录下执行
railway run node scripts/manage-super-admin.js
```

### 方式 2: 先进入容器，再执行

```bash
# 进入 Railway 容器
railway run bash

# 在容器内执行脚本
node scripts/manage-super-admin.js
```

---

## 📝 完整操作示例

### 示例：查看所有超级管理员

```bash
# 1. 确保在项目目录
cd D:\Code\affiliate

# 2. 链接到 Railway 项目（如果还没链接）
railway link

# 3. 执行脚本
railway run node scripts/manage-super-admin.js

# 4. 在交互式菜单中选择选项 1
# 输入: 1
# 按回车

# 5. 查看输出结果
```

### 示例：降级超级管理员

```bash
# 执行脚本
railway run node scripts/manage-super-admin.js

# 交互式操作：
# 1. 选择 1 - 查看所有超级管理员，记住要操作的 ID
# 2. 选择 3 - 降级超级管理员
# 3. 输入用户 ID（例如: 2）
# 4. 输入 yes 确认
```

### 示例：删除用户

```bash
# 执行脚本
railway run node scripts/manage-super-admin.js

# 交互式操作：
# 1. 选择 1 - 查看所有超级管理员，记住要操作的 ID
# 2. 选择 2 - 检查用户数据依赖（可选，但推荐）
# 3. 选择 4 - 删除用户
# 4. 输入用户 ID（例如: 2）
# 5. 输入 yes 进行第一次确认
# 6. 输入 DELETE 进行第二次确认
```

---

## 🔍 常见问题排查

### 问题 1: `railway: command not found`

**原因**: Railway CLI 未安装或未添加到 PATH

**解决方案**:
```bash
# 重新安装
npm install -g @railway/cli

# 验证安装
railway --version
```

### 问题 2: `Not logged in`

**原因**: 未登录 Railway

**解决方案**:
```bash
railway login
```

### 问题 3: `No project linked`

**原因**: 当前目录未链接到 Railway 项目

**解决方案**:
```bash
# 在项目目录下执行
railway link

# 或指定项目 ID
railway link <project-id>
```

### 问题 4: `数据库文件不存在`

**原因**: 数据库路径不正确或 Volume 未挂载

**解决方案**:
```bash
# 1. 检查 Volume 是否已挂载
railway run ls -la /app/data

# 2. 检查数据库文件是否存在
railway run ls -la /app/data/data.db

# 3. 如果文件不存在，检查环境变量
railway run env | grep NODE_ENV
```

### 问题 5: `NODE_ENV 未设置为 production`

**原因**: Railway 环境变量未正确设置

**解决方案**:
```bash
# 方法1: 在 Railway Web 控制台设置
# Settings → Variables → 添加 NODE_ENV=production

# 方法2: 在脚本执行时临时设置
railway run env NODE_ENV=production node scripts/manage-super-admin.js
```

---

## 🛠️ 高级用法

### 1. 查看 Railway 环境变量

```bash
railway run env
```

### 2. 查看数据库文件信息

```bash
railway run ls -lh /app/data/data.db
```

### 3. 备份数据库

```bash
# 下载数据库文件到本地
railway run cat /app/data/data.db > backup-$(date +%Y%m%d).db
```

### 4. 查看脚本日志

```bash
# 在容器内查看日志文件
railway run cat scripts/super-admin-management.log

# 或下载到本地
railway run cat scripts/super-admin-management.log > management.log
```

### 5. 直接执行 SQL 查询（调试用）

```bash
# 进入容器
railway run bash

# 使用 sqlite3 命令行工具
sqlite3 /app/data/data.db

# 执行 SQL
SELECT id, username, email, role FROM users WHERE role = 'super_admin';

# 退出
.exit
```

---

## 📊 操作流程图

```
开始
  ↓
安装 Railway CLI
  ↓
登录 Railway (railway login)
  ↓
链接项目 (railway link)
  ↓
执行脚本 (railway run node scripts/manage-super-admin.js)
  ↓
选择操作 (1-5)
  ↓
按提示输入信息
  ↓
确认操作
  ↓
查看结果
  ↓
完成
```

---

## ⚠️ 重要提示

1. **操作前备份数据库**
   ```bash
   railway run cat /app/data/data.db > backup-$(date +%Y%m%d).db
   ```

2. **确保至少保留一个超级管理员**
   - 系统会自动检查
   - 如果是最后一个，会阻止删除/降级

3. **所有操作都会记录日志**
   - 日志文件: `scripts/super-admin-management.log`
   - 可以下载查看: `railway run cat scripts/super-admin-management.log`

4. **Railway 环境变量**
   - 确保 `NODE_ENV=production` 已设置
   - 脚本会自动检测并使用正确的数据库路径

---

## 🎯 快速参考命令

```bash
# 安装 CLI
npm install -g @railway/cli

# 登录
railway login

# 链接项目
railway link

# 执行脚本
railway run node scripts/manage-super-admin.js

# 查看状态
railway status

# 查看环境变量
railway run env

# 进入容器
railway run bash

# 备份数据库
railway run cat /app/data/data.db > backup.db
```

---

## 📞 获取帮助

如果遇到问题：

1. **查看 Railway 文档**: https://docs.railway.app
2. **查看脚本日志**: `railway run cat scripts/super-admin-management.log`
3. **检查 Railway 日志**: Railway Web 控制台 → Deployments → 查看日志
4. **验证环境变量**: `railway run env | grep NODE_ENV`

---

**最后更新**: 2025-11-07

