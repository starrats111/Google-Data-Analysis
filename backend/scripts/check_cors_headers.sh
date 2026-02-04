#!/bin/bash
# 检查 API 端点的 CORS 头

echo "=========================================="
echo "检查 CORS 响应头"
echo "=========================================="
echo ""

API_BASE="http://127.0.0.1:8000"
ORIGIN="https://google-data-analysis.top"

echo "测试端点: $API_BASE"
echo "Origin: $ORIGIN"
echo ""

# 1. 测试健康检查端点
echo "1. 测试 /health 端点..."
HEALTH_RESPONSE=$(curl -s -H "Origin: $ORIGIN" -v "$API_BASE/health" 2>&1)
echo "$HEALTH_RESPONSE" | grep -i "access-control" || echo "   ⚠ 未找到 CORS 头"
echo ""

# 2. 测试 OPTIONS 预检请求
echo "2. 测试 OPTIONS 预检请求..."
OPTIONS_RESPONSE=$(curl -s -H "Origin: $ORIGIN" \
    -H "Access-Control-Request-Method: POST" \
    -H "Access-Control-Request-Headers: Content-Type" \
    -X OPTIONS \
    -v "$API_BASE/api/mcc/accounts/1/sync" 2>&1)

echo "$OPTIONS_RESPONSE" | grep -i "access-control" || echo "   ⚠ 未找到 CORS 头"
HTTP_CODE=$(echo "$OPTIONS_RESPONSE" | grep "< HTTP" | tail -1 | awk '{print $3}')
echo "   HTTP 状态码: $HTTP_CODE"
echo ""

# 3. 测试实际 POST 请求（会失败，但可以看到 CORS 头）
echo "3. 测试 POST 请求的 CORS 头（预期 401/403，但应包含 CORS 头）..."
POST_RESPONSE=$(curl -s -H "Origin: $ORIGIN" \
    -H "Content-Type: application/json" \
    -X POST \
    -v "$API_BASE/api/mcc/accounts/1/sync" \
    -d '{}' 2>&1)

echo "$POST_RESPONSE" | grep -i "access-control" || echo "   ⚠ 未找到 CORS 头"
POST_HTTP_CODE=$(echo "$POST_RESPONSE" | grep "< HTTP" | tail -1 | awk '{print $3}')
echo "   HTTP 状态码: $POST_HTTP_CODE"
echo ""

echo "=========================================="
echo "检查完成"
echo "=========================================="
echo ""
echo "如果看到 'Access-Control-Allow-Origin' 头，说明 CORS 配置正常"
echo "如果未看到，可能需要重启服务或检查配置"

