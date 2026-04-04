#!/bin/bash

echo "=== 1. 直接查DB: yz02 user_merchants表中各状态数量 ==="
sudo mysql google-data-analysis -e "SELECT status, is_deleted, COUNT(*) as cnt FROM user_merchants WHERE user_id = 18 GROUP BY status, is_deleted;"

echo ""
echo "=== 2. 检查user_merchants表结构是否有问题 ==="
sudo mysql google-data-analysis -e "SELECT id, user_id, platform, merchant_id, merchant_name, status, is_deleted FROM user_merchants WHERE user_id = 18 LIMIT 5;"

echo ""
echo "=== 3. 用curl测试API(available tab) ==="
# 首先需要获取yz02的token
# 使用内部API测试
curl -s -o /dev/null -w "HTTP_STATUS: %{http_code}\n" http://localhost:20050/api/health

echo ""
echo "=== 4. 检查PM2进程状态 ==="
pm2 list

echo ""
echo "=== 5. 检查user_merchants表索引 ==="
sudo mysql google-data-analysis -e "SHOW INDEX FROM user_merchants;"

echo ""
echo "=== 6. 测试user_merchants查询性能 ==="
sudo mysql google-data-analysis -e "SELECT COUNT(*) as total FROM user_merchants WHERE user_id = 18 AND is_deleted = 0 AND status = 'available';"

echo ""
echo "=== 7. 检查users表中yz02的完整信息 ==="
sudo mysql google-data-analysis -e "SELECT * FROM users WHERE id = 18\G"
