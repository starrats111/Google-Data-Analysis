#!/usr/bin/env python3
# 修复mcc.py的缩进错误

import re

# 读取文件
with open('app/api/mcc.py', 'r', encoding='utf-8') as f:
    lines = f.readlines()

# 修复第401行（索引是400，因为从0开始）
if len(lines) > 400:
    # 检查第401行的内容
    line_401 = lines[400]
    print(f"修复前第401行: {repr(line_401)}")
    
    # 如果这行是raise语句，确保它有正确的缩进（20个空格，在if块内）
    if 'raise HTTPException' in line_401:
        # 移除所有前导空格，然后添加20个空格
        lines[400] = '                    ' + line_401.lstrip()
        print(f"修复后第401行: {repr(lines[400])}")

# 写回文件
with open('app/api/mcc.py', 'w', encoding='utf-8') as f:
    f.writelines(lines)

print("✓ 修复完成")










