#!/bin/bash
# D-365 探查：wj05(陈正深) 今日投放广告显示 19 条，实际今日未投放
Q() { sudo mysql google-data-analysis -t -e "$1"; }

echo "===== 0. 当前时间（UTC / CST） ====="
Q "SELECT NOW() AS db_now_utc, CONVERT_TZ(NOW(),'+00:00','+08:00') AS cst, @@global.time_zone AS tz;"

echo "===== 1. wj05 用户行 ====="
Q "SELECT id, username, display_name, status FROM users WHERE username LIKE 'wj%' ORDER BY username;"

echo "===== 2. 缓存里的 ads_count ====="
Q "SELECT config_key, config_value, updated_at FROM system_configs
   WHERE config_key LIKE 'today_merchants_%' AND is_deleted=0
   ORDER BY config_key;"

echo "===== 3. wj05 名下 campaigns 今日(CST)新建且有 gcid 的 ====="
Q "SELECT c.id, c.campaign_name, c.google_campaign_id, c.status, c.is_deleted,
          c.created_at AS created_utc, CONVERT_TZ(c.created_at,'+00:00','+08:00') AS created_cst
   FROM campaigns c JOIN users u ON u.id=c.user_id
   WHERE u.username='wj05' AND c.is_deleted=0
     AND c.google_campaign_id IS NOT NULL
     AND c.created_at >= CONVERT_TZ(CONCAT(DATE(CONVERT_TZ(NOW(),'+00:00','+08:00')),' 00:00:00'),'+08:00','+00:00')
   ORDER BY c.created_at;"

echo "===== 4. 同上但不限 is_deleted / 不限 gcid（看草稿与软删） ====="
Q "SELECT COUNT(*) AS all_rows,
          SUM(c.google_campaign_id IS NOT NULL) AS with_gcid,
          SUM(c.is_deleted=0) AS not_deleted,
          SUM(c.is_deleted=0 AND c.google_campaign_id IS NOT NULL) AS counted
   FROM campaigns c JOIN users u ON u.id=c.user_id
   WHERE u.username='wj05'
     AND c.created_at >= CONVERT_TZ(CONCAT(DATE(CONVERT_TZ(NOW(),'+00:00','+08:00')),' 00:00:00'),'+08:00','+00:00');"

echo "===== 5. wj05 近 7 天每日新建条数（看 19 是不是堆积） ====="
Q "SELECT DATE(CONVERT_TZ(c.created_at,'+00:00','+08:00')) AS d_cst,
          COUNT(*) AS cnt, SUM(c.google_campaign_id IS NOT NULL) AS with_gcid, SUM(c.is_deleted=0) AS alive
   FROM campaigns c JOIN users u ON u.id=c.user_id
   WHERE u.username='wj05' AND c.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
   GROUP BY d_cst ORDER BY d_cst;"
