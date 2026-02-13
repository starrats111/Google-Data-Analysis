#!/bin/bash
# 修复 analysis.py 的语法错误

cd ~/Google-Data-Analysis/backend

echo "=========================================="
echo "修复 analysis.py 语法错误"
echo "=========================================="
echo ""

# 1. 查看第30-40行
echo "1. 查看第30-40行..."
sed -n '30,40p' app/api/analysis.py
echo ""

# 2. 修复语法错误（移除多余的括号）
echo "2. 修复语法错误..."
python3 << 'EOF'
import re

file_path = 'app/api/analysis.py'

with open(file_path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

# 查找并修复语法错误
fixed = False
for i, line in enumerate(lines, 1):
    # 查找类似 ")def" 或 ")async def" 的模式
    if re.search(r'^\s*\)\s*(async\s+)?def\s+', line):
        print(f"发现语法错误在第 {i} 行: {line.strip()}")
        # 移除多余的右括号
        lines[i-1] = re.sub(r'^\s*\)\s*', '', line)
        fixed = True
        print(f"修复后: {lines[i-1].strip()}")

if fixed:
    with open(file_path, 'w', encoding='utf-8') as f:
        f.writelines(lines)
    print("✓ 已修复语法错误")
else:
    print("未发现明显的语法错误，检查其他可能的问题...")
    
    # 检查是否有未闭合的括号
    content = ''.join(lines)
    
    # 检查 @router.post("/process") 后面的内容
    pattern = r'@router\.post\("/process"\)\s*(.*?)(async\s+def\s+process_analysis)'
    match = re.search(pattern, content, re.DOTALL)
    if match:
        between = match.group(1)
        if between.strip() and ')' in between:
            print("发现 @router.post 和 def 之间有额外的括号")
            # 移除之间的内容
            content = re.sub(pattern, r'@router.post("/process")\n\2', content, flags=re.DOTALL)
            with open(file_path, 'w', encoding='utf-8') as f:
                f.write(content)
            print("✓ 已修复")
EOF

echo ""

# 3. 验证语法
echo "3. 验证语法..."
python3 -m py_compile app/api/analysis.py 2>&1 && echo "   ✓ 语法正确" || echo "   ✗ 仍有语法错误"
echo ""

# 4. 尝试导入
echo "4. 尝试导入..."
python3 -c "
try:
    from app.api import analysis
    print('   ✓ 导入成功')
except SyntaxError as e:
    print(f'   ✗ 语法错误: {e}')
    print(f'   文件: {e.filename}, 行号: {e.lineno}')
    print(f'   错误内容: {e.text}')
except Exception as e:
    print(f'   ✗ 其他错误: {e}')
" 2>&1

echo ""
echo "=========================================="
echo "修复完成"
echo "=========================================="
















