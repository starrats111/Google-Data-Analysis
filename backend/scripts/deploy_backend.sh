#!/bin/bash
# 后端部署脚本 - 阿里云服务器
# 使用方法: bash scripts/deploy_backend.sh

set -e  # 遇到错误立即退出

echo "=== 后端部署脚本 ==="
echo "开始时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# 项目根目录
PROJECT_ROOT="$HOME/Google-Data-Analysis"
BACKEND_DIR="$PROJECT_ROOT/backend"

# 检查项目目录是否存在
if [ ! -d "$PROJECT_ROOT" ]; then
    echo "错误: 项目目录不存在: $PROJECT_ROOT"
    echo "请先克隆项目: git clone https://github.com/starrats111/Google-Data-Analysis.git ~/Google-Data-Analysis"
    exit 1
fi

cd "$PROJECT_ROOT"

echo "=== 1. 拉取最新代码 ==="
git fetch origin
git pull origin main
echo "✓ 代码更新完成"
echo ""

echo "=== 2. 进入后端目录 ==="
cd "$BACKEND_DIR"
echo "当前目录: $(pwd)"
echo ""

echo "=== 3. 检查虚拟环境 ==="
if [ ! -d "venv" ]; then
    echo "虚拟环境不存在，正在创建..."
    python3 -m venv venv
    echo "✓ 虚拟环境创建完成"
fi

echo "=== 4. 激活虚拟环境 ==="
source venv/bin/activate
echo "✓ 虚拟环境已激活"
echo "Python版本: $(python --version)"
echo ""

echo "=== 5. 更新依赖包 ==="
pip install --upgrade pip -q
pip install -r requirements.txt -q
echo "✓ 依赖包更新完成"
echo ""

echo "=== 6. 停止现有服务器 ==="
# 查找并停止uvicorn进程
pkill -f "uvicorn.*app.main" || echo "没有运行中的服务器"
sleep 2
echo "✓ 服务器已停止"
echo ""

echo "=== 7. 检查端口占用 ==="
if lsof -ti:8000 > /dev/null 2>&1; then
    echo "警告: 端口8000仍被占用，强制停止..."
    lsof -ti:8000 | xargs kill -9 || true
    sleep 2
fi
echo "✓ 端口检查完成"
echo ""

echo "=== 8. 启动服务器 ==="
# 创建日志目录
mkdir -p logs

# 启动服务器（后台运行）
nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 &
SERVER_PID=$!

echo "服务器正在启动 (PID: $SERVER_PID)..."
sleep 3
echo ""

echo "=== 9. 检查服务器状态 ==="
# 等待服务器启动
for i in {1..10}; do
    if curl -s http://127.0.0.1:8000/health > /dev/null 2>&1; then
        echo "✓ 后端服务器启动成功!"
        echo "  进程ID: $(pgrep -f 'uvicorn app.main:app')"
        echo "  访问地址: http://0.0.0.0:8000"
        echo "  API文档: http://0.0.0.0:8000/docs"
        echo "  健康检查: http://0.0.0.0:8000/health"
        echo ""
        echo "=== 部署完成 ==="
        echo "完成时间: $(date '+%Y-%m-%d %H:%M:%S')"
        exit 0
    fi
    echo "等待服务器启动... ($i/10)"
    sleep 2
done

echo "✗ 服务器启动失败或未响应"
echo "查看日志:"
tail -n 30 run.log
echo ""
echo "=== 部署失败 ==="
exit 1

