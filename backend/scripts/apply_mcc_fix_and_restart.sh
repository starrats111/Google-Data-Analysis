#!/bin/bash
# 应用MCC修复并重启服务

cd ~/Google-Data-Analysis/backend
source venv/bin/activate

echo "=========================================="
echo "应用MCC修复并重启服务"
echo "=========================================="
echo ""

# 1. 处理git冲突：保存本地修改
echo "1. 处理git冲突..."
git stash push -m "MCC sync timeout fix" || true
git pull origin main || echo "git pull 失败，使用本地代码"

# 2. 如果本地有修复，重新应用
if git stash list | grep -q "MCC sync timeout fix"; then
    echo "   恢复本地修复..."
    git stash pop || true
fi

# 3. 验证代码
echo ""
echo "2. 验证代码..."
python3 -m py_compile app/api/mcc.py && echo "   ✓ 语法正确" || {
    echo "   ✗ 语法错误"
    tail -n 20 run.log 2>/dev/null || true
    exit 1
}

# 4. 停止旧服务
echo ""
echo "3. 停止旧服务..."
pkill -9 -f "uvicorn.*app.main" || true
sleep 2

# 5. 检查端口
echo "4. 检查端口8000..."
if lsof -i:8000 2>/dev/null | grep -q LISTEN; then
    echo "   ⚠ 端口8000仍被占用，强制释放..."
    lsof -ti:8000 | xargs kill -9 2>/dev/null || true
    sleep 2
fi

# 6. 启动服务
echo ""
echo "5. 启动服务..."
nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 &
UVICORN_PID=$!
echo "   进程ID: $UVICORN_PID"

# 7. 等待启动
echo ""
echo "6. 等待服务启动（最多10秒）..."
for i in {1..10}; do
    sleep 1
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8000/health 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "200" ]; then
        echo "   ✓ 服务启动成功 (HTTP $HTTP_CODE)"
        break
    else
        if [ $i -le 5 ]; then
            echo "   等待中... ($i/10) - HTTP: $HTTP_CODE"
        fi
    fi
done

# 8. 最终检查
echo ""
echo "7. 最终健康检查..."
FINAL_HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8000/health 2>/dev/null || echo "000")
FINAL_RESPONSE=$(curl -s http://127.0.0.1:8000/health 2>/dev/null || echo "ERROR")

if [ "$FINAL_HTTP_CODE" = "200" ]; then
    echo "   ✓ 后端服务运行正常"
    echo "   响应: $FINAL_RESPONSE"
    echo ""
    echo "=========================================="
    echo "✓ 修复完成！"
    echo "=========================================="
    echo ""
    echo "MCC同步现在会："
    echo "- 日期范围同步 → 后台任务（立即返回202）"
    echo "- 单个日期同步 → 同步执行"
    exit 0
else
    echo "   ✗ 后端服务启动失败 (HTTP $FINAL_HTTP_CODE)"
    echo "   响应: $FINAL_RESPONSE"
    echo ""
    echo "   查看错误日志:"
    tail -n 30 run.log
    echo ""
    echo "=========================================="
    echo "✗ 启动失败，请检查日志"
    echo "=========================================="
    exit 1
fi














