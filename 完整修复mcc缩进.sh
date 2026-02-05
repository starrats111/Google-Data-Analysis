#!/bin/bash
# 完整修复mcc.py的缩进

cd ~/Google-Data-Analysis/backend

python3 << 'PYTHON_SCRIPT'
# 读取文件
with open('app/api/mcc.py', 'r', encoding='utf-8') as f:
    lines = f.readlines()

# 修复第403-456行的缩进（确保它们在try块内，16个空格）
# 第396行是 try:，所以第397行开始应该是16个空格（4个缩进级别）
# 但第403行开始的内容应该在try块内，所以应该是16个空格

fixed = False
for i in range(402, min(457, len(lines))):  # 第403-457行（索引402-456）
    line = lines[i]
    stripped = line.lstrip()
    
    # 跳过空行
    if not stripped:
        continue
    
    # 检查缩进级别
    # 第403-456行应该在try块内，所以应该有16个空格的缩进
    # 但return语句等可能需要不同的缩进级别
    
    # 如果这行不是except，且缩进少于16个空格，需要修复
    if not stripped.startswith('except') and not stripped.startswith('#'):
        # 计算当前缩进
        indent = len(line) - len(stripped)
        
        # 第403行（total_saved = 0）应该在try块内，16个空格
        if i == 402 and indent < 16:  # 第403行（索引402）
            lines[i] = '                ' + stripped
            fixed = True
            print(f"修复第{i+1}行: {repr(lines[i][:50])}")

if fixed:
    # 写回文件
    with open('app/api/mcc.py', 'w', encoding='utf-8') as f:
        f.writelines(lines)
    print("✓ 修复完成")
else:
    print("未发现需要修复的行")

PYTHON_SCRIPT

# 验证语法
python -m py_compile app/api/mcc.py && echo "✓ 语法正确" || echo "✗ 仍有语法错误"










