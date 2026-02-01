# 部署脚本使用说明

## 快速开始

### 方式1: 一键推送和部署（推荐）

```powershell
# 推送代码并显示部署指令
.\scripts\快速部署.ps1 "修复CollabGlow API问题"
```

这个脚本会：
1. 自动推送代码到GitHub
2. 显示完整的后端部署指令（可直接复制到阿里云服务器）

### 方式2: 分步执行

#### 步骤1: 推送代码到GitHub

```powershell
# PowerShell
.\scripts\push_to_github.ps1 "你的提交信息"

# 或批处理
scripts\push_to_github.bat "你的提交信息"
```

#### 步骤2: 在阿里云服务器执行部署

**完整部署指令（一次性复制粘贴）：**

```bash
cd ~/Google-Data-Analysis && git pull origin main && cd backend && source venv/bin/activate && pip install -q --upgrade pip && pip install -q -r requirements.txt && pkill -f 'uvicorn.*app.main' && sleep 2 && nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 & sleep 3 && curl -s http://127.0.0.1:8000/health && echo "" && echo "✓ 部署完成" && tail -n 5 run.log
```

**或使用部署脚本（推荐）：**

```bash
cd ~/Google-Data-Analysis/backend && bash scripts/deploy_backend.sh
```

## 脚本说明

### 本地脚本（Windows）

| 脚本 | 说明 | 使用方法 |
|------|------|----------|
| `快速部署.ps1` | 一键推送代码并显示部署指令 | `.\scripts\快速部署.ps1 "提交信息"` |
| `push_to_github.ps1` | 推送代码到GitHub | `.\scripts\push_to_github.ps1 "提交信息"` |
| `push_to_github.bat` | 推送代码到GitHub（批处理） | `scripts\push_to_github.bat "提交信息"` |

### 服务器脚本（Linux）

| 脚本 | 说明 | 使用方法 |
|------|------|----------|
| `deploy_backend.sh` | 完整部署脚本 | `bash scripts/deploy_backend.sh` |
| `restart_backend.sh` | 重启服务器 | `bash scripts/restart_backend.sh` |

## 完整工作流程

### 1. 本地开发完成后

```powershell
# 使用快速部署脚本
.\scripts\快速部署.ps1 "修复CollabGlow API问题"
```

### 2. 复制显示的部署指令

脚本会显示完整的部署指令，直接复制即可。

### 3. 在阿里云服务器执行

在阿里云服务器的终端中粘贴并执行部署指令。

### 4. 验证部署

```bash
# 检查服务器状态
curl http://127.0.0.1:8000/health

# 查看日志
tail -f ~/Google-Data-Analysis/backend/run.log
```

## 常见问题

### Q: PowerShell脚本无法执行？

A: 设置执行策略
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### Q: 推送失败？

A: 检查Git配置
```bash
git config --global user.name "你的名字"
git config --global user.email "你的邮箱"
```

### Q: 服务器部署失败？

A: 查看详细日志
```bash
tail -n 100 ~/Google-Data-Analysis/backend/run.log
tail -n 100 ~/Google-Data-Analysis/backend/logs/error.log
```

## 详细文档

更多详细信息请参考：
- [部署指令.md](../部署指令.md) - 完整的部署指令文档

