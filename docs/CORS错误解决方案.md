# CORS错误解决方案

## 问题分析

从错误信息看，前端（`https://google-data-analysis.top`）无法访问后端API（`https://api.google-data-analysis.top`），出现CORS错误。

## 可能的原因

1. **后端没有正确启动**
2. **后端代码没有更新到服务器**
3. **CORS配置有问题**
4. **前端API地址配置错误**

## 解决步骤

### 步骤1：检查后端是否运行

在服务器上执行：
```bash
ps aux | grep uvicorn
```

如果看不到uvicorn进程，说明后端没有运行。

### 步骤2：更新后端代码并重启

在服务器上执行：
```bash
cd ~/Google-Data-Analysis
git pull origin main
cd backend
source venv/bin/activate
pip install -r requirements.txt
pkill -f "uvicorn"
nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > backend.log 2>&1 &
sleep 3
ps aux | grep uvicorn
```

### 步骤3：检查后端日志

```bash
tail -50 ~/Google-Data-Analysis/backend/backend.log
```

查看是否有错误信息。

### 步骤4：测试后端是否可访问

在浏览器中访问：
```
https://api.google-data-analysis.top/health
```

应该返回：`{"status":"ok"}`

如果无法访问，可能是：
- 服务器防火墙问题
- Nginx配置问题
- 域名解析问题

### 步骤5：检查前端API配置

前端应该配置为使用 `https://api.google-data-analysis.top` 作为API地址。

检查Cloudflare Pages的环境变量：
- 变量名：`VITE_API_URL`
- 值：`https://api.google-data-analysis.top`

### 步骤6：清除浏览器缓存

1. 按 `Ctrl+Shift+Delete`
2. 清除缓存和Cookie
3. 硬刷新页面（`Ctrl+Shift+R`）

## 快速诊断命令

在服务器上执行：
```bash
cd ~/Google-Data-Analysis && git pull origin main && cd backend && source venv/bin/activate && pip install -r requirements.txt && pkill -f "uvicorn" && nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > backend.log 2>&1 & && sleep 3 && curl http://localhost:8000/health && echo "=== 后端日志 ===" && tail -20 backend.log
```

## 如果还是不行

1. 检查Nginx配置（如果有反向代理）
2. 检查防火墙设置
3. 检查域名DNS解析
4. 查看完整的后端日志

