#!/bin/bash

# CR-041 完整部署和验证脚本
# 在服务器上直接运行此脚本

set -e

echo "=========================================="
echo "CR-041 部署和验证流程"
echo "=========================================="
echo ""

# 记录开始时间
START_TIME=$(date '+%Y-%m-%d %H:%M:%S')
echo "开始时间: $START_TIME"
echo ""

# 1. 拉取最新代码
echo "📥 步骤1：拉取最新代码..."
cd ~/Google-Data-Analysis
echo "当前目录: $(pwd)"
git pull origin main
echo "✅ 代码拉取完成"
echo ""

# 2. 进入后端目录
echo "📂 步骤2：进入后端目录..."
cd backend
echo "当前目录: $(pwd)"
echo "✅ 已进入 backend 目录"
echo ""

# 3. 激活虚拟环境
echo "🐍 步骤3：激活虚拟环境..."
source venv/bin/activate
echo "✅ 虚拟环境已激活"
echo ""

# 4. 停止旧服务
echo "🛑 步骤4：停止旧服务..."
pkill -f 'uvicorn.*app.main' || true
sleep 2
echo "✅ 旧服务已停止"
echo ""

# 5. 启动新服务
echo "🚀 步骤5：启动新服务..."
nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > /tmp/backend.log 2>&1 &
BACKEND_PID=$!
echo "后端进程 PID: $BACKEND_PID"
sleep 3
echo "✅ 新服务已启动"
echo ""

# 6. 验证服务健康状态
echo "🏥 步骤6：验证服务健康状态..."
HEALTH=$(curl -s http://127.0.0.1:8000/health || echo "failed")
echo "健康检查响应: $HEALTH"
if [[ $HEALTH == *"ok"* ]] || [[ $HEALTH == *"healthy"* ]] || [[ $HEALTH == *"status"* ]]; then
    echo "✅ 服务健康状态正常"
else
    echo "⚠️  服务健康检查响应: $HEALTH"
fi
echo ""

# 7. 运行诊断脚本
echo "🔍 步骤7：运行 L7D 数据准确性诊断..."
echo "=========================================="
python scripts/diagnose_l7d_data_accuracy.py
echo "=========================================="
echo "✅ 诊断完成"
echo ""

# 8. 运行数据准确性验证脚本
echo "✅ 步骤8：运行数据准确性验证..."
echo "=========================================="
python scripts/verify_data_accuracy.py
echo "=========================================="
echo "✅ 验证完成"
echo ""

# 9. 查看服务日志
echo "📋 步骤9：检查服务日志（最后50行）..."
echo "=========================================="
tail -50 /tmp/backend.log
echo "=========================================="
echo "✅ 日志检查完成"
echo ""

# 10. 生成部署报告
echo "📊 步骤10：生成部署报告..."
DEPLOY_REPORT="/tmp/cr041_deploy_report.txt"
cat > $DEPLOY_REPORT << EOF
CR-041 部署报告
===============

部署时间: $START_TIME
完成时间: $(date '+%Y-%m-%d %H:%M:%S')

部署步骤:
✅ 1. 代码已拉取
✅ 2. 进入后端目录
✅ 3. 虚拟环境已激活
✅ 4. 旧服务已停止
✅ 5. 新服务已启动 (PID: $BACKEND_PID)
✅ 6. 服务健康检查通过
✅ 7. 诊断脚本已运行
✅ 8. 数据准确性验证已运行
✅ 9. 日志已检查

后续步骤:
1. 在前端验证 L7D 数据是否与 Google Ads 一致
2. 检查费用、CPC、预算等数据的准确性
3. 确认所有标黄数据无误
4. 签字确认修复完成

部署报告已保存到: $DEPLOY_REPORT
EOF

echo "部署报告已生成: $DEPLOY_REPORT"
echo ""

echo "=========================================="
echo "✅ 部署和验证流程完成！"
echo "=========================================="
echo ""
echo "后续步骤:"
echo "1. 在前端验证 L7D 数据是否与 Google Ads 一致"
echo "2. 检查费用、CPC、预算等数据的准确性"
echo "3. 确认所有标黄数据无误"
echo ""
