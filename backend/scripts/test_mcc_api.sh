#!/bin/bash
# 测试MCC API接口

cd ~/Google-Data-Analysis/backend
source venv/bin/activate

echo "=== 测试MCC API接口 ==="

# 1. 检查服务是否运行
echo "1. 检查服务状态..."
if curl -s http://127.0.0.1:8000/health > /dev/null 2>&1; then
    echo "✓ 服务运行正常"
else
    echo "✗ 服务未运行，请先启动服务"
    exit 1
fi

# 2. 测试健康检查
echo "2. 测试健康检查接口..."
health_response=$(curl -s http://127.0.0.1:8000/health)
echo "响应: $health_response"

# 3. 检查数据库连接
echo "3. 检查数据库连接..."
python3 << 'EOF'
from app.database import SessionLocal
from app.models.google_ads_api_data import GoogleMccAccount

try:
    db = SessionLocal()
    count = db.query(GoogleMccAccount).count()
    print(f"✓ 数据库连接正常，MCC账号总数: {count}")
    db.close()
except Exception as e:
    print(f"✗ 数据库连接失败: {e}")
    import traceback
    traceback.print_exc()
EOF

# 4. 测试MCC账号列表接口（需要认证，这里只测试路由是否存在）
echo "4. 测试MCC账号列表接口路由..."
response=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8000/api/mcc/accounts)
echo "HTTP状态码: $response"
if [ "$response" = "401" ] || [ "$response" = "403" ]; then
    echo "✓ 接口路由正常（需要认证）"
elif [ "$response" = "200" ]; then
    echo "✓ 接口正常"
else
    echo "✗ 接口可能有问题，状态码: $response"
fi

# 5. 检查最近的错误日志
echo "5. 检查最近的错误日志..."
if [ -f "run.log" ]; then
    echo "最后20行日志:"
    tail -n 20 run.log | grep -i "error\|exception\|traceback" || echo "没有发现错误"
else
    echo "日志文件不存在"
fi

echo "=== 测试完成 ==="


# 测试MCC API接口

cd ~/Google-Data-Analysis/backend
source venv/bin/activate

echo "=== 测试MCC API接口 ==="

# 1. 检查服务是否运行
echo "1. 检查服务状态..."
if curl -s http://127.0.0.1:8000/health > /dev/null 2>&1; then
    echo "✓ 服务运行正常"
else
    echo "✗ 服务未运行，请先启动服务"
    exit 1
fi

# 2. 测试健康检查
echo "2. 测试健康检查接口..."
health_response=$(curl -s http://127.0.0.1:8000/health)
echo "响应: $health_response"

# 3. 检查数据库连接
echo "3. 检查数据库连接..."
python3 << 'EOF'
from app.database import SessionLocal
from app.models.google_ads_api_data import GoogleMccAccount

try:
    db = SessionLocal()
    count = db.query(GoogleMccAccount).count()
    print(f"✓ 数据库连接正常，MCC账号总数: {count}")
    db.close()
except Exception as e:
    print(f"✗ 数据库连接失败: {e}")
    import traceback
    traceback.print_exc()
EOF

# 4. 测试MCC账号列表接口（需要认证，这里只测试路由是否存在）
echo "4. 测试MCC账号列表接口路由..."
response=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8000/api/mcc/accounts)
echo "HTTP状态码: $response"
if [ "$response" = "401" ] || [ "$response" = "403" ]; then
    echo "✓ 接口路由正常（需要认证）"
elif [ "$response" = "200" ]; then
    echo "✓ 接口正常"
else
    echo "✗ 接口可能有问题，状态码: $response"
fi

# 5. 检查最近的错误日志
echo "5. 检查最近的错误日志..."
if [ -f "run.log" ]; then
    echo "最后20行日志:"
    tail -n 20 run.log | grep -i "error\|exception\|traceback" || echo "没有发现错误"
else
    echo "日志文件不存在"
fi

echo "=== 测试完成 ==="










