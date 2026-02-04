#!/bin/bash
# 修复健康检查脚本 - 正确检测服务状态

echo "修复健康检查并重启服务..."
echo ""

# 1. 停掉旧进程
echo "1. 停止旧进程..."
pkill -9 -f "uvicorn.*app.main" || true
sleep 2

# 2. 进入后端目录
cd ~/Google-Data-Analysis/backend || cd backend || exit 1

# 3. 激活虚拟环境
source venv/bin/activate || exit 1

# 4. 启动服务
echo "2. 启动后端服务..."
nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 &
UVICORN_PID=$!
echo "   服务进程 ID: $UVICORN_PID"

# 5. 等待服务启动
echo "3. 等待服务启动（最多10秒）..."
for i in {1..10}; do
    sleep 1
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8000/health 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "200" ]; then
        echo "   ✓ 服务启动成功 (HTTP $HTTP_CODE)"
        break
    else
        echo "   等待中... ($i/10) - HTTP $HTTP_CODE"
    fi
done

# 6. 最终检查
echo ""
echo "4. 最终健康检查..."
FINAL_HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8000/health 2>/dev/null || echo "000")
FINAL_RESPONSE=$(curl -s http://127.0.0.1:8000/health 2>/dev/null || echo "ERROR")

if [ "$FINAL_HTTP_CODE" = "200" ]; then
    echo "   ✓ 后端服务运行正常"
    echo "   响应: $FINAL_RESPONSE"
    echo ""
    echo "=========================================="
    echo "服务启动成功！"
    echo "=========================================="
else
    echo "   ✗ 后端服务启动失败 (HTTP $FINAL_HTTP_CODE)"
    echo "   响应: $FINAL_RESPONSE"
    echo ""
    echo "   查看错误日志:"
    tail -n 30 run.log
    echo ""
    echo "=========================================="
    echo "服务启动失败，请检查日志"
    echo "=========================================="
    exit 1
fi

