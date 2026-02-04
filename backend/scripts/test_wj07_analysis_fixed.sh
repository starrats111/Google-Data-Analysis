#!/bin/bash
# 测试 wj07 用户的每日分析和 L7D 分析（修复版）

echo "=========================================="
echo "测试 wj07 用户的每日分析和 L7D 分析"
echo "=========================================="
echo ""

# 配置
API_BASE="http://127.0.0.1:8000"
USERNAME="wj07"
PASSWORD="wj123456"

# 1. 登录获取 token
echo "1. 登录获取 token..."
LOGIN_RESPONSE=$(curl -s -X POST "$API_BASE/api/auth/login" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=$USERNAME&password=$PASSWORD")

TOKEN=$(echo "$LOGIN_RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin).get('access_token', ''))" 2>/dev/null)

if [ -z "$TOKEN" ]; then
    echo "   ✗ 登录失败"
    echo "   响应: $LOGIN_RESPONSE"
    exit 1
fi

echo "   ✓ 登录成功"
echo ""

# 2. 测试每日分析（过去7天）
echo "2. 测试每日分析（过去7天）..."
echo "   ----------------------------------------"

for i in {0..6}; do
    TARGET_DATE=$(python3 -c "from datetime import date, timedelta; print((date.today() - timedelta(days=$i)).isoformat())")
    
    echo "   生成 $TARGET_DATE 的每日分析..."
    
    RESPONSE=$(curl -s -X POST "$API_BASE/api/analysis/daily?target_date=$TARGET_DATE" \
      -H "Authorization: Bearer $TOKEN")
    
    # 检查响应
    SUCCESS=$(echo "$RESPONSE" | python3 -c "import sys, json; r=json.load(sys.stdin); print(r.get('success', False))" 2>/dev/null)
    TOTAL_RECORDS=$(echo "$RESPONSE" | python3 -c "import sys, json; r=json.load(sys.stdin); print(r.get('total_records', 0))" 2>/dev/null)
    MESSAGE=$(echo "$RESPONSE" | python3 -c "import sys, json; r=json.load(sys.stdin); print(r.get('message', ''))" 2>/dev/null)
    DETAIL=$(echo "$RESPONSE" | python3 -c "import sys, json; r=json.load(sys.stdin); print(r.get('detail', ''))" 2>/dev/null)
    
    if [ "$SUCCESS" = "True" ]; then
        echo "     ✓ 成功: 生成 ${TOTAL_RECORDS} 条记录"
    else
        ERROR_MSG="${MESSAGE:-${DETAIL:-未知错误}}"
        echo "     ✗ 失败: $ERROR_MSG"
        if [ -z "$MESSAGE" ] && [ -z "$DETAIL" ]; then
            echo "     完整响应: $RESPONSE"
        fi
    fi
done

echo ""

# 3. 测试 L7D 分析
echo "3. 测试 L7D 分析（过去7天汇总）..."
echo "   ----------------------------------------"

YESTERDAY=$(python3 -c "from datetime import date, timedelta; print((date.today() - timedelta(days=1)).isoformat())")

echo "   生成截止到 $YESTERDAY 的 L7D 分析（过去7天）..."

RESPONSE=$(curl -s -X POST "$API_BASE/api/analysis/l7d?end_date=$YESTERDAY" \
  -H "Authorization: Bearer $TOKEN")

SUCCESS=$(echo "$RESPONSE" | python3 -c "import sys, json; r=json.load(sys.stdin); print(r.get('success', False))" 2>/dev/null)
TOTAL_RECORDS=$(echo "$RESPONSE" | python3 -c "import sys, json; r=json.load(sys.stdin); print(r.get('total_records', 0))" 2>/dev/null)
BEGIN_DATE=$(echo "$RESPONSE" | python3 -c "import sys, json; r=json.load(sys.stdin); print(r.get('begin_date', ''))" 2>/dev/null)
END_DATE=$(echo "$RESPONSE" | python3 -c "import sys, json; r=json.load(sys.stdin); print(r.get('end_date', ''))" 2>/dev/null)
MESSAGE=$(echo "$RESPONSE" | python3 -c "import sys, json; r=json.load(sys.stdin); print(r.get('message', ''))" 2>/dev/null)
DETAIL=$(echo "$RESPONSE" | python3 -c "import sys, json; r=json.load(sys.stdin); print(r.get('detail', ''))" 2>/dev/null)

if [ "$SUCCESS" = "True" ]; then
    echo "     ✓ 成功: 生成 ${TOTAL_RECORDS} 条记录"
    echo "     日期范围: ${BEGIN_DATE} 至 ${END_DATE}"
else
    ERROR_MSG="${MESSAGE:-${DETAIL:-未知错误}}"
    echo "     ✗ 失败: $ERROR_MSG"
    if [ -z "$MESSAGE" ] && [ -z "$DETAIL" ]; then
        echo "     完整响应: $RESPONSE"
    fi
fi

echo ""
echo "=========================================="
echo "测试完成！"
echo "=========================================="

