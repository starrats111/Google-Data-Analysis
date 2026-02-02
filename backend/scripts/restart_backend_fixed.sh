#!/bin/bash
# 修复版后端重启脚本 - 确保服务器持续运行

set -e

echo "=== 后端部署脚本（修复版）==="
echo "开始时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# 项目根目录
PROJECT_ROOT="$HOME/Google-Data-Analysis"
BACKEND_DIR="$PROJECT_ROOT/backend"

# 检查项目目录
if [ ! -d "$PROJECT_ROOT" ]; then
    echo "错误: 项目目录不存在: $PROJECT_ROOT"
    exit 1
fi

cd "$PROJECT_ROOT"

echo "=== 1. 拉取最新代码 ==="
git pull origin main
echo "✓ 代码更新完成"
echo ""

echo "=== 2. 进入后端目录 ==="
cd "$BACKEND_DIR"
echo "当前目录: $(pwd)"
echo ""

echo "=== 3. 激活虚拟环境 ==="
source venv/bin/activate
echo "✓ 虚拟环境已激活"
echo "Python版本: $(python --version)"
echo ""

echo "=== 4. 停止现有服务器 ==="
# 查找并停止uvicorn进程
pkill -f "uvicorn.*app.main" || echo "没有运行中的服务器"
sleep 2

# 确保端口释放
if lsof -ti:8000 > /dev/null 2>&1; then
    echo "警告: 端口8000仍被占用，强制停止..."
    lsof -ti:8000 | xargs kill -9 || true
    sleep 2
fi
echo "✓ 服务器已停止，端口已释放"
echo ""

echo "=== 5. 检查代码语法 ==="
python -m py_compile app/main.py && echo "✓ main.py 语法正确" || echo "✗ main.py 有语法错误"
python -m py_compile app/api/affiliate.py && echo "✓ affiliate.py 语法正确" || echo "✗ affiliate.py 有语法错误"
echo ""

echo "=== 6. 测试应用导入 ==="
python -c "from app.main import app; print('✓ 应用导入成功')" || {
    echo "✗ 应用导入失败"
    exit 1
}
echo ""

echo "=== 7. 启动服务器 ==="
# 创建日志目录
mkdir -p logs

# 使用更可靠的方式启动服务器
# 方法1: 使用 nohup 并在后台运行
nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 &
SERVER_PID=$!

echo "服务器正在启动 (PID: $SERVER_PID)..."
sleep 5
echo ""

echo "=== 8. 检查服务器状态 ==="
# 等待服务器启动
for i in {1..10}; do
    if curl -s http://127.0.0.1:8000/health > /dev/null 2>&1; then
        echo "✓ 后端服务器启动成功!"
        echo "  进程ID: $SERVER_PID"
        echo "  访问地址: http://0.0.0.0:8000"
        echo "  API文档: http://0.0.0.0:8000/docs"
        echo "  健康检查: http://0.0.0.1:8000/health"
        echo ""
        echo "=== 部署完成 ==="
        echo "完成时间: $(date '+%Y-%m-%d %H:%M:%S')"
        echo ""
        echo "查看日志: tail -f $BACKEND_DIR/run.log"
        echo "检查进程: ps aux | grep uvicorn"
        exit 0
    fi
    echo "等待服务器启动... ($i/10)"
    sleep 2
done

echo "✗ 服务器启动失败或未响应"
echo "查看日志:"
tail -n 30 run.log
echo ""
echo "检查进程:"
ps aux | grep uvicorn | grep -v grep || echo "没有运行中的uvicorn进程"
echo ""
echo "=== 部署失败 ==="
exit 1

