#!/bin/bash
# 快速修复MCC同步问题 - 直接在服务器上修改代码

cd ~/Google-Data-Analysis/backend
source venv/bin/activate

echo "=== 快速修复MCC同步问题 ==="

# 1. 备份
cp app/api/mcc.py app/api/mcc.py.backup 2>/dev/null || true

# 2. 修复代码 - 使用sed直接修改
echo "修复 background_tasks 参数..."

# 检查是否已经修复
if grep -q "background_tasks: BackgroundTasks," app/api/mcc.py && ! grep -q "background_tasks: BackgroundTasks = None" app/api/mcc.py; then
    echo "✓ 代码已经修复，跳过"
else
    # 修复函数签名
    python3 << 'PYTHON_FIX'
import re

# 读取文件
with open('app/api/mcc.py', 'r', encoding='utf-8') as f:
    content = f.read()

# 修复函数签名：将 background_tasks: BackgroundTasks = None 改为正确的顺序
old_pattern = r'async def sync_mcc_data\(\s*mcc_id: int,\s*request_data: Optional\[dict\] = None,\s*request: Request = None,\s*background_tasks: BackgroundTasks = None,'
new_pattern = r'async def sync_mcc_data(\n    mcc_id: int,\n    request: Request,\n    background_tasks: BackgroundTasks,\n    request_data: Optional[dict] = None,'

if re.search(old_pattern, content):
    content = re.sub(old_pattern, new_pattern, content)
    print("✓ 修复函数签名")
else:
    # 尝试其他可能的模式
    old_pattern2 = r'async def sync_mcc_data\(\s*mcc_id: int,\s*request_data: Optional\[dict\] = None,\s*request: Request = None,\s*background_tasks: BackgroundTasks = None,'
    if re.search(old_pattern2, content):
        content = re.sub(old_pattern2, new_pattern, content)
        print("✓ 修复函数签名（模式2）")
    else:
        print("⚠ 未找到需要修复的模式，可能已经修复")

# 删除死代码（如果存在）
# 查找并删除从 "# 如果没有background_tasks" 到下一个 elif/else 之间的代码
dead_code_pattern = r'# 如果没有background_tasks.*?(\n\s+elif|\n\s+else|\n\s+# 如果提供了单个日期)'
if re.search(dead_code_pattern, content, re.DOTALL):
    content = re.sub(dead_code_pattern, r'\1', content, flags=re.DOTALL)
    print("✓ 删除死代码")

# 确保 background_tasks 的使用是正确的（移除 if background_tasks: 检查）
if 'if background_tasks:' in content:
    # 找到并替换
    lines = content.split('\n')
    new_lines = []
    skip_next = False
    for i, line in enumerate(lines):
        if 'if background_tasks:' in line:
            # 跳过 if 行，直接保留后面的代码
            skip_next = True
            continue
        elif skip_next and line.strip().startswith('background_tasks.add_task'):
            # 保留这行，移除缩进
            new_lines.append('                ' + line.strip())
            skip_next = False
        elif skip_next and (line.strip() == '' or line.strip().startswith('#')):
            continue
        elif skip_next:
            skip_next = False
            new_lines.append(line)
        else:
            new_lines.append(line)
    content = '\n'.join(new_lines)
    print("✓ 移除 background_tasks 检查")

# 保存文件
with open('app/api/mcc.py', 'w', encoding='utf-8') as f:
    f.write(content)
    
print("✓ 代码修复完成")
PYTHON_FIX
fi

# 3. 检查语法
echo "检查语法..."
python3 -m py_compile app/api/mcc.py && echo "✓ 语法正确" || {
    echo "✗ 语法错误，恢复备份..."
    cp app/api/mcc.py.backup app/api/mcc.py 2>/dev/null || true
    exit 1
}

# 4. 停止旧服务
echo "停止旧服务..."
pkill -9 -f "uvicorn.*app.main" 2>/dev/null || true
sleep 2
lsof -ti:8000 | xargs kill -9 2>/dev/null || true
sleep 2

# 5. 启动服务
echo "启动服务..."
nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 &
sleep 5

# 6. 检查服务状态
echo "检查服务状态..."
if curl -s http://127.0.0.1:8000/health > /dev/null 2>&1; then
    echo "✓ 服务运行正常"
    echo "=== 修复完成 ==="
else
    echo "✗ 服务启动失败，查看日志:"
    tail -n 30 run.log
    echo ""
    echo "请检查错误信息并手动修复"
    exit 1
