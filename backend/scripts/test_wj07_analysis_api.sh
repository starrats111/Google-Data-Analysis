#!/bin/bash
# 测试 wj07 用户的每日分析和 L7D 分析（通过 API）

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

TOKEN=$(echo "$LOGIN_RESPONSE" | grep -o '"access_token":"[^"]*' | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
    echo "   ✗ 登录失败"
    echo "   响应: $LOGIN_RESPONSE"
    exit 1
fi

echo "   ✓ 登录成功"
echo ""

# 2. 计算过去7天的日期
echo "2. 计算过去7天的日期..."
TODAY=$(date +%Y-%m-%d)
echo "   今天: $TODAY"
echo ""

# 3. 测试每日分析（过去7天，每天生成一次）
echo "3. 测试每日分析（过去7天）..."
echo "   ----------------------------------------"

for i in {0..6}; do
    TARGET_DATE=$(date -d "$TODAY - $i days" +%Y-%m-%d 2>/dev/null || date -v-${i}d +%Y-%m-%d 2>/dev/null || python3 -c "from datetime import date, timedelta; print((date.today() - timedelta(days=$i)).isoformat())")
    
    echo "   生成 $TARGET_DATE 的每日分析..."
    
    RESPONSE=$(curl -s -X POST "$API_BASE/api/analysis/daily?target_date=$TARGET_DATE" \
      -H "Authorization: Bearer $TOKEN")
    
    SUCCESS=$(echo "$RESPONSE" | grep -o '"success":[^,}]*' | cut -d':' -f2)
    TOTAL_RECORDS=$(echo "$RESPONSE" | grep -o '"total_records":[^,}]*' | cut -d':' -f2)
    MESSAGE=$(echo "$RESPONSE" | grep -o '"message":"[^"]*' | cut -d'"' -f4)
    
    if [ "$SUCCESS" = "true" ]; then
        echo "     ✓ 成功: 生成 ${TOTAL_RECORDS} 条记录"
    else
        echo "     ✗ 失败: ${MESSAGE:-未知错误}"
    fi
done

echo ""

# 4. 测试 L7D 分析
echo "4. 测试 L7D 分析（过去7天汇总）..."
echo "   ----------------------------------------"

YESTERDAY=$(date -d "$TODAY - 1 days" +%Y-%m-%d 2>/dev/null || date -v-1d +%Y-%m-%d 2>/dev/null || python3 -c "from datetime import date, timedelta; print((date.today() - timedelta(days=1)).isoformat())")

echo "   生成截止到 $YESTERDAY 的 L7D 分析（过去7天）..."

RESPONSE=$(curl -s -X POST "$API_BASE/api/l7d?end_date=$YESTERDAY" \
  -H "Authorization: Bearer $TOKEN")

SUCCESS=$(echo "$RESPONSE" | grep -o '"success":[^,}]*' | cut -d':' -f2)
TOTAL_RECORDS=$(echo "$RESPONSE" | grep -o '"total_records":[^,}]*' | cut -d':' -f2)
BEGIN_DATE=$(echo "$RESPONSE" | grep -o '"begin_date":"[^"]*' | cut -d'"' -f4)
END_DATE=$(echo "$RESPONSE" | grep -o '"end_date":"[^"]*' | cut -d'"' -f4)
MESSAGE=$(echo "$RESPONSE" | grep -o '"message":"[^"]*' | cut -d'"' -f4)

if [ "$SUCCESS" = "true" ]; then
    echo "     ✓ 成功: 生成 ${TOTAL_RECORDS} 条记录"
    echo "     日期范围: ${BEGIN_DATE} 至 ${END_DATE}"
else
    echo "     ✗ 失败: ${MESSAGE:-未知错误}"
    echo "     完整响应: $RESPONSE"
fi

echo ""
echo "=========================================="
echo "测试完成！"
echo "=========================================="

