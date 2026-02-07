#!/bin/bash
# 解决服务器上的分支分歧问题

cd ~/Google-Data-Analysis

# 1. 配置 pull 策略为 merge（避免 rebase 冲突）
git config pull.rebase false

# 2. 使用 merge 方式拉取
git pull --no-rebase origin main

# 3. 如果有冲突，使用我们的版本（因为本地已经是最新的）
if [ $? -ne 0 ]; then
    echo "检测到合并冲突，使用我们的版本..."
    git checkout --ours backend/app/api/mcc.py
    git add backend/app/api/mcc.py
    git commit -m "解决合并冲突：保留最新的CORS修复"
fi

# 4. 进入后端目录并激活虚拟环境
cd backend
source venv/bin/activate

# 5. 停掉旧的 uvicorn 进程
pkill -9 -f "uvicorn.*app.main" || true

# 6. 启动新的后端
nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 &

# 7. 等 2 秒检查健康状态
sleep 2
curl -s http://127.0.0.1:8000/health && echo "" && echo "✓ 后端服务运行正常" || echo "✗ 后端服务启动失败，请查看 run.log"












