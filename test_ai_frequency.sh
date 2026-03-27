#!/bin/bash
# ============================================================
# AI 频繁调用防护测试脚本 v2
# Next.js 16 生产模式下 console.log 不输出到 PM2 out.log
# 所有 AI 日志通过 console.warn/error 输出到 error.log
# ============================================================

set -euo pipefail

BASE_URL="http://localhost:20050"
APP_DIR="/home/ubuntu/Google-Data-Analysis/crm-mvp"
ERR_LOG="/home/ubuntu/.pm2/logs/ad-automation-error.log"

JWT_SECRET=$(grep '^JWT_SECRET=' "$APP_DIR/.env" | cut -d'=' -f2- | tr -d '"')
if [ -z "$JWT_SECRET" ]; then
  echo "ERROR: JWT_SECRET not found"
  exit 1
fi

# 找到一个未就绪的 campaign
CAMPAIGN_ID=$(mysql -u crm -p'CrmPass2026!' google-data-analysis -N -e "
  SELECT c.id FROM campaigns c
  JOIN ad_groups ag ON ag.campaign_id = c.id AND ag.is_deleted=0
  JOIN ad_creatives ac ON ac.ad_group_id = ag.id AND ac.is_deleted=0
  WHERE c.is_deleted=0
    AND (JSON_LENGTH(ac.headlines) < 15 OR JSON_LENGTH(ac.descriptions) < 4)
  ORDER BY c.id DESC LIMIT 1
" 2>/dev/null)

if [ -z "$CAMPAIGN_ID" ]; then
  CAMPAIGN_ID=$(mysql -u crm -p'CrmPass2026!' google-data-analysis -N -e "
    SELECT c.id FROM campaigns c
    JOIN ad_groups ag ON ag.campaign_id = c.id AND ag.is_deleted=0
    JOIN ad_creatives ac ON ac.ad_group_id = ag.id AND ac.is_deleted=0
    WHERE c.is_deleted=0 ORDER BY c.id DESC LIMIT 1
  " 2>/dev/null)
  echo "INFO: 所有 adCreative 都已就绪，使用 campaign $CAMPAIGN_ID 测试冷却行为"
fi

USER_ID=$(mysql -u crm -p'CrmPass2026!' google-data-analysis -N -e "
  SELECT user_id FROM campaigns WHERE id=$CAMPAIGN_ID AND is_deleted=0 LIMIT 1
" 2>/dev/null)

echo "========================================="
echo " AI 频繁调用防护测试 v2"
echo "========================================="
echo "Campaign ID: $CAMPAIGN_ID"
echo "User ID:     $USER_ID"

# 生成 JWT token
TOKEN=$(cd "$APP_DIR" && node -e "
  const j=require('jsonwebtoken');
  process.stdout.write(j.sign({userId:'$USER_ID',role:'user',username:'test'},'$JWT_SECRET',{expiresIn:'1h'}));
")
echo "Token: ${TOKEN:0:20}..."

# 查看数据库中当前状态
echo ""
echo "========================================="
echo " 数据库当前状态"
echo "========================================="
mysql -u crm -p'CrmPass2026!' google-data-analysis -N -e "
  SELECT ac.id, JSON_LENGTH(ac.headlines) as h, JSON_LENGTH(ac.descriptions) as d
  FROM campaigns c
  JOIN ad_groups ag ON ag.campaign_id=c.id AND ag.is_deleted=0
  JOIN ad_creatives ac ON ac.ad_group_id=ag.id AND ac.is_deleted=0
  WHERE c.id=$CAMPAIGN_ID
" 2>/dev/null | while read id h d; do
  READY="NO"
  if [ "$h" -ge 15 ] && [ "$d" -ge 4 ]; then READY="YES"; fi
  echo "adCreative #$id: headlines=$h/15  descriptions=$d/4  isReady=$READY"
done

# 记录 error.log 起始行
ERR_BEFORE=$(wc -l < "$ERR_LOG" 2>/dev/null || echo 0)

echo ""
echo "========================================="
echo " 测试 1: 快速连续轮询 20 次 (间隔 2s)"
echo "========================================="
echo "预期: 最多 1 次 AI 触发（冷却期 10 分钟内不会重复）"
echo ""

for i in $(seq 1 20); do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -b "user_token=$TOKEN" \
    "$BASE_URL/api/user/ad-creation/status?campaign_id=$CAMPAIGN_ID")
  printf "  Poll %2d: HTTP %s\n" "$i" "$HTTP_CODE"
  sleep 2
done

echo ""
echo "等待 15 秒让异步 AI 任务完成..."
sleep 15

# 分析 error.log 中的 AI 相关条目
ERR_AFTER=$(wc -l < "$ERR_LOG" 2>/dev/null || echo 0)
ERR_START=$((ERR_BEFORE + 1))

echo ""
echo "========================================="
echo " 日志分析 (error.log)"
echo "========================================="

if [ "$ERR_AFTER" -gt "$ERR_BEFORE" ]; then
  NEW_LINES=$(sed -n "${ERR_START},\$p" "$ERR_LOG" 2>/dev/null)
  TRIGGER_COUNT=$(echo "$NEW_LINES" | grep -c '\[AdCopy\] 补充生成' || true)
  PAD_H=$(echo "$NEW_LINES" | grep -c '\[padHeadlines\]' || true)
  PAD_D=$(echo "$NEW_LINES" | grep -c '\[padDescriptions\]' || true)
  AI_CALLS=$(echo "$NEW_LINES" | grep -c '\[AI\]' || true)
  QUOTA_ERR=$(echo "$NEW_LINES" | grep -c 'insufficient_user_quota' || true)
else
  TRIGGER_COUNT=0; PAD_H=0; PAD_D=0; AI_CALLS=0; QUOTA_ERR=0
  NEW_LINES=""
fi

echo "AI 补充触发:      $TRIGGER_COUNT 次 (预期: <=1)"
echo "padHeadlines:     $PAD_H 次 (预期: <=1)"
echo "padDescriptions:  $PAD_D 次 (预期: <=1)"
echo "AI API 调用:      $AI_CALLS 次 (预期: <=4)"
echo "额度不足错误:     $QUOTA_ERR 次"

if [ -n "$NEW_LINES" ]; then
  echo ""
  echo "--- 相关日志 ---"
  echo "$NEW_LINES" | grep '\[AdCopy\]\|\[AI\]\|\[pad\]\|quota\|insufficient' | head -20
fi

# 测试 2: 冷却期验证
ERR_MID=$(wc -l < "$ERR_LOG" 2>/dev/null || echo 0)

echo ""
echo "========================================="
echo " 测试 2: 冷却期验证 — 立即再轮询 10 次"
echo "========================================="
echo "预期: 0 次 AI 触发（冷却期未过）"

for i in $(seq 1 10); do
  curl -s -o /dev/null -b "user_token=$TOKEN" \
    "$BASE_URL/api/user/ad-creation/status?campaign_id=$CAMPAIGN_ID"
  printf "  Poll %2d: done\n" "$i"
  sleep 1
done

sleep 3
ERR_END=$(wc -l < "$ERR_LOG" 2>/dev/null || echo 0)
MID_START=$((ERR_MID + 1))

if [ "$ERR_END" -gt "$ERR_MID" ]; then
  T2_TRIGGERS=$(sed -n "${MID_START},\$p" "$ERR_LOG" 2>/dev/null | grep -c '\[padHeadlines\]\|\[padDescriptions\]\|\[AdCopy\] 补充' || true)
else
  T2_TRIGGERS=0
fi

echo ""
echo "冷却期内 AI 触发: $T2_TRIGGERS 次 (预期: 0)"

# 总结
echo ""
echo "========================================="
echo " 总结"
echo "========================================="

PASS=true

if [ "$TRIGGER_COUNT" -le 1 ]; then
  echo "PASS: 测试1 — 快速轮询 AI 触发 $TRIGGER_COUNT 次 (<=1)"
else
  echo "FAIL: 测试1 — 快速轮询 AI 触发 $TRIGGER_COUNT 次 (应 <=1)"
  PASS=false
fi

if [ "$AI_CALLS" -le 8 ]; then
  echo "PASS: 测试1 — AI API 调用 $AI_CALLS 次 (<=8)"
else
  echo "FAIL: 测试1 — AI API 调用 $AI_CALLS 次 (应 <=8)"
  PASS=false
fi

if [ "$T2_TRIGGERS" -eq 0 ]; then
  echo "PASS: 测试2 — 冷却期内 0 次 AI 触发"
else
  echo "FAIL: 测试2 — 冷却期内 $T2_TRIGGERS 次 AI 触发 (应 0)"
  PASS=false
fi

echo ""
if [ "$PASS" = true ]; then
  echo "=== ALL TESTS PASSED ==="
else
  echo "=== SOME TESTS FAILED ==="
fi
