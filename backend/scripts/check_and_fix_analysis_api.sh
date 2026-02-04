#!/bin/bash
# 检查并修复分析 API（如果代码未更新）

cd ~/Google-Data-Analysis/backend || exit 1

echo "检查当前代码状态..."
echo ""

# 检查是否已经有 Query 导入
if grep -q "from fastapi import.*Query" app/api/analysis.py; then
    echo "✓ Query 已导入"
else
    echo "✗ Query 未导入，需要修复"
    # 修复导入
    sed -i 's/from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File, Form$/from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File, Form, Query/' app/api/analysis.py
    echo "  ✓ 已添加 Query 导入"
fi

# 检查 daily 路由参数
if grep -q "target_date: str = Query" app/api/analysis.py; then
    echo "✓ daily 路由参数已修复"
else
    echo "✗ daily 路由参数需要修复"
    # 使用 Python 脚本修复（更可靠）
    python3 << 'EOF'
import re

with open('app/api/analysis.py', 'r', encoding='utf-8') as f:
    content = f.read()

# 修复 daily 路由参数
content = re.sub(
    r'(@router\.post\("/daily"\)\s+async def generate_daily_analysis_from_api\(\s+)target_date: str,',
    r'\1target_date: str = Query(..., description="目标日期 YYYY-MM-DD"),',
    content
)

# 修复 l7d 路由参数
content = re.sub(
    r'(@router\.post\("/l7d"\)\s+async def generate_l7d_analysis_from_api\(\s+)end_date: Optional\[str\] = None,',
    r'\1end_date: Optional[str] = Query(None, description="结束日期 YYYY-MM-DD（默认为昨天）"),',
    content
)

with open('app/api/analysis.py', 'w', encoding='utf-8') as f:
    f.write(content)

print("  ✓ 已修复路由参数")
EOF
fi

# 验证
echo ""
echo "验证修复结果..."
if grep -q "target_date: str = Query" app/api/analysis.py && grep -q "end_date: Optional\[str\] = Query" app/api/analysis.py; then
    echo "✓ 所有修复已完成"
    echo ""
    echo "请重启服务："
    echo "  pkill -9 -f 'uvicorn.*app.main' || true"
    echo "  sleep 2"
    echo "  source venv/bin/activate"
    echo "  nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 &"
else
    echo "✗ 修复可能不完整，请手动检查"
fi

