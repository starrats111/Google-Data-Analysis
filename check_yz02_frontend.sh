#!/bin/bash

echo "=== 1. 模拟登录yz02获取token ==="
LOGIN_RESP=$(curl -s -X POST http://localhost:20050/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"yz02","password":"yz02"}')
echo "Login response: $LOGIN_RESP"

TOKEN=$(echo "$LOGIN_RESP" | grep -o '"token":"[^"]*"' | head -1 | sed 's/"token":"//;s/"//')
echo "Token: ${TOKEN:0:30}..."

if [ -z "$TOKEN" ]; then
  echo "Login failed, trying to get token from cookie..."
  LOGIN_RESP2=$(curl -s -c /tmp/yz02_cookie.txt -X POST http://localhost:20050/api/auth/login \
    -H "Content-Type: application/json" \
    -d '{"username":"yz02","password":"yz02"}')
  echo "Login response 2: $LOGIN_RESP2"
  cat /tmp/yz02_cookie.txt
fi

echo ""
echo "=== 2. 检查error日志中是否有merchants相关错误 ==="
grep -i 'merchants\|user_merchants' /home/ubuntu/.pm2/logs/ad-automation-error.log 2>/dev/null | tail -10

echo ""
echo "=== 3. 检查Next.js进程日志 ==="
grep -i 'merchant\|ERROR\|error\|userId=18\|user=18' /home/ubuntu/.pm2/logs/ad-automation-out.log 2>/dev/null | tail -20

echo ""
echo "=== 4. 检查应用的实际进程 ==="
ps aux | grep next | grep -v grep

echo ""
echo "=== 5. 查看最近的应用错误日志 ==="
tail -50 /home/ubuntu/.pm2/logs/ad-automation-error.log 2>/dev/null | head -50
