#!/bin/bash
# 重启服务并测试CORS

cd ~/Google-Data-Analysis/backend
source venv/bin/activate

echo "=========================================="
echo "重启服务并测试CORS"
echo "=========================================="
echo ""

# 1. 停止旧服务
echo "1. 停止旧服务..."
pkill -9 -f "uvicorn.*app.main" || true
sleep 2
echo "   ✓ 已停止"
echo ""

# 2. 检查端口是否释放
echo "2. 检查端口8000..."
if lsof -i:8000 2>/dev/null | grep -q LISTEN; then
    echo "   ⚠ 端口8000仍被占用，强制释放..."
    lsof -ti:8000 | xargs kill -9 2>/dev/null || true
    sleep 2
fi
echo "   ✓ 端口已释放"
echo ""

# 3. 启动服务
echo "3. 启动服务..."
nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 &
UVICORN_PID=$!
echo "   进程ID: $UVICORN_PID"
echo ""

# 4. 等待服务启动
echo "4. 等待服务启动（最多15秒）..."
for i in {1..15}; do
    sleep 1
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8000/health 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "200" ]; then
        echo "   ✓ 服务启动成功 (HTTP $HTTP_CODE)"
        break
    else
        if [ $i -le 10 ]; then
            echo "   等待中... ($i/15) - HTTP: $HTTP_CODE"
        fi
    fi
done
echo ""

# 5. 检查服务进程
echo "5. 检查服务进程..."
if ps -p $UVICORN_PID > /dev/null 2>&1; then
    echo "   ✓ 服务进程运行中 (PID: $UVICORN_PID)"
else
    echo "   ✗ 服务进程已退出"
    echo "   查看错误日志:"
    tail -n 30 run.log
    exit 1
fi
echo ""

# 6. 测试健康检查
echo "6. 测试健康检查..."
HEALTH_RESPONSE=$(curl -s http://127.0.0.1:8000/health 2>/dev/null || echo "ERROR")
if [ "$HEALTH_RESPONSE" != "ERROR" ]; then
    echo "   ✓ 健康检查通过"
    echo "   响应: $HEALTH_RESPONSE"
else
    echo "   ✗ 健康检查失败"
    exit 1
fi
echo ""

# 7. 测试CORS - 健康检查端点
echo "7. 测试CORS - 健康检查端点..."
CORS_HEALTH=$(curl -s -H "Origin: https://google-data-analysis.top" \
  -v http://127.0.0.1:8000/health 2>&1)
CORS_HEADER=$(echo "$CORS_HEALTH" | grep -i "access-control-allow-origin" || echo "NOT_FOUND")

if [ "$CORS_HEADER" != "NOT_FOUND" ]; then
    echo "   ✓ CORS头已设置"
    echo "   $CORS_HEADER"
else
    echo "   ✗ CORS头未找到"
    echo "   完整响应:"
    echo "$CORS_HEALTH" | head -20
fi
echo ""

# 8. 测试CORS - OPTIONS预检请求
echo "8. 测试CORS - OPTIONS预检请求..."
CORS_OPTIONS=$(curl -s -H "Origin: https://google-data-analysis.top" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: Content-Type" \
  -X OPTIONS \
  -v http://127.0.0.1:8000/api/auth/login 2>&1)
CORS_OPTIONS_HEADER=$(echo "$CORS_OPTIONS" | grep -i "access-control" || echo "NOT_FOUND")

if [ "$CORS_OPTIONS_HEADER" != "NOT_FOUND" ]; then
    echo "   ✓ OPTIONS请求CORS头已设置"
    echo "$CORS_OPTIONS_HEADER" | head -5
else
    echo "   ✗ OPTIONS请求CORS头未找到"
    echo "   完整响应:"
    echo "$CORS_OPTIONS" | head -20
fi
echo ""

# 9. 测试CORS - 实际POST请求
echo "9. 测试CORS - 实际POST请求..."
CORS_POST=$(curl -s -H "Origin: https://google-data-analysis.top" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -X POST \
  -d "username=wj07&password=wj123456" \
  -v http://127.0.0.1:8000/api/auth/login 2>&1)
CORS_POST_HEADER=$(echo "$CORS_POST" | grep -i "access-control-allow-origin" || echo "NOT_FOUND")

if [ "$CORS_POST_HEADER" != "NOT_FOUND" ]; then
    echo "   ✓ POST请求CORS头已设置"
    echo "   $CORS_POST_HEADER"
else
    echo "   ✗ POST请求CORS头未找到"
    echo "   完整响应:"
    echo "$CORS_POST" | head -20
fi
echo ""

# 10. 检查服务日志
echo "10. 检查服务日志（最近CORS相关）..."
CORS_LOGS=$(tail -n 50 run.log | grep -i "cors\|origin" || echo "未找到CORS相关日志")
echo "$CORS_LOGS"
echo ""

echo "=========================================="
echo "测试完成"
echo "=========================================="
echo ""
echo "如果CORS头仍然缺失，请检查："
echo "1. app/main.py 中的CORS配置"
echo "2. 是否有Nginx/反向代理覆盖了CORS头"
echo "3. 服务日志中的错误信息"

















