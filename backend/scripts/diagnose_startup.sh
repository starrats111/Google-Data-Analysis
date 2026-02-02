#!/bin/bash
# 诊断服务器启动问题

echo "=== 诊断服务器启动问题 ==="
echo ""

# 1. 检查日志
echo "1. 检查最近的错误日志："
echo "----------------------------------------"
tail -n 50 ~/Google-Data-Analysis/backend/run.log 2>/dev/null || echo "日志文件不存在或无法读取"
echo ""

# 2. 检查端口占用
echo "2. 检查端口8000占用情况："
echo "----------------------------------------"
lsof -i :8000 2>/dev/null || echo "端口8000未被占用"
echo ""

# 3. 检查Python环境
echo "3. 检查Python环境："
echo "----------------------------------------"
cd ~/Google-Data-Analysis/backend
source venv/bin/activate 2>/dev/null && python --version || echo "虚拟环境激活失败"
echo ""

# 4. 检查依赖
echo "4. 检查关键依赖："
echo "----------------------------------------"
source venv/bin/activate 2>/dev/null && python -c "import fastapi; print(f'FastAPI: {fastapi.__version__}')" 2>&1 || echo "FastAPI未安装"
source venv/bin/activate 2>/dev/null && python -c "import uvicorn; print(f'Uvicorn: {uvicorn.__version__}')" 2>&1 || echo "Uvicorn未安装"
echo ""

# 5. 检查代码语法
echo "5. 检查代码语法："
echo "----------------------------------------"
source venv/bin/activate 2>/dev/null && python -m py_compile app/main.py 2>&1 && echo "✓ main.py 语法正确" || echo "✗ main.py 有语法错误"
source venv/bin/activate 2>/dev/null && python -m py_compile app/api/affiliate.py 2>&1 && echo "✓ affiliate.py 语法正确" || echo "✗ affiliate.py 有语法错误"
echo ""

# 6. 尝试导入应用
echo "6. 尝试导入应用："
echo "----------------------------------------"
cd ~/Google-Data-Analysis/backend
source venv/bin/activate 2>/dev/null && python -c "from app.main import app; print('✓ 应用导入成功')" 2>&1 || echo "✗ 应用导入失败"
echo ""

# 7. 检查进程
echo "7. 检查uvicorn进程："
echo "----------------------------------------"
ps aux | grep uvicorn | grep -v grep || echo "没有运行中的uvicorn进程"
echo ""

echo "=== 诊断完成 ==="

