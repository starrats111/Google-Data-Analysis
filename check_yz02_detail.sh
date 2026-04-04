#!/bin/bash
echo "=== 1. yz02 CF平台连接详情 ==="
sudo mysql google-data-analysis -e "SELECT id, user_id, platform, account_name, is_deleted, LEFT(api_key,20) as api_key_prefix, created_at, updated_at FROM platform_connections WHERE user_id = (SELECT id FROM users WHERE username='yz02') ORDER BY id;"

echo ""
echo "=== 2. yz02 各平台商家数量 ==="
sudo mysql google-data-analysis -e "SELECT platform, status, COUNT(*) as cnt, is_deleted FROM user_merchants WHERE user_id = (SELECT id FROM users WHERE username='yz02') GROUP BY platform, status, is_deleted;"

echo ""
echo "=== 3. yz02 RW平台连接? ==="
sudo mysql google-data-analysis -e "SELECT * FROM platform_connections WHERE user_id = (SELECT id FROM users WHERE username='yz02') AND platform = 'RW';"

echo ""
echo "=== 4. PM2 日志中yz02/CF相关错误 ==="
cd /home/ubuntu/Google-Data-Analysis
sudo pm2 logs ad-automation --lines 200 --nostream 2>&1 | grep -i -E "yz02|CF|504|sync.*error|FATAL" | tail -50

echo ""
echo "=== 5. yz02 最近同步状态 ==="
sudo mysql google-data-analysis -e "SELECT id, user_id, title, LEFT(content, 300) as content, is_read, created_at FROM notifications WHERE user_id = (SELECT id FROM users WHERE username='yz02') ORDER BY created_at DESC LIMIT 5;"

echo ""
echo "=== 6. yz02 的CF商家数 ==="
sudo mysql google-data-analysis -e "SELECT platform, COUNT(*) as cnt FROM user_merchants WHERE user_id = (SELECT id FROM users WHERE username='yz02') AND platform = 'CF' GROUP BY platform;"
