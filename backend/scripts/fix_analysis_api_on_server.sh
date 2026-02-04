#!/bin/bash
# 直接在服务器上修复分析 API 路由

echo "=========================================="
echo "修复分析 API 路由（服务器端）"
echo "=========================================="
echo ""

cd ~/Google-Data-Analysis/backend || exit 1

# 备份原文件
cp app/api/analysis.py app/api/analysis.py.bak
echo "✓ 已备份原文件"

# 修复导入：添加 Query
sed -i 's/from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File, Form$/from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File, Form, Query/' app/api/analysis.py

# 修复 daily 路由参数
sed -i 's/async def generate_daily_analysis_from_api($/async def generate_daily_analysis_from_api(/' app/api/analysis.py
sed -i '/@router.post("\/daily")/,/async def generate_daily_analysis_from_api(/ {
    /target_date: str,/ s/target_date: str,/target_date: str = Query(..., description="目标日期 YYYY-MM-DD"),/
}' app/api/analysis.py

# 修复 l7d 路由参数
sed -i '/@router.post("\/l7d")/,/async def generate_l7d_analysis_from_api(/ {
    /end_date: Optional\[str\] = None,/ s/end_date: Optional\[str\] = None,/end_date: Optional[str] = Query(None, description="结束日期 YYYY-MM-DD（默认为昨天）"),/
}' app/api/analysis.py

echo "✓ 已修复路由参数定义"

# 验证修改
if grep -q "Query" app/api/analysis.py && grep -q "target_date: str = Query" app/api/analysis.py; then
    echo "✓ 验证通过：Query 已添加"
else
    echo "✗ 验证失败：可能需要手动检查"
fi

echo ""
echo "=========================================="
echo "修复完成，请重启服务"
echo "=========================================="

