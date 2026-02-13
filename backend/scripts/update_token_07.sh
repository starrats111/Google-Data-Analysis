#!/bin/bash
# 07的开发者令牌更新脚本 - 一键完成所有步骤

echo "=== 07的开发者令牌更新 ==="
echo ""

# 新令牌
NEW_TOKEN="hWBTxgYlOiWB4XfXQl_UfA"

# 1. 进入目录
cd ~/Google-Data-Analysis/backend || exit 1
source venv/bin/activate || exit 1

# 2. 更新.env文件
echo "步骤1: 更新开发者令牌..."
python3 << EOF
import os
from pathlib import Path

token = "$NEW_TOKEN"
env_file = Path(".env")

# 读取或创建.env文件
if env_file.exists():
    with open(env_file, 'r', encoding='utf-8') as f:
        lines = f.readlines()
else:
    lines = []

# 更新或添加令牌
updated = False
new_lines = []
for line in lines:
    if line.strip().startswith('GOOGLE_ADS_SHARED_DEVELOPER_TOKEN'):
        new_lines.append(f"GOOGLE_ADS_SHARED_DEVELOPER_TOKEN={token}\n")
        updated = True
    else:
        new_lines.append(line)

if not updated:
    if new_lines and not new_lines[-1].endswith('\n'):
        new_lines.append('\n')
    new_lines.append(f"GOOGLE_ADS_SHARED_DEVELOPER_TOKEN={token}\n")

# 写入文件
with open(env_file, 'w', encoding='utf-8') as f:
    f.writelines(new_lines)

print("✓ 令牌已更新")
EOF

# 3. 验证配置
echo "步骤2: 验证配置..."
python3 << 'EOF'
from app.config import settings
token = settings.google_ads_shared_developer_token
if token:
    print(f"✓ 配置验证成功，令牌长度: {len(token)} 字符")
else:
    print("✗ 配置验证失败，令牌为空")
    exit(1)
EOF

# 4. 重启服务
echo "步骤3: 重启服务..."
pkill -9 -f "uvicorn.*app.main" 2>/dev/null
sleep 2
nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 &
sleep 8

# 5. 测试服务
echo "步骤4: 测试服务..."
if curl -s http://127.0.0.1:8000/health > /dev/null 2>&1; then
    echo "✓ 服务运行正常"
    echo ""
    echo "=== 完成！新令牌已生效 ==="
else
    echo "✗ 服务启动失败，查看日志:"
    tail -n 20 run.log
    exit 1
fi


# 07的开发者令牌更新脚本 - 一键完成所有步骤

echo "=== 07的开发者令牌更新 ==="
echo ""

# 新令牌
NEW_TOKEN="hWBTxgYlOiWB4XfXQl_UfA"

# 1. 进入目录
cd ~/Google-Data-Analysis/backend || exit 1
source venv/bin/activate || exit 1

# 2. 更新.env文件
echo "步骤1: 更新开发者令牌..."
python3 << EOF
import os
from pathlib import Path

token = "$NEW_TOKEN"
env_file = Path(".env")

# 读取或创建.env文件
if env_file.exists():
    with open(env_file, 'r', encoding='utf-8') as f:
        lines = f.readlines()
else:
    lines = []

# 更新或添加令牌
updated = False
new_lines = []
for line in lines:
    if line.strip().startswith('GOOGLE_ADS_SHARED_DEVELOPER_TOKEN'):
        new_lines.append(f"GOOGLE_ADS_SHARED_DEVELOPER_TOKEN={token}\n")
        updated = True
    else:
        new_lines.append(line)

if not updated:
    if new_lines and not new_lines[-1].endswith('\n'):
        new_lines.append('\n')
    new_lines.append(f"GOOGLE_ADS_SHARED_DEVELOPER_TOKEN={token}\n")

# 写入文件
with open(env_file, 'w', encoding='utf-8') as f:
    f.writelines(new_lines)

print("✓ 令牌已更新")
EOF

# 3. 验证配置
echo "步骤2: 验证配置..."
python3 << 'EOF'
from app.config import settings
token = settings.google_ads_shared_developer_token
if token:
    print(f"✓ 配置验证成功，令牌长度: {len(token)} 字符")
else:
    print("✗ 配置验证失败，令牌为空")
    exit(1)
EOF

# 4. 重启服务
echo "步骤3: 重启服务..."
pkill -9 -f "uvicorn.*app.main" 2>/dev/null
sleep 2
nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 &
sleep 8

# 5. 测试服务
echo "步骤4: 测试服务..."
if curl -s http://127.0.0.1:8000/health > /dev/null 2>&1; then
    echo "✓ 服务运行正常"
    echo ""
    echo "=== 完成！新令牌已生效 ==="
else
    echo "✗ 服务启动失败，查看日志:"
    tail -n 20 run.log
    exit 1
fi














