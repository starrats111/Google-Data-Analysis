#!/bin/bash
# 检查服务启动错误

cd ~/Google-Data-Analysis/backend

echo "=========================================="
echo "检查服务启动错误"
echo "=========================================="
echo ""

# 1. 查看最新日志
echo "1. 查看最新日志（最后50行）..."
tail -n 50 run.log
echo ""

# 2. 检查Python语法
echo "2. 检查Python语法..."
python3 -m py_compile app/main.py 2>&1 && echo "   ✓ 语法正确" || echo "   ✗ 语法错误"
echo ""

# 3. 尝试导入模块
echo "3. 尝试导入模块..."
python3 << 'EOF'
try:
    import app.main
    print("   ✓ 模块导入成功")
except Exception as e:
    print(f"   ✗ 模块导入失败: {e}")
    import traceback
    traceback.print_exc()
EOF
echo ""

# 4. 检查依赖
echo "4. 检查关键依赖..."
python3 -c "
try:
    import fastapi
    import starlette
    import uvicorn
    print('   ✓ 关键依赖已安装')
except ImportError as e:
    print(f'   ✗ 缺少依赖: {e}')
"
echo ""

# 5. 手动启动测试（前台运行，查看错误）
echo "5. 手动启动测试（5秒后自动停止）..."
timeout 5 uvicorn app.main:app --host 127.0.0.1 --port 8001 2>&1 || true
echo ""


















