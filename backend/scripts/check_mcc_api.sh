#!/bin/bash
# 检查MCC API接口

cd ~/Google-Data-Analysis/backend
source venv/bin/activate

echo "=== 检查MCC API ==="

# 1. 检查服务
echo "1. 检查服务..."
if ! curl -s http://127.0.0.1:8000/health > /dev/null; then
    echo "✗ 服务未运行"
    exit 1
fi
echo "✓ 服务运行正常"

# 2. 检查数据库
echo "2. 检查数据库..."
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

# 3. 检查日志
echo "3. 检查最近日志..."
if [ -f "run.log" ]; then
    echo "最后10行日志:"
    tail -n 10 run.log
    echo ""
    echo "错误日志:"
    tail -n 50 run.log | grep -i "error\|exception\|traceback" || echo "没有发现错误"
else
    echo "日志文件不存在"
fi

echo "=== 检查完成 ==="


# 检查MCC API接口

cd ~/Google-Data-Analysis/backend
source venv/bin/activate

echo "=== 检查MCC API ==="

# 1. 检查服务
echo "1. 检查服务..."
if ! curl -s http://127.0.0.1:8000/health > /dev/null; then
    echo "✗ 服务未运行"
    exit 1
fi
echo "✓ 服务运行正常"

# 2. 检查数据库
echo "2. 检查数据库..."
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

# 3. 检查日志
echo "3. 检查最近日志..."
if [ -f "run.log" ]; then
    echo "最后10行日志:"
    tail -n 10 run.log
    echo ""
    echo "错误日志:"
    tail -n 50 run.log | grep -i "error\|exception\|traceback" || echo "没有发现错误"
else
    echo "日志文件不存在"
fi

echo "=== 检查完成 ==="









