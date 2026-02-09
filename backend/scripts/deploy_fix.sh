#!/bin/bash
# 简单的MCC同步修复部署脚本
# 自动处理所有步骤，减少错误

cd ~/Google-Data-Analysis/backend
source venv/bin/activate

echo "=== 开始部署MCC同步修复 ==="

# 1. 备份当前代码
echo "1. 备份当前代码..."
cp app/api/mcc.py app/api/mcc.py.backup.$(date +%Y%m%d_%H%M%S) 2>/dev/null || true

# 2. 处理Git冲突 - 强制使用远程代码，然后应用修复
echo "2. 处理Git冲突..."
git fetch origin main
git reset --hard origin/main 2>/dev/null || echo "Git重置失败，继续使用本地代码"

# 3. 验证修复文件是否存在
if [ ! -f "app/api/mcc.py" ]; then
    echo "错误: app/api/mcc.py 不存在"
    exit 1
fi

# 4. 检查语法
echo "3. 检查代码语法..."
python3 -m py_compile app/api/mcc.py && echo "✓ 语法正确" || {
    echo "✗ 语法错误，恢复备份..."
    cp app/api/mcc.py.backup.* app/api/mcc.py 2>/dev/null || true
    exit 1
}

# 5. 停止旧服务
echo "4. 停止旧服务..."
pkill -9 -f "uvicorn.*app.main" 2>/dev/null || true
sleep 2
lsof -ti:8000 | xargs kill -9 2>/dev/null || true
sleep 2

# 6. 启动新服务
echo "5. 启动新服务..."
nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 &
sleep 5

# 7. 测试服务
echo "6. 测试服务..."
if curl -s http://127.0.0.1:8000/health > /dev/null; then
    echo "✓ 服务运行正常"
    echo "=== 部署完成 ==="
else
    echo "✗ 服务启动失败，查看日志:"
    tail -n 30 run.log
    exit 1
fi


# 简单的MCC同步修复部署脚本
# 自动处理所有步骤，减少错误

cd ~/Google-Data-Analysis/backend
source venv/bin/activate

echo "=== 开始部署MCC同步修复 ==="

# 1. 备份当前代码
echo "1. 备份当前代码..."
cp app/api/mcc.py app/api/mcc.py.backup.$(date +%Y%m%d_%H%M%S) 2>/dev/null || true

# 2. 处理Git冲突 - 强制使用远程代码，然后应用修复
echo "2. 处理Git冲突..."
git fetch origin main
git reset --hard origin/main 2>/dev/null || echo "Git重置失败，继续使用本地代码"

# 3. 验证修复文件是否存在
if [ ! -f "app/api/mcc.py" ]; then
    echo "错误: app/api/mcc.py 不存在"
    exit 1
fi

# 4. 检查语法
echo "3. 检查代码语法..."
python3 -m py_compile app/api/mcc.py && echo "✓ 语法正确" || {
    echo "✗ 语法错误，恢复备份..."
    cp app/api/mcc.py.backup.* app/api/mcc.py 2>/dev/null || true
    exit 1
}

# 5. 停止旧服务
echo "4. 停止旧服务..."
pkill -9 -f "uvicorn.*app.main" 2>/dev/null || true
sleep 2
lsof -ti:8000 | xargs kill -9 2>/dev/null || true
sleep 2

# 6. 启动新服务
echo "5. 启动新服务..."
nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 &
sleep 5

# 7. 测试服务
echo "6. 测试服务..."
if curl -s http://127.0.0.1:8000/health > /dev/null; then
    echo "✓ 服务运行正常"
    echo "=== 部署完成 ==="
else
    echo "✗ 服务启动失败，查看日志:"
    tail -n 30 run.log
    exit 1
fi












