#!/bin/bash
# 解决服务器上的 git rebase 冲突

# 1. 中止当前的 rebase
cd ~/Google-Data-Analysis
git rebase --abort

# 2. 改用 merge 方式拉取（更安全）
git pull origin main

# 3. 如果有冲突，解决后继续
# git add backend/app/api/mcc.py
# git commit -m "解决合并冲突"

# 4. 进入后端目录并激活虚拟环境
cd backend
source venv/bin/activate

# 5. 停掉旧的 uvicorn 进程
pkill -9 -f "uvicorn.*app.main" || true

# 6. 启动新的后端
nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 &

# 7. 等 2 秒检查健康状态
sleep 2
curl -s http://127.0.0.1:8000/health && echo "✓ 后端服务运行正常" || echo "✗ 后端服务启动失败，请查看 run.log"














