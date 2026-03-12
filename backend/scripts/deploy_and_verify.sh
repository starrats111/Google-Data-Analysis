#!/bin/bash

# CR-041 部署和验证脚本
# 功能：部署代码、重启服务、运行诊断、验证数据准确性

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
HEALTH=$(curl -s http://127.0.0.1:8000/health || echo "failed")
if [[ $HEALTH == *"ok"* ]] || [[ $HEALTH == *"healthy"* ]]; then
    echo "✅ 服务健康状态正常"
else
    echo "⚠️  服务健康检查响应: $HEALTH"
fi

# 7. 运行诊断脚本
echo ""
echo "🔍 步骤7：运行 L7D 数据准确性诊断..."
python scripts/diagnose_l7d_data_accuracy.py
echo "✅ 诊断完成"

# 8. 检查服务日志
echo ""
echo "📋 步骤8：检查服务日志（最后20行）..."
tail -20 /tmp/backend.log
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
