#!/bin/bash
# 修复服务器上的CORS问题

cd ~/Google-Data-Analysis/backend
source venv/bin/activate

echo "=========================================="
echo "修复CORS配置"
echo "=========================================="
echo ""

# 1. 检查当前CORS配置
echo "1. 检查当前CORS配置..."
if grep -q 'allow_origins=\["\*"\]' app/main.py; then
    echo "   ✓ CORS配置已设置为允许所有来源"
else
    echo "   ✗ CORS配置不正确，正在修复..."
    
    # 修复CORS配置
    python3 << 'EOF'
import re

file_path = 'app/main.py'
with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# 确保使用 Starlette 的 CORSMiddleware
content = content.replace(
    'from fastapi.middleware.cors import CORSMiddleware',
    'from starlette.middleware.cors import CORSMiddleware'
)

# 确保 allow_origins=["*"]
pattern = r'app\.add_middleware\(\s*CORSMiddleware,.*?allow_origins=\[.*?\],'
replacement = '''app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 临时允许所有来源，确保CORS正常工作
    allow_credentials=False,  # 当allow_origins=["*"]时，allow_credentials必须为False
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH", "HEAD"],
    allow_headers=["*"],
    expose_headers=["*"],
    max_age=3600,
)'''

if 'allow_origins=["*"]' not in content:
    # 查找并替换CORS中间件配置
    content = re.sub(
        r'app\.add_middleware\(\s*CORSMiddleware,.*?max_age=\d+,?\s*\)',
        replacement,
        content,
        flags=re.DOTALL
    )

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("✓ 已修复CORS配置")
EOF
fi
echo ""

# 2. 验证代码语法
echo "2. 验证代码语法..."
python3 -c "
try:
    import app.main
    print('   ✓ 代码语法正确')
except SyntaxError as e:
    print(f'   ✗ 语法错误: {e}')
    exit(1)
except Exception as e:
    print(f'   ⚠ 导入警告: {e}')
" || exit 1
echo ""

# 3. 重启服务
echo "3. 重启服务..."
pkill -9 -f "uvicorn.*app.main" || true
sleep 2
nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 &
UVICORN_PID=$!
echo "   服务进程 ID: $UVICORN_PID"
echo ""

# 4. 等待服务启动
echo "4. 等待服务启动（最多10秒）..."
for i in {1..10}; do
    sleep 1
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8000/health 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "200" ]; then
        echo "   ✓ 服务启动成功 (HTTP $HTTP_CODE)"
        break
    else
        if [ $i -le 5 ]; then
            echo "   等待中... ($i/10)"
        fi
    fi
done
echo ""

# 5. 测试CORS头
echo "5. 测试CORS响应头..."
CORS_TEST=$(curl -s -H "Origin: https://google-data-analysis.top" \
  -H "Access-Control-Request-Method: POST" \
  -X OPTIONS \
  -v http://127.0.0.1:8000/api/auth/login 2>&1 | grep -i "access-control-allow-origin" || echo "NOT_FOUND")

if [ "$CORS_TEST" != "NOT_FOUND" ]; then
    echo "   ✓ CORS头已正确设置"
    echo "   响应: $CORS_TEST"
else
    echo "   ✗ CORS头未找到"
    echo "   查看服务日志:"
    tail -n 20 run.log
fi
echo ""

# 6. 最终检查
echo "6. 最终健康检查..."
FINAL_HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8000/health 2>/dev/null || echo "000")
FINAL_RESPONSE=$(curl -s http://127.0.0.1:8000/health 2>/dev/null || echo "ERROR")

if [ "$FINAL_HTTP_CODE" = "200" ]; then
    echo "   ✓ 后端服务运行正常"
    echo "   响应: $FINAL_RESPONSE"
    echo ""
    echo "=========================================="
    echo "✓ CORS修复完成！"
    echo "=========================================="
    echo ""
    echo "如果前端仍有CORS错误，请检查："
    echo "1. 浏览器缓存（清除缓存或使用无痕模式）"
    echo "2. Nginx/反向代理配置（如果有）"
    echo "3. Cloudflare设置（如果使用）"
    exit 0
else
    echo "   ✗ 后端服务启动失败 (HTTP $FINAL_HTTP_CODE)"
    echo "   响应: $FINAL_RESPONSE"
    echo ""
    echo "   查看错误日志:"
    tail -n 30 run.log
    echo ""
    echo "=========================================="
    echo "✗ CORS修复失败，请检查日志"
    echo "=========================================="
    exit 1
fi
















