#!/bin/bash
# 一键修复CORS问题脚本

echo "=========================================="
echo "开始修复CORS问题"
echo "=========================================="

# 步骤1: 更新代码
echo ""
echo "[1/7] 更新代码..."
cd ~/Google-Data-Analysis
git pull origin main
if [ $? -eq 0 ]; then
    echo "✓ 代码更新成功"
else
    echo "⚠ 代码更新失败，继续执行..."
fi

# 步骤2: 进入后端目录
echo ""
echo "[2/7] 进入后端目录..."
cd ~/Google-Data-Analysis/backend
source venv/bin/activate
echo "✓ 已激活虚拟环境"

# 步骤3: 停止服务
echo ""
echo "[3/7] 停止旧服务..."
pkill -9 -f 'uvicorn.*app.main'
pkill -9 -f 'python.*uvicorn'
sleep 5
ps aux | grep uvicorn | grep -v grep || echo "✓ 所有进程已停止"

# 步骤4: 启动服务
echo ""
echo "[4/7] 启动新服务..."
nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 &
sleep 8
echo "✓ 服务已启动"

# 步骤5: 验证服务
echo ""
echo "[5/7] 验证服务状态..."
HEALTH=$(curl -s http://127.0.0.1:8000/health)
if [[ $HEALTH == *"ok"* ]]; then
    echo "✓ 服务健康检查通过"
else
    echo "⚠ 服务健康检查失败: $HEALTH"
fi

# 步骤6: 测试CORS
echo ""
echo "[6/7] 测试CORS配置..."
test_cors() {
    local endpoint=$1
    local name=$2
    echo -n "  测试 $name: "
    CORS_RESULT=$(curl -s -X OPTIONS \
      -H "Origin: https://google-data-analysis.top" \
      -H "Access-Control-Request-Method: GET" \
      -H "Access-Control-Request-Headers: Content-Type,Authorization" \
      -v "https://api.google-data-analysis.top$endpoint" 2>&1 | grep -i "access-control-allow-origin")
    
    if [[ $CORS_RESULT == *"google-data-analysis.top"* ]]; then
        echo "✓ 正常"
    else
        echo "✗ 异常"
        echo "    响应: $CORS_RESULT"
    fi
}

test_cors "/api/user/statistics" "用户统计"
test_cors "/api/dashboard/employee-insights?range=7d" "员工洞察"
test_cors "/api/mcc/accounts" "MCC账号"
test_cors "/api/expenses/summary?start_date=2026-01-01&end_date=2026-01-31" "费用汇总"
test_cors "/api/affiliate/platforms" "联盟平台"

# 步骤7: 显示日志
echo ""
echo "[7/7] 查看启动日志（最后15行）..."
tail -n 15 run.log

echo ""
echo "=========================================="
echo "修复完成！"
echo "=========================================="
echo ""
echo "如果看到多个 ✓，说明修复成功。"
echo "请在浏览器中："
echo "  1. 硬刷新页面 (Ctrl+Shift+R 或 Cmd+Shift+R)"
echo "  2. 清除浏览器缓存"
echo "  3. 重新测试"
echo ""
echo "如果还有问题，查看完整日志："
echo "  tail -f ~/Google-Data-Analysis/backend/run.log"


















