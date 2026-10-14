#!/bin/bash
# D-365 探查2：补上一轮的两个坑
#   ① 第 3 段（竞品引擎系列）返回空 —— 是真没有，还是 source 标记不是 'rival_intel'？
#   ② 第 5 段列名错（campaigns 没有 name 列）—— 找对列名再查 HYTEST
# 只读。
Q() { sudo mysql google-data-analysis -t -e "$1"; }

echo "===== A. campaigns 的列名（找系列名那一列） ====="
Q "SHOW COLUMNS FROM campaigns LIKE '%name%';"

echo "===== B. keywords.source 的真实取值分布 ====="
Q "SELECT COALESCE(source,'(NULL)') AS source, COUNT(*) AS 条数
   FROM keywords WHERE is_deleted = 0
   GROUP BY source ORDER BY 条数 DESC LIMIT 15;"

echo "===== C. 竞品情报草稿表自己有多少行（最直接的出处） ====="
Q "SELECT COUNT(*) AS 草稿总数,
          SUM(status='draft_ready') AS 已就绪,
          SUM(campaign_id IS NOT NULL) AS 已关联系列,
          MIN(created_at) AS 最早, MAX(created_at) AS 最晚
   FROM rival_intel_drafts WHERE is_deleted = 0;"

echo "===== D. 哪些人把引擎切成了竞品情报 ====="
Q "SELECT u.username, s.ad_engine, s.updated_at
   FROM ad_default_settings s JOIN users u ON u.id = s.user_id
   WHERE s.is_deleted = 0 AND s.ad_engine IS NOT NULL AND s.ad_engine <> 'evidence'
   ORDER BY s.updated_at DESC LIMIT 20;"

echo "===== E. 竞品引擎发出去的系列（经草稿表反查）后缀现状 ====="
Q "SELECT c.google_status,
          COUNT(*) AS 条数,
          SUM(c.final_url_suffix IS NULL OR TRIM(c.final_url_suffix)='') AS 库里无后缀,
          SUM(c.suffix_last_apply_at IS NULL) AS 从未换链
   FROM rival_intel_drafts d
   JOIN campaigns c ON c.id = d.campaign_id AND c.is_deleted = 0
   WHERE d.is_deleted = 0 AND c.google_campaign_id IS NOT NULL
   GROUP BY c.google_status ORDER BY 条数 DESC;"

echo "===== F. 01 报案那条（HYTEST）====="
Q "SELECT c.id, c.google_campaign_id, c.campaign_name, c.google_status,
          c.customer_id, c.suffix_last_apply_at,
          LEFT(c.final_url_suffix,74) AS suffix_db
   FROM campaigns c
   JOIN user_merchants m ON m.id = c.user_merchant_id
   WHERE c.is_deleted = 0 AND m.merchant_name LIKE '%HYTEST%'
   ORDER BY c.created_at DESC LIMIT 10;"

echo "===== G. 待补 15 条逐条明细（补推前的快照，兼作回滚依据） ====="
Q "SELECT c.id, u.username, c.google_campaign_id, c.customer_id,
          LEFT(c.campaign_name,40) AS campaign_name,
          LENGTH(c.final_url_suffix) AS suffix_len
   FROM campaigns c JOIN users u ON u.id = c.user_id
   WHERE c.is_deleted = 0
     AND c.google_campaign_id IS NOT NULL
     AND c.google_status = 'ENABLED'
     AND c.suffix_last_apply_at IS NULL
     AND c.final_url_suffix IS NOT NULL AND TRIM(c.final_url_suffix) <> ''
   ORDER BY u.username, c.id;"
