#!/bin/bash
# 快速调试测试：单次 curl 请求 + 检查日志
APP_DIR="/home/ubuntu/Google-Data-Analysis/crm-mvp"
LOG="/home/ubuntu/.pm2/logs/ad-automation-out.log"

echo "=== out日志行数 ==="
wc -l "$LOG"

echo ""
echo "=== 生成token ==="
JWT_SECRET=$(grep JWT_SECRET "$APP_DIR/.env" | cut -d= -f2- | tr -d '"')
TOKEN=$(cd "$APP_DIR" && node -e "
  const j=require('jsonwebtoken');
  process.stdout.write(j.sign({userId:'11',role:'user',username:'t'},'$JWT_SECRET',{expiresIn:'1h'}));
")
echo "Token: ${TOKEN:0:20}..."

echo ""
echo "=== 发送1次status请求 ==="
LOG_BEFORE=$(wc -l < "$LOG")
RESP=$(curl -s -b "user_token=$TOKEN" 'http://localhost:20050/api/user/ad-creation/status?campaign_id=2555')
echo "Response (前200字符): ${RESP:0:200}"

echo ""
echo "=== isReady 值 ==="
echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('isReady:', d.get('data',{}).get('isReady','N/A'))" 2>/dev/null || echo "(解析失败)"

sleep 2
echo ""
echo "=== 请求后新增的out日志 ==="
LOG_AFTER=$(wc -l < "$LOG")
NEW_START=$((LOG_BEFORE + 1))
if [ "$LOG_AFTER" -gt "$LOG_BEFORE" ]; then
  sed -n "${NEW_START},\$p" "$LOG"
else
  echo "(无新日志)"
fi

echo ""
echo "=== 请求后新增的error日志 ==="
tail -5 /home/ubuntu/.pm2/logs/ad-automation-error.log
