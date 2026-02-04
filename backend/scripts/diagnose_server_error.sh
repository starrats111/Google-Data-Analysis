#!/bin/bash
# 诊断服务器 Internal Server Error 问题

echo "=========================================="
echo "后端服务错误诊断脚本"
echo "=========================================="
echo ""

# 1. 检查服务是否在运行
echo "1. 检查 uvicorn 进程..."
ps aux | grep -E "uvicorn.*app.main" | grep -v grep
if [ $? -eq 0 ]; then
    echo "   ✓ 服务进程正在运行"
else
    echo "   ✗ 服务进程未运行"
fi
echo ""

# 2. 检查端口占用
echo "2. 检查端口 8000 占用情况..."
netstat -tlnp 2>/dev/null | grep :8000 || ss -tlnp 2>/dev/null | grep :8000
echo ""

# 3. 查看最新的日志
echo "3. 查看最新的 run.log (最后50行)..."
if [ -f "run.log" ]; then
    echo "   --- run.log 最后50行 ---"
    tail -n 50 run.log
    echo ""
    echo "   --- 错误信息 ---"
    grep -i "error\|exception\|traceback\|failed" run.log | tail -n 20
else
    echo "   ✗ run.log 文件不存在"
fi
echo ""

# 4. 测试健康检查端点
echo "4. 测试 /health 端点..."
HEALTH_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" http://127.0.0.1:8000/health 2>&1)
HTTP_CODE=$(echo "$HEALTH_RESPONSE" | grep "HTTP_CODE" | cut -d: -f2)
BODY=$(echo "$HEALTH_RESPONSE" | grep -v "HTTP_CODE")

echo "   HTTP 状态码: $HTTP_CODE"
echo "   响应内容: $BODY"
echo ""

# 5. 测试根端点
echo "5. 测试根端点 / ..."
ROOT_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" http://127.0.0.1:8000/ 2>&1)
ROOT_HTTP_CODE=$(echo "$ROOT_RESPONSE" | grep "HTTP_CODE" | cut -d: -f2)
ROOT_BODY=$(echo "$ROOT_RESPONSE" | grep -v "HTTP_CODE")

echo "   HTTP 状态码: $ROOT_HTTP_CODE"
echo "   响应内容: $ROOT_BODY"
echo ""

# 6. 检查 Python 导入
echo "6. 检查关键模块导入..."
cd ~/Google-Data-Analysis/backend 2>/dev/null || cd backend 2>/dev/null || pwd
source venv/bin/activate 2>/dev/null || echo "   警告: 无法激活虚拟环境"

python3 -c "
import sys
print('   Python 版本:', sys.version)
print('')

modules_to_check = [
    'fastapi',
    'uvicorn',
    'sqlalchemy',
    'app.main',
    'app.config',
    'app.database',
    'app.services.scheduler',
]

for module in modules_to_check:
    try:
        __import__(module)
        print(f'   ✓ {module}')
    except Exception as e:
        print(f'   ✗ {module}: {e}')
" 2>&1

echo ""
echo "=========================================="
echo "诊断完成"
echo "=========================================="

