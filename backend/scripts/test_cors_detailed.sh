#!/bin/bash
# 详细测试CORS配置

echo "=========================================="
echo "详细CORS测试"
echo "=========================================="
echo ""

# 1. 测试健康检查端点
echo "1. 测试健康检查端点（带Origin头）..."
echo "命令: curl -H 'Origin: https://google-data-analysis.top' -v http://127.0.0.1:8000/health"
echo ""
curl -s -H "Origin: https://google-data-analysis.top" \
  -v http://127.0.0.1:8000/health 2>&1 | head -30
echo ""
echo ""

# 2. 测试OPTIONS预检请求
echo "2. 测试OPTIONS预检请求..."
echo "命令: curl -H 'Origin: https://google-data-analysis.top' -H 'Access-Control-Request-Method: POST' -X OPTIONS -v http://127.0.0.1:8000/api/auth/login"
echo ""
curl -s -H "Origin: https://google-data-analysis.top" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: Content-Type" \
  -X OPTIONS \
  -v http://127.0.0.1:8000/api/auth/login 2>&1 | head -30
echo ""
echo ""

# 3. 测试实际POST请求
echo "3. 测试实际POST请求（登录端点）..."
echo "命令: curl -H 'Origin: https://google-data-analysis.top' -H 'Content-Type: application/x-www-form-urlencoded' -X POST -d 'username=wj07&password=wj123456' -v http://127.0.0.1:8000/api/auth/login"
echo ""
curl -s -H "Origin: https://google-data-analysis.top" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -X POST \
  -d "username=wj07&password=wj123456" \
  -v http://127.0.0.1:8000/api/auth/login 2>&1 | head -40
echo ""
echo ""

# 4. 检查服务日志
echo "4. 检查服务日志（最近20行）..."
tail -n 20 ~/Google-Data-Analysis/backend/run.log
echo ""
echo ""

# 5. 检查服务进程
echo "5. 检查服务进程..."
ps aux | grep uvicorn | grep -v grep
echo ""
echo ""

# 6. 检查端口监听
echo "6. 检查端口8000监听..."
netstat -tlnp | grep 8000 || ss -tlnp | grep 8000
echo ""
















