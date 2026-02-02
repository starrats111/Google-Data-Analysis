# CORS 问题修复说明

## 问题描述

**错误信息：**
```
Access to XMLHttpRequest at 'https://api.google-data-analysis.top/api/affiliate/platforms' 
from origin 'https://google-data-analysis.top' has been blocked by CORS policy: 
Response to preflight request doesn't pass access control check: 
No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

**问题表现：**
- 前端无法获取平台列表
- 浏览器控制台显示 CORS 错误
- 网络请求失败：`net::ERR_FAILED`

## 问题原因分析

1. **CORS 预检请求（OPTIONS）未正确处理**
   - 浏览器在发送跨域请求前会先发送 OPTIONS 预检请求
   - 预检请求需要返回正确的 CORS 响应头
   - 虽然代码中已有 CORS 中间件，但某些情况下 OPTIONS 请求可能没有被正确处理

2. **跨域访问**
   - 前端：`https://google-data-analysis.top`
   - 后端：`https://api.google-data-analysis.top`
   - 这是跨域请求，需要正确的 CORS 配置

3. **可能的网络问题**
   - `net::ERR_FAILED` 可能表示后端服务未运行或网络不通
   - 需要确保后端服务正常运行

## 解决方案

### 1. 添加显式的 OPTIONS 处理器

在 `backend/app/api/affiliate.py` 中添加了显式的 OPTIONS 处理器：

```python
# 显式处理OPTIONS请求，确保CORS预检请求通过
@router.options("/platforms")
@router.options("/accounts")
@router.options("/accounts/by-employees")
async def options_handler(request: Request):
    """处理OPTIONS预检请求"""
    # 使用与main.py相同的CORS逻辑
    # 返回正确的CORS响应头
```

### 2. 改进 CORS 中间件配置

在 `backend/app/main.py` 中：
- 确保 `automatic_options=True`（虽然这是默认值，但显式设置更清晰）
- 改进了 OPTIONS 请求的日志记录

### 3. 改进 CORS 日志

- 将 OPTIONS 请求的日志级别从 `debug` 改为 `info`，便于排查问题
- 记录更详细的 CORS 信息

## 修复内容

### 修改的文件

1. **`backend/app/main.py`**
   - 改进了全局 OPTIONS 处理器的日志记录
   - 确保 CORS 中间件正确配置

2. **`backend/app/api/affiliate.py`**
   - 添加了显式的 OPTIONS 处理器
   - 使用与主应用相同的 CORS 逻辑
   - 确保预检请求返回正确的 CORS 头

## 部署步骤

修复代码已推送到 GitHub，需要在服务器上部署：

```bash
# 在服务器上执行
cd ~/Google-Data-Analysis && git pull origin main && cd backend && source venv/bin/activate && pkill -f 'uvicorn.*app.main' && sleep 2 && nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 & sleep 3 && curl -s http://127.0.0.1:8000/health && echo "" && echo "✓ 后端部署完成" && tail -n 10 run.log
```

## 验证步骤

1. **检查后端服务是否运行**
   ```bash
   curl https://api.google-data-analysis.top/health
   ```
   应该返回：`{"status":"ok"}`

2. **检查 OPTIONS 请求**
   ```bash
   curl -X OPTIONS https://api.google-data-analysis.top/api/affiliate/platforms \
     -H "Origin: https://google-data-analysis.top" \
     -H "Access-Control-Request-Method: GET" \
     -v
   ```
   应该返回 200 状态码和正确的 CORS 头

3. **检查前端**
   - 刷新前端页面
   - 检查浏览器控制台是否还有 CORS 错误
   - 验证平台列表是否能正常加载

## 如果问题仍然存在

1. **检查后端服务状态**
   ```bash
   ps aux | grep uvicorn
   lsof -i :8000
   ```

2. **检查后端日志**
   ```bash
   tail -n 50 ~/Google-Data-Analysis/backend/run.log | grep -i "cors\|options\|error"
   ```

3. **检查网络连接**
   - 确认 `https://api.google-data-analysis.top` 可以访问
   - 检查防火墙和负载均衡器配置

4. **检查 DNS 配置**
   - 确认 `api.google-data-analysis.top` 正确解析到后端服务器

## 预防措施

1. **监控 CORS 错误**
   - 定期检查后端日志中的 CORS 相关错误
   - 监控前端错误日志

2. **测试跨域请求**
   - 在部署后测试所有跨域 API 端点
   - 确保 OPTIONS 请求正常工作

3. **文档化 CORS 配置**
   - 记录所有允许的来源
   - 确保新添加的域名及时更新到 CORS 配置中

---

**修复时间：** 2026-02-02  
**修复版本：** main (928f17e)

