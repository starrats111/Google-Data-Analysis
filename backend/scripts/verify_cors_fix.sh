#!/bin/bash
# 验证 CORS 修复是否已应用

echo "=========================================="
echo "验证 CORS 修复状态"
echo "=========================================="
echo ""

cd ~/Google-Data-Analysis/backend || exit 1

echo "1. 检查 CORS 导入..."
if grep -q "from starlette.middleware.cors import CORSMiddleware" app/main.py; then
    echo "   ✓ 已使用 Starlette 的 CORSMiddleware（修复版本）"
    LINE=$(grep -n "from starlette.middleware.cors import CORSMiddleware" app/main.py | cut -d: -f1)
    echo "   位置: 第 $LINE 行"
else
    if grep -q "from fastapi.middleware.cors import CORSMiddleware" app/main.py; then
        echo "   ✗ 仍在使用 FastAPI 的 CORSMiddleware（旧版本，可能有兼容性问题）"
    else
        echo "   ⚠ 未找到 CORS 中间件导入"
    fi
fi
echo ""

echo "2. 检查 CORS 配置..."
if grep -A 5 "app.add_middleware" app/main.py | grep -q "CORSMiddleware"; then
    echo "   ✓ CORS 中间件已配置"
    echo ""
    echo "   当前配置:"
    grep -A 8 "app.add_middleware" app/main.py | head -9
else
    echo "   ✗ 未找到 CORS 中间件配置"
fi
echo ""

echo "3. 测试 CORS 响应..."
TEST_RESPONSE=$(curl -s -H "Origin: https://google-data-analysis.top" \
    -v http://127.0.0.1:8000/health 2>&1)

if echo "$TEST_RESPONSE" | grep -qi "access-control-allow-origin"; then
    echo "   ✓ CORS 响应头正常"
    echo ""
    echo "   CORS 头详情:"
    echo "$TEST_RESPONSE" | grep -i "access-control" | head -5
else
    echo "   ✗ 未找到 CORS 响应头"
fi
echo ""

echo "=========================================="
echo "验证完成"
echo "=========================================="

