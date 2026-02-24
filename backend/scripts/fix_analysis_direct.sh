#!/bin/bash
# 直接修复 analysis.py 的语法错误

cd ~/Google-Data-Analysis/backend

echo "=========================================="
echo "修复 analysis.py 语法错误"
echo "=========================================="
echo ""

# 使用sed直接修复
echo "1. 使用sed修复..."
sed -i 's/@router\.post("\/process"async def/@router.post("\/process")\nasync def/' app/api/analysis.py

# 如果sed失败，使用Python
if [ $? -ne 0 ] || grep -q '@router.post("/process"async def' app/api/analysis.py; then
    echo "   sed修复失败，使用Python修复..."
    python3 << 'EOF'
import re

file_path = 'app/api/analysis.py'

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# 修复各种可能的错误格式
# 1. @router.post("/process"async def
content = re.sub(
    r'@router\.post\("/process"\)?\s*async\s+def\s+process_analysis\(',
    '@router.post("/process")\nasync def process_analysis(',
    content
)

# 2. @router.post("/process")def
content = re.sub(
    r'@router\.post\("/process"\)\s*def\s+process_analysis\(',
    '@router.post("/process")\nasync def process_analysis(',
    content
)

# 3. 确保 @router.post("/process") 后面有换行
if '@router.post("/process")' in content and 'async def process_analysis' in content:
    # 检查它们是否在同一行
    lines = content.split('\n')
    for i, line in enumerate(lines):
        if '@router.post("/process")' in line and 'async def' in line:
            # 分割这一行
            if 'async def' in line:
                parts = line.split('async def', 1)
                lines[i] = parts[0].rstrip() + '\nasync def' + parts[1]
                content = '\n'.join(lines)
                break

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("✓ 已修复")
EOF
fi

echo ""

# 验证
echo "2. 验证语法..."
python3 -m py_compile app/api/analysis.py 2>&1 && echo "   ✓ 语法正确" || {
    echo "   ✗ 仍有语法错误"
    echo ""
    echo "   查看第24-30行:"
    sed -n '24,30p' app/api/analysis.py
    exit 1
}

echo ""

# 测试导入
echo "3. 测试导入..."
python3 -c "from app.api import analysis; print('   ✓ 导入成功')" 2>&1 || {
    echo "   ✗ 导入失败"
    exit 1
}

echo ""
echo "=========================================="
echo "✓ 修复完成"
echo "=========================================="


















