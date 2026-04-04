#!/bin/bash
echo "=== 1. yz02 用户基本信息 ==="
sudo mysql google-data-analysis -e "SELECT id, username, email, role FROM users WHERE username='yz02';"

echo ""
echo "=== 2. yz02 平台连接 ==="
sudo mysql google-data-analysis -e "SELECT id, platform, account_name, is_deleted, publish_site_id, created_at, updated_at FROM platform_connections WHERE user_id = (SELECT id FROM users WHERE username='yz02') ORDER BY id;"

echo ""
echo "=== 3. yz02 商家统计(按平台/状态) ==="
sudo mysql google-data-analysis -e "SELECT platform, status, is_deleted, COUNT(*) as cnt FROM user_merchants WHERE user_id = (SELECT id FROM users WHERE username='yz02') GROUP BY platform, status, is_deleted ORDER BY platform, status;"

echo ""
echo "=== 4. yz02 文章状态 ==="
sudo mysql google-data-analysis -e "SELECT status, COUNT(*) as cnt FROM articles WHERE user_id = (SELECT id FROM users WHERE username='yz02') AND is_deleted = 0 GROUP BY status;"

echo ""
echo "=== 5. yz02 最近5条通知 ==="
sudo mysql google-data-analysis -e "SELECT id, title, LEFT(content, 150) as content, is_read, created_at FROM notifications WHERE user_id = (SELECT id FROM users WHERE username='yz02') ORDER BY created_at DESC LIMIT 5;"

echo ""
echo "=== 6. yz02 广告状态 ==="
sudo mysql google-data-analysis -e "SELECT ad_status, COUNT(*) as cnt FROM user_merchants WHERE user_id = (SELECT id FROM users WHERE username='yz02') AND is_deleted = 0 AND ad_status IS NOT NULL AND ad_status != '' GROUP BY ad_status;"

echo ""
echo "=== 7. yz02 最近生成/失败的文章 ==="
sudo mysql google-data-analysis -e "SELECT id, status, merchant_name, created_at, updated_at FROM articles WHERE user_id = (SELECT id FROM users WHERE username='yz02') ORDER BY created_at DESC LIMIT 10;"

echo ""
echo "=== 8. yz02 相关的最近PM2日志 ==="
pm2 logs ad-automation --lines 300 --nostream 2>&1 | grep -i -E "yz02|user.*18|userId.*18" | tail -20

echo ""
echo "=== 9. 最近AI调用错误(影响所有用户) ==="
pm2 logs ad-automation --lines 200 --nostream 2>&1 | grep -i -E "\[AI\].*失败|ArticleCreate.*失败|generateMerchant.*失败|padHeadlines.*失败" | tail -15
