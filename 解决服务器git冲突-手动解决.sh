#!/bin/bash
# 手动解决服务器上的 git rebase 冲突

cd ~/Google-Data-Analysis

# 1. 查看冲突文件
echo "=== 查看冲突文件 ==="
git status

# 2. 查看冲突内容
echo "=== 查看冲突内容 ==="
cat backend/app/api/mcc.py | grep -A 10 -B 10 "<<<<<<<"

# 3. 手动编辑文件解决冲突（保留当前版本，因为本地已经是最新的）
# 编辑 backend/app/api/mcc.py，删除冲突标记（<<<<<<<, =======, >>>>>>>）
# 保留需要的代码

# 4. 标记冲突已解决
git add backend/app/api/mcc.py

# 5. 继续 rebase
git rebase --continue

# 6. 如果还有其他冲突，重复步骤 3-5

# 7. rebase 完成后，进入后端目录并启动服务
cd backend
source venv/bin/activate
pkill -9 -f "uvicorn.*app.main" || true
nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 &
sleep 2
curl -s http://127.0.0.1:8000/health && echo "✓ 后端服务运行正常" || echo "✗ 后端服务启动失败，请查看 run.log"


















