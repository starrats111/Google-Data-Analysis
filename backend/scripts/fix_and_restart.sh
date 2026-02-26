#!/bin/bash
# 修复MCC同步问题并重启服务

cd ~/Google-Data-Analysis/backend
source venv/bin/activate

echo "=== 修复MCC同步问题 ==="

# 1. 检查当前代码
echo "1. 检查代码..."
if ! grep -q "background_tasks: BackgroundTasks" app/api/mcc.py; then
    echo "需要修复代码..."
    
    # 使用Python直接修复
    python3 << 'EOF'
import re

with open('app/api/mcc.py', 'r', encoding='utf-8') as f:
    content = f.read()

# 修复函数签名
pattern1 = r'async def sync_mcc_data\(\s*mcc_id: int,\s*request_data: Optional\[dict\] = None,\s*request: Request = None,\s*background_tasks: BackgroundTasks = None,'
replacement1 = '''async def sync_mcc_data(
    mcc_id: int,
    request: Request,
    background_tasks: BackgroundTasks,
    request_data: Optional[dict] = None,'''

if re.search(pattern1, content):
    content = re.sub(pattern1, replacement1, content)
    print("✓ 修复函数签名")

# 移除 if background_tasks: 检查
if 'if background_tasks:' in content:
    # 找到 if background_tasks: 并移除，保留后面的代码
    lines = content.split('\n')
    new_lines = []
    i = 0
    while i < len(lines):
        if 'if background_tasks:' in lines[i]:
            # 跳过这一行，但保留后面的代码（移除一层缩进）
            i += 1
            # 找到对应的代码块
            while i < len(lines) and (lines[i].strip() == '' or lines[i].strip().startswith('background_tasks.add_task') or lines[i].startswith('                    ')):
                if lines[i].strip().startswith('background_tasks.add_task'):
                    # 保留这行，但调整缩进
                    new_lines.append('                ' + lines[i].strip())
                elif lines[i].startswith('                    '):
                    # 减少4个空格缩进
                    new_lines.append(lines[i][4:])
                else:
                    new_lines.append(lines[i])
                i += 1
        else:
            new_lines.append(lines[i])
            i += 1
    content = '\n'.join(new_lines)
    print("✓ 移除 background_tasks 检查")

with open('app/api/mcc.py', 'w', encoding='utf-8') as f:
    f.write(content)
    
print("✓ 代码修复完成")
EOF
else
    echo "✓ 代码已经正确"
fi

# 2. 检查语法
echo "2. 检查语法..."
python3 -m py_compile app/api/mcc.py && echo "✓ 语法正确" || {
    echo "✗ 语法错误"
    echo "查看错误:"
    python3 -m py_compile app/api/mcc.py 2>&1
    exit 1
}

# 3. 检查导入
echo "3. 检查导入..."
python3 << 'EOF'
try:
    from app.api.mcc import router
    print("✓ 导入成功")
except Exception as e:
    print(f"✗ 导入失败: {e}")
    import traceback
    traceback.print_exc()
    exit(1)
EOF

# 4. 停止旧服务
echo "4. 停止旧服务..."
pkill -9 -f "uvicorn.*app.main" 2>/dev/null || true
sleep 2
lsof -ti:8000 | xargs kill -9 2>/dev/null || true
sleep 2

# 5. 启动服务
echo "5. 启动服务..."
nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 &
sleep 8

# 6. 检查服务
echo "6. 检查服务..."
if curl -s http://127.0.0.1:8000/health > /dev/null 2>&1; then
    echo "✓ 服务运行正常"
    echo "=== 修复完成 ==="
else
    echo "✗ 服务启动失败"
    echo "最后30行日志:"
    tail -n 30 run.log
    echo ""
    echo "请检查上面的错误信息"
    exit 1
fi


# 修复MCC同步问题并重启服务

cd ~/Google-Data-Analysis/backend
source venv/bin/activate

echo "=== 修复MCC同步问题 ==="

# 1. 检查当前代码
echo "1. 检查代码..."
if ! grep -q "background_tasks: BackgroundTasks" app/api/mcc.py; then
    echo "需要修复代码..."
    
    # 使用Python直接修复
    python3 << 'EOF'
import re

with open('app/api/mcc.py', 'r', encoding='utf-8') as f:
    content = f.read()

# 修复函数签名
pattern1 = r'async def sync_mcc_data\(\s*mcc_id: int,\s*request_data: Optional\[dict\] = None,\s*request: Request = None,\s*background_tasks: BackgroundTasks = None,'
replacement1 = '''async def sync_mcc_data(
    mcc_id: int,
    request: Request,
    background_tasks: BackgroundTasks,
    request_data: Optional[dict] = None,'''

if re.search(pattern1, content):
    content = re.sub(pattern1, replacement1, content)
    print("✓ 修复函数签名")

# 移除 if background_tasks: 检查
if 'if background_tasks:' in content:
    # 找到 if background_tasks: 并移除，保留后面的代码
    lines = content.split('\n')
    new_lines = []
    i = 0
    while i < len(lines):
        if 'if background_tasks:' in lines[i]:
            # 跳过这一行，但保留后面的代码（移除一层缩进）
            i += 1
            # 找到对应的代码块
            while i < len(lines) and (lines[i].strip() == '' or lines[i].strip().startswith('background_tasks.add_task') or lines[i].startswith('                    ')):
                if lines[i].strip().startswith('background_tasks.add_task'):
                    # 保留这行，但调整缩进
                    new_lines.append('                ' + lines[i].strip())
                elif lines[i].startswith('                    '):
                    # 减少4个空格缩进
                    new_lines.append(lines[i][4:])
                else:
                    new_lines.append(lines[i])
                i += 1
        else:
            new_lines.append(lines[i])
            i += 1
    content = '\n'.join(new_lines)
    print("✓ 移除 background_tasks 检查")

with open('app/api/mcc.py', 'w', encoding='utf-8') as f:
    f.write(content)
    
print("✓ 代码修复完成")
EOF
else
    echo "✓ 代码已经正确"
fi

# 2. 检查语法
echo "2. 检查语法..."
python3 -m py_compile app/api/mcc.py && echo "✓ 语法正确" || {
    echo "✗ 语法错误"
    echo "查看错误:"
    python3 -m py_compile app/api/mcc.py 2>&1
    exit 1
}

# 3. 检查导入
echo "3. 检查导入..."
python3 << 'EOF'
try:
    from app.api.mcc import router
    print("✓ 导入成功")
except Exception as e:
    print(f"✗ 导入失败: {e}")
    import traceback
    traceback.print_exc()
    exit(1)
EOF

# 4. 停止旧服务
echo "4. 停止旧服务..."
pkill -9 -f "uvicorn.*app.main" 2>/dev/null || true
sleep 2
lsof -ti:8000 | xargs kill -9 2>/dev/null || true
sleep 2

# 5. 启动服务
echo "5. 启动服务..."
nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 &
sleep 8

# 6. 检查服务
echo "6. 检查服务..."
if curl -s http://127.0.0.1:8000/health > /dev/null 2>&1; then
    echo "✓ 服务运行正常"
    echo "=== 修复完成 ==="
else
    echo "✗ 服务启动失败"
    echo "最后30行日志:"
    tail -n 30 run.log
    echo ""
    echo "请检查上面的错误信息"
    exit 1
fi

















