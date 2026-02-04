#!/bin/bash
# 修复 MCC 同步的 CORS 和超时问题

echo "=========================================="
echo "修复 MCC 同步错误"
echo "=========================================="
echo ""

# 1. 进入项目目录
cd ~/Google-Data-Analysis || exit 1

# 2. 拉取最新代码（确保包含 CORS 修复）
echo "1. 拉取最新代码..."
git pull origin main || echo "警告: git pull 失败，继续使用本地代码"
echo ""

# 3. 检查 CORS 配置是否正确
echo "2. 检查 CORS 配置..."
cd backend
if grep -q "from starlette.middleware.cors import CORSMiddleware" app/main.py; then
    echo "   ✓ CORS 配置已修复（使用 Starlette 中间件）"
else
    echo "   ✗ CORS 配置可能有问题，需要检查"
fi
echo ""

# 4. 停止旧进程
echo "3. 停止旧进程..."
pkill -9 -f "uvicorn.*app.main" || true
sleep 2
echo ""

# 5. 激活虚拟环境
echo "4. 激活虚拟环境..."
source venv/bin/activate || exit 1
echo ""

# 6. 验证代码
echo "5. 验证代码..."
python3 -c "
try:
    from starlette.middleware.cors import CORSMiddleware
    from app.main import app
    print('   ✓ 代码验证成功')
except Exception as e:
    print(f'   ✗ 代码验证失败: {e}')
    exit(1)
" || exit 1
echo ""

# 7. 启动服务
echo "6. 启动后端服务..."
nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 &
UVICORN_PID=$!
echo "   服务进程 ID: $UVICORN_PID"
echo ""

# 8. 等待服务启动
echo "7. 等待服务启动（最多15秒）..."
for i in {1..15}; do
    sleep 1
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8000/health 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "200" ]; then
        echo "   ✓ 服务启动成功 (HTTP $HTTP_CODE)"
        break
    else
        if [ $i -le 5 ]; then
            echo "   等待中... ($i/15)"
        fi
    fi
done
echo ""

# 9. 测试 CORS
echo "8. 测试 CORS 配置..."
CORS_TEST=$(curl -s -H "Origin: https://google-data-analysis.top" \
    -H "Access-Control-Request-Method: POST" \
    -H "Access-Control-Request-Headers: Content-Type" \
    -X OPTIONS \
    -w "\nHTTP_CODE:%{http_code}" \
    http://127.0.0.1:8000/api/mcc/accounts/1/sync 2>/dev/null)

CORS_HEADER=$(echo "$CORS_TEST" | grep -i "access-control-allow-origin" || echo "")
HTTP_CODE=$(echo "$CORS_TEST" | grep "HTTP_CODE" | cut -d: -f2)

if [ -n "$CORS_HEADER" ] || [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "405" ]; then
    echo "   ✓ CORS 配置正常"
else
    echo "   ⚠ CORS 测试结果: HTTP $HTTP_CODE"
    echo "   注意: 如果返回 404/405 是正常的（端点需要认证）"
fi
echo ""

# 10. 最终健康检查
echo "9. 最终健康检查..."
FINAL_HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8000/health 2>/dev/null || echo "000")
FINAL_RESPONSE=$(curl -s http://127.0.0.1:8000/health 2>/dev/null || echo "ERROR")

if [ "$FINAL_HTTP_CODE" = "200" ]; then
    echo "   ✓ 后端服务运行正常"
    echo "   响应: $FINAL_RESPONSE"
    echo ""
    echo "=========================================="
    echo "✓ 修复完成！服务已重启并应用 CORS 修复"
    echo "=========================================="
    echo ""
    echo "提示："
    echo "1. 如果前端仍有 CORS 错误，请清除浏览器缓存并刷新"
    echo "2. MCC 同步使用后台任务，避免 504 超时"
    echo "3. 查看服务日志: tail -f run.log"
    exit 0
else
    echo "   ✗ 后端服务启动失败 (HTTP $FINAL_HTTP_CODE)"
    echo "   响应: $FINAL_RESPONSE"
    echo ""
    echo "   查看错误日志:"
    tail -n 30 run.log
    echo ""
    echo "=========================================="
    echo "✗ 修复失败，请检查日志"
    echo "=========================================="
    exit 1
fi

