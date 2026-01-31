#!/bin/bash
# 重启后端服务器

cd ~/Google-Data-Analysis/backend

echo "=== 停止现有服务器 ==="
pkill -f "uvicorn" || echo "没有运行中的服务器"

sleep 2

echo "=== 激活虚拟环境 ==="
source venv/bin/activate

echo "=== 启动服务器 ==="
nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 &

sleep 3

echo "=== 检查服务器状态 ==="
if curl -s http://127.0.0.1:8000/health > /dev/null; then
    echo "✓ 后端服务器启动成功"
    echo "进程ID: $(pgrep -f 'uvicorn app.main:app')"
else
    echo "✗ 后端服务器启动失败，查看日志："
    tail -n 20 run.log
fi

