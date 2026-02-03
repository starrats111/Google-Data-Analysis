#!/bin/bash
# 快速修复CORS问题 - 一键执行脚本

echo "=========================================="
echo "开始修复CORS问题"
echo "=========================================="

# 步骤1: 更新代码
echo ""
echo "[1/6] 更新代码..."
cd ~/Google-Data-Analysis
git pull origin main
if [ $? -eq 0 ]; then
    echo "✓ 代码更新成功"
else
    echo "⚠ 代码更新失败，继续执行..."
fi

# 步骤2: 停止服务
echo ""
echo "[2/6] 停止旧服务..."
pkill -f 'uvicorn.*app.main'
pkill -f 'python.*uvicorn'
sleep 3
echo "✓ 服务已停止"

# 步骤3: 启动服务
echo ""
echo "[3/6] 启动新服务..."
cd ~/Google-Data-Analysis/backend
source venv/bin/activate
nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 &
sleep 5
echo "✓ 服务已启动"

# 步骤4: 验证服务
echo ""
echo "[4/6] 验证服务状态..."
HEALTH=$(curl -s http://127.0.0.1:8000/health)
if [[ $HEALTH == *"ok"* ]]; then
    echo "✓ 服务健康检查通过"
else
    echo "⚠ 服务健康检查失败: $HEALTH"
fi

# 步骤5: 测试CORS
echo ""
echo "[5/6] 测试CORS配置..."
echo "测试 /api/affiliate/platforms:"
CORS_TEST1=$(curl -s -X OPTIONS \
  -H "Origin: https://google-data-analysis.top" \
  -H "Access-Control-Request-Method: GET" \
  -v https://api.google-data-analysis.top/api/affiliate/platforms 2>&1 | grep -i "access-control-allow-origin")

if [[ $CORS_TEST1 == *"google-data-analysis.top"* ]]; then
    echo "✓ /api/affiliate/platforms CORS配置正常"
else
    echo "⚠ /api/affiliate/platforms CORS配置可能有问题"
    echo "   响应: $CORS_TEST1"
fi

# 步骤6: 显示日志
echo ""
echo "[6/6] 查看启动日志（最后20行）..."
tail -n 20 run.log

echo ""
echo "=========================================="
echo "修复完成！"
echo "=========================================="
echo ""
echo "如果看到 'access-control-allow-origin: https://google-data-analysis.top'，"
echo "说明CORS配置正常。请在浏览器中刷新页面测试。"
echo ""
echo "如果还有问题，请查看完整日志:"
echo "  tail -f ~/Google-Data-Analysis/backend/run.log"

