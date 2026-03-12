# CR-041 远程部署脚本（PowerShell）
# 连接到服务器并执行部署

param(
    [string]$ServerIP = "47.239.193.33",
    [int]$ServerPort = 22,
    [string]$Username = "admin",
    [string]$Password = "A123456"
)

Write-Host "=========================================="
Write-Host "CR-041 远程部署和验证"
Write-Host "=========================================="
Write-Host ""

# 创建 SSH 连接字符串
$SSHConnection = "$Username@$ServerIP"

Write-Host "🔗 连接到服务器: $SSHConnection"
Write-Host ""

# 定义部署命令
$DeployCommands = @"
#!/bin/bash
set -e

echo "=========================================="
echo "CR-041 部署和验证流程"
echo "=========================================="

# 1. 拉取最新代码
echo ""
echo "📥 步骤1：拉取最新代码..."
cd ~/Google-Data-Analysis
git pull origin main
echo "✅ 代码拉取完成"

# 2. 进入后端目录
echo ""
echo "📂 步骤2：进入后端目录..."
cd backend
echo "✅ 已进入 backend 目录"

# 3. 激活虚拟环境
echo ""
echo "🐍 步骤3：激活虚拟环境..."
source venv/bin/activate
echo "✅ 虚拟环境已激活"

# 4. 停止旧服务
echo ""
echo "🛑 步骤4：停止旧服务..."
pkill -f 'uvicorn.*app.main' || true
sleep 2
echo "✅ 旧服务已停止"

# 5. 启动新服务
echo ""
echo "🚀 步骤5：启动新服务..."
nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > /tmp/backend.log 2>&1 &
sleep 3
echo "✅ 新服务已启动"

# 6. 验证服务健康状态
echo ""
echo "🏥 步骤6：验证服务健康状态..."
HEALTH=\$(curl -s http://127.0.0.1:8000/health || echo "failed")
if [[ \$HEALTH == *"ok"* ]] || [[ \$HEALTH == *"healthy"* ]]; then
    echo "✅ 服务健康状态正常"
    echo "响应: \$HEALTH"
else
    echo "⚠️  服务健康检查响应: \$HEALTH"
fi

# 7. 运行诊断脚本
echo ""
echo "🔍 步骤7：运行 L7D 数据准确性诊断..."
python scripts/diagnose_l7d_data_accuracy.py
echo "✅ 诊断完成"

# 8. 运行数据准确性验证脚本
echo ""
echo "✅ 步骤8：运行数据准确性验证..."
python scripts/verify_data_accuracy.py
echo "✅ 验证完成"

# 9. 查看服务日志
echo ""
echo "📋 步骤9：检查服务日志（最后30行）..."
tail -30 /tmp/backend.log
echo "✅ 日志检查完成"

echo ""
echo "=========================================="
echo "✅ 部署和验证流程完成！"
echo "=========================================="
echo ""
echo "后续步骤："
echo "1. 在前端验证 L7D 数据是否与 Google Ads 一致"
echo "2. 检查费用、CPC、预算等数据的准确性"
echo "3. 确认所有标黄数据无误"
echo ""
"@

# 保存部署脚本到临时文件
$TempScript = "$env:TEMP\deploy_cr041.sh"
$DeployCommands | Out-File -FilePath $TempScript -Encoding UTF8 -NoNewline

Write-Host "📝 部署脚本已准备"
Write-Host ""

# 尝试使用 SSH 执行部署
Write-Host "🚀 开始远程部署..."
Write-Host ""

try {
    # 使用 SSH 执行部署命令
    # 注意：这需要 SSH 客户端已安装并配置
    
    $SSHCommand = @"
cd ~/Google-Data-Analysis
git pull origin main
cd backend
source venv/bin/activate
pkill -f 'uvicorn.*app.main' || true
sleep 2
nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > /tmp/backend.log 2>&1 &
sleep 3
curl -s http://127.0.0.1:8000/health
python scripts/diagnose_l7d_data_accuracy.py
python scripts/verify_data_accuracy.py
tail -30 /tmp/backend.log
"@

    # 尝试执行 SSH 命令
    Write-Host "⏳ 正在连接到服务器并执行部署..."
    Write-Host ""
    
    # 使用 SSH 执行命令
    $SSHCommand | ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 $SSHConnection
    
    Write-Host ""
    Write-Host "=========================================="
    Write-Host "✅ 远程部署完成！"
    Write-Host "=========================================="
    
} catch {
    Write-Host "❌ SSH 连接失败: $_"
    Write-Host ""
    Write-Host "请确保："
    Write-Host "1. SSH 客户端已安装"
    Write-Host "2. 服务器地址正确: $ServerIP"
    Write-Host "3. 用户名和密码正确: $Username"
    Write-Host ""
    Write-Host "或者，请在服务器上手动执行以下命令："
    Write-Host ""
    Write-Host "cd ~/Google-Data-Analysis"
    Write-Host "git pull origin main"
    Write-Host "cd backend"
    Write-Host "source venv/bin/activate"
    Write-Host "pkill -f 'uvicorn.*app.main' || true"
    Write-Host "sleep 2"
    Write-Host "nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > /tmp/backend.log 2>&1 &"
    Write-Host "sleep 3"
    Write-Host "curl -s http://127.0.0.1:8000/health"
    Write-Host "python scripts/diagnose_l7d_data_accuracy.py"
    Write-Host "python scripts/verify_data_accuracy.py"
    Write-Host "tail -30 /tmp/backend.log"
}

# 清理临时文件
if (Test-Path $TempScript) {
    Remove-Item $TempScript -Force
}
