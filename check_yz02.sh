#!/bin/bash
echo "=== 1. 查找yz02用户 ==="
sudo mysql google-data-analysis -e "SELECT id, username, email, role FROM users WHERE username LIKE '%yz%' OR email LIKE '%yz%' LIMIT 10;"

echo ""
echo "=== 2. 所有用户列表 ==="
sudo mysql google-data-analysis -e "SELECT id, username, email, role FROM users LIMIT 20;"

echo ""
echo "=== 3. 平台连接信息 ==="
sudo mysql google-data-analysis -e "SELECT pc.id, u.username, pc.platform, pc.account_name, pc.is_deleted, LEFT(pc.api_key,10) as api_key_prefix FROM platform_connections pc JOIN users u ON pc.user_id = u.id WHERE u.username LIKE '%yz%' OR pc.account_name LIKE '%yz%';"

echo ""
echo "=== 4. 商家库(user_merchants)统计 ==="
sudo mysql google-data-analysis -e "SELECT u.username, um.platform, um.status, COUNT(*) as cnt FROM user_merchants um JOIN users u ON um.user_id = u.id GROUP BY u.username, um.platform, um.status ORDER BY u.username;"

echo ""
echo "=== 5. 通知记录中的同步失败 ==="
sudo mysql google-data-analysis -e "SELECT u.username, n.title, LEFT(n.content, 200) as content, n.created_at FROM notifications n JOIN users u ON n.user_id = u.id WHERE n.title LIKE '%商家%' OR n.title LIKE '%同步%' ORDER BY n.created_at DESC LIMIT 20;"
