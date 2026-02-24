#!/bin/bash
# 检查并启动后端服务

cd ~/Google-Data-Analysis/backend
source venv/bin/activate

# 1. 检查是否有uvicorn进程在运行
echo "=== 检查现有进程 ==="
ps aux | grep "uvicorn.*app.main" | grep -v grep

# 2. 检查端口8000是否被占用
echo ""
echo "=== 检查端口8000 ==="
lsof -ti:8000 && echo "端口8000已被占用" || echo "端口8000未被占用"

# 3. 停掉旧的进程（如果有）
echo ""
echo "=== 停止旧进程 ==="
pkill -9 -f "uvicorn.*app.main" || echo "没有找到运行中的进程"

# 4. 等待2秒
sleep 2

# 5. 启动新的后端服务
echo ""
echo "=== 启动后端服务 ==="
nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 &

# 6. 等待3秒让服务启动
sleep 3

# 7. 检查服务状态
echo ""
echo "=== 检查服务状态 ==="
curl -s http://127.0.0.1:8000/health && echo "" && echo "✓ 后端服务运行正常" || (echo "✗ 后端服务启动失败，查看日志：" && tail -n 30 run.log)


