fi


# 快速修复MCC同步问题 - 直接在服务器上修改代码

cd ~/Google-Data-Analysis/backend
source venv/bin/activate

echo "=== 快速修复MCC同步问题 ==="

# 1. 备份
cp app/api/mcc.py app/api/mcc.py.backup 2>/dev/null || true

# 2. 修复代码 - 使用sed直接修改
echo "修复 background_tasks 参数..."

# 检查是否已经修复
if grep -q "background_tasks: BackgroundTasks," app/api/mcc.py && ! grep -q "background_tasks: BackgroundTasks = None" app/api/mcc.py; then
    echo "✓ 代码已经修复，跳过"
else
    # 修复函数签名
    python3 << 'PYTHON_FIX'
import re

# 读取文件
with open('app/api/mcc.py', 'r', encoding='utf-8') as f:
    content = f.read()

# 修复函数签名：将 background_tasks: BackgroundTasks = None 改为正确的顺序
old_pattern = r'async def sync_mcc_data\(\s*mcc_id: int,\s*request_data: Optional\[dict\] = None,\s*request: Request = None,\s*background_tasks: BackgroundTasks = None,'
new_pattern = r'async def sync_mcc_data(\n    mcc_id: int,\n    request: Request,\n    background_tasks: BackgroundTasks,\n    request_data: Optional[dict] = None,'

if re.search(old_pattern, content):
    content = re.sub(old_pattern, new_pattern, content)
    print("✓ 修复函数签名")
else:
    # 尝试其他可能的模式
    old_pattern2 = r'async def sync_mcc_data\(\s*mcc_id: int,\s*request_data: Optional\[dict\] = None,\s*request: Request = None,\s*background_tasks: BackgroundTasks = None,'
    if re.search(old_pattern2, content):
        content = re.sub(old_pattern2, new_pattern, content)
        print("✓ 修复函数签名（模式2）")
    else:
        print("⚠ 未找到需要修复的模式，可能已经修复")

# 删除死代码（如果存在）
# 查找并删除从 "# 如果没有background_tasks" 到下一个 elif/else 之间的代码
dead_code_pattern = r'# 如果没有background_tasks.*?(\n\s+elif|\n\s+else|\n\s+# 如果提供了单个日期)'
if re.search(dead_code_pattern, content, re.DOTALL):
    content = re.sub(dead_code_pattern, r'\1', content, flags=re.DOTALL)
    print("✓ 删除死代码")

# 确保 background_tasks 的使用是正确的（移除 if background_tasks: 检查）
if 'if background_tasks:' in content:
    # 找到并替换
    lines = content.split('\n')
    new_lines = []
    skip_next = False
    for i, line in enumerate(lines):
        if 'if background_tasks:' in line:
            # 跳过 if 行，直接保留后面的代码
            skip_next = True
            continue
        elif skip_next and line.strip().startswith('background_tasks.add_task'):
            # 保留这行，移除缩进
            new_lines.append('                ' + line.strip())
            skip_next = False
        elif skip_next and (line.strip() == '' or line.strip().startswith('#')):
            continue
        elif skip_next:
            skip_next = False
            new_lines.append(line)
        else:
            new_lines.append(line)
    content = '\n'.join(new_lines)
    print("✓ 移除 background_tasks 检查")

# 保存文件
with open('app/api/mcc.py', 'w', encoding='utf-8') as f:
    f.write(content)
    
print("✓ 代码修复完成")
PYTHON_FIX
fi

# 3. 检查语法
echo "检查语法..."
python3 -m py_compile app/api/mcc.py && echo "✓ 语法正确" || {
    echo "✗ 语法错误，恢复备份..."
    cp app/api/mcc.py.backup app/api/mcc.py 2>/dev/null || true
    exit 1
}

# 4. 停止旧服务
echo "停止旧服务..."
pkill -9 -f "uvicorn.*app.main" 2>/dev/null || true
sleep 2
lsof -ti:8000 | xargs kill -9 2>/dev/null || true
sleep 2

# 5. 启动服务
echo "启动服务..."
nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 &
sleep 5

# 6. 检查服务状态
echo "检查服务状态..."
if curl -s http://127.0.0.1:8000/health > /dev/null 2>&1; then
    echo "✓ 服务运行正常"
    echo "=== 修复完成 ==="
else
    echo "✗ 服务启动失败，查看日志:"
    tail -n 30 run.log
    echo ""
    echo "请检查错误信息并手动修复"
    exit 1
fi










