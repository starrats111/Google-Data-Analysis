#!/bin/bash
# 调试版本：显示完整的 API 响应

echo "=========================================="
echo "测试 wj07 用户的每日分析和 L7D 分析（调试版）"
echo "=========================================="
echo ""

# 1. 登录获取 token
echo "1. 登录获取 token..."
LOGIN_RESPONSE=$(curl -s -X POST "http://127.0.0.1:8000/api/auth/login" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=wj07&password=wj123456")

echo "登录响应: $LOGIN_RESPONSE"
echo ""

TOKEN=$(echo "$LOGIN_RESPONSE" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('access_token', ''))" 2>/dev/null)

if [ -z "$TOKEN" ]; then
    echo "✗ 登录失败，无法获取 token"
    exit 1
fi

echo "✓ Token 获取成功"
echo ""

# 2. 测试每日分析（只测试一天，看完整响应）
echo "2. 测试每日分析（今天）..."
TODAY=$(python3 -c "from datetime import date; print(date.today().isoformat())")
echo "日期: $TODAY"
echo ""

RESPONSE=$(curl -s -X POST "http://127.0.0.1:8000/api/analysis/daily?target_date=$TODAY" \
  -H "Authorization: Bearer $TOKEN")

echo "完整响应:"
echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
echo ""

# 3. 测试 L7D 分析
echo "3. 测试 L7D 分析..."
YESTERDAY=$(python3 -c "from datetime import date, timedelta; print((date.today() - timedelta(days=1)).isoformat())")
echo "结束日期: $YESTERDAY"
echo ""

RESPONSE=$(curl -s -X POST "http://127.0.0.1:8000/api/l7d?end_date=$YESTERDAY" \
  -H "Authorization: Bearer $TOKEN")

echo "完整响应:"
echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
echo ""

echo "=========================================="
echo "调试完成"
echo "=========================================="

